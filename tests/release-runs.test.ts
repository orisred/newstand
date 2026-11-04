/* eslint-disable @typescript-eslint/no-explicit-any -- a fake of Shopify's loosely typed responses */
import { applyD1Migrations, createMessageBatch, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../app/db.server";
import type {
  OrderTiming,
  ReleaseStatus,
  SubscriptionStatus,
} from "../app/generated/prisma/enums";
import { consumeJobs, type Job } from "../app/jobs/runner.server";
import type { Graphql } from "../app/plan-sync.server";
import { buildRunCsv, csvCell } from "../app/release-csv.server";
import { formatZoned, zonedFields, zonedToUtc } from "../app/release-dates";
import { createDeliveryOrder } from "../app/release-orders.server";
import {
  createDueDeliveries,
  findReleaseRuns,
  findScheduledSteps,
  runReleaseSlice,
} from "../app/release-runs.server";
import {
  fireScheduledRelease,
  listRunProgress,
  moveRelease,
  scheduleRelease,
  setReleaseProduct,
} from "../app/releases.server";
import { getOrCreateShop } from "../app/shop.server";
import {
  pickFirstRelease,
  RELEASE_RUN_JOB,
  releaseRunJob,
} from "../app/subscriptions.server";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const db = () => createDb(env.DB);
let n = 0;

const ADDRESS = { address1: "1 Test St", city: "NY", countryCode: "US" };

/** A Shopify holding orders, allowing `limit` new ones a minute on the given clock. */
function fakeShopify(
  options: { limit?: number; clock?: () => Date; errors?: string[] } = {},
) {
  const orders: any[] = [];
  const stamps: number[] = [];
  const state = { failing: false, attempts: 0 };
  const graphql: Graphql = async (query, variables: any) => {
    if (state.failing) throw new Error("Admin API returned errors");
    if (query.includes("OrderByMarker")) {
      const marker = /source_identifier:'(.+)'/.exec(variables.query)![1];
      return {
        orders: {
          nodes: orders.filter((order) => order.sourceIdentifier === marker),
        },
      };
    }
    if (query.includes("ContractForOrder")) {
      return {
        shop: { currencyCode: "USD" },
        productVariant: { inventoryItem: { requiresShipping: true } },
        subscriptionContract: { deliveryMethod: { address: ADDRESS } },
      };
    }
    if (query.includes("ReleaseOrderCreate")) {
      state.attempts++;
      if (options.errors?.length) {
        return {
          orderCreate: {
            order: null,
            userErrors: options.errors.map((message) => ({ message })),
          },
        };
      }
      const now = (options.clock ?? (() => new Date()))().getTime();
      if (
        options.limit !== undefined &&
        stamps.filter((stamp) => now - stamp < 60_000).length >= options.limit
      ) {
        return {
          orderCreate: {
            order: null,
            userErrors: [
              { message: "Too many attempts. Please try again later." },
            ],
          },
        };
      }
      stamps.push(now);
      const id = ++n;
      const order = {
        id: `gid://shopify/Order/${id}`,
        name: `#${id}`,
        sourceIdentifier: variables.order.sourceIdentifier,
      };
      orders.push(order);
      return { orderCreate: { order, userErrors: [] } };
    }
    throw new Error(`Unexpected query: ${query}`);
  };
  return { graphql, orders, state };
}

async function newShop(orderTiming: OrderTiming = "READY_TO_SHIP") {
  const shopDomain = `runs${++n}.myshopify.com`;
  const shop = await getOrCreateShop(db(), shopDomain);
  await db().shop.update({ where: { id: shop.id }, data: { orderTiming } });
  const plan = await db().plan.create({
    data: {
      shopId: shop.id,
      name: "Yearly",
      displayName: "Yearly",
      priceCents: 4000,
    },
  });
  return {
    ...shop,
    orderTiming,
    shopDomain,
    planId: plan.id,
    releaseWordSingular: "drop",
  };
}

type TestShop = Awaited<ReturnType<typeof newShop>>;

const newRelease = (
  shop: TestShop,
  number: number,
  status: ReleaseStatus = "READY",
  fields: Record<string, unknown> = {},
) =>
  db().release.create({
    data: {
      shopId: shop.id,
      number,
      title: `R${number}`,
      status,
      productGid: "gid://shopify/ProductVariant/1",
      ...fields,
    },
  });

const newSubscriber = (
  shop: TestShop,
  fields: {
    releasesRemaining?: number;
    firstReleaseNumber?: number;
    status?: SubscriptionStatus;
  } = {},
) =>
  db().subscription.create({
    data: {
      shopId: shop.id,
      planId: shop.planId,
      contractGid: `gid://shopify/SubscriptionContract/${++n}`,
      customerGid: `gid://shopify/Customer/${n}`,
      releasesRemaining: 1,
      ...fields,
    },
  });

const assign = (subscriptionId: string, releaseId: string) =>
  db().delivery.create({ data: { subscriptionId, releaseId } });

const remaining = async (id: string) =>
  (await db().subscription.findUniqueOrThrow({ where: { id } }))
    .releasesRemaining;
const deliveriesOf = (releaseId: string) =>
  db().delivery.findMany({ where: { releaseId } });

function fakeQueue() {
  const sent: { body: Job; delaySeconds?: number }[] = [];
  // Announcing a pre-order also starts the shop's emails, which these tests aren't about.
  const emails: { body: Job; delaySeconds?: number }[] = [];
  return {
    sent,
    emails,
    env: {
      DB: env.DB,
      JOBS: {
        sendBatch: async (messages: any[]) => {
          for (const message of messages) {
            (message.body.type === "email.run" ? emails : sent).push(message);
          }
        },
      },
    } as any,
  };
}

const startJob = (shop: TestShop, releaseId: string, key = "start") =>
  releaseRunJob(shop.shopDomain, releaseId, key);

/** Runs a chain of slices to its end on a clock that follows each delay. */
async function drain(
  shop: TestShop,
  releaseId: string,
  shopify: ReturnType<typeof fakeShopify>,
  clock: { now: number },
) {
  const delays: number[] = [];
  let next: Awaited<ReturnType<typeof runReleaseSlice>> = {
    job: startJob(shop, releaseId, `drain-${++n}`),
    delaySeconds: 0,
  };
  while (next) {
    expect(delays.length).toBeLessThan(200);
    clock.now += next.delaySeconds * 1000;
    delays.push(next.delaySeconds);
    next = await runReleaseSlice(
      db(),
      env.DB,
      async () => shopify.graphql,
      next.job,
      () => new Date(clock.now),
    );
  }
  return delays;
}

const FAR = () => ({ now: Date.UTC(2027, 0, 1) });

describe("who a run includes", () => {
  it("each subscription status: ended is out, paused and cancelled are in", async () => {
    const shop = await newShop();
    const release = await newRelease(shop, 1);
    const rows = await Promise.all(
      (["ACTIVE", "PAUSED", "CANCELLED", "ENDED"] as const).map((status) =>
        newSubscriber(shop, { status }),
      ),
    );
    expect(await createDueDeliveries(env.DB, shop.id, release.id)).toBe(3);
    const got = (await deliveriesOf(release.id)).map((d) => d.subscriptionId);
    expect(got).toHaveLength(3);
    expect(got).not.toContain(rows[3].id);
  });

  it("leaves out a release before the subscriber's first, and an empty balance", async () => {
    const shop = await newShop();
    const release = await newRelease(shop, 3);
    await newSubscriber(shop, { firstReleaseNumber: 4 });
    await newSubscriber(shop, { releasesRemaining: 0 });
    const due = await newSubscriber(shop, { firstReleaseNumber: 3 });
    await createDueDeliveries(env.DB, shop.id, release.id);
    expect(
      (await deliveriesOf(release.id)).map((d) => d.subscriptionId),
    ).toEqual([due.id]);
  });

  it("leaves out a contract-less subscription and other shops' subscribers", async () => {
    const shop = await newShop();
    const other = await newShop();
    const release = await newRelease(shop, 1);
    await newSubscriber(other);
    const bare = await newSubscriber(shop);
    await db().subscription.update({
      where: { id: bare.id },
      data: { contractGid: null },
    });
    expect(await createDueDeliveries(env.DB, shop.id, release.id)).toBe(0);
    expect(await createDueDeliveries(env.DB, other.id, release.id)).toBe(0);
  });

  it("repeating adds nothing and keeps the Delivery it found", async () => {
    const shop = await newShop();
    const release = await newRelease(shop, 1);
    const subscriber = await newSubscriber(shop, { releasesRemaining: 2 });
    const first = await assign(subscriber.id, release.id);
    expect(await createDueDeliveries(env.DB, shop.id, release.id)).toBe(0);
    expect((await deliveriesOf(release.id)).map((d) => d.id)).toEqual([
      first.id,
    ]);
  });

  describe("each orderTiming", () => {
    const table: [OrderTiming, ReleaseStatus, boolean][] = [
      ["READY_TO_SHIP", "UNANNOUNCED", false],
      ["READY_TO_SHIP", "PREORDER", false],
      ["READY_TO_SHIP", "READY", true],
      ["READY_TO_SHIP", "SHIPPED", false],
      ["READY_TO_SHIP", "CANCELLED", false],
      ["PREORDER_OPENS", "UNANNOUNCED", false],
      ["PREORDER_OPENS", "PREORDER", true],
      ["PREORDER_OPENS", "READY", true],
      ["PREORDER_OPENS", "SHIPPED", false],
    ];
    for (const [timing, status, assigned] of table) {
      it(`${timing}, ${status}: ${assigned ? "assigned" : "nothing"}`, async () => {
        const shop = await newShop(timing);
        const release = await newRelease(shop, 1, status);
        await newSubscriber(shop);
        expect(await createDueDeliveries(env.DB, shop.id, release.id)).toBe(
          assigned ? 1 : 0,
        );
      });
    }
  });
});

describe("the paid count versus open Deliveries", () => {
  it("one paid release held by an earlier PENDING Delivery: no second one", async () => {
    const shop = await newShop();
    const earlier = await newRelease(shop, 1, "READY", { productGid: null });
    const later = await newRelease(shop, 2);
    const subscriber = await newSubscriber(shop);
    await assign(subscriber.id, earlier.id);

    const shopify = fakeShopify();
    await drain(shop, later.id, shopify, FAR());
    expect(await deliveriesOf(later.id)).toHaveLength(0);
    expect(shopify.orders).toHaveLength(0);
    expect(await remaining(subscriber.id)).toBe(1);
  });

  it("a refused order keeps its claim too", async () => {
    const shop = await newShop();
    const earlier = await newRelease(shop, 1);
    const later = await newRelease(shop, 2);
    const subscriber = await newSubscriber(shop);
    await db().delivery.create({
      data: {
        subscriptionId: subscriber.id,
        releaseId: earlier.id,
        orderError: "No",
      },
    });
    expect(await createDueDeliveries(env.DB, shop.id, later.id)).toBe(0);
  });

  it("two paid releases: both runs at once get orders and the balance lands on 0", async () => {
    const shop = await newShop();
    const a = await newRelease(shop, 1);
    const b = await newRelease(shop, 2);
    const subscriber = await newSubscriber(shop, { releasesRemaining: 2 });
    const shopify = fakeShopify();
    await Promise.all([
      drain(shop, a.id, shopify, FAR()),
      drain(shop, b.id, shopify, FAR()),
    ]);
    expect(shopify.orders).toHaveLength(2);
    expect(await remaining(subscriber.id)).toBe(0);
  });

  it("one paid release: both runs at once spend it once", async () => {
    const shop = await newShop();
    const a = await newRelease(shop, 1);
    const b = await newRelease(shop, 2);
    const subscriber = await newSubscriber(shop);
    const shopify = fakeShopify();
    await Promise.all([
      drain(shop, a.id, shopify, FAR()),
      drain(shop, b.id, shopify, FAR()),
    ]);
    expect(shopify.orders).toHaveLength(1);
    expect(await remaining(subscriber.id)).toBe(0);
  });

  it("two PENDING on one paid release, however that came about: one order, never negative", async () => {
    const shop = await newShop();
    const a = await newRelease(shop, 1);
    const b = await newRelease(shop, 2);
    const subscriber = await newSubscriber(shop);
    const first = await assign(subscriber.id, a.id);
    const second = await assign(subscriber.id, b.id);
    const shopify = fakeShopify();
    expect(
      await createDeliveryOrder(db(), env.DB, shopify.graphql, first.id),
    ).toBe("created");
    expect(
      await createDeliveryOrder(db(), env.DB, shopify.graphql, second.id),
    ).toBe("no_balance");
    expect(shopify.orders).toHaveLength(1);
    expect(await remaining(subscriber.id)).toBe(0);
  });

  it("a run skips a PENDING Delivery with nothing paid, so it can't spin", async () => {
    const shop = await newShop();
    const release = await newRelease(shop, 1);
    const subscriber = await newSubscriber(shop, { releasesRemaining: 0 });
    await assign(subscriber.id, release.id);
    const shopify = fakeShopify();
    expect(await drain(shop, release.id, shopify, FAR())).toEqual([0]);
    expect(shopify.state.attempts).toBe(0);
  });
});

describe("a run", () => {
  it("makes one order per subscriber, and counts each once", async () => {
    const shop = await newShop();
    const release = await newRelease(shop, 1);
    const subscribers = await Promise.all(
      Array.from({ length: 45 }, () => newSubscriber(shop)),
    );
    const shopify = fakeShopify();
    // Sliced, so one message never holds the whole run.
    expect(await drain(shop, release.id, shopify, FAR())).toEqual([0, 0, 0]);
    expect(shopify.orders).toHaveLength(45);
    expect(new Set(shopify.orders.map((o) => o.sourceIdentifier)).size).toBe(
      45,
    );
    for (const { id } of subscribers) expect(await remaining(id)).toBe(0);
    for (const row of await deliveriesOf(release.id)) {
      expect(row.status).toBe("ORDERED");
      expect(row.orderName).toMatch(/^#\d+$/);
    }
  });

  it("a double press flips once and starts one run", async () => {
    const shop = await newShop();
    const release = await newRelease(shop, 1, "PREORDER");
    const queue = fakeQueue();
    const results = await Promise.all([
      moveRelease(db(), queue.env, shop, release.id, "ready"),
      moveRelease(db(), queue.env, shop, release.id, "ready"),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0].body.type).toBe(RELEASE_RUN_JOB);
  });

  it("two presses a moment apart and a tick make the same orders as one", async () => {
    const shop = await newShop();
    const release = await newRelease(shop, 1, "PREORDER");
    await newSubscriber(shop);
    await newSubscriber(shop);
    const queue = fakeQueue();
    await moveRelease(db(), queue.env, shop, release.id, "ready");
    await moveRelease(db(), queue.env, shop, release.id, "ready");
    const shopify = fakeShopify();
    for (let i = 0; i < 3; i++) await drain(shop, release.id, shopify, FAR());
    expect(shopify.orders).toHaveLength(2);
  });

  it("announcing starts a run only under PREORDER_OPENS", async () => {
    for (const [timing, jobs] of [
      ["READY_TO_SHIP", 0],
      ["PREORDER_OPENS", 1],
    ] as const) {
      const shop = await newShop(timing);
      const release = await newRelease(shop, 1, "UNANNOUNCED");
      const queue = fakeQueue();
      await moveRelease(db(), queue.env, shop, release.id, "announce");
      expect(queue.sent).toHaveLength(jobs);
      // Subscribers hear of the pre-order at once, whatever the order timing.
      expect(queue.emails.map((message) => message.body.shop)).toEqual([shop.shopDomain]);
    }
  });

  it("a redelivered job runs once", async () => {
    const shop = await newShop();
    const release = await newRelease(shop, 1);
    await newSubscriber(shop);
    const shopify = fakeShopify();
    const job = startJob(shop, release.id, `redeliver-${++n}`);
    const handlers = {
      [RELEASE_RUN_JOB]: async (body: Job) => {
        await runReleaseSlice(db(), env.DB, async () => shopify.graphql, body);
      },
    };
    for (let i = 0; i < 2; i++) {
      const batch = createMessageBatch<unknown>("release-subscriptions-jobs", [
        { id: `m-${++n}`, timestamp: new Date(), attempts: 1, body: job },
      ]);
      await consumeJobs(batch, env, handlers);
    }
    expect(shopify.orders).toHaveLength(1);
  });

  it("a second chain gives way while one holds the lease, working or sleeping", async () => {
    const shop = await newShop();
    const release = await newRelease(shop, 1);
    await newSubscriber(shop);
    await newSubscriber(shop);
    const clock = FAR();
    const shopify = fakeShopify({ limit: 1, clock: () => new Date(clock.now) });
    const run = (key: string, at: number) =>
      runReleaseSlice(
        db(),
        env.DB,
        async () => shopify.graphql,
        startJob(shop, release.id, key),
        () => new Date(at),
      );
    const sleeping = await run("a", clock.now);
    expect(sleeping?.delaySeconds).toBe(60);
    expect(await run("b", clock.now + 30_000)).toBeNull();
    expect(shopify.state.attempts).toBe(2);
  });

  it("a message arriving a moment early still gets the lease", async () => {
    const shop = await newShop();
    const release = await newRelease(shop, 1);
    await newSubscriber(shop);
    await newSubscriber(shop);
    const clock = FAR();
    const shopify = fakeShopify({ limit: 1, clock: () => new Date(clock.now) });
    const first = await runReleaseSlice(
      db(),
      env.DB,
      async () => shopify.graphql,
      startJob(shop, release.id),
      () => new Date(clock.now),
    );
    clock.now += 60_000;
    const second = await runReleaseSlice(
      db(),
      env.DB,
      async () => shopify.graphql,
      first!.job,
      // Two seconds before the 60 it was asked to wait.
      () => new Date(clock.now - 2000),
    );
    expect(second).toBeNull();
    expect(shopify.orders).toHaveLength(2);
  });
});

describe("throttling", () => {
  it("runs for more rounds than the queue has retries, losing no one and throwing nothing", async () => {
    const shop = await newShop();
    const release = await newRelease(shop, 1);
    const subscribers = await Promise.all(
      Array.from({ length: 40 }, () => newSubscriber(shop)),
    );
    const clock = FAR();
    const shopify = fakeShopify({ limit: 5, clock: () => new Date(clock.now) });
    const delays = await drain(shop, release.id, shopify, clock);
    expect(delays.filter((delay) => delay === 60).length).toBeGreaterThan(5);
    expect(shopify.orders).toHaveLength(40);
    for (const { id } of subscribers) expect(await remaining(id)).toBe(0);
    const rows = await deliveriesOf(release.id);
    expect(rows.every((row) => row.status === "ORDERED")).toBe(true);
    expect(rows.every((row) => row.orderError === null)).toBe(true);
  });

  it("backs off while nothing gets through, and resets when something does", async () => {
    const shop = await newShop();
    const release = await newRelease(shop, 1);
    await newSubscriber(shop);
    const shopify = fakeShopify({ errors: ["Too many attempts"] });
    const delays: number[] = [];
    let job = startJob(shop, release.id, "backoff");
    let at = FAR().now;
    for (let i = 0; i < 7; i++) {
      const moment = at;
      const next = await runReleaseSlice(
        db(),
        env.DB,
        async () => shopify.graphql,
        job,
        () => new Date(moment),
      );
      delays.push(next!.delaySeconds);
      job = next!.job;
      at += next!.delaySeconds * 1000;
    }
    expect(delays).toEqual([60, 120, 240, 480, 900, 900, 900]);
    const row = (await deliveriesOf(release.id))[0];
    expect(row.status).toBe("PENDING");
    expect(row.orderError).toBeNull();
  });

  it("treats a rate limit in Shopify's REST wording the same way", async () => {
    const shop = await newShop();
    const release = await newRelease(shop, 1);
    await newSubscriber(shop);
    const shopify = fakeShopify({
      errors: ["Exceeded order API rate limit, please try again in a minute."],
    });
    const next = await runReleaseSlice(
      db(),
      env.DB,
      async () => shopify.graphql,
      startJob(shop, release.id),
    );
    expect(next?.delaySeconds).toBe(60);
  });
});

describe("recovery: the tick finds work however the run ended", () => {
  const tick = (now: Date) => findReleaseRuns({ env, db: db(), now } as any);

  async function withSession(shop: TestShop) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO "OfflineSession" ("id", "data") VALUES (?1, '{}')`,
    )
      .bind(`offline_${shop.shopDomain}`)
      .run();
  }

  const jobFor = (jobs: Job[], releaseId: string) =>
    jobs.find((job) => job.data?.releaseId === releaseId);

  it("a crash after the flip, before anything was enqueued", async () => {
    const shop = await newShop();
    await withSession(shop);
    const release = await newRelease(shop, 1, "PREORDER");
    await newSubscriber(shop);
    const broken = {
      DB: env.DB,
      JOBS: { sendBatch: () => Promise.reject(new Error("queue down")) },
    } as any;
    const result = await moveRelease(db(), broken, shop, release.id, "ready");
    expect(result.ok).toBe(true);

    const shopify = fakeShopify();
    const job = jobFor(
      await tick(new Date("2027-01-01T10:00:00Z")),
      release.id,
    );
    await runReleaseSlice(db(), env.DB, async () => shopify.graphql, job!);
    expect(shopify.orders).toHaveLength(1);
  });

  it("a slice's message lost mid-chain: the next tick's slice takes over after the lease", async () => {
    const shop = await newShop();
    await withSession(shop);
    const release = await newRelease(shop, 1);
    await newSubscriber(shop);
    await newSubscriber(shop);
    const clock = FAR();
    const shopify = fakeShopify({ limit: 1, clock: () => new Date(clock.now) });
    const lost = await runReleaseSlice(
      db(),
      env.DB,
      async () => shopify.graphql,
      startJob(shop, release.id, "lost"),
      () => new Date(clock.now),
    );
    expect(lost).not.toBeNull();
    clock.now += 3600_000;
    const job = jobFor(await tick(new Date(clock.now)), release.id);
    const next = await runReleaseSlice(
      db(),
      env.DB,
      async () => shopify.graphql,
      job!,
      () => new Date(clock.now),
    );
    expect(next).toBeNull();
    expect(shopify.orders).toHaveLength(2);
  });

  it("a slice dying hard leaves the lease to lapse, and the next one runs", async () => {
    const shop = await newShop();
    const release = await newRelease(shop, 1);
    await newSubscriber(shop);
    const start = FAR().now;
    await db().release.update({
      where: { id: release.id },
      data: { runLeaseUntil: new Date(start + 15 * 60_000) },
    });
    const shopify = fakeShopify();
    const run = (at: number, key: string) =>
      runReleaseSlice(
        db(),
        env.DB,
        async () => shopify.graphql,
        startJob(shop, release.id, key),
        () => new Date(at),
      );
    await run(start + 60_000, "early");
    expect(shopify.orders).toHaveLength(0);
    await run(start + 16 * 60_000, "late");
    expect(shopify.orders).toHaveLength(1);
  });

  it("a slice failing on D1 lets go of the lease, so the queue's retry can run", async () => {
    const shop = await newShop();
    const release = await newRelease(shop, 1);
    await newSubscriber(shop);
    const failing = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare") {
          return () => {
            throw new Error("D1 down");
          };
        }
        const value = (target as any)[key];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const job = startJob(shop, release.id);
    await expect(
      runReleaseSlice(db(), failing, async () => fakeShopify().graphql, job),
    ).rejects.toThrow("D1 down");
    expect(
      (await db().release.findUniqueOrThrow({ where: { id: release.id } }))
        .runLeaseUntil,
    ).toBeNull();
  });

  it("a crash after Shopify made the order: the retry finds it and counts it once", async () => {
    const shop = await newShop();
    const release = await newRelease(shop, 1);
    const subscriber = await newSubscriber(shop);
    const crashing = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch") return () => Promise.reject(new Error("crash"));
        const value = (target as any)[key];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const clock = FAR();
    const shopify = fakeShopify();
    const retry = await runReleaseSlice(
      db(),
      crashing,
      async () => shopify.graphql,
      startJob(shop, release.id),
      () => new Date(clock.now),
    );
    // Held by the lease, and not lost: the chain comes back past it.
    expect(retry?.delaySeconds).toBe(360);
    expect(shopify.orders).toHaveLength(1);
    expect(await remaining(subscriber.id)).toBe(1);

    clock.now += 360_000;
    await runReleaseSlice(
      db(),
      env.DB,
      async () => shopify.graphql,
      retry!.job,
      () => new Date(clock.now),
    );
    expect(shopify.orders).toHaveLength(1);
    expect(await remaining(subscriber.id)).toBe(0);
    expect((await deliveriesOf(release.id))[0].status).toBe("ORDERED");
  });

  it("an order that keeps failing doesn't stop the others, and the chain stops trying", async () => {
    const shop = await newShop();
    const release = await newRelease(shop, 1);
    await newSubscriber(shop);
    await newSubscriber(shop);
    const shopify = fakeShopify();
    await createDueDeliveries(env.DB, shop.id, release.id);
    const [bad] = await deliveriesOf(release.id);
    const graphql: Graphql = async (query, variables: any) => {
      if (query.includes("OrderByMarker") && variables.query.includes(bad.id)) {
        throw new Error("Admin API returned errors");
      }
      return shopify.graphql(query, variables);
    };
    const clock = FAR();
    const delays = await drain(
      shop,
      release.id,
      { ...shopify, graphql },
      clock,
    );
    expect(shopify.orders).toHaveLength(1);
    // Three more passes past order leases, and then it's the tick's.
    expect(delays).toEqual([0, 360, 360, 360]);
    const rows = await deliveriesOf(release.id);
    expect(rows.filter((row) => row.status === "PENDING")).toHaveLength(1);
  });

  it("a DEAD job doesn't block anything: each hour's job has its own ID", async () => {
    const shop = await newShop();
    await withSession(shop);
    const release = await newRelease(shop, 1);
    const one = jobFor(
      await tick(new Date("2027-01-01T10:00:00Z")),
      release.id,
    );
    const two = jobFor(
      await tick(new Date("2027-01-01T11:00:00Z")),
      release.id,
    );
    expect(one!.id).not.toBe(two!.id);
    await env.DB.prepare(
      `INSERT INTO "JobRun" ("key", "type", "status", "updatedAt") VALUES (?1, ?2, 'DEAD', ?3)`,
    )
      .bind(one!.id, one!.type, new Date().toISOString())
      .run();
    await newSubscriber(shop);
    const shopify = fakeShopify();
    const batch = createMessageBatch<unknown>("release-subscriptions-jobs", [
      { id: `m-${++n}`, timestamp: new Date(), attempts: 1, body: two },
    ]);
    await consumeJobs(batch, env, {
      [RELEASE_RUN_JOB]: async (body: Job) => {
        await runReleaseSlice(db(), env.DB, async () => shopify.graphql, body);
      },
    });
    expect(shopify.orders).toHaveLength(1);
  });

  it("a subscriber whose webhook came after the run joins at the next tick", async () => {
    const shop = await newShop();
    await withSession(shop);
    const release = await newRelease(shop, 1);
    await newSubscriber(shop);
    const shopify = fakeShopify();
    await drain(shop, release.id, shopify, FAR());
    expect(shopify.orders).toHaveLength(1);

    await newSubscriber(shop);
    const job = jobFor(
      await tick(new Date("2027-01-01T12:00:00Z")),
      release.id,
    );
    await runReleaseSlice(db(), env.DB, async () => shopify.graphql, job!);
    expect(shopify.orders).toHaveLength(2);
  });

  it("a change of orderTiming during a pre-order: the tick starts the run", async () => {
    const shop = await newShop();
    await withSession(shop);
    const release = await newRelease(shop, 1, "PREORDER");
    await newSubscriber(shop);
    const now = new Date("2027-01-01T13:00:00Z");
    expect(jobFor(await tick(now), release.id)).toBeUndefined();

    await db().shop.update({
      where: { id: shop.id },
      data: { orderTiming: "PREORDER_OPENS" },
    });
    const job = jobFor(await tick(now), release.id);
    const shopify = fakeShopify();
    await runReleaseSlice(db(), env.DB, async () => shopify.graphql, job!);
    expect(shopify.orders).toHaveLength(1);
  });

  it("a shipped release takes no one new, but finishes what it holds", async () => {
    const shop = await newShop();
    await withSession(shop);
    const release = await newRelease(shop, 1, "SHIPPED");
    const now = new Date("2027-01-01T14:00:00Z");
    await newSubscriber(shop);
    expect(jobFor(await tick(now), release.id)).toBeUndefined();

    const held = await newSubscriber(shop);
    await assign(held.id, release.id);
    const job = jobFor(await tick(now), release.id);
    const shopify = fakeShopify();
    await runReleaseSlice(db(), env.DB, async () => shopify.graphql, job!);
    expect(shopify.orders).toHaveLength(1);
    expect(await deliveriesOf(release.id)).toHaveLength(1);
  });

  it("marking as shipped assigns anyone still due, so a dead run can't lose them", async () => {
    const shop = await newShop();
    const release = await newRelease(shop, 1, "READY");
    await newSubscriber(shop);
    const queue = fakeQueue();
    await moveRelease(db(), queue.env, shop, release.id, "ship");
    expect(await deliveriesOf(release.id)).toHaveLength(1);
    expect(queue.sent).toHaveLength(1);
    const shopify = fakeShopify();
    await runReleaseSlice(
      db(),
      env.DB,
      async () => shopify.graphql,
      queue.sent[0].body,
    );
    expect(shopify.orders).toHaveLength(1);
  });

  it("an uninstalled shop is left alone", async () => {
    const shop = await newShop();
    const release = await newRelease(shop, 1);
    expect(
      jobFor(await tick(new Date("2027-01-01T15:00:00Z")), release.id),
    ).toBeUndefined();
  });

  it("a slice with nothing to do never calls Shopify", async () => {
    const shop = await newShop();
    const release = await newRelease(shop, 1);
    let asked = 0;
    await runReleaseSlice(
      db(),
      env.DB,
      async () => {
        asked++;
        return fakeShopify().graphql;
      },
      startJob(shop, release.id),
    );
    expect(asked).toBe(0);
  });
});

describe("refusals", () => {
  it("are kept and not retried, while the rest of the run goes on", async () => {
    const shop = await newShop();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO "OfflineSession" ("id", "data") VALUES (?1, '{}')`,
    )
      .bind(`offline_${shop.shopDomain}`)
      .run();
    const release = await newRelease(shop, 1);
    await newSubscriber(shop);
    const refusing = fakeShopify({ errors: ["Customer is disabled"] });
    expect(await drain(shop, release.id, refusing, FAR())).toEqual([0]);
    expect(refusing.state.attempts).toBe(1);
    const [row] = await deliveriesOf(release.id);
    expect(row.orderError).toBe("Customer is disabled");

    // The tick's slice sees it and leaves it.
    await drain(shop, release.id, refusing, FAR());
    expect(refusing.state.attempts).toBe(1);
    expect(
      await listRunProgress(db(), shop.orderTiming, [
        { id: release.id, status: "READY" },
      ]),
    ).toEqual({
      [release.id]: {
        ordered: 0,
        waiting: 0,
        refused: 1,
        held: 0,
        error: "Customer is disabled",
      },
    });

    // Choosing the product again runs it.
    const queue = fakeQueue();
    await setReleaseProduct(
      db(),
      queue.env,
      shop,
      release.id,
      "gid://shopify/ProductVariant/1",
      "Z",
    );
    const shopify = fakeShopify();
    await runReleaseSlice(
      db(),
      env.DB,
      async () => shopify.graphql,
      queue.sent[0].body,
    );
    expect(shopify.orders).toHaveLength(1);
    expect((await deliveriesOf(release.id))[0].orderError).toBeNull();
  });
});

describe("no product", () => {
  it("a run with no product assigns everyone, and choosing one makes the orders", async () => {
    const shop = await newShop();
    const release = await newRelease(shop, 1, "PREORDER", { productGid: null });
    await newSubscriber(shop);
    await newSubscriber(shop);
    const queue = fakeQueue();
    await moveRelease(db(), queue.env, shop, release.id, "ready");
    const shopify = fakeShopify();
    expect(
      await runReleaseSlice(
        db(),
        env.DB,
        async () => shopify.graphql,
        queue.sent[0].body,
      ),
    ).toBeNull();
    expect(shopify.state.attempts).toBe(0);
    expect(await deliveriesOf(release.id)).toHaveLength(2);
    expect(
      await listRunProgress(db(), shop.orderTiming, [
        { id: release.id, status: "READY" },
      ]),
    ).toEqual({
      [release.id]: { ordered: 0, waiting: 2, refused: 0, held: 0, error: null },
    });

    await setReleaseProduct(
      db(),
      queue.env,
      shop,
      release.id,
      "gid://shopify/ProductVariant/9",
      "Zine",
    );
    await runReleaseSlice(
      db(),
      env.DB,
      async () => shopify.graphql,
      queue.sent[1].body,
    );
    expect(shopify.orders).toHaveLength(2);
  });
});

describe("cancel", () => {
  it("cancels PENDING Deliveries; the subscriber keeps their balance and joins the next run", async () => {
    const shop = await newShop();
    const first = await newRelease(shop, 1, "PREORDER");
    const second = await newRelease(shop, 2, "PREORDER");
    const subscriber = await newSubscriber(shop, { firstReleaseNumber: 1 });
    const delivery = await assign(subscriber.id, first.id);
    const queue = fakeQueue();
    const result = await moveRelease(db(), queue.env, shop, first.id, "cancel");
    expect(result.ok).toBe(true);
    expect(queue.sent).toHaveLength(0);
    expect(
      (await db().delivery.findUniqueOrThrow({ where: { id: delivery.id } }))
        .status,
    ).toBe("CANCELLED");
    expect(await remaining(subscriber.id)).toBe(1);

    await moveRelease(db(), queue.env, shop, second.id, "ready");
    const shopify = fakeShopify();
    await runReleaseSlice(
      db(),
      env.DB,
      async () => shopify.graphql,
      queue.sent[0].body,
    );
    expect(shopify.orders).toHaveLength(1);
    expect(await remaining(subscriber.id)).toBe(0);
  });

  it("is refused with orders, under PREORDER_OPENS, and nothing changes", async () => {
    const shop = await newShop("PREORDER_OPENS");
    const release = await newRelease(shop, 1, "PREORDER");
    const a = await newSubscriber(shop);
    const b = await newSubscriber(shop);
    const shopify = fakeShopify();
    const [da, db2] = [
      await assign(a.id, release.id),
      await assign(b.id, release.id),
    ];
    await createDeliveryOrder(db(), env.DB, shopify.graphql, da.id);
    const queue = fakeQueue();
    const result = await moveRelease(
      db(),
      queue.env,
      shop,
      release.id,
      "cancel",
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(
      /orders have been or are being created for this drop/,
    );
    expect(
      (await db().release.findUniqueOrThrow({ where: { id: release.id } }))
        .status,
    ).toBe("PREORDER");
    expect(
      (await db().delivery.findUniqueOrThrow({ where: { id: db2.id } })).status,
    ).toBe("PENDING");
  });

  it("is refused while a lease is held, even one left by a crash", async () => {
    const shop = await newShop("PREORDER_OPENS");
    const release = await newRelease(shop, 1, "PREORDER");
    const subscriber = await newSubscriber(shop);
    const delivery = await assign(subscriber.id, release.id);
    await db().delivery.update({
      where: { id: delivery.id },
      data: { orderLeaseUntil: new Date(Date.UTC(2000, 0, 1)) },
    });
    const result = await moveRelease(
      db(),
      fakeQueue().env,
      shop,
      release.id,
      "cancel",
    );
    expect(result.ok).toBe(false);
  });

  it("a job holding a stale read can't put an order on a cancelled release", async () => {
    const shop = await newShop("PREORDER_OPENS");
    const release = await newRelease(shop, 1, "PREORDER");
    const subscriber = await newSubscriber(shop);
    const delivery = await assign(subscriber.id, release.id);
    const shopify = fakeShopify();
    // Cancel lands between the job's read of the Delivery and its lease.
    const racing = createDb(env.DB);
    const original = racing.delivery.updateMany.bind(racing.delivery);
    let cancelled = false;
    (racing.delivery as any).updateMany = async (args: any) => {
      if (!cancelled) {
        cancelled = true;
        const result = await moveRelease(
          db(),
          fakeQueue().env,
          shop,
          release.id,
          "cancel",
        );
        expect(result.ok).toBe(true);
      }
      return original(args);
    };
    await expect(
      createDeliveryOrder(racing, env.DB, shopify.graphql, delivery.id),
    ).rejects.toThrow();
    expect(shopify.orders).toHaveLength(0);
    expect(await remaining(subscriber.id)).toBe(1);
    // The retry sees it for what it is.
    expect(
      await createDeliveryOrder(db(), env.DB, shopify.graphql, delivery.id),
    ).toBe("skipped");
  });

  it("a run's next slice stops at a cancelled release", async () => {
    const shop = await newShop();
    const release = await newRelease(shop, 1, "CANCELLED");
    const subscriber = await newSubscriber(shop);
    await assign(subscriber.id, release.id);
    const shopify = fakeShopify();
    expect(
      await runReleaseSlice(
        db(),
        env.DB,
        async () => shopify.graphql,
        startJob(shop, release.id),
      ),
    ).toBeNull();
    expect(shopify.state.attempts).toBe(0);
  });

  it("never touches another shop's release", async () => {
    const shop = await newShop();
    const other = await newShop();
    const release = await newRelease(other, 1, "PREORDER");
    const result = await moveRelease(
      db(),
      fakeQueue().env,
      shop,
      release.id,
      "cancel",
    );
    expect(result.ok).toBe(false);
    expect(
      (await db().release.findUniqueOrThrow({ where: { id: release.id } }))
        .status,
    ).toBe("PREORDER");
  });
});

describe("scheduled dates", () => {
  const at = (day: number, hour = 0) => new Date(Date.UTC(2027, 0, day, hour));
  const NOW = at(10);

  const finder = (now: Date) =>
    findScheduledSteps({ env, db: db(), now } as any);

  async function installed() {
    const shop = await newShop();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO "OfflineSession" ("id", "data") VALUES (?1, '{}')`,
    )
      .bind(`offline_${shop.shopDomain}`)
      .run();
    return shop;
  }

  const read = (id: string) =>
    db().release.findUniqueOrThrow({ where: { id } });

  const save = (
    shop: TestShop,
    id: string,
    fields: {
      mode?: "MANUAL" | "SCHEDULED";
      preorderOpensAt?: Date | null;
      cutoffAt?: Date | null;
    },
    now = NOW,
  ) =>
    scheduleRelease(
      db(),
      shop.id,
      id,
      "drop",
      {
        mode: fields.mode ?? "SCHEDULED",
        preorderOpensAt: fields.preorderOpensAt ?? null,
        cutoffAt: fields.cutoffAt ?? null,
      },
      now,
    );

  describe("the tick", () => {
    it("fires a due step and not a future one, and starts the run", async () => {
      const shop = await installed();
      const due = await newRelease(shop, 1, "UNANNOUNCED", {
        triggerMode: "SCHEDULED",
        preorderOpensAt: at(9),
        cutoffAt: at(20),
      });
      const future = await newRelease(shop, 2, "UNANNOUNCED", {
        triggerMode: "SCHEDULED",
        preorderOpensAt: at(11),
      });
      const jobs = await finder(NOW);
      const ids = jobs.map((job) => job.data?.releaseId);
      expect(ids).toContain(due.id);
      expect(ids).not.toContain(future.id);

      const queue = fakeQueue();
      await fireScheduledRelease(db(), queue.env, shop, due.id, NOW);
      const row = await read(due.id);
      expect(row.status).toBe("PREORDER");
      // Under ready to ship timing, opening a pre-order makes no orders.
      expect(queue.sent).toHaveLength(0);
      expect(row.cutoffAt).toEqual(at(20));
    });

    it("a manual release never fires from a date", async () => {
      const shop = await installed();
      const release = await newRelease(shop, 1, "PREORDER", {
        cutoffAt: at(1),
      });
      expect(
        (await finder(NOW)).map((job) => job.data?.releaseId),
      ).not.toContain(release.id);
      await fireScheduledRelease(db(), fakeQueue().env, shop, release.id, NOW);
      expect((await read(release.id)).status).toBe("PREORDER");
    });

    it("fires ready to ship through to a run", async () => {
      const shop = await installed();
      const release = await newRelease(shop, 1, "PREORDER", {
        triggerMode: "SCHEDULED",
        preorderOpensAt: at(1),
        cutoffAt: at(9),
      });
      await newSubscriber(shop);
      const queue = fakeQueue();
      await fireScheduledRelease(db(), queue.env, shop, release.id, NOW);
      expect(queue.sent).toHaveLength(1);
      const shopify = fakeShopify();
      await runReleaseSlice(
        db(),
        env.DB,
        async () => shopify.graphql,
        queue.sent[0].body,
      );
      expect(shopify.orders).toHaveLength(1);
    });

    it("both overdue at once: both fire in order, stamped with when they did", async () => {
      const shop = await installed();
      const release = await newRelease(shop, 1, "UNANNOUNCED", {
        triggerMode: "SCHEDULED",
        preorderOpensAt: at(1),
        cutoffAt: at(2),
      });
      const queue = fakeQueue();
      await fireScheduledRelease(db(), queue.env, shop, release.id, NOW);
      const row = await read(release.id);
      expect(row.status).toBe("READY");
      expect(row.preorderOpensAt).toEqual(NOW);
      expect(row.cutoffAt).toEqual(NOW);
      expect(queue.sent).toHaveLength(1);
    });

    it("fired late: the date becomes when it really happened", async () => {
      const shop = await installed();
      const release = await newRelease(shop, 1, "UNANNOUNCED", {
        triggerMode: "SCHEDULED",
        preorderOpensAt: at(9, 9),
      });
      await fireScheduledRelease(db(), fakeQueue().env, shop, release.id, NOW);
      expect((await read(release.id)).preorderOpensAt).toEqual(NOW);
    });

    it("pressed early: the date is when it was pressed, and the tick has nothing left", async () => {
      const shop = await installed();
      const release = await newRelease(shop, 1, "UNANNOUNCED", {
        triggerMode: "SCHEDULED",
        preorderOpensAt: at(20),
        cutoffAt: at(25),
      });
      await moveRelease(
        db(),
        fakeQueue().env,
        shop,
        release.id,
        "announce",
        NOW,
      );
      const row = await read(release.id);
      expect(row.preorderOpensAt).toEqual(NOW);
      expect(row.cutoffAt).toEqual(at(25));
      expect(
        (await finder(at(21))).map((job) => job.data?.releaseId),
      ).not.toContain(release.id);
    });

    it("a merchant moving the date while the job waited wins", async () => {
      const shop = await installed();
      const release = await newRelease(shop, 1, "UNANNOUNCED", {
        triggerMode: "SCHEDULED",
        preorderOpensAt: at(20),
      });
      const result = await moveRelease(
        db(),
        fakeQueue().env,
        shop,
        release.id,
        "announce",
        NOW,
        true,
      );
      expect(result.ok).toBe(false);
      expect((await read(release.id)).status).toBe("UNANNOUNCED");
    });

    it("another step's second firing changes nothing", async () => {
      const shop = await installed();
      const release = await newRelease(shop, 1, "UNANNOUNCED", {
        triggerMode: "SCHEDULED",
        preorderOpensAt: at(9),
      });
      const queue = fakeQueue();
      await fireScheduledRelease(db(), queue.env, shop, release.id, NOW);
      await fireScheduledRelease(db(), queue.env, shop, release.id, at(11));
      expect((await read(release.id)).preorderOpensAt).toEqual(NOW);
    });

    it("an uninstalled shop's dates wait", async () => {
      const shop = await newShop();
      const release = await newRelease(shop, 1, "UNANNOUNCED", {
        triggerMode: "SCHEDULED",
        preorderOpensAt: at(1),
      });
      expect(
        (await finder(NOW)).map((job) => job.data?.releaseId),
      ).not.toContain(release.id);
    });
  });

  describe("validating dates", () => {
    it("saves both future dates", async () => {
      const shop = await newShop();
      const { id } = await newRelease(shop, 1, "UNANNOUNCED");
      const result = await save(shop, id, {
        preorderOpensAt: at(20),
        cutoffAt: at(25),
      });
      expect(result.ok).toBe(true);
      expect(await read(id)).toMatchObject({
        triggerMode: "SCHEDULED",
        preorderOpensAt: at(20),
        cutoffAt: at(25),
      });
    });

    it("a pre-order date alone is fine: ready to ship stays a button", async () => {
      const shop = await newShop();
      const { id } = await newRelease(shop, 1, "UNANNOUNCED");
      expect((await save(shop, id, { preorderOpensAt: at(20) })).ok).toBe(true);
    });

    const refusals: [string, Record<string, Date | null>, RegExp][] = [
      [
        "ready before pre-order",
        { preorderOpensAt: at(25), cutoffAt: at(20) },
        /must be after/,
      ],
      [
        "ready at the pre-order",
        { preorderOpensAt: at(25), cutoffAt: at(25) },
        /must be after/,
      ],
      ["pre-order in the past", { preorderOpensAt: at(5) }, /has passed/],
      [
        "ready in the past",
        { preorderOpensAt: at(1), cutoffAt: at(5) },
        /has passed/,
      ],
      [
        "ready with no pre-order",
        { cutoffAt: at(25) },
        /needs a pre-order date/,
      ],
      ["no dates at all", {}, /Choose the date this drop's pre-order opens/],
    ];
    for (const [name, fields, message] of refusals) {
      it(`refuses ${name}, and changes nothing`, async () => {
        const shop = await newShop();
        const { id } = await newRelease(shop, 1, "UNANNOUNCED");
        const result = await save(shop, id, fields);
        expect(result.ok).toBe(false);
        expect(result.message).toMatch(message);
        expect((await read(id)).triggerMode).toBe("MANUAL");
      });
    }

    it("a date that passed while waiting for the tick can stay, and fires", async () => {
      const shop = await newShop();
      const { id } = await newRelease(shop, 1, "UNANNOUNCED", {
        triggerMode: "SCHEDULED",
        preorderOpensAt: at(9),
      });
      const result = await save(shop, id, {
        preorderOpensAt: at(9),
        cutoffAt: at(25),
      });
      expect(result.ok).toBe(true);
    });

    it("in a pre-order, only the ready date moves, and it must be set", async () => {
      const shop = await newShop();
      const { id } = await newRelease(shop, 1, "PREORDER", {
        preorderOpensAt: at(2),
      });
      expect((await save(shop, id, {})).message).toMatch(/ready to ship/);
      const result = await save(shop, id, {
        preorderOpensAt: at(30),
        cutoffAt: at(25),
      });
      expect(result.ok).toBe(true);
      expect(await read(id)).toMatchObject({
        preorderOpensAt: at(2),
        cutoffAt: at(25),
      });
    });

    it("a step that's happened can't be scheduled", async () => {
      const shop = await newShop();
      for (const status of ["READY", "SHIPPED", "CANCELLED"] as const) {
        const { id } = await newRelease(shop, ++n, status);
        expect((await save(shop, id, { cutoffAt: at(25) })).ok).toBe(false);
      }
    });

    it("going back to manual drops the plan and keeps what happened", async () => {
      const shop = await newShop();
      const planned = await newRelease(shop, 1, "UNANNOUNCED", {
        triggerMode: "SCHEDULED",
        preorderOpensAt: at(20),
        cutoffAt: at(25),
      });
      expect((await save(shop, planned.id, { mode: "MANUAL" })).ok).toBe(true);
      expect(await read(planned.id)).toMatchObject({
        triggerMode: "MANUAL",
        preorderOpensAt: null,
        cutoffAt: null,
      });
      const open = await newRelease(shop, 2, "PREORDER", {
        triggerMode: "SCHEDULED",
        preorderOpensAt: at(2),
        cutoffAt: at(25),
      });
      await save(shop, open.id, { mode: "MANUAL" });
      expect(await read(open.id)).toMatchObject({
        preorderOpensAt: at(2),
        cutoffAt: null,
      });
    });

    it("never touches another shop's release", async () => {
      const shop = await newShop();
      const other = await newShop();
      const { id } = await newRelease(other, 1, "UNANNOUNCED");
      expect((await save(shop, id, { preorderOpensAt: at(20) })).ok).toBe(
        false,
      );
    });
  });

  describe("start rules with future dates", () => {
    const rel = (
      number: number,
      status: ReleaseStatus,
      preorderOpensAt: Date | null = null,
      cutoffAt: Date | null = null,
    ) => ({ id: `r${number}`, number, status, preorderOpensAt, cutoffAt });
    const shipped = rel(1, "SHIPPED", at(1), at(2));
    // Planned for the future, or overdue with the tick yet to come: status decides either way.
    const planned = rel(2, "UNANNOUNCED", at(20), at(25));
    const overdue = rel(2, "UNANNOUNCED", at(9), at(9, 12));
    const opened = rel(2, "PREORDER", at(5), at(25));

    const table: [string, any[], any, any, any][] = [
      [
        "unannounced with future dates",
        [shipped, planned],
        ["r1", 1],
        [null, 2],
        [null, 2],
      ],
      [
        "unannounced with overdue dates",
        [shipped, overdue],
        ["r1", 1],
        [null, 2],
        [null, 2],
      ],
      [
        "in pre-order with a future ready date",
        [shipped, opened],
        ["r2", 2],
        ["r2", 2],
        [null, 3],
      ],
      ["only a planned release", [planned], [null, 1], [null, 1], [null, 1]],
    ];
    for (const [state, releases, switchover, current, next] of table) {
      for (const [rule, expected] of [
        ["PREORDER_SWITCHOVER", switchover],
        ["CURRENT_IF_BEFORE_CUTOFF", current],
        ["NEXT", next],
      ] as const) {
        it(`${rule}: ${state}`, () => {
          const result = pickFirstRelease(rule, releases, NOW);
          expect([
            result.release?.id ?? null,
            result.firstReleaseNumber,
          ]).toEqual(expected);
        });
      }
    }

    it("a tick firing late gives a late webhook the answer a prompt one got", () => {
      // The date was 09:00, the tick fired at 10:00, the customer signed up at 09:30.
      const signedUp = at(9, 9.5);
      const before = pickFirstRelease(
        "PREORDER_SWITCHOVER",
        [shipped, rel(2, "UNANNOUNCED", at(9, 9))],
        signedUp,
      );
      const after = pickFirstRelease(
        "PREORDER_SWITCHOVER",
        [shipped, rel(2, "PREORDER", at(9, 10))],
        signedUp,
      );
      expect(before.release?.id).toBe("r1");
      expect(after.release?.id).toBe("r1");
    });

    it("a NEXT subscriber waiting on a scheduled release joins its run", async () => {
      const shop = await newShop();
      const release = await newRelease(shop, 2, "READY", {
        preorderOpensAt: at(9),
        cutoffAt: at(9),
      });
      await newSubscriber(shop, { firstReleaseNumber: 2 });
      expect(await createDueDeliveries(env.DB, shop.id, release.id)).toBe(1);
    });
  });

  describe("the store's timezone", () => {
    const NY = "America/New_York";

    it("converts in both directions, either side of daylight saving", () => {
      expect(zonedToUtc("2027-01-15", 9, NY)).toEqual(
        new Date("2027-01-15T14:00:00Z"),
      );
      expect(zonedToUtc("2027-07-15", 9, NY)).toEqual(
        new Date("2027-07-15T13:00:00Z"),
      );
      expect(zonedFields(new Date("2027-07-15T13:00:00Z"), NY)).toEqual({
        date: "2027-07-15",
        hour: 9,
      });
      expect(zonedFields(new Date("2027-01-15T03:00:00Z"), NY)).toEqual({
        date: "2027-01-14",
        hour: 22,
      });
      expect(zonedToUtc("2027-01-15", 9, "Asia/Kolkata")).toEqual(
        new Date("2027-01-15T03:30:00Z"),
      );
    });

    it("an hour daylight saving skips or repeats still gives a real time", () => {
      const skipped = zonedToUtc("2027-03-14", 2, NY)!;
      expect(
        Math.abs(skipped.getTime() - Date.UTC(2027, 2, 14, 7)),
      ).toBeLessThanOrEqual(3600_000);
      const repeated = zonedToUtc("2027-11-07", 1, NY)!;
      expect(zonedFields(repeated, NY)).toEqual({
        date: "2027-11-07",
        hour: 1,
      });
    });

    it("refuses what isn't a date or an hour", () => {
      expect(zonedToUtc("2027-02-30", 9, NY)).toBeNull();
      expect(zonedToUtc("soon", 9, NY)).toBeNull();
      expect(zonedToUtc("2027-02-20", 24, NY)).toBeNull();
      expect(zonedToUtc("2027-02-20", Number.NaN, NY)).toBeNull();
    });

    it("shows dates on the store's clock", () => {
      expect(formatZoned(new Date("2027-01-15T14:00:00Z"), NY)).toMatch(
        /Jan 15, 2027.*9:00/,
      );
    });
  });
});

describe("listRunProgress", () => {
  it("counts each state, and shows nothing before the step", async () => {
    const shop = await newShop();
    const release = await newRelease(shop, 1);
    const early = await newRelease(shop, 2, "PREORDER");
    const [a, b, c, d] = await Promise.all(
      Array.from({ length: 4 }, () =>
        newSubscriber(shop, { releasesRemaining: 3 }),
      ),
    );
    await db().delivery.createMany({
      data: [
        { subscriptionId: a.id, releaseId: release.id, status: "ORDERED" },
        { subscriptionId: b.id, releaseId: release.id },
        { subscriptionId: c.id, releaseId: release.id, orderError: "No" },
        { subscriptionId: d.id, releaseId: release.id, status: "CANCELLED" },
        { subscriptionId: d.id, releaseId: early.id },
      ],
    });
    expect(
      await listRunProgress(db(), shop.orderTiming, [
        { id: release.id, status: "READY" },
        { id: early.id, status: "PREORDER" },
      ]),
    ).toEqual({
      [release.id]: { ordered: 1, waiting: 1, refused: 1, held: 0, error: "No" },
    });
  });
});

describe("the CSV", () => {
  const parse = (csv: string) =>
    csv
      .replace(/^\uFEFF/, "")
      .trim()
      .split("\r\n");

  it("neutralizes formulas, in every form a spreadsheet would run", () => {
    for (const bad of [
      "=1+1",
      "+1",
      "-1",
      "@SUM(A1)",
      "\t=1",
      "\r=1",
      " =1",
      "＝1",
      '=HYPERLINK("http://x","y")',
    ]) {
      const cell = csvCell(bad);
      expect(cell.replace(/^"/, "").startsWith("'")).toBe(true);
    }
    expect(csvCell("#1017")).toBe("#1017");
    expect(csvCell("https://x.myshopify.com/admin/orders/1")).toBe(
      "https://x.myshopify.com/admin/orders/1",
    );
    expect(csvCell(3)).toBe("3");
    expect(csvCell(null)).toBe("");
  });

  it("quotes what CSV needs quoted", () => {
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell('=a,"b"')).toBe(`"'=a,""b"""`);
  });

  it("holds what a merchant fulfilling by hand needs, in the merchant's word, and no personal data", async () => {
    const shop = await newShop();
    const release = await newRelease(shop, 7, "READY", {
      title: "=Spring, 2027",
    });
    await db().plan.update({
      where: { id: shop.planId },
      data: { name: "@Yearly" },
    });
    const ordered = await newSubscriber(shop);
    const waiting = await newSubscriber(shop);
    const redacted = await newSubscriber(shop);
    await db().subscription.update({
      where: { id: redacted.id },
      data: { customerGid: "redacted" },
    });
    await db().delivery.createMany({
      data: [
        {
          subscriptionId: ordered.id,
          releaseId: release.id,
          status: "ORDERED",
          orderGid: `gid://shopify/Order/${++n}`,
          orderName: "#1017",
        },
        {
          subscriptionId: waiting.id,
          releaseId: release.id,
          orderError: "-No address",
        },
        {
          subscriptionId: redacted.id,
          releaseId: release.id,
          status: "ORDERED",
          orderGid: `gid://shopify/Order/${++n}`,
          orderName: "#1018",
        },
      ],
    });
    const csv = await buildRunCsv(
      env.DB,
      { id: shop.id, shopDomain: shop.shopDomain, word: "drop" },
      release.id,
    );
    expect(csv!.startsWith("\uFEFF")).toBe(true);
    const lines = parse(csv!);
    expect(lines[0]).toBe(
      "Drop,Order,Order link,Status,Problem,Quantity,Plan,Customer link,Contract ID",
    );
    // Waiting first, then by order number.
    expect(lines[1]).toContain("Waiting for an order");
    expect(lines[1]).toContain("'-No address");
    expect(lines[2]).toContain(",#1017,");
    expect(lines[2]).toContain(`https://${shop.shopDomain}/admin/orders/`);
    expect(lines[2]).toContain(",'@Yearly,");
    expect(lines[2]).toContain("/admin/customers/");
    expect(lines[3]).toContain(",#1018,");
    expect(lines[3]).not.toContain("/admin/customers/");
    expect(lines[3]).not.toContain("redacted");
  });

  it("is another shop's release: nothing", async () => {
    const shop = await newShop();
    const other = await newShop();
    const release = await newRelease(other, 1);
    expect(
      await buildRunCsv(
        env.DB,
        { id: shop.id, shopDomain: shop.shopDomain, word: "drop" },
        release.id,
      ),
    ).toBeNull();
  });

  it("holds a run of 1,000 rows", async () => {
    const shop = await newShop();
    const release = await newRelease(shop, 1);
    const statements = Array.from({ length: 1000 }, (_, i) => {
      const id = `sub-${shop.id}-${i}`;
      return [
        env.DB.prepare(
          `INSERT INTO "Subscription" ("id", "shopId", "planId", "contractGid", "customerGid", "releasesRemaining", "updatedAt")
           VALUES (?1, ?2, ?3, ?4, 'gid://shopify/Customer/1', 1, ?5)`,
        ).bind(
          id,
          shop.id,
          shop.planId,
          `c-${shop.id}-${i}`,
          new Date().toISOString(),
        ),
      ];
    }).flat();
    for (let i = 0; i < statements.length; i += 100) {
      await env.DB.batch(statements.slice(i, i + 100));
    }
    // One statement assigns them all.
    expect(await createDueDeliveries(env.DB, shop.id, release.id)).toBe(1000);
    const csv = await buildRunCsv(
      env.DB,
      { id: shop.id, shopDomain: shop.shopDomain, word: "drop" },
      release.id,
    );
    expect(parse(csv!)).toHaveLength(1001);
  });
});

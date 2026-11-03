/* eslint-disable @typescript-eslint/no-explicit-any -- a fake of Shopify's loosely typed responses */
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../app/db.server";
import type { ReleaseStatus, StartRule } from "../app/generated/prisma/enums";
import { getOrCreateShop } from "../app/shop.server";
import {
  addMonths,
  CONTRACT_JOB,
  contractJob,
  findMissedContracts,
  orderStepReached,
  pickFirstRelease,
  MIXED_PLANS_EVENT,
  syncContract,
} from "../app/subscriptions.server";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const db = () => createDb(env.DB);
let n = 0;

const at = (day: number) => new Date(Date.UTC(2026, 0, day));

function release(
  number: number,
  status: ReleaseStatus,
  preorderOpensAt: Date | null = null,
  cutoffAt: Date | null = null,
) {
  return { id: `r${number}`, number, status, preorderOpensAt, cutoffAt };
}

const pick = (rule: StartRule, releases: ReturnType<typeof release>[], day = 20) =>
  pickFirstRelease(rule, releases, at(day));
const ids = (result: ReturnType<typeof pick>) => [
  result.release?.id ?? null,
  result.firstReleaseNumber,
];

const released = release(1, "SHIPPED", at(1), at(5));
const readied = release(1, "READY", at(1), at(5));
const preorder = release(2, "PREORDER", at(10));
const unannounced = release(3, "UNANNOUNCED");

describe("pickFirstRelease", () => {
  // [state, releases, SWITCHOVER, CURRENT, NEXT]: the expected [release, firstReleaseNumber].
  const table: [string, ReturnType<typeof release>[], any[], any[], any[]][] = [
    ["no releases", [], [null, 1], [null, 1], [null, 1]],
    [
      "only cancelled releases",
      [release(1, "CANCELLED", at(1))],
      [null, 1],
      [null, 1],
      [null, 1],
    ],
    [
      "only an unannounced release",
      [release(1, "UNANNOUNCED")],
      [null, 1],
      [null, 1],
      [null, 1],
    ],
    [
      "latest released, next unannounced",
      [released, release(2, "UNANNOUNCED")],
      ["r1", 1],
      [null, 2],
      [null, 2],
    ],
    ["latest ready to ship", [readied], ["r1", 1], [null, 2], [null, 2]],
    [
      "in pre-order",
      [released, preorder],
      ["r2", 2],
      ["r2", 2],
      [null, 3],
    ],
    [
      "in pre-order, later one unannounced",
      [released, preorder, unannounced],
      ["r2", 2],
      ["r2", 2],
      [null, 3],
    ],
    [
      "newest cancelled, falls back to the one before",
      [released, release(2, "CANCELLED", at(10))],
      ["r1", 1],
      [null, 2],
      [null, 2],
    ],
  ];
  for (const [state, releases, switchover, current, next] of table) {
    it(`PREORDER_SWITCHOVER: ${state}`, () => {
      expect(ids(pick("PREORDER_SWITCHOVER", releases))).toEqual(switchover);
    });
    it(`CURRENT_IF_BEFORE_CUTOFF: ${state}`, () => {
      expect(ids(pick("CURRENT_IF_BEFORE_CUTOFF", releases))).toEqual(current);
    });
    it(`NEXT: ${state}`, () => {
      expect(ids(pick("NEXT", releases))).toEqual(next);
    });
  }

  it("works on a release with no dates at all, going by status", () => {
    const undated = [release(1, "SHIPPED"), release(2, "PREORDER")];
    expect(ids(pick("PREORDER_SWITCHOVER", undated))).toEqual(["r2", 2]);
    expect(ids(pick("CURRENT_IF_BEFORE_CUTOFF", undated))).toEqual(["r2", 2]);
    expect(ids(pick("NEXT", undated))).toEqual([null, 3]);
  });

  it("ignores a scheduled date on a release that hasn't opened", () => {
    const scheduled = [released, release(2, "UNANNOUNCED", at(10), at(15))];
    expect(ids(pick("PREORDER_SWITCHOVER", scheduled))).toEqual(["r1", 1]);
  });

  describe("a webhook handled late goes by the sign-up time", () => {
    it("signed up before the announcement: still the released one", () => {
      expect(ids(pick("PREORDER_SWITCHOVER", [released, preorder], 8))).toEqual([
        "r1",
        1,
      ]);
    });

    it("signed up before the very first announcement: gets it once it has opened", () => {
      expect(ids(pick("PREORDER_SWITCHOVER", [preorder], 8))).toEqual(["r2", 2]);
    });

    it("signed up during a pre-order that has since gone ready", () => {
      const went = release(2, "READY", at(10), at(15));
      expect(ids(pick("CURRENT_IF_BEFORE_CUTOFF", [went], 12))).toEqual(["r2", 2]);
    });

    it("NEXT signed up before it opened: gets it, though it's open now", () => {
      expect(ids(pick("NEXT", [released, preorder], 8))).toEqual(["r2", 2]);
    });
  });
});

describe("orderStepReached", () => {
  const table: [ReleaseStatus, boolean, boolean][] = [
    ["UNANNOUNCED", false, false],
    ["PREORDER", false, true],
    ["READY", true, true],
    ["SHIPPED", true, true],
    ["CANCELLED", false, false],
  ];
  for (const [status, readyToShip, preorderOpens] of table) {
    it(`${status}`, () => {
      expect(orderStepReached(status, "READY_TO_SHIP")).toBe(readyToShip);
      expect(orderStepReached(status, "PREORDER_OPENS")).toBe(preorderOpens);
    });
  }
});

describe("addMonths", () => {
  it("adds calendar months", () => {
    expect(addMonths(new Date("2026-11-03T17:00:00Z"), 12).toISOString()).toBe(
      "2027-11-03T17:00:00.000Z",
    );
  });
  it("stays within a shorter month", () => {
    expect(addMonths(new Date("2027-01-31T00:00:00Z"), 1).toISOString()).toBe(
      "2027-02-28T00:00:00.000Z",
    );
  });
});

function contract(overrides: Record<string, unknown> = {}) {
  return {
    id: `gid://shopify/SubscriptionContract/${++n}`,
    status: "ACTIVE",
    createdAt: "2026-03-01T10:00:00Z",
    customer: { id: "gid://shopify/Customer/1" },
    originOrder: { id: `gid://shopify/Order/${++n}` },
    lines: {
      nodes: [
        {
          quantity: 1,
          sellingPlanId: "PLAN",
          currentPrice: { amount: "40.0" },
        },
      ],
    },
    ...overrides,
  };
}

async function setup(
  fields: Record<string, unknown> = {},
  orderTiming: "READY_TO_SHIP" | "PREORDER_OPENS" = "READY_TO_SHIP",
) {
  const domain = `subs${++n}.myshopify.com`;
  const shop = await getOrCreateShop(db(), domain);
  await db().shop.update({ where: { id: shop.id }, data: { orderTiming } });
  const sellingPlanGid = `gid://shopify/SellingPlan/${++n}`;
  const plan = await db().plan.create({
    data: {
      shopId: shop.id,
      name: "P",
      displayName: "P",
      priceCents: 4000,
      billingMode: "PREPAID_BUNDLE",
      releasesPerTerm: 2,
      termMonths: 12,
      sellingPlanGid,
      ...fields,
    },
  });
  return {
    shop: { ...shop, shopDomain: domain, orderTiming },
    plan,
    sellingPlanGid,
  };
}

const addRelease = (
  shopId: string,
  number: number,
  status: ReleaseStatus,
  dates: Record<string, Date> = {},
) =>
  db().release.create({
    data: { shopId, number, title: `R${number}`, status, ...dates },
  });

/** A contract's lines say PLAN until the test's own selling plan is known. */
const withPlan = (value: any, plan: string) => {
  value.lines.nodes.forEach((line: any) => {
    if (line.sellingPlanId === "PLAN") line.sellingPlanId = plan;
  });
  return value;
};

const shopifyWith = (read: any) => async () => ({ subscriptionContract: read });

const subscriptionFor = (contractGid: string) =>
  db().subscription.findUnique({
    where: { contractGid },
    include: { deliveries: true },
  });

describe("syncContract", () => {
  it("creates a bundle: remaining, term, price and source, before any order", async () => {
    const { shop, sellingPlanGid } = await setup();
    const read = withPlan(contract(), sellingPlanGid);
    await syncContract(db(), env.DB, shopifyWith(read), shop, read.id);
    const row = (await subscriptionFor(read.id))!;
    expect(row).toMatchObject({
      status: "ACTIVE",
      source: "NEW",
      quantity: 1,
      releasesRemaining: 2,
      lockedPriceCents: 4000,
      customerGid: "gid://shopify/Customer/1",
    });
    expect(row.termEndsAt?.toISOString()).toBe("2027-03-01T10:00:00.000Z");
  });

  it("creates a per-release plan: one paid release and no term", async () => {
    const { shop, sellingPlanGid } = await setup({
      billingMode: "PER_RELEASE",
      releasesPerTerm: 1,
      termMonths: null,
    });
    const read = withPlan(contract(), sellingPlanGid);
    await syncContract(db(), env.DB, shopifyWith(read), shop, read.id);
    const row = (await subscriptionFor(read.id))!;
    expect(row.releasesRemaining).toBe(1);
    expect(row.termEndsAt).toBeNull();
  });

  it("keeps a quantity of 2 as two copies, counting releases not copies", async () => {
    const { shop, sellingPlanGid } = await setup();
    const read = withPlan(
      contract({
        lines: {
          nodes: [
            { quantity: 2, sellingPlanId: "PLAN", currentPrice: { amount: "40.0" } },
          ],
        },
      }),
      sellingPlanGid,
    );
    await syncContract(db(), env.DB, shopifyWith(read), shop, read.id);
    expect(await subscriptionFor(read.id)).toMatchObject({
      quantity: 2,
      releasesRemaining: 2,
    });
  });

  it("adds up several lines of one plan", async () => {
    const { shop, sellingPlanGid } = await setup();
    const line = { quantity: 1, sellingPlanId: "PLAN", currentPrice: { amount: "40.0" } };
    const read = withPlan(
      contract({ lines: { nodes: [{ ...line }, { ...line, quantity: 2 }] } }),
      sellingPlanGid,
    );
    await syncContract(db(), env.DB, shopifyWith(read), shop, read.id);
    expect((await subscriptionFor(read.id))?.quantity).toBe(3);
  });

  it("holds a contract with two plans: no subscription, no jobs, one flag", async () => {
    const { shop, sellingPlanGid } = await setup();
    const other = await db().plan.create({
      data: {
        shopId: shop.id,
        name: "Q",
        displayName: "Q",
        priceCents: 1300,
        sellingPlanGid: `gid://shopify/SellingPlan/${++n}`,
      },
    });
    const line = { quantity: 1, currentPrice: { amount: "40.0" } };
    const read = contract({
      lines: {
        nodes: [
          { ...line, sellingPlanId: sellingPlanGid },
          { ...line, sellingPlanId: other.sellingPlanGid },
        ],
      },
    });
    for (let i = 0; i < 2; i++) {
      expect(
        await syncContract(db(), env.DB, shopifyWith(read), shop, read.id),
      ).toEqual([]);
    }
    expect(await subscriptionFor(read.id)).toBeNull();
    const flags = await db().event.findMany({
      where: { shopId: shop.id, type: MIXED_PLANS_EVENT },
    });
    expect(flags).toHaveLength(1);
    expect(flags[0].payload).toMatchObject({ orderGid: read.originOrder.id });
  });

  it("still creates a subscription on a plan turned off after the customer paid", async () => {
    const { shop, sellingPlanGid } = await setup({ active: false });
    const read = withPlan(contract(), sellingPlanGid);
    await syncContract(db(), env.DB, shopifyWith(read), shop, read.id);
    expect((await subscriptionFor(read.id))?.status).toBe("ACTIVE");
  });

  it("ignores a contract with no plan of this shop's, or one it can't read", async () => {
    const { shop } = await setup();
    const read = contract();
    expect(
      await syncContract(db(), env.DB, shopifyWith(read), shop, read.id),
    ).toEqual([]);
    expect(await subscriptionFor(read.id)).toBeNull();
    expect(
      await syncContract(db(), env.DB, shopifyWith(null), shop, "gid://x"),
    ).toEqual([]);
  });

  it("repeats change nothing, and return the same job IDs", async () => {
    const { shop, sellingPlanGid } = await setup();
    await addRelease(shop.id, 1, "SHIPPED");
    const read = withPlan(contract(), sellingPlanGid);
    const first = await syncContract(db(), env.DB, shopifyWith(read), shop, read.id);
    const second = await syncContract(db(), env.DB, shopifyWith(read), shop, read.id);
    expect(second.map((job) => job.id)).toEqual(first.map((job) => job.id));
    const rows = await db().subscription.findMany({
      where: { contractGid: read.id },
      include: { deliveries: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].deliveries).toHaveLength(1);
  });

  it("an update arriving before the create still creates it, once", async () => {
    const { shop, sellingPlanGid } = await setup();
    const read = withPlan(contract({ status: "CANCELLED" }), sellingPlanGid);
    await syncContract(db(), env.DB, shopifyWith(read), shop, read.id);
    expect((await subscriptionFor(read.id))?.status).toBe("CANCELLED");
    await syncContract(db(), env.DB, shopifyWith(read), shop, read.id);
    expect(
      await db().subscription.count({ where: { contractGid: read.id } }),
    ).toBe(1);
  });

  it("racing create jobs make one Subscription and one first release", async () => {
    const { shop, sellingPlanGid } = await setup();
    await addRelease(shop.id, 1, "SHIPPED");
    const read = withPlan(contract(), sellingPlanGid);
    await Promise.all(
      Array.from({ length: 5 }, () =>
        syncContract(db(), env.DB, shopifyWith(read), shop, read.id),
      ),
    );
    const rows = await db().subscription.findMany({
      where: { contractGid: read.id },
      include: { deliveries: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].deliveries).toHaveLength(1);
  });

  describe("status changes", () => {
    const after = async (
      current: "ACTIVE" | "PAUSED" | "CANCELLED" | "ENDED",
      contractStatus: string,
    ) => {
      const { shop, sellingPlanGid } = await setup();
      const read = withPlan(contract(), sellingPlanGid);
      await syncContract(db(), env.DB, shopifyWith(read), shop, read.id);
      await db().subscription.update({
        where: { contractGid: read.id },
        data: { status: current },
      });
      await syncContract(
        db(),
        env.DB,
        shopifyWith({ ...read, status: contractStatus }),
        shop,
        read.id,
      );
      return (await subscriptionFor(read.id))!;
    };

    it("cancelled contract: cancelled, keeping paid releases", async () => {
      const row = await after("ACTIVE", "CANCELLED");
      expect(row.status).toBe("CANCELLED");
      expect(row.releasesRemaining).toBe(2);
    });
    it("expired contract: cancelled", async () => {
      expect((await after("ACTIVE", "EXPIRED")).status).toBe("CANCELLED");
    });
    it("reactivated contract: active again", async () => {
      expect((await after("CANCELLED", "ACTIVE")).status).toBe("ACTIVE");
    });
    it("leaves pausing to Step 9", async () => {
      expect((await after("PAUSED", "ACTIVE")).status).toBe("PAUSED");
      expect((await after("ACTIVE", "PAUSED")).status).toBe("ACTIVE");
      expect((await after("ACTIVE", "FAILED")).status).toBe("ACTIVE");
    });
    it("never reopens an ended subscription", async () => {
      expect((await after("ENDED", "ACTIVE")).status).toBe("ENDED");
      expect((await after("ENDED", "CANCELLED")).status).toBe("ENDED");
    });
  });

  describe("the first order, against order timing", () => {
    const jobsFor = async (
      status: ReleaseStatus,
      timing: "READY_TO_SHIP" | "PREORDER_OPENS",
      dates: Record<string, Date> = {},
    ) => {
      const { shop, sellingPlanGid } = await setup({}, timing);
      await addRelease(shop.id, 1, status, dates);
      const read = withPlan(contract(), sellingPlanGid);
      const jobs = await syncContract(db(), env.DB, shopifyWith(read), shop, read.id);
      return {
        types: jobs.map((job) => job.type),
        row: (await subscriptionFor(read.id))!,
      };
    };

    it("released: a pending Delivery, its order queued, and the payment order", async () => {
      const { types, row } = await jobsFor("SHIPPED", "READY_TO_SHIP");
      expect(types).toEqual(["payment_order.fulfill", "delivery.order"]);
      expect(row.deliveries[0].status).toBe("PENDING");
      expect(row.releasesRemaining).toBe(2);
    });

    it("in pre-order, ready to ship timing: waits for the run", async () => {
      const { types, row } = await jobsFor("PREORDER", "READY_TO_SHIP");
      expect(types).toEqual(["payment_order.fulfill"]);
      expect(row.deliveries).toHaveLength(1);
      expect(row.deliveries[0].orderGid).toBeNull();
    });

    it("in pre-order, pre-order timing: the run may be over, so its order is queued", async () => {
      const { types } = await jobsFor("PREORDER", "PREORDER_OPENS");
      expect(types).toEqual(["payment_order.fulfill", "delivery.order"]);
    });

    it("a release going ready just as the sign-up lands gets its order queued", async () => {
      const { shop, sellingPlanGid } = await setup();
      const opened = await addRelease(shop.id, 1, "PREORDER");
      const read = withPlan(contract(), sellingPlanGid);
      // The release flips after the choice, before the check that follows the write.
      const graphql = async () => {
        await db().release.update({
          where: { id: opened.id },
          data: { status: "READY" },
        });
        return { subscriptionContract: read };
      };
      const jobs = await syncContract(db(), env.DB, graphql, shop, read.id);
      expect(jobs.map((job) => job.type)).toContain("delivery.order");
    });

    it("no release yet: no Delivery, and which run it joins is recorded", async () => {
      const { shop, sellingPlanGid } = await setup();
      const read = withPlan(contract(), sellingPlanGid);
      await syncContract(db(), env.DB, shopifyWith(read), shop, read.id);
      const row = (await subscriptionFor(read.id))!;
      expect(row.deliveries).toHaveLength(0);
      expect(row.firstReleaseNumber).toBe(1);
    });
  });

  it("a contract from no checkout has no payment order to mark", async () => {
    const { shop, sellingPlanGid } = await setup();
    const read = withPlan(contract({ originOrder: null }), sellingPlanGid);
    expect(
      await syncContract(db(), env.DB, shopifyWith(read), shop, read.id),
    ).toEqual([]);
  });
});

describe("findMissedContracts", () => {
  it("queues only contracts with no subscription, under the webhook's job ID", async () => {
    const { shop, sellingPlanGid } = await setup();
    const known = withPlan(contract(), sellingPlanGid);
    await syncContract(db(), env.DB, shopifyWith(known), shop, known.id);
    const graphql = async () => ({
      subscriptionContracts: {
        nodes: [
          { id: "gid://shopify/SubscriptionContract/missed", revisionId: "7" },
          { id: known.id, revisionId: "1" },
        ],
        pageInfo: { hasNextPage: true, endCursor: "next" },
      },
    });
    const jobs = await findMissedContracts(db(), graphql, shop.shopDomain);
    expect(jobs).toEqual([
      contractJob(shop.shopDomain, "gid://shopify/SubscriptionContract/missed", "7"),
    ]);
    expect(jobs[0].type).toBe(CONTRACT_JOB);
  });

  it("keeps reading while a whole page is unknown", async () => {
    const pages = [
      { nodes: [{ id: `missed-${++n}`, revisionId: "1" }], hasNextPage: true },
      { nodes: [{ id: `missed-${++n}`, revisionId: "1" }], hasNextPage: false },
    ];
    let read = 0;
    const graphql = async () => {
      const page = pages[read++];
      return {
        subscriptionContracts: {
          nodes: page.nodes,
          pageInfo: { hasNextPage: page.hasNextPage, endCursor: "c" },
        },
      };
    };
    expect(await findMissedContracts(db(), graphql, "s.myshopify.com")).toHaveLength(2);
    expect(read).toBe(2);
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any -- a fake of Shopify's loosely typed responses */
import { applyD1Migrations, createMessageBatch, env } from "cloudflare:test";
import type { ActionFunctionArgs } from "react-router";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BILLING_RESUME_JOB,
  DOUBLE_CHARGE_EVENT,
  findLostResults,
  findRenewals,
  findRetries,
  recordChargeback,
  recoverAttempt,
  renewalDue,
  resumeAfterCardUpdate,
  renewIfDue,
  retryCharge,
  retryDue,
  runResumeJob,
  settleAttempt,
  termChargeFor,
  worthRetrying,
} from "../app/billing.server";
import { createDb } from "../app/db.server";
import type {
  EmailStatus,
  OrderTiming,
  PriceChangePolicy,
  ReleaseStatus,
  RenewalRule,
  SubscriptionSource,
  SubscriptionStatus,
} from "../app/generated/prisma/enums";
import { redactCustomer } from "../app/gdpr.server";
import { billingAttemptKey } from "../app/jobs/idempotency.server";
import { consumeJobs, type Job } from "../app/jobs/runner.server";
import type { Graphql } from "../app/plan-sync.server";
import { parsePlan, updatePlan } from "../app/plans.server";
import { buildRunCsv } from "../app/release-csv.server";
import { createDeliveryOrder } from "../app/release-orders.server";
import {
  createDueDeliveries,
  findReleaseRuns,
  renewAfterOrder,
  runReleaseSlice,
} from "../app/release-runs.server";
import {
  listPaymentProblems,
  listRunProgress,
  moveRelease,
  releasesPageData,
} from "../app/releases.server";
import { action as disputeWebhook } from "../app/routes/webhooks.disputes";
import { action as billingWebhook } from "../app/routes/webhooks.subscription_billing_attempts";
import { getOrCreateShop } from "../app/shop.server";
import {
  addMonths,
  markCancelled,
  PAYMENT_ORDER_JOB,
  RELEASE_RUN_JOB,
  releaseRunJob,
  syncContract,
} from "../app/subscriptions.server";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const db = () => createDb(env.DB);
let n = 0;
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2027-06-01T12:00:00.000Z");
const days = (count: number, from = NOW) =>
  new Date(from.getTime() + count * DAY);

type Attempt = {
  id: string;
  key: string;
  contract: string;
  state: any;
  total: number;
  shipping: number;
  order: string | null;
};

/**
 * Shopify as it behaved on `newstand-dev`: a key it has seen returns its attempt and charges
 * nothing, a charge bills each line's price times its quantity plus the contract's delivery
 * price, and a result is only visible once the attempt finishes. `decline` is what the card does.
 */
function fakeShopify() {
  const contracts = new Map<string, any>();
  const attempts = new Map<string, Attempt>();
  const orders: any[] = [];
  const state = {
    decline: null as string | null,
    orderLimit: Infinity,
    ordersMade: 0,
    held: false, // attempts stay pending until `finish`
    throwAfterCharge: false,
    drafts: 0,
    creates: 0,
  };
  const finish = (attempt: Attempt) => {
    if (state.decline === "ACTION_REQUIRED") {
      attempt.state = { __typename: "SubscriptionBillingAttemptActionRequiredState" };
    } else if (state.decline) {
      attempt.state = {
        __typename: "SubscriptionBillingAttemptFailedState",
        error: { __typename: "x", code: state.decline },
      };
    } else {
      const contract = contracts.get(attempt.contract);
      attempt.shipping = Number(contract.deliveryPrice?.amount ?? 0);
      attempt.total =
        contract.lines.nodes.reduce(
          (sum: number, line: any) =>
            sum + Number(line.currentPrice.amount) * line.quantity,
          0,
        ) + attempt.shipping;
      attempt.order = `gid://shopify/Order/b${++n}`;
      attempt.state = {
        __typename: "SubscriptionBillingAttemptSuccessState",
        order: { id: attempt.order },
      };
    }
  };
  const graphql: Graphql = async (query, variables: any) => {
    if (query.includes("ContractForCharge")) {
      return { subscriptionContract: contracts.get(variables.id) ?? null };
    }
    if (query.includes("BillingAttemptCreate")) {
      state.creates++;
      const key = variables.input.idempotencyKey;
      expect(variables.input.originTime).toBeUndefined();
      let attempt = attempts.get(key);
      if (!attempt) {
        attempt = {
          id: `gid://shopify/SubscriptionBillingAttempt/${++n}`,
          key,
          contract: variables.contract,
          state: { __typename: "SubscriptionBillingAttemptPendingState" },
          total: 0,
          shipping: 0,
          order: null,
        };
        attempts.set(key, attempt);
        if (!state.held) finish(attempt);
      }
      if (state.throwAfterCharge) {
        state.throwAfterCharge = false;
        throw new Error("The response never came");
      }
      return {
        subscriptionBillingAttemptCreate: {
          subscriptionBillingAttempt: { id: attempt.id, state: attempt.state },
          userErrors: [],
        },
      };
    }
    if (query.includes("BillingAttemptResult")) {
      const attempt = [...attempts.values()].find((a) => a.id === variables.id);
      return {
        subscriptionBillingAttempt: attempt && {
          id: attempt.id,
          idempotencyKey: attempt.key,
          completedAt: NOW.toISOString(),
          state: attempt.state,
        },
      };
    }
    if (query.includes("AttemptsOnContract")) {
      return {
        subscriptionContract: {
          billingAttempts: {
            nodes: [...attempts.values()]
              .filter((a) => a.contract === variables.id)
              .map((a) => ({ id: a.id, idempotencyKey: a.key })),
          },
        },
      };
    }
    if (query.includes("PriceDraftOpen")) {
      state.drafts++;
      return {
        subscriptionContractUpdate: {
          draft: { id: variables.contract },
          userErrors: [],
        },
      };
    }
    if (query.includes("PriceDraftLine")) {
      const line = contracts
        .get(variables.draft)
        .lines.nodes.find((l: any) => l.id === variables.line);
      line.currentPrice.amount = variables.input.currentPrice;
      return { subscriptionDraftLineUpdate: { userErrors: [] } };
    }
    if (query.includes("PriceDraftCommit")) {
      return {
        subscriptionDraftCommit: { contract: { id: variables.draft }, userErrors: [] },
      };
    }
    if (query.includes("DisputedOrder")) {
      const attempt = [...attempts.values()].find((a) => a.order === variables.id);
      return {
        order: attempt && {
          lineItems: { nodes: [{ contract: { id: attempt.contract } }] },
        },
      };
    }
    if (query.includes("OrderByMarker")) {
      const marker = /source_identifier:'(.+)'/.exec(variables.query)![1];
      return {
        orders: { nodes: orders.filter((o) => o.sourceIdentifier === marker) },
      };
    }
    if (query.includes("ContractForOrder")) {
      return {
        shop: { currencyCode: "USD" },
        productVariant: { inventoryItem: { requiresShipping: true } },
        subscriptionContract: {
          deliveryMethod: { address: { address1: "1 Test St" } },
        },
      };
    }
    if (query.includes("ReleaseOrderCreate")) {
      if (state.ordersMade >= state.orderLimit) {
        return {
          orderCreate: {
            order: null,
            userErrors: [{ message: "Too many attempts. Please try again later." }],
          },
        };
      }
      state.ordersMade++;
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
  const charges = () =>
    [...attempts.values()].filter(
      (a) => a.state.__typename === "SubscriptionBillingAttemptSuccessState",
    );
  return { graphql, contracts, attempts, orders, state, finish, charges };
}

type Shopify = ReturnType<typeof fakeShopify>;

async function newShop(orderTiming: OrderTiming = "READY_TO_SHIP") {
  const shopDomain = `billing${++n}.myshopify.com`;
  const shop = await getOrCreateShop(db(), shopDomain);
  await db().shop.update({ where: { id: shop.id }, data: { orderTiming } });
  return {
    ...shop,
    orderTiming,
    shopDomain,
    releaseWordSingular: "drop",
    word: "drop",
  };
}
type TestShop = Awaited<ReturnType<typeof newShop>>;

const SELLING_PLAN = "gid://shopify/SellingPlan/1";

const newPlan = (
  shop: TestShop,
  fields: {
    billingMode?: "PER_RELEASE" | "PREPAID_BUNDLE";
    renewalRule?: RenewalRule;
    autoRenew?: boolean;
    releasesPerTerm?: number;
    termMonths?: number | null;
  } = {},
) =>
  db().plan.create({
    data: {
      shopId: shop.id,
      name: "Plan",
      displayName: "Plan",
      priceCents: 4000,
      billingMode: "PREPAID_BUNDLE",
      releasesPerTerm: 2,
      termMonths: 12,
      sellingPlanGid: `${SELLING_PLAN}${++n}`,
      ...fields,
    },
  });

async function newSubscriber(
  shop: TestShop,
  shopify: Shopify,
  plan: { id: string; sellingPlanGid: string | null },
  fields: {
    releasesRemaining?: number;
    termEndsAt?: Date | null;
    status?: SubscriptionStatus;
    source?: SubscriptionSource;
    firstReleaseNumber?: number;
    quantity?: number;
    createdAt?: Date;
    lockedPriceCents?: number;
    deliveryPrice?: string;
    contractStatus?: string;
  } = {},
) {
  const { deliveryPrice = "0.0", contractStatus = "ACTIVE", ...row } = fields;
  const contractGid = `gid://shopify/SubscriptionContract/${++n}`;
  shopify.contracts.set(contractGid, {
    status: contractStatus,
    deliveryPrice: { amount: deliveryPrice },
    deliveryMethod: { address: { address1: "1 Test St" } },
    lines: {
      nodes: [
        {
          id: `line-${n}`,
          sellingPlanId: plan.sellingPlanGid,
          quantity: fields.quantity ?? 1,
          currentPrice: { amount: "40.0" },
        },
      ],
    },
  });
  return db().subscription.create({
    data: {
      shopId: (await db().plan.findUniqueOrThrow({
        where: { id: plan.id },
        select: { shopId: true },
      })).shopId,
      planId: plan.id,
      contractGid,
      customerGid: `gid://shopify/Customer/${n}`,
      releasesRemaining: 0,
      lockedPriceCents: 4000,
      ...row,
    },
  });
}

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

const row = (id: string) =>
  db().subscription.findUniqueOrThrow({ where: { id } });
const deliveryOf = (subscriptionId: string, releaseId: string) =>
  db().delivery.findUnique({
    where: { subscriptionId_releaseId: { subscriptionId, releaseId } },
  });
const attemptsOf = (subscriptionId: string) =>
  db().billingAttempt.findMany({
    where: { subscriptionId },
    orderBy: { attempt: "asc" },
  });

const slice = (
  shop: TestShop,
  shopify: Shopify,
  releaseId: string,
  at: Date = NOW,
  key = `s${++n}`,
) =>
  runReleaseSlice(
    db(),
    env.DB,
    async () => shopify.graphql,
    releaseRunJob(shop.shopDomain, releaseId, key),
    () => at,
  );

/** A run to its end, on a clock that follows each delay. Releases its lease as it goes. */
async function drain(
  shop: TestShop,
  shopify: Shopify,
  releaseId: string,
  at: Date = NOW,
  afterSlice: () => Promise<void> = async () => {},
) {
  let time = at.getTime();
  let next = await slice(shop, shopify, releaseId, new Date(time));
  for (let i = 0; next && i < 200; i++) {
    await afterSlice();
    time += next.delaySeconds * 1000;
    next = await runReleaseSlice(
      db(),
      env.DB,
      async () => shopify.graphql,
      next.job,
      () => new Date(time),
    );
  }
  expect(next).toBeNull();
}

/** Every attempt's webhook, as Shopify would send it. */
async function deliverWebhooks(shopify: Shopify, at: Date = NOW) {
  const jobs: Job[] = [];
  for (const attempt of shopify.attempts.values()) {
    jobs.push(
      ...(await settleAttempt(db(), env.DB, shopify.graphql, attempt.id, at)),
    );
  }
  return jobs;
}

/** What the finders need to see a shop as installed. */
async function install(shop: TestShop) {
  await env.DB.prepare(
    `INSERT INTO "OfflineSession" ("id", "data") VALUES (?1, '[]') ON CONFLICT DO NOTHING`,
  )
    .bind(`offline_${shop.shopDomain}`)
    .run();
}

const finderContext = (now: Date) =>
  ({ env, db: db(), now }) as Parameters<typeof findRenewals>[0];

const jobsFor = (jobs: Job[], subscriptionId: string) =>
  jobs.filter((job) => job.data?.subscriptionId === subscriptionId);

describe("a per-release charge lands with its order", () => {
  it("charges at the order step, then the webhook's slice makes the order, once", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, {
      billingMode: "PER_RELEASE",
      releasesPerTerm: 1,
      termMonths: null,
    });
    const subscriber = await newSubscriber(shop, shopify, plan);
    const release = await newRelease(shop, 1);

    await slice(shop, shopify, release.id);
    expect(shopify.charges()).toHaveLength(1);
    expect(shopify.orders).toHaveLength(0);
    expect((await deliveryOf(subscriber.id, release.id))?.status).toBe("PENDING");

    const [attempt] = await attemptsOf(subscriber.id);
    expect(attempt.idempotencyKey).toBe(
      billingAttemptKey(subscriber.id, release.id, 1),
    );
    expect(attempt.result).toBe("PENDING");

    const jobs = await deliverWebhooks(shopify);
    expect((await row(subscriber.id)).releasesRemaining).toBe(1);
    expect(jobs.map((job) => job.type)).toEqual([PAYMENT_ORDER_JOB, RELEASE_RUN_JOB]);

    await db().release.update({ where: { id: release.id }, data: { runLeaseUntil: null } });
    await slice(shop, shopify, release.id);
    expect(shopify.orders).toHaveLength(1);
    expect((await row(subscriber.id)).releasesRemaining).toBe(0);
    const delivery = await deliveryOf(subscriber.id, release.id);
    expect(delivery?.status).toBe("ORDERED");
    expect(shopify.charges()).toHaveLength(1);
    expect((await attemptsOf(subscriber.id))[0]).toMatchObject({
      result: "SUCCEEDED",
      orderGid: shopify.charges()[0].order,
    });
  });

  it("doesn't charge before the step, and follows PREORDER_OPENS when the shop chooses it", async () => {
    const later = await newShop();
    const laterShopify = fakeShopify();
    const laterPlan = await newPlan(later, {
      billingMode: "PER_RELEASE",
      releasesPerTerm: 1,
      termMonths: null,
    });
    await newSubscriber(later, laterShopify, laterPlan);
    const preorder = await newRelease(later, 1, "PREORDER");
    await slice(later, laterShopify, preorder.id);
    expect(laterShopify.attempts.size).toBe(0);

    const early = await newShop("PREORDER_OPENS");
    const earlyShopify = fakeShopify();
    const earlyPlan = await newPlan(early, {
      billingMode: "PER_RELEASE",
      releasesPerTerm: 1,
      termMonths: null,
    });
    await newSubscriber(early, earlyShopify, earlyPlan);
    const opened = await newRelease(early, 1, "PREORDER");
    await slice(early, earlyShopify, opened.id);
    expect(earlyShopify.attempts.size).toBe(1);
  });

  it("no product means no charge, because the order couldn't follow", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, {
      billingMode: "PER_RELEASE",
      releasesPerTerm: 1,
      termMonths: null,
    });
    await newSubscriber(shop, shopify, plan);
    const release = await newRelease(shop, 1, "READY", { productGid: null });
    await slice(shop, shopify, release.id);
    expect(shopify.attempts.size).toBe(0);
  });

  it("a subscriber with a paid first release isn't charged for it", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, {
      billingMode: "PER_RELEASE",
      releasesPerTerm: 1,
      termMonths: null,
    });
    const subscriber = await newSubscriber(shop, shopify, plan, {
      releasesRemaining: 1,
    });
    const release = await newRelease(shop, 1);
    await drain(shop, shopify, release.id);
    expect(shopify.attempts.size).toBe(0);
    expect(shopify.orders).toHaveLength(1);
    expect((await row(subscriber.id)).releasesRemaining).toBe(0);
  });

  it("a run leaves out cancelled, paused and ended subscribers, gifts and manual renewal", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, {
      billingMode: "PER_RELEASE",
      releasesPerTerm: 1,
      termMonths: null,
    });
    const manual = await newPlan(shop, {
      billingMode: "PER_RELEASE",
      releasesPerTerm: 1,
      termMonths: null,
      autoRenew: false,
    });
    for (const status of ["CANCELLED", "PAUSED", "ENDED"] as const) {
      await newSubscriber(shop, shopify, plan, { status });
    }
    await newSubscriber(shop, shopify, plan, { source: "GIFT" });
    await newSubscriber(shop, shopify, manual);
    const release = await newRelease(shop, 1);
    await drain(shop, shopify, release.id);
    expect(shopify.attempts.size).toBe(0);
    expect(shopify.orders).toHaveLength(0);
    expect(await db().delivery.count({ where: { releaseId: release.id } })).toBe(0);
  });

  it("a duplicate webhook and a re-sent job don't charge or count twice", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, {
      billingMode: "PER_RELEASE",
      releasesPerTerm: 1,
      termMonths: null,
    });
    const subscriber = await newSubscriber(shop, shopify, plan);
    const release = await newRelease(shop, 1);
    await slice(shop, shopify, release.id);
    const first = await deliverWebhooks(shopify);
    const again = await deliverWebhooks(shopify);
    // A repeat asks for the same follow-ups under the same IDs, so they run once.
    expect(again.map((job) => job.id)).toEqual(first.map((job) => job.id));
    expect((await row(subscriber.id)).releasesRemaining).toBe(1);

    await db().release.update({ where: { id: release.id }, data: { runLeaseUntil: null } });
    await slice(shop, shopify, release.id);
    await db().release.update({ where: { id: release.id }, data: { runLeaseUntil: null } });
    await slice(shop, shopify, release.id);
    await deliverWebhooks(shopify);
    expect(shopify.attempts.size).toBe(1);
    expect(shopify.charges()).toHaveLength(1);
    expect(shopify.orders).toHaveLength(1);
    expect((await row(subscriber.id)).releasesRemaining).toBe(0);
  });

  it("a slow store never charges far ahead of its orders, and a throttled order never re-charges", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, {
      billingMode: "PER_RELEASE",
      releasesPerTerm: 1,
      termMonths: null,
    });
    const subscribers = 45;
    for (let i = 0; i < subscribers; i++) {
      await newSubscriber(shop, shopify, plan);
    }
    const release = await newRelease(shop, 1);
    shopify.state.orderLimit = 5;

    let most = 0;
    await drain(shop, shopify, release.id, NOW, async () => {
      most = Math.max(most, shopify.charges().length - shopify.orders.length);
      await deliverWebhooks(shopify);
      // The store's limit opens a little each time the chain comes round.
      shopify.state.orderLimit = shopify.orders.length + 5;
    });
    await deliverWebhooks(shopify);
    expect(most).toBeLessThanOrEqual(20);
    expect(shopify.charges()).toHaveLength(subscribers);
    expect(shopify.orders).toHaveLength(subscribers);
    expect(new Set(shopify.charges().map((c) => c.contract)).size).toBe(subscribers);
  }, 60_000);
});

describe("bundle renewals", () => {
  describe("the rule, per renewal setting", () => {
    const plan = (renewalRule: RenewalRule, autoRenew = true) => ({
      billingMode: "PREPAID_BUNDLE",
      autoRenew,
      renewalRule,
    });
    const subscription = (fields: Record<string, unknown> = {}) => ({
      status: "ACTIVE",
      source: "NEW",
      contractGid: "gid://x",
      termEndsAt: days(-1),
      releasesRemaining: 0,
      paymentProblemSince: null,
      ...fields,
    });
    const before = { termEndsAt: days(1) };
    const table: [RenewalRule, Record<string, unknown>, boolean][] = [
      ["TERM_DATE_HOLD_IF_LATE", {}, true],
      ["TERM_DATE_HOLD_IF_LATE", { releasesRemaining: 1 }, false],
      ["TERM_DATE_HOLD_IF_LATE", before, false],
      ["TERM_DATE", {}, true],
      ["TERM_DATE", { releasesRemaining: 1 }, true],
      ["TERM_DATE", before, false],
      ["ON_DEPLETION", {}, true],
      ["ON_DEPLETION", before, true],
      ["ON_DEPLETION", { releasesRemaining: 1 }, false],
    ];
    for (const [rule, fields, due] of table) {
      it(`${rule} ${JSON.stringify(fields)}: ${due}`, () => {
        expect(renewalDue(subscription(fields) as any, plan(rule), NOW)).toBe(due);
      });
    }
    for (const fields of [
      { status: "CANCELLED" },
      { status: "ENDED" },
      { status: "PAUSED" },
      { source: "GIFT" },
      { contractGid: null },
      { termEndsAt: null },
      { paymentProblemSince: days(-3) },
    ]) {
      it(`never: ${JSON.stringify(fields)}`, () => {
        for (const rule of ["TERM_DATE_HOLD_IF_LATE", "TERM_DATE", "ON_DEPLETION"] as const) {
          expect(renewalDue(subscription(fields) as any, plan(rule), NOW)).toBe(false);
        }
      });
    }
    it("never with auto-renew off", () => {
      expect(
        renewalDue(subscription() as any, plan("TERM_DATE", false), NOW),
      ).toBe(false);
    });
  });

  it("the late hold: the renewal is charged when the last paid release's order is created", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop);
    const subscriber = await newSubscriber(shop, shopify, plan, {
      releasesRemaining: 1,
      termEndsAt: days(-40),
    });
    const release = await newRelease(shop, 5, "PREORDER");

    // The term date has long passed, but the last paid release has no order yet.
    expect((await findRenewals(finderContext(NOW))).length).toBe(0);
    await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
    expect(shopify.attempts.size).toBe(0);

    await db().release.update({ where: { id: release.id }, data: { status: "READY" } });
    await drain(shop, shopify, release.id);
    expect(shopify.orders).toHaveLength(1);
    expect(shopify.charges()).toHaveLength(1);
    expect([...shopify.attempts.keys()]).toEqual([
      billingAttemptKey(subscriber.id, termChargeFor(days(-40)), 1),
    ]);

    await deliverWebhooks(shopify);
    const renewed = await row(subscriber.id);
    expect(renewed.releasesRemaining).toBe(2);
    // Held, so the new term runs from when it was paid, not from the old date.
    expect(renewed.termEndsAt?.toISOString()).toBe(addMonths(NOW, 12).toISOString());
  });

  it("the sign-up path's order triggers it too", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop);
    const subscriber = await newSubscriber(shop, shopify, plan, {
      releasesRemaining: 1,
      termEndsAt: days(-1),
    });
    const release = await newRelease(shop, 1);
    const delivery = await db().delivery.create({
      data: { subscriptionId: subscriber.id, releaseId: release.id },
    });
    expect(
      await createDeliveryOrder(db(), env.DB, shopify.graphql, delivery.id, NOW),
    ).toBe("created");
    await renewAfterOrder(db(), env.DB, shopify.graphql, delivery.id, NOW);
    expect(shopify.charges()).toHaveLength(1);
  });

  it("TERM_DATE: renews on the date with releases still left, and from the old date when on time", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, { renewalRule: "TERM_DATE" });
    const end = new Date(NOW.getTime() + 60_000);
    const subscriber = await newSubscriber(shop, shopify, plan, {
      releasesRemaining: 1,
      termEndsAt: end,
    });
    await install(shop);
    expect(jobsFor(await findRenewals(finderContext(NOW)), subscriber.id)).toHaveLength(0);
    const due = jobsFor(await findRenewals(finderContext(end)), subscriber.id);
    expect(due).toHaveLength(1);

    await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, end);
    // Attempted just before the date's end in this fake's clock: the later of the two is the term.
    await deliverWebhooks(shopify, end);
    const renewed = await row(subscriber.id);
    expect(renewed.releasesRemaining).toBe(3);
    expect(renewed.termEndsAt?.toISOString()).toBe(addMonths(end, 12).toISOString());
    // A term renews once: the next due date is a year on, and nothing is due now.
    expect(jobsFor(await findRenewals(finderContext(end)), subscriber.id)).toHaveLength(0);
    await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, end);
    expect(shopify.charges()).toHaveLength(1);
  });

  it("ON_DEPLETION: renews after the last paid order, whatever the date", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, { renewalRule: "ON_DEPLETION" });
    const subscriber = await newSubscriber(shop, shopify, plan, {
      releasesRemaining: 1,
      termEndsAt: days(300),
    });
    const release = await newRelease(shop, 1);
    await drain(shop, shopify, release.id);
    expect(shopify.charges()).toHaveLength(1);
    await deliverWebhooks(shopify);
    expect((await row(subscriber.id)).releasesRemaining).toBe(2);
    await install(shop);
    expect(jobsFor(await findRenewals(finderContext(NOW)), subscriber.id)).toHaveLength(0);
  });

  it("a bundle of one can't choose ON_DEPLETION, which would charge again right after sign-up", () => {
    const form = new FormData();
    for (const [key, value] of Object.entries({
      name: "One",
      displayName: "One",
      billingMode: "PREPAID_BUNDLE",
      releasesPerTerm: "1",
      termMonths: "12",
      renewalRule: "ON_DEPLETION",
      startRule: "NEXT",
      price: "10",
      productGid: "gid://shopify/Product/1",
    })) {
      form.set(key, value);
    }
    const one = parsePlan(form);
    expect(one.ok).toBe(false);
    form.set("releasesPerTerm", "2");
    expect(parsePlan(form).ok).toBe(true);
  });

  it("respects auto-renew, and never renews cancelled, ended or gift subscriptions", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, { renewalRule: "TERM_DATE" });
    const manual = await newPlan(shop, { renewalRule: "TERM_DATE", autoRenew: false });
    const noRenew = [
      await newSubscriber(shop, shopify, manual, { termEndsAt: days(-1) }),
      await newSubscriber(shop, shopify, plan, { termEndsAt: days(-1), status: "CANCELLED" }),
      await newSubscriber(shop, shopify, plan, { termEndsAt: days(-1), status: "ENDED" }),
      await newSubscriber(shop, shopify, plan, { termEndsAt: days(-1), source: "GIFT" }),
    ];
    await install(shop);
    const found = await findRenewals(finderContext(NOW));
    for (const subscriber of noRenew) {
      expect(jobsFor(found, subscriber.id)).toHaveLength(0);
      await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
    }
    expect(shopify.attempts.size).toBe(0);
  });
});

describe("reach-back", () => {
  async function atZero(rule: RenewalRule = "TERM_DATE_HOLD_IF_LATE") {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, { renewalRule: rule });
    const subscriber = await newSubscriber(shop, shopify, plan, {
      termEndsAt: days(-1),
    });
    return { shop, shopify, plan, subscriber };
  }

  it("an extra release before the renewal isn't included, however long it stays open", async () => {
    const { shop, shopify, subscriber } = await atZero();
    const extra = await newRelease(shop, 3);
    // At 0, before the term date: they're not due the extra release.
    await db().subscription.update({
      where: { id: subscriber.id },
      data: { termEndsAt: days(10) },
    });
    await createDueDeliveries(env.DB, shop.id, extra.id, NOW);
    expect(await deliveryOf(subscriber.id, extra.id)).toBeNull();

    // The term date passes and they renew, with the extra release still open.
    await db().subscription.update({
      where: { id: subscriber.id },
      data: { termEndsAt: days(-1) },
    });
    await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
    await deliverWebhooks(shopify);
    expect((await row(subscriber.id)).releasesRemaining).toBe(2);

    // Months of hourly scans later, it still doesn't reach back.
    for (const at of [days(1), days(90), days(200)]) {
      await createDueDeliveries(env.DB, shop.id, extra.id, at);
    }
    expect(await deliveryOf(subscriber.id, extra.id)).toBeNull();
    expect((await row(subscriber.id)).firstReleaseNumber).toBe(4);

    // The new term starts with the next release.
    const next = await newRelease(shop, 4);
    await drain(shop, shopify, next.id);
    expect((await deliveryOf(subscriber.id, next.id))?.status).toBe("ORDERED");
    expect((await row(subscriber.id)).releasesRemaining).toBe(1);
  });

  it("a renewal on the last order doesn't reach back to a second release open at that moment", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop);
    const subscriber = await newSubscriber(shop, shopify, plan, {
      releasesRemaining: 1,
      termEndsAt: days(-1),
    });
    const paid = await newRelease(shop, 1);
    const open = await newRelease(shop, 2);
    await drain(shop, shopify, paid.id);
    await deliverWebhooks(shopify);
    await createDueDeliveries(env.DB, shop.id, open.id, NOW);
    expect(await deliveryOf(subscriber.id, open.id)).toBeNull();
  });

  it("a renewal with paid releases left moves nothing, so they still get what's open", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, { renewalRule: "TERM_DATE" });
    const subscriber = await newSubscriber(shop, shopify, plan, {
      releasesRemaining: 1,
      termEndsAt: days(-1),
    });
    const open = await newRelease(shop, 1);
    await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
    await deliverWebhooks(shopify);
    await createDueDeliveries(env.DB, shop.id, open.id, NOW);
    expect(await deliveryOf(subscriber.id, open.id)).not.toBeNull();
  });

  it("a failed renewal's missed release is HELD, and ships late once paid", async () => {
    const { shop, shopify, subscriber } = await atZero();
    const extra = await newRelease(shop, 3);
    shopify.state.decline = "EXPIRED_CARD";
    await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
    await deliverWebhooks(shopify);
    expect((await row(subscriber.id)).status).toBe("PAUSED");

    // Open since before the renewal was due: extra. Reached after: missed.
    const missed = await newRelease(shop, 4);
    await createDueDeliveries(env.DB, shop.id, extra.id, NOW);
    await createDueDeliveries(env.DB, shop.id, missed.id, NOW);
    expect(await deliveryOf(subscriber.id, extra.id)).toBeNull();
    expect((await deliveryOf(subscriber.id, missed.id))?.status).toBe("HELD");
    // Marked as shipped while held: it's closed to new subscribers, but it holds this one.
    await db().release.update({ where: { id: missed.id }, data: { status: "SHIPPED" } });

    shopify.state.decline = null;
    const jobs = await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, true, NOW);
    expect(jobs).toEqual([]);
    const settled = await deliverWebhooks(shopify);
    expect((await deliveryOf(subscriber.id, missed.id))?.status).toBe("PENDING");
    expect(settled.map((job) => job.data?.releaseId)).toContain(missed.id);

    await drain(shop, shopify, missed.id);
    expect((await deliveryOf(subscriber.id, missed.id))?.status).toBe("ORDERED");
    expect((await deliveryOf(subscriber.id, extra.id))).toBeNull();
    expect(await row(subscriber.id)).toMatchObject({
      status: "ACTIVE",
      releasesRemaining: 1,
      paymentProblemSince: null,
      pausedReason: null,
    });
  });

  it("a retry doesn't move the term's start, so a release reached between tries isn't skipped", async () => {
    const { shop, shopify, subscriber } = await atZero();
    shopify.state.decline = "INSUFFICIENT_FUNDS";
    await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
    await deliverWebhooks(shopify);
    const [attempt] = await attemptsOf(subscriber.id);
    // Reached between the tries, and nothing has scanned it yet.
    const between = await newRelease(shop, 1);
    shopify.state.decline = null;
    await retryDue(db(), env.DB, shopify.graphql, attempt.id, days(3));
    await deliverWebhooks(shopify, days(3));
    await createDueDeliveries(env.DB, shop.id, between.id, days(3));
    expect((await deliveryOf(subscriber.id, between.id))?.status).toBe("PENDING");
  });

  it("a release reached while retries are still running is held too, before anything pauses", async () => {
    const { shop, shopify, subscriber } = await atZero();
    shopify.state.decline = "INSUFFICIENT_FUNDS";
    await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
    await deliverWebhooks(shopify);
    expect((await row(subscriber.id)).status).toBe("ACTIVE");
    const release = await newRelease(shop, 1);
    await moveRelease(
      db(),
      { DB: env.DB, JOBS: { sendBatch: async () => {} } } as any,
      shop,
      release.id,
      "ship",
      NOW,
    );
    expect((await deliveryOf(subscriber.id, release.id))?.status).toBe("HELD");
  });

  it("a bundle missing more than it renews for ships what's paid, and closes the rest", async () => {
    const { shop, shopify, subscriber } = await atZero();
    shopify.state.decline = "EXPIRED_CARD";
    await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
    await deliverWebhooks(shopify);
    const held = [];
    for (const number of [1, 2, 3]) {
      const release = await newRelease(shop, number);
      await createDueDeliveries(env.DB, shop.id, release.id, NOW);
      held.push(release);
    }
    shopify.state.decline = null;
    await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, true, NOW);
    await deliverWebhooks(shopify);
    expect((await deliveryOf(subscriber.id, held[0].id))?.status).toBe("PENDING");
    expect((await deliveryOf(subscriber.id, held[1].id))?.status).toBe("PENDING");
    expect((await deliveryOf(subscriber.id, held[2].id))?.status).toBe("CANCELLED");
    expect((await row(subscriber.id)).releasesRemaining).toBe(2);
  });

  it("pay-per-release: a release open since before sign-up never reaches back", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, {
      billingMode: "PER_RELEASE",
      releasesPerTerm: 1,
      termMonths: null,
    });
    const old = await newRelease(shop, 1);
    const subscriber = await newSubscriber(shop, shopify, plan, {
      firstReleaseNumber: 2,
    });
    for (const at of [days(1), days(200)]) {
      await createDueDeliveries(env.DB, shop.id, old.id, at);
    }
    expect(await deliveryOf(subscriber.id, old.id)).toBeNull();
    expect(shopify.attempts.size).toBe(0);
  });

  it("pay-per-release: a release left open for months is charged once, with its order", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, {
      billingMode: "PER_RELEASE",
      releasesPerTerm: 1,
      termMonths: null,
    });
    const subscriber = await newSubscriber(shop, shopify, plan);
    const release = await newRelease(shop, 1);
    await drain(shop, shopify, release.id);
    await deliverWebhooks(shopify);
    await drain(shop, shopify, release.id);
    expect(shopify.orders).toHaveLength(1);
    for (const at of [days(30), days(120)]) {
      await drain(shop, shopify, release.id, at);
      await deliverWebhooks(shopify);
    }
    expect(shopify.charges()).toHaveLength(1);
    expect(shopify.orders).toHaveLength(1);
    expect((await row(subscriber.id)).releasesRemaining).toBe(0);
  });
});

describe("a failed card", () => {
  async function failing(decline: string) {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, {
      billingMode: "PER_RELEASE",
      releasesPerTerm: 1,
      termMonths: null,
    });
    const subscriber = await newSubscriber(shop, shopify, plan);
    const release = await newRelease(shop, 1);
    shopify.state.decline = decline;
    await slice(shop, shopify, release.id);
    await db().release.update({ where: { id: release.id }, data: { runLeaseUntil: null } });
    await deliverWebhooks(shopify);
    await install(shop);
    return { shop, shopify, plan, subscriber, release };
  }

  it("sorts failures by Shopify's codes, and retries what it doesn't know", () => {
    for (const code of ["INSUFFICIENT_FUNDS", "CARD_DECLINED", "DO_NOT_HONOR", "PROCESSING_ERROR", "TRANSIENT_ERROR", "PAYMENT_METHOD_NOT_SPECIFIED", "SOMETHING_NEW"]) {
      expect(worthRetrying(code)).toBe(true);
    }
    for (const code of ["EXPIRED_CARD", "INVALID_PAYMENT_METHOD", "FRAUD_SUSPECTED", "INCORRECT_NUMBER", "ACTION_REQUIRED"]) {
      expect(worthRetrying(code)).toBe(false);
    }
  });

  it("retries on days 3 and 7, each a new key, then pauses and holds the release", async () => {
    const { shopify, subscriber, release } = await failing("INSUFFICIENT_FUNDS");
    let attempts = await attemptsOf(subscriber.id);
    expect(attempts[0]).toMatchObject({
      result: "FAILED",
      errorCode: "INSUFFICIENT_FUNDS",
      nextRetryAt: days(3),
    });
    expect((await row(subscriber.id)).status).toBe("ACTIVE");
    expect((await deliveryOf(subscriber.id, release.id))?.status).toBe("HELD");
    const eventsOf = (type: string) => db().event.count({ where: { subscriptionId: subscriber.id, type } });
    expect(await eventsOf("billing.failed")).toBe(1);
    expect(await eventsOf("subscription.paused")).toBe(0); // still retrying: Flow hears of the failure only

    // Not before its date.
    expect(
      (await findRetries(finderContext(days(2)))).filter((j) => j.data?.attemptId === attempts[0].id),
    ).toHaveLength(0);
    expect(
      (await findRetries(finderContext(days(3)))).filter((j) => j.data?.attemptId === attempts[0].id),
    ).toHaveLength(1);

    await retryDue(db(), env.DB, shopify.graphql, attempts[0].id, days(3));
    // A re-sent job finds the retry already under way, and adds nothing.
    await retryDue(db(), env.DB, shopify.graphql, attempts[0].id, days(3));
    expect(shopify.attempts.size).toBe(2);
    await deliverWebhooks(shopify, days(3));
    attempts = await attemptsOf(subscriber.id);
    expect(attempts[1]).toMatchObject({ attempt: 2, nextRetryAt: days(7) });

    await retryDue(db(), env.DB, shopify.graphql, attempts[1].id, days(7));
    await deliverWebhooks(shopify, days(7));
    attempts = await attemptsOf(subscriber.id);
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
    expect(attempts[2].nextRetryAt).toBeNull();
    expect(await eventsOf("billing.failed")).toBe(3);
    expect(await eventsOf("subscription.paused")).toBe(1); // the last try also paused it, once
    expect(await row(subscriber.id)).toMatchObject({
      status: "PAUSED",
      pausedReason: "FAILED_PAYMENT",
      releasesRemaining: 0,
    });
    expect((await deliveryOf(subscriber.id, release.id))?.status).toBe("HELD");
    expect(shopify.charges()).toHaveLength(0);
    expect(shopify.orders).toHaveLength(0);
  });

  it("a failure not worth retrying pauses at once", async () => {
    const { subscriber } = await failing("EXPIRED_CARD");
    const [attempt] = await attemptsOf(subscriber.id);
    expect(attempt.nextRetryAt).toBeNull();
    expect((await row(subscriber.id)).status).toBe("PAUSED");
  });

  it("a card a bank wants confirmed pauses, and completing it later still counts once", async () => {
    const { shopify, subscriber, release } = await failing("ACTION_REQUIRED");
    expect((await row(subscriber.id)).status).toBe("PAUSED");
    expect((await attemptsOf(subscriber.id))[0].errorCode).toBe("ACTION_REQUIRED");
    shopify.state.decline = null;
    shopify.finish([...shopify.attempts.values()][0]);
    await deliverWebhooks(shopify);
    await deliverWebhooks(shopify);
    expect(await row(subscriber.id)).toMatchObject({
      status: "ACTIVE",
      releasesRemaining: 1,
    });
    expect((await deliveryOf(subscriber.id, release.id))?.status).toBe("PENDING");
  });

  it("a customer's retry can't start a second charge while a bank's challenge may still be completed", async () => {
    const { shopify, subscriber, release } = await failing("ACTION_REQUIRED");
    shopify.state.decline = null;
    const chargesBefore = shopify.charges().length;
    // The card update, or the portal's button: nothing new is attempted.
    expect(await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, false, NOW)).toEqual([]);
    expect(await attemptsOf(subscriber.id)).toHaveLength(1);
    expect(shopify.charges()).toHaveLength(chargesBefore);
    // Completing the challenge is what pays, once.
    shopify.finish([...shopify.attempts.values()][0]);
    await deliverWebhooks(shopify);
    expect(await row(subscriber.id)).toMatchObject({ status: "ACTIVE", releasesRemaining: 1 });
    expect((await deliveryOf(subscriber.id, release.id))?.status).toBe("PENDING");
  });

  it("while Shopify says a challenge is open, neither a merchant's press nor a customer's goes through, however old it is", async () => {
    const { shopify, subscriber } = await failing("ACTION_REQUIRED");
    shopify.state.decline = null;
    await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, true, NOW);
    expect(await attemptsOf(subscriber.id)).toHaveLength(1);
    await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, false, days(40));
    expect(await attemptsOf(subscriber.id)).toHaveLength(1);
    expect(shopify.charges()).toHaveLength(0);
  });

  it("once Shopify says a challenge has expired, a merchant's press and a customer's go through", async () => {
    for (const byMerchant of [true, false]) {
      const { shopify, subscriber } = await failing("ACTION_REQUIRED");
      shopify.state.decline = null;
      [...shopify.attempts.values()][0].state = {
        __typename: "SubscriptionBillingAttemptFailedState",
        error: { __typename: "x", code: "EXPIRED_BUYER_ACTION" },
      };
      await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, byMerchant, NOW);
      expect(await attemptsOf(subscriber.id)).toHaveLength(2);
    }
  });

  it("asks Shopify first: a challenge completed with its webhook lost is credited, and no one is charged again", async () => {
    const presses: [boolean, Date, boolean][] = [
      [true, NOW, false], // a merchant's press
      [false, days(4), false], // a customer's, after the old 3-day wait
      [false, NOW, true], // a newly saved card
    ];
    for (const [byMerchant, at, savedCard] of presses) {
      const { shopify, subscriber } = await failing("ACTION_REQUIRED");
      shopify.state.decline = null;
      shopify.finish([...shopify.attempts.values()][0]);
      const jobs = await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, byMerchant, at, savedCard);
      expect(await attemptsOf(subscriber.id)).toHaveLength(1);
      expect(shopify.charges()).toHaveLength(1);
      expect(await row(subscriber.id)).toMatchObject({ status: "ACTIVE", releasesRemaining: 1, paymentProblemSince: null });
      expect(jobs.some((job) => job.type === PAYMENT_ORDER_JOB)).toBe(true);
    }
  });

  it("a scheduled retry asks too: a completed challenge is credited, and an open one holds it off", async () => {
    const { shopify, subscriber, release } = await failing("ACTION_REQUIRED");
    const [challenged] = await attemptsOf(subscriber.id);
    // A later soft failure, with its retry scheduled, on the same charge.
    const later = await db().billingAttempt.create({
      data: {
        subscriptionId: subscriber.id,
        chargeFor: release.id,
        idempotencyKey: billingAttemptKey(subscriber.id, release.id, 2),
        attempt: 2,
        result: "FAILED",
        errorCode: "INSUFFICIENT_FUNDS",
        nextRetryAt: NOW,
      },
    });
    await db().subscription.update({ where: { id: subscriber.id }, data: { status: "ACTIVE", pausedReason: null } });
    shopify.state.decline = null;
    expect(await retryDue(db(), env.DB, shopify.graphql, later.id, NOW)).toEqual([]);
    expect(await attemptsOf(subscriber.id)).toHaveLength(2);
    expect((await db().billingAttempt.findUniqueOrThrow({ where: { id: later.id } })).nextRetryAt).not.toBeNull();

    shopify.finish([...shopify.attempts.values()].find((a) => a.key === challenged.idempotencyKey)!);
    const jobs = await retryDue(db(), env.DB, shopify.graphql, later.id, NOW);
    expect(await attemptsOf(subscriber.id)).toHaveLength(2);
    expect(shopify.charges()).toHaveLength(1);
    expect(jobs.some((job) => job.type === PAYMENT_ORDER_JOB)).toBe(true);
    expect((await row(subscriber.id)).releasesRemaining).toBe(1);
  });

  it("a saved card still goes through an open challenge, and if both then pay, the second isn't credited and is flagged", async () => {
    const { shop, shopify, subscriber, release } = await failing("ACTION_REQUIRED");
    shopify.state.decline = null;
    const [challenged] = await attemptsOf(subscriber.id);
    await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, false, NOW, true);
    await deliverWebhooks(shopify);
    expect(await row(subscriber.id)).toMatchObject({ status: "ACTIVE", releasesRemaining: 1 });

    // The customer now completes the old challenge as well, and the bank takes the money twice.
    const old = [...shopify.attempts.values()].find((a) => a.key === challenged.idempotencyKey)!;
    shopify.finish(old);
    const jobs = await settleAttempt(db(), env.DB, shopify.graphql, old.id, NOW);
    await settleAttempt(db(), env.DB, shopify.graphql, old.id, NOW);
    await deliverWebhooks(shopify);

    expect(shopify.charges()).toHaveLength(2);
    expect((await row(subscriber.id)).releasesRemaining).toBe(1);
    const rows = await attemptsOf(subscriber.id);
    expect(rows.map((a) => a.result)).toEqual(["DUPLICATE", "SUCCEEDED"]);
    expect(rows[0].orderGid).toBe(old.order);
    // The payment order is marked fulfilled like any other, because it never ships.
    expect(jobs.some((job) => job.type === PAYMENT_ORDER_JOB)).toBe(true);

    const flags = await db().event.findMany({ where: { subscriptionId: subscriber.id, type: DOUBLE_CHARGE_EVENT } });
    expect(flags).toHaveLength(1);
    expect(flags[0].payload).toMatchObject({ orderGid: old.order, chargeFor: release.id });
    expect(await db().event.count({ where: { subscriptionId: subscriber.id, type: "billing.succeeded" } })).toBe(1);
    expect((await releasesPageData(db(), env.DB, { id: shop.id, orderTiming: shop.orderTiming })).mixed.map((e) => e.type)).toContain(DOUBLE_CHARGE_EVENT);
  });

  it("whichever success lands first is the one credited, and a failure landing after it changes nothing", async () => {
    const { shopify, subscriber } = await failing("ACTION_REQUIRED");
    shopify.state.decline = null;
    shopify.state.held = true;
    await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, false, NOW, true);
    shopify.state.held = false;
    const [first, second] = [...shopify.attempts.values()];
    shopify.finish(first);
    await settleAttempt(db(), env.DB, shopify.graphql, first.id, NOW);
    expect((await row(subscriber.id)).releasesRemaining).toBe(1);

    // The new card fails after the old challenge paid: no problem, no retry, no failure email.
    second.state = {
      __typename: "SubscriptionBillingAttemptFailedState",
      error: { __typename: "x", code: "INSUFFICIENT_FUNDS" },
    };
    await settleAttempt(db(), env.DB, shopify.graphql, second.id, NOW);
    expect(await row(subscriber.id)).toMatchObject({ status: "ACTIVE", paymentProblemSince: null, releasesRemaining: 1 });
    const rows = await attemptsOf(subscriber.id);
    expect(rows.map((a) => a.nextRetryAt)).toEqual([null, null]);
    expect(await db().event.count({ where: { subscriptionId: subscriber.id, type: "billing.failed", id: { contains: rows[1].id } } })).toBe(0);
  });

  it("a second success on a renewal buys no second term, for an imported subscriber as for anyone", async () => {
    for (const source of ["NEW", "IMPORTED"] as const) {
      const shop = await newShop();
      const shopify = fakeShopify();
      const plan = await newPlan(shop, { renewalRule: "TERM_DATE" });
      const subscriber = await newSubscriber(shop, shopify, plan, { termEndsAt: days(-1), source });
      shopify.state.decline = "ACTION_REQUIRED";
      await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
      await deliverWebhooks(shopify);
      shopify.state.decline = null;
      await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, false, NOW, true);
      await deliverWebhooks(shopify);
      const afterFirst = await row(subscriber.id);
      expect(afterFirst.releasesRemaining).toBe(2);

      const old = [...shopify.attempts.values()][0];
      shopify.finish(old);
      await settleAttempt(db(), env.DB, shopify.graphql, old.id, NOW);
      const afterSecond = await row(subscriber.id);
      expect(afterSecond.releasesRemaining).toBe(2);
      expect(afterSecond.termEndsAt).toEqual(afterFirst.termEndsAt);
      expect((await attemptsOf(subscriber.id)).map((a) => a.result)).toEqual(["DUPLICATE", "SUCCEEDED"]);
    }
  });

  it("a charge already paid is never tried again, whatever asks", async () => {
    const { shopify, subscriber, release } = await failing("INSUFFICIENT_FUNDS");
    shopify.state.decline = null;
    const [failed] = await attemptsOf(subscriber.id);
    await db().billingAttempt.create({
      data: {
        subscriptionId: subscriber.id,
        chargeFor: release.id,
        idempotencyKey: billingAttemptKey(subscriber.id, release.id, 2),
        attempt: 2,
        result: "SUCCEEDED",
      },
    });
    // A retry left over from before the success, however it got here.
    await db().billingAttempt.update({ where: { id: failed.id }, data: { nextRetryAt: NOW } });
    await retryDue(db(), env.DB, shopify.graphql, failed.id, NOW);
    await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, true, NOW);
    expect(shopify.charges()).toHaveLength(0);
    expect(shopify.attempts.size).toBe(1);
  });

  it("a press with no payment problem charges nothing, even with an old failed attempt on file", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, { renewalRule: "TERM_DATE" });
    const subscriber = await newSubscriber(shop, shopify, plan, { termEndsAt: days(100), releasesRemaining: 1 });
    await db().billingAttempt.create({
      data: {
        subscriptionId: subscriber.id,
        chargeFor: termChargeFor(days(-300)),
        idempotencyKey: billingAttemptKey(subscriber.id, termChargeFor(days(-300)), 1),
        attempt: 1,
        result: "FAILED",
        errorCode: "INSUFFICIENT_FUNDS",
      },
    });
    await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, false, NOW);
    await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, true, NOW);
    expect(shopify.attempts.size).toBe(0);
  });

  it("a customer can't run charge attempts against a failing card more than twice an hour", async () => {
    const { shopify, subscriber } = await failing("INSUFFICIENT_FUNDS");
    expect(await attemptsOf(subscriber.id)).toHaveLength(1);
    // One retry fits after the attempt that failed, then they are held off.
    await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, false, NOW);
    await deliverWebhooks(shopify);
    expect(await attemptsOf(subscriber.id)).toHaveLength(2);
    for (let press = 0; press < 5; press++) {
      await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, false, NOW);
    }
    expect(await attemptsOf(subscriber.id)).toHaveLength(2);
    expect(shopify.attempts.size).toBe(2);
    // A merchant's press isn't held off, and the customer is free again an hour later.
    await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, true, NOW);
    expect(await attemptsOf(subscriber.id)).toHaveLength(3);
    await deliverWebhooks(shopify);
    await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, false, new Date(NOW.getTime() + 61 * 60 * 1000));
    expect(await attemptsOf(subscriber.id)).toHaveLength(4);
  });

  it("a saved card is retried once even right after a bank's challenge and past the hourly limit", async () => {
    // The challenge: the customer's button is held off, the new card is not.
    const challenged = await failing("ACTION_REQUIRED");
    challenged.shopify.state.decline = null;
    expect(await retryCharge(db(), env.DB, challenged.shopify.graphql, challenged.subscriber.id, false, NOW)).toEqual([]);
    expect(await attemptsOf(challenged.subscriber.id)).toHaveLength(1);
    await retryCharge(db(), env.DB, challenged.shopify.graphql, challenged.subscriber.id, false, NOW, true);
    expect(await attemptsOf(challenged.subscriber.id)).toHaveLength(2);

    // Two attempts in the hour: the button is held off, the new card is not.
    const busy = await failing("INSUFFICIENT_FUNDS");
    await retryCharge(db(), env.DB, busy.shopify.graphql, busy.subscriber.id, false, NOW);
    await deliverWebhooks(busy.shopify);
    expect(await attemptsOf(busy.subscriber.id)).toHaveLength(2);
    await retryCharge(db(), env.DB, busy.shopify.graphql, busy.subscriber.id, false, NOW);
    expect(await attemptsOf(busy.subscriber.id)).toHaveLength(2);
    busy.shopify.state.decline = null;
    await retryCharge(db(), env.DB, busy.shopify.graphql, busy.subscriber.id, false, NOW, true);
    expect(await attemptsOf(busy.subscriber.id)).toHaveLength(3);
  });

  it("one save that fires two webhooks gets one try, and a save later on gets its own", async () => {
    const { shop, subscriber } = await failing("INSUFFICIENT_FUNDS");
    const at = (minutes: number) => new Date(Date.UTC(2027, 5, 1, 12, minutes));
    const first = await resumeAfterCardUpdate(db(), shop.shopDomain, subscriber.customerGid, at(1));
    const second = await resumeAfterCardUpdate(db(), shop.shopDomain, subscriber.customerGid, at(2));
    expect(second.map((job) => job.id)).toEqual(first.map((job) => job.id));
    const later = await resumeAfterCardUpdate(db(), shop.shopDomain, subscriber.customerGid, at(20));
    expect(later[0].id).not.toBe(first[0].id);
    expect(later[0].data).toMatchObject({ byMerchant: false, savedCard: true });
  });

  describe("the portal's cap of 5 attempts per charge per 30 days", () => {
    /** Earlier attempts on the failed charge, an hour or more apart so the hourly limit stays out of it. */
    async function tried(
      subscriber: { id: string },
      release: { id: string },
      ages: number[],
    ) {
      for (const [i, age] of ages.entries()) {
        await db().billingAttempt.create({
          data: {
            subscriptionId: subscriber.id,
            chargeFor: release.id,
            idempotencyKey: billingAttemptKey(subscriber.id, release.id, i + 2),
            attempt: i + 2,
            result: "FAILED",
            errorCode: "INSUFFICIENT_FUNDS",
            createdAt: days(age),
          },
        });
      }
      await db().billingAttempt.updateMany({
        where: { subscriptionId: subscriber.id, attempt: 1 },
        data: { createdAt: days(-10) },
      });
    }

    it("stops the button at 5, counting scheduled tries as well as its own", async () => {
      const { shopify, subscriber, release } = await failing("INSUFFICIENT_FUNDS");
      await tried(subscriber, release, [-9, -8, -7]); // 4 in all
      await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, false, NOW);
      expect(await attemptsOf(subscriber.id)).toHaveLength(5);
      await deliverWebhooks(shopify);

      const later = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);
      await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, false, later);
      expect(await attemptsOf(subscriber.id)).toHaveLength(5);
    });

    it("lets one go again once the oldest are over 30 days old", async () => {
      const { shopify, subscriber, release } = await failing("INSUFFICIENT_FUNDS");
      await tried(subscriber, release, [-40, -35, -31, -9]); // 2 within 30 days, counting the first
      await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, false, NOW);
      expect(await attemptsOf(subscriber.id)).toHaveLength(6);
    });

    it("doesn't hold off a merchant's press or a newly saved card", async () => {
      for (const [byMerchant, savedCard] of [[true, false], [false, true]]) {
        const { shopify, subscriber, release } = await failing("INSUFFICIENT_FUNDS");
        await tried(subscriber, release, [-9, -8, -7, -6, -5]); // 6 in all
        await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, byMerchant, NOW, savedCard);
        expect(await attemptsOf(subscriber.id)).toHaveLength(7);
      }
    });
  });

  it("the same card webhook delivered twice charges once, and a card saved is not the merchant", async () => {
    const { shop, shopify, subscriber } = await failing("INSUFFICIENT_FUNDS");
    shopify.state.decline = null;
    const jobs = await resumeAfterCardUpdate(db(), shop.shopDomain, subscriber.customerGid, NOW);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data).toMatchObject({ byMerchant: false, savedCard: true });

    const handlers = {
      [BILLING_RESUME_JOB]: async (job: Job, { db: jobDb, env: jobEnv }: any) => {
        await runResumeJob(jobDb, jobEnv.DB, shopify.graphql, job);
      },
    };
    // The queue can deliver a message twice, and Shopify can send a webhook twice with the same ID.
    const twice = await resumeAfterCardUpdate(db(), shop.shopDomain, subscriber.customerGid, NOW);
    expect(twice.map((job) => job.id)).toEqual(jobs.map((job) => job.id));
    const batch = createMessageBatch<unknown>("release-subscriptions-jobs", [jobs[0], twice[0]].map((body, i) => ({
      id: `saved-${++n}-${i}`,
      timestamp: new Date(),
      attempts: 1,
      body,
    })));
    await consumeJobs(batch, env, handlers);
    expect(await attemptsOf(subscriber.id)).toHaveLength(2);
    expect(shopify.attempts.size).toBe(2);
  });

  it("a saved card doesn't end a chargeback hold, only the merchant does", async () => {
    const { shop, shopify, subscriber } = await failing("INSUFFICIENT_FUNDS");
    await db().subscription.update({
      where: { id: subscriber.id },
      data: { status: "PAUSED", pausedReason: "CHARGEBACK", paymentProblemSince: NOW },
    });
    shopify.state.decline = null;
    expect(await resumeAfterCardUpdate(db(), shop.shopDomain, subscriber.customerGid, NOW)).toEqual([]);
    // Even if the job were sent anyway, with the flag set.
    expect(await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, false, NOW, true)).toEqual([]);
    expect(await attemptsOf(subscriber.id)).toHaveLength(1);
    expect(await row(subscriber.id)).toMatchObject({ status: "PAUSED", pausedReason: "CHARGEBACK" });
  });

  it("a bundle's held release shows on the screen and in the CSV, and isn't refused", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop);
    const subscriber = await newSubscriber(shop, shopify, plan, { termEndsAt: days(-1) });
    shopify.state.decline = "EXPIRED_CARD";
    await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
    await deliverWebhooks(shopify);
    const next = await newRelease(shop, 2);
    await slice(shop, shopify, next.id);
    expect((await deliveryOf(subscriber.id, next.id))?.status).toBe("HELD");
    expect(await attemptsOf(subscriber.id)).toHaveLength(1);

    const progress = await listRunProgress(db(), "READY_TO_SHIP", [
      { id: next.id, status: "READY" },
    ]);
    expect(progress[next.id]).toMatchObject({ held: 1, refused: 0, waiting: 0, ordered: 0 });

    const csv = await buildRunCsv(env.DB, { ...shop, word: "drop" }, next.id);
    expect(csv).toContain("Held: waiting for payment");

    const problems = await listPaymentProblems(db(), shop.id);
    expect(problems.rows[0]).toMatchObject({
      id: subscriber.id,
      pausedReason: "FAILED_PAYMENT",
      plan: { name: plan.name },
    });
    expect(problems.rows[0].billingAttempts[0].errorCode).toBe("EXPIRED_CARD");
  });

  it("recovery: the charge lands, then the held release ships late, once", async () => {
    const { shop, shopify, subscriber, release } = await failing("EXPIRED_CARD");
    shopify.state.decline = null;
    await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, true, NOW);
    // A second press while it's under way sends nothing new.
    shopify.state.held = true;
    await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, true, NOW);
    expect(shopify.charges()).toHaveLength(1);
    expect(shopify.attempts.size).toBe(2);

    const jobs = await deliverWebhooks(shopify);
    expect(jobs.some((job) => job.type === RELEASE_RUN_JOB)).toBe(true);
    await drain(shop, shopify, release.id);
    expect((await deliveryOf(subscriber.id, release.id))?.status).toBe("ORDERED");
    expect(shopify.orders).toHaveLength(1);
    expect(await row(subscriber.id)).toMatchObject({
      status: "ACTIVE",
      pausedReason: null,
      paymentProblemSince: null,
      releasesRemaining: 0,
    });
  });

  it("the merchant's retry on a release since cancelled charges nothing and lifts the pause", async () => {
    const { shopify, subscriber, release } = await failing("EXPIRED_CARD");
    await db().delivery.updateMany({
      where: { releaseId: release.id },
      data: { status: "CANCELLED" },
    });
    await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, true, NOW);
    expect(shopify.attempts.size).toBe(1);
    expect(await row(subscriber.id)).toMatchObject({
      status: "ACTIVE",
      paymentProblemSince: null,
    });
  });

  it("a scheduled retry for a release since cancelled charges nothing either", async () => {
    const { shopify, subscriber, release } = await failing("INSUFFICIENT_FUNDS");
    const [attempt] = await attemptsOf(subscriber.id);
    await db().delivery.updateMany({
      where: { releaseId: release.id },
      data: { status: "CANCELLED" },
    });
    await retryDue(db(), env.DB, shopify.graphql, attempt.id, days(3));
    expect(shopify.attempts.size).toBe(1);
    expect((await attemptsOf(subscriber.id))[0].nextRetryAt).toBeNull();
    expect((await row(subscriber.id)).paymentProblemSince).toBeNull();
  });

  it("a subscription without a card fails visibly, and a retry picks up a card added since", async () => {
    const { shopify, subscriber, release } = await failing("PAYMENT_METHOD_NOT_SPECIFIED");
    const [attempt] = await attemptsOf(subscriber.id);
    expect(attempt).toMatchObject({
      errorCode: "PAYMENT_METHOD_NOT_SPECIFIED",
      nextRetryAt: days(3),
    });
    expect((await deliveryOf(subscriber.id, release.id))?.status).toBe("HELD");
    shopify.state.decline = null;
    await retryDue(db(), env.DB, shopify.graphql, attempt.id, days(3));
    await deliverWebhooks(shopify, days(3));
    expect((await row(subscriber.id)).releasesRemaining).toBe(1);
    expect((await deliveryOf(subscriber.id, release.id))?.status).toBe("PENDING");
  });
});

describe("one missed payment holds back later releases, on pay per release", () => {
  async function missed(decline = "EXPIRED_CARD") {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, {
      billingMode: "PER_RELEASE",
      releasesPerTerm: 1,
      termMonths: null,
    });
    const subscriber = await newSubscriber(shop, shopify, plan);
    const failed = await newRelease(shop, 5);
    shopify.state.decline = decline;
    await drain(shop, shopify, failed.id);
    await deliverWebhooks(shopify);
    expect((await deliveryOf(subscriber.id, failed.id))?.status).toBe("HELD");
    return { shop, shopify, plan, subscriber, failed };
  }
  const charges = (shopify: Shopify) => [...shopify.attempts.keys()];

  /** Runs each release's slices, as the tick would, and proves nothing came of it. */
  async function expectNothingOn(
    shop: TestShop,
    shopify: Shopify,
    subscriberId: string,
    releaseId: string,
    at = NOW,
  ) {
    const before = shopify.attempts.size;
    await drain(shop, shopify, releaseId, at);
    await createDueDeliveries(env.DB, shop.id, releaseId, at);
    expect(await deliveryOf(subscriberId, releaseId)).toBeNull();
    expect(shopify.attempts.size).toBe(before);
  }

  it("while paused: a later release gets no charge and no Delivery", async () => {
    const { shop, shopify, subscriber } = await missed();
    expect((await row(subscriber.id)).status).toBe("PAUSED");
    for (const number of [6, 7]) {
      await expectNothingOn(shop, shopify, subscriber.id, (await newRelease(shop, number)).id);
    }
  });

  it("from the first failure, during the retry days too, and marking it shipped doesn't bring it in", async () => {
    const { shop, shopify, subscriber } = await missed("INSUFFICIENT_FUNDS");
    expect((await row(subscriber.id)).status).toBe("ACTIVE");
    const open = await newRelease(shop, 6);
    await expectNothingOn(shop, shopify, subscriber.id, open.id);
    await moveRelease(
      db(),
      { DB: env.DB, JOBS: { sendBatch: async () => {} } } as any,
      shop,
      open.id,
      "ship",
      NOW,
    );
    expect(await deliveryOf(subscriber.id, open.id)).toBeNull();
  });

  it("on recovery: one charge, the failed release ships, and later ones are skipped for good", async () => {
    const { shop, shopify, subscriber, failed } = await missed();
    const open = await newRelease(shop, 6); // still open when they recover
    const closed = await newRelease(shop, 7, "SHIPPED");
    await expectNothingOn(shop, shopify, subscriber.id, open.id);

    shopify.state.decline = null;
    await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, true, NOW);
    const jobs = await deliverWebhooks(shopify);
    expect(jobs.map((job) => job.type)).toEqual([PAYMENT_ORDER_JOB, RELEASE_RUN_JOB]);
    expect(jobs[1].data?.releaseId).toBe(failed.id);
    expect(shopify.charges()).toHaveLength(1);
    expect(charges(shopify)).toEqual([
      billingAttemptKey(subscriber.id, failed.id, 1),
      billingAttemptKey(subscriber.id, failed.id, 2),
    ]);
    expect(await row(subscriber.id)).toMatchObject({
      status: "ACTIVE",
      firstReleaseNumber: 8,
      paymentProblemSince: null,
      pausedReason: null,
    });

    await drain(shop, shopify, failed.id);
    expect((await deliveryOf(subscriber.id, failed.id))?.status).toBe("ORDERED");
    expect(shopify.orders).toHaveLength(1);
    expect((await row(subscriber.id)).releasesRemaining).toBe(0);

    // The hourly scan, for months, on the release left open.
    for (const at of [days(1), days(120)]) {
      await expectNothingOn(shop, shopify, subscriber.id, open.id, at);
    }
    expect(await deliveryOf(subscriber.id, closed.id)).toBeNull();
    expect(shopify.charges()).toHaveLength(1);
  });

  it("the next release after recovery is charged and shipped as normal", async () => {
    const { shop, shopify, subscriber } = await missed();
    await newRelease(shop, 6);
    shopify.state.decline = null;
    await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, true, NOW);
    await deliverWebhooks(shopify);
    const [failedDelivery] = await db().delivery.findMany({
      where: { subscriptionId: subscriber.id },
    });
    await drain(shop, shopify, failedDelivery.releaseId);

    const next = await newRelease(shop, 8);
    await drain(shop, shopify, next.id);
    await deliverWebhooks(shopify);
    await drain(shop, shopify, next.id);
    expect((await deliveryOf(subscriber.id, next.id))?.status).toBe("ORDERED");
    expect(shopify.charges()).toHaveLength(2);
    expect(shopify.orders).toHaveLength(2);
    expect((await row(subscriber.id)).releasesRemaining).toBe(0);
  });

  it("a scheduled retry that succeeds skips them too", async () => {
    const { shop, shopify, subscriber } = await missed("INSUFFICIENT_FUNDS");
    const open = await newRelease(shop, 6);
    const [attempt] = await attemptsOf(subscriber.id);
    shopify.state.decline = null;
    await retryDue(db(), env.DB, shopify.graphql, attempt.id, days(3));
    await deliverWebhooks(shopify, days(3));
    expect((await row(subscriber.id)).firstReleaseNumber).toBe(7);
    await expectNothingOn(shop, shopify, subscriber.id, open.id, days(3));
  });

  it("the missed release was cancelled: no charge at all, and later ones stay skipped", async () => {
    const { shop, shopify, subscriber, failed } = await missed();
    const open = await newRelease(shop, 6);
    await db().delivery.updateMany({
      where: { releaseId: failed.id },
      data: { status: "CANCELLED" },
    });
    await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, true, NOW);
    expect(shopify.attempts.size).toBe(1);
    expect(await row(subscriber.id)).toMatchObject({
      status: "ACTIVE",
      firstReleaseNumber: 7,
      paymentProblemSince: null,
    });
    await expectNothingOn(shop, shopify, subscriber.id, open.id);
  });

  it("the same when a scheduled retry finds it cancelled", async () => {
    const { shop, shopify, subscriber, failed } = await missed("INSUFFICIENT_FUNDS");
    const open = await newRelease(shop, 6);
    await db().delivery.updateMany({
      where: { releaseId: failed.id },
      data: { status: "CANCELLED" },
    });
    const [attempt] = await attemptsOf(subscriber.id);
    await retryDue(db(), env.DB, shopify.graphql, attempt.id, days(3));
    expect((await row(subscriber.id)).firstReleaseNumber).toBe(7);
    await expectNothingOn(shop, shopify, subscriber.id, open.id);
  });

  it("no problem, nothing skipped: a release reached while a charge is on its way still comes next", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, {
      billingMode: "PER_RELEASE",
      releasesPerTerm: 1,
      termMonths: null,
    });
    const subscriber = await newSubscriber(shop, shopify, plan);
    const first = await newRelease(shop, 1);
    await drain(shop, shopify, first.id);
    const second = await newRelease(shop, 2);
    await deliverWebhooks(shopify);
    expect((await row(subscriber.id)).firstReleaseNumber).toBe(1);
    await drain(shop, shopify, first.id);
    await drain(shop, shopify, second.id);
    await deliverWebhooks(shopify);
    await drain(shop, shopify, second.id);
    expect((await deliveryOf(subscriber.id, second.id))?.status).toBe("ORDERED");
    expect(shopify.charges()).toHaveLength(2);
  });

  it("paused with a paid balance: it still ships, with no charge", async () => {
    const { shop, shopify, subscriber } = await missed();
    await db().subscription.update({
      where: { id: subscriber.id },
      data: { releasesRemaining: 2 },
    });
    const next = await newRelease(shop, 6);
    const before = shopify.attempts.size;
    await drain(shop, shopify, next.id);
    expect((await deliveryOf(subscriber.id, next.id))?.status).toBe("ORDERED");
    expect(shopify.attempts.size).toBe(before);
  });

  it("nothing else ever charges a second release: no job follows, and no finder looks for one", async () => {
    const { shop, shopify, subscriber } = await missed();
    await newRelease(shop, 6);
    await install(shop);
    shopify.state.decline = null;
    await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, true, NOW);
    const jobs = await deliverWebhooks(shopify);
    expect(jobs.some((job) => job.type === "billing.resume")).toBe(false);
    for (const find of [findRenewals, findRetries, findLostResults]) {
      expect(jobsFor(await find(finderContext(days(30))), subscriber.id)).toEqual([]);
    }
  });

  it("a chargeback's held releases: one charge for the oldest, and the rest are closed", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, {
      billingMode: "PER_RELEASE",
      releasesPerTerm: 1,
      termMonths: null,
    });
    const subscriber = await newSubscriber(shop, shopify, plan);
    const contract = (await row(subscriber.id)).contractGid!;
    await shopify.graphql("BillingAttemptCreate", {
      contract,
      input: { idempotencyKey: "sign-up" },
    });
    await recordChargeback(db(), env.DB, shopify.graphql, shopify.charges()[0].order!, NOW);
    const six = await newRelease(shop, 6);
    const seven = await newRelease(shop, 7);
    await createDueDeliveries(env.DB, shop.id, six.id, NOW);
    await createDueDeliveries(env.DB, shop.id, seven.id, NOW);
    expect((await deliveryOf(subscriber.id, seven.id))?.status).toBe("HELD");

    await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, true, NOW);
    await deliverWebhooks(shopify);
    expect(shopify.charges()).toHaveLength(2);
    expect((await deliveryOf(subscriber.id, six.id))?.status).toBe("PENDING");
    expect((await deliveryOf(subscriber.id, seven.id))?.status).toBe("CANCELLED");
    expect(await row(subscriber.id)).toMatchObject({
      status: "ACTIVE",
      paymentProblemSince: null,
      firstReleaseNumber: 8,
    });
  });

  it("a customer's own retry recovers a failed card, but can't end a chargeback", async () => {
    const { shopify, subscriber, failed } = await missed();
    shopify.state.decline = null;
    await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, false, NOW);
    await deliverWebhooks(shopify);
    expect((await deliveryOf(subscriber.id, failed.id))?.status).toBe("PENDING");
    expect((await row(subscriber.id)).status).toBe("ACTIVE");
  });
});

describe("the crash at each write boundary", () => {
  async function perRelease() {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, {
      billingMode: "PER_RELEASE",
      releasesPerTerm: 1,
      termMonths: null,
    });
    const subscriber = await newSubscriber(shop, shopify, plan);
    const release = await newRelease(shop, 1);
    await install(shop);
    return { shop, shopify, plan, subscriber, release };
  }

  it("after the billing call and before recording it: the webhook settles it by its key", async () => {
    const { shop, shopify, subscriber, release } = await perRelease();
    shopify.state.throwAfterCharge = true;
    await slice(shop, shopify, release.id);
    const [attempt] = await attemptsOf(subscriber.id);
    expect(attempt.shopifyAttemptGid).toBeNull();
    expect(shopify.charges()).toHaveLength(1);

    await deliverWebhooks(shopify);
    expect((await attemptsOf(subscriber.id))[0]).toMatchObject({
      result: "SUCCEEDED",
      shopifyAttemptGid: [...shopify.attempts.values()][0].id,
    });
    expect((await row(subscriber.id)).releasesRemaining).toBe(1);
  });

  it("after the billing call, with the webhook lost too: the tick finds it on the contract", async () => {
    const { shop, shopify, subscriber, release } = await perRelease();
    shopify.state.throwAfterCharge = true;
    await slice(shop, shopify, release.id);
    const [attempt] = await attemptsOf(subscriber.id);
    const found = await findLostResults(
      finderContext(new Date(NOW.getTime() + 11 * 60 * 1000)),
    );
    expect(found.map((job) => job.data?.attemptId)).toContain(attempt.id);

    await recoverAttempt(db(), env.DB, shopify.graphql, attempt.id, NOW);
    expect(shopify.attempts.size).toBe(1);
    expect(shopify.charges()).toHaveLength(1);
    expect((await attemptsOf(subscriber.id))[0].result).toBe("SUCCEEDED");
    expect((await row(subscriber.id)).releasesRemaining).toBe(1);
  });

  it("before the billing call: the same key goes out once, with no second row", async () => {
    const { shopify, subscriber, release } = await perRelease();
    const key = billingAttemptKey(subscriber.id, release.id, 1);
    const stored = await db().billingAttempt.create({
      data: {
        subscriptionId: subscriber.id,
        chargeFor: release.id,
        idempotencyKey: key,
        attempt: 1,
      },
    });
    await recoverAttempt(db(), env.DB, shopify.graphql, stored.id, NOW);
    expect([...shopify.attempts.keys()]).toEqual([key]);
    expect(await attemptsOf(subscriber.id)).toHaveLength(1);
  });

  it("before the billing call, and cancelled since: nothing goes out, and the row goes", async () => {
    const { shopify, subscriber, release } = await perRelease();
    const stored = await db().billingAttempt.create({
      data: {
        subscriptionId: subscriber.id,
        chargeFor: release.id,
        idempotencyKey: billingAttemptKey(subscriber.id, release.id, 1),
        attempt: 1,
      },
    });
    await db().subscription.update({
      where: { id: subscriber.id },
      data: { status: "CANCELLED" },
    });
    await recoverAttempt(db(), env.DB, shopify.graphql, stored.id, NOW);
    expect(shopify.attempts.size).toBe(0);
    expect(await attemptsOf(subscriber.id)).toHaveLength(0);
  });

  it("after success and before the order: the tick's run makes it, and charges nothing", async () => {
    const { shop, shopify, subscriber, release } = await perRelease();
    await slice(shop, shopify, release.id);
    await deliverWebhooks(shopify);
    // Whatever was enqueued next is lost, and the lease has lapsed.
    await db().release.update({ where: { id: release.id }, data: { runLeaseUntil: null } });
    const runs = await findReleaseRuns(finderContext(NOW));
    expect(runs.map((job) => job.data?.releaseId)).toContain(release.id);
    await drain(shop, shopify, release.id);
    expect(shopify.orders).toHaveLength(1);
    expect(shopify.charges()).toHaveLength(1);
    expect((await deliveryOf(subscriber.id, release.id))?.status).toBe("ORDERED");
  });

  it("a webhook arriving before the row has its Shopify ID finds it by key", async () => {
    const { shopify, subscriber, release } = await perRelease();
    const key = billingAttemptKey(subscriber.id, release.id, 1);
    await db().billingAttempt.create({
      data: {
        subscriptionId: subscriber.id,
        chargeFor: release.id,
        idempotencyKey: key,
        attempt: 1,
      },
    });
    const contract = (await row(subscriber.id)).contractGid!;
    const made = await shopify.graphql("BillingAttemptCreate", {
      contract,
      input: { idempotencyKey: key },
    });
    await settleAttempt(
      db(),
      env.DB,
      shopify.graphql,
      made.subscriptionBillingAttemptCreate.subscriptionBillingAttempt.id,
      NOW,
    );
    expect((await row(subscriber.id)).releasesRemaining).toBe(1);
  });

  it("a webhook for an attempt the app never made changes nothing", async () => {
    const { shopify, subscriber } = await perRelease();
    const contract = (await row(subscriber.id)).contractGid!;
    const made = await shopify.graphql("BillingAttemptCreate", {
      contract,
      input: { idempotencyKey: "someone-elses" },
    });
    expect(
      await settleAttempt(
        db(),
        env.DB,
        shopify.graphql,
        made.subscriptionBillingAttemptCreate.subscriptionBillingAttempt.id,
        NOW,
      ),
    ).toEqual([]);
    expect((await row(subscriber.id)).releasesRemaining).toBe(0);
  });

  it("webhooks out of order end on what Shopify says now", async () => {
    const { shop, shopify, subscriber, release } = await perRelease();
    await slice(shop, shopify, release.id);
    // A failure webhook delivered after the success: the job reads the attempt fresh.
    await deliverWebhooks(shopify);
    await deliverWebhooks(shopify);
    expect((await attemptsOf(subscriber.id))[0].result).toBe("SUCCEEDED");
    expect((await row(subscriber.id)).paymentProblemSince).toBeNull();
    expect((await row(subscriber.id)).releasesRemaining).toBe(1);
  });

  it("a result still pending changes nothing, and the tick looks again", async () => {
    const { shop, shopify, subscriber, release } = await perRelease();
    shopify.state.held = true;
    await slice(shop, shopify, release.id);
    await deliverWebhooks(shopify);
    const [attempt] = await attemptsOf(subscriber.id);
    expect(attempt.result).toBe("PENDING");
    shopify.state.held = false;
    shopify.finish([...shopify.attempts.values()][0]);
    await recoverAttempt(db(), env.DB, shopify.graphql, attempt.id, NOW);
    expect((await row(subscriber.id)).releasesRemaining).toBe(1);
  });
});

describe("guards in front of the billing call", () => {
  it("a contract cancelled at Shopify, webhook lost: no charge, and the subscription catches up", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, {
      billingMode: "PER_RELEASE",
      releasesPerTerm: 1,
      termMonths: null,
    });
    const subscriber = await newSubscriber(shop, shopify, plan, {
      contractStatus: "CANCELLED",
    });
    const release = await newRelease(shop, 1);
    await drain(shop, shopify, release.id);
    expect(shopify.attempts.size).toBe(0);
    expect(shopify.orders).toHaveLength(0);
    expect((await row(subscriber.id)).status).toBe("CANCELLED");
    expect((await deliveryOf(subscriber.id, release.id))?.status).toBe("CANCELLED");
  });

  it("the same for a bundle's renewal", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop);
    const subscriber = await newSubscriber(shop, shopify, plan, {
      termEndsAt: days(-1),
      contractStatus: "EXPIRED",
    });
    expect(
      await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW),
    ).toBe("contract_closed");
    expect(shopify.attempts.size).toBe(0);
    expect((await row(subscriber.id)).status).toBe("CANCELLED");
  });

  it("a contract Shopify has paused isn't charged, and nothing changes here", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop);
    const subscriber = await newSubscriber(shop, shopify, plan, {
      termEndsAt: days(-1),
      contractStatus: "PAUSED",
    });
    expect(
      await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW),
    ).toBe("contract_not_active");
    expect(shopify.attempts.size).toBe(0);
    expect((await row(subscriber.id)).status).toBe("ACTIVE");
  });

  it("the contract webhook's cancellation closes what's unpaid and keeps what's paid", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, {
      billingMode: "PER_RELEASE",
      releasesPerTerm: 1,
      termMonths: null,
    });
    const subscriber = await newSubscriber(shop, shopify, plan);
    const release = await newRelease(shop, 1);
    shopify.state.decline = "INSUFFICIENT_FUNDS";
    await slice(shop, shopify, release.id);
    await deliverWebhooks(shopify);
    const graphql: Graphql = async () => ({
      subscriptionContract: {
        id: subscriber.contractGid,
        status: "CANCELLED",
        createdAt: NOW.toISOString(),
        customer: { id: subscriber.customerGid },
        originOrder: null,
        lines: {
          nodes: [
            {
              quantity: 1,
              sellingPlanId: plan.sellingPlanGid,
              currentPrice: { amount: "40.0" },
            },
          ],
        },
      },
    });
    await syncContract(db(), env.DB, graphql, shop, subscriber.contractGid!, NOW);
    expect(await row(subscriber.id)).toMatchObject({
      status: "CANCELLED",
      paymentProblemSince: null,
    });
    expect((await deliveryOf(subscriber.id, release.id))?.status).toBe("CANCELLED");
    expect((await attemptsOf(subscriber.id))[0].nextRetryAt).toBeNull();
  });

  it("never charges an ENDED subscription, by any way in", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, { renewalRule: "TERM_DATE" });
    const subscriber = await newSubscriber(shop, shopify, plan, {
      termEndsAt: days(-1),
      status: "ENDED",
    });
    const key = termChargeFor(days(-1));
    const stored = await db().billingAttempt.create({
      data: {
        subscriptionId: subscriber.id,
        chargeFor: key,
        idempotencyKey: billingAttemptKey(subscriber.id, key, 1),
        attempt: 1,
        result: "FAILED",
        nextRetryAt: days(-1),
      },
    });
    const graphql = shopify.graphql;
    await renewIfDue(db(), env.DB, graphql, subscriber.id, NOW);
    await retryCharge(db(), env.DB, graphql, subscriber.id, true, NOW);
    await retryDue(db(), env.DB, graphql, stored.id, NOW);
    await recoverAttempt(db(), env.DB, graphql, stored.id, NOW);
    expect(shopify.attempts.size).toBe(0);
    await install(shop);
    expect(
      (await findRetries(finderContext(NOW))).map((job) => job.data?.attemptId),
    ).not.toContain(stored.id);
  });

  it("a retry stops at the billing call for a gift, or once auto-renew is turned off", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, { renewalRule: "TERM_DATE" });
    const manual = await newPlan(shop, { renewalRule: "TERM_DATE", autoRenew: false });
    const key = termChargeFor(days(-1));
    for (const subscriber of [
      await newSubscriber(shop, shopify, plan, { termEndsAt: days(-1), source: "GIFT" }),
      await newSubscriber(shop, shopify, manual, { termEndsAt: days(-1) }),
    ]) {
      const stored = await db().billingAttempt.create({
        data: {
          subscriptionId: subscriber.id,
          chargeFor: key,
          idempotencyKey: billingAttemptKey(subscriber.id, key, 1),
          attempt: 1,
          result: "FAILED",
          nextRetryAt: days(-1),
        },
      });
      await retryDue(db(), env.DB, shopify.graphql, stored.id, NOW);
      expect(
        (await db().billingAttempt.findUniqueOrThrow({ where: { id: stored.id } })).nextRetryAt,
      ).toBeNull();
    }
    expect(shopify.state.creates).toBe(0);
  });

  it("a re-sent retry whose try has finished doesn't go back to Shopify", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, { renewalRule: "TERM_DATE" });
    const subscriber = await newSubscriber(shop, shopify, plan, { termEndsAt: days(-1) });
    shopify.state.decline = "INSUFFICIENT_FUNDS";
    await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
    await deliverWebhooks(shopify);
    const [first] = await attemptsOf(subscriber.id);
    await retryDue(db(), env.DB, shopify.graphql, first.id, days(3));
    await deliverWebhooks(shopify, days(3));
    expect(shopify.state.creates).toBe(2);
    // As if a crash left the first row's retry standing.
    await db().billingAttempt.update({
      where: { id: first.id },
      data: { nextRetryAt: days(3) },
    });
    await retryDue(db(), env.DB, shopify.graphql, first.id, days(3));
    expect(shopify.state.creates).toBe(2);
    expect(await attemptsOf(subscriber.id)).toHaveLength(2);
  });

  it("cancelling a release takes its held Deliveries with it, and nothing more is charged for it", async () => {
    const shop = await newShop("PREORDER_OPENS");
    const shopify = fakeShopify();
    const plan = await newPlan(shop, {
      billingMode: "PER_RELEASE",
      releasesPerTerm: 1,
      termMonths: null,
    });
    const subscriber = await newSubscriber(shop, shopify, plan);
    const release = await newRelease(shop, 1, "PREORDER");
    shopify.state.decline = "INSUFFICIENT_FUNDS";
    await slice(shop, shopify, release.id);
    await deliverWebhooks(shopify);
    expect((await deliveryOf(subscriber.id, release.id))?.status).toBe("HELD");
    const result = await moveRelease(
      db(),
      { DB: env.DB, JOBS: { sendBatch: async () => {} } } as any,
      shop,
      release.id,
      "cancel",
      NOW,
    );
    expect(result.ok).toBe(true);
    expect((await deliveryOf(subscriber.id, release.id))?.status).toBe("CANCELLED");
    const [attempt] = await attemptsOf(subscriber.id);
    await retryDue(db(), env.DB, shopify.graphql, attempt.id, days(3));
    expect(shopify.state.creates).toBe(1);
  });

  it("redacting a customer ends charging and clears the flag", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop);
    const subscriber = await newSubscriber(shop, shopify, plan, { termEndsAt: days(-1) });
    shopify.state.decline = "INSUFFICIENT_FUNDS";
    await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
    await deliverWebhooks(shopify);
    await redactCustomer(db(), env.DB, shop.shopDomain, subscriber.customerGid);
    expect(await row(subscriber.id)).toMatchObject({
      status: "ENDED",
      paymentProblemSince: null,
    });
    expect((await attemptsOf(subscriber.id))[0].nextRetryAt).toBeNull();
  });
});

describe("shipping on a charge", () => {
  it("a renewal on a free-shipping plan charges no shipping", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, { renewalRule: "TERM_DATE" });
    // As a free rate at checkout leaves the contract (checked live).
    const subscriber = await newSubscriber(shop, shopify, plan, {
      termEndsAt: days(-1),
      deliveryPrice: "0.0",
      quantity: 2,
    });
    await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
    const [charge] = shopify.charges();
    expect(charge.shipping).toBe(0);
    expect(charge.total).toBe(80);
    const contract = shopify.contracts.get(subscriber.contractGid!);
    expect(contract.deliveryPrice.amount).toBe("0.0");
  });

  it("the app adds nothing and changes nothing: paid shipping stays what the customer agreed to", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, { renewalRule: "TERM_DATE" });
    const subscriber = await newSubscriber(shop, shopify, plan, {
      termEndsAt: days(-1),
      deliveryPrice: "8.0",
    });
    await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
    expect(shopify.charges()[0]).toMatchObject({ shipping: 8, total: 48 });
  });
});

/** The notice row the email run writes, by default sent long enough ago. */
const priceNotice = (
  shop: TestShop,
  subscriptionId: string,
  changeId: string,
  status: EmailStatus = "SENT",
  sentAt: Date | null = days(-31),
) =>
  db().emailSend.create({
    data: {
      id: `priceChange:${subscriptionId}:${changeId}`,
      shopId: shop.id,
      subscriptionId,
      kind: "priceChange",
      subject: changeId,
      status,
      sentAt,
    },
  });

describe("the price-change policy", () => {
  async function renewing(
    policy: PriceChangePolicy | null,
    fields: {
      effectiveAt?: Date;
      newPriceCents?: number;
      notice?: { status?: EmailStatus; sentAt?: Date | null } | null;
    } = {},
  ) {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, { renewalRule: "TERM_DATE" });
    const subscriber = await newSubscriber(shop, shopify, plan, {
      termEndsAt: days(-1),
      createdAt: days(-400),
      quantity: 2,
    });
    if (policy) {
      const change = await db().priceChange.create({
        data: {
          planId: plan.id,
          newPriceCents: fields.newPriceCents ?? 5000,
          policy,
          effectiveAt: fields.effectiveAt ?? days(-1),
        },
      });
      if (fields.notice !== null) {
        await priceNotice(shop, subscriber.id, change.id, fields.notice?.status, fields.notice?.sentAt);
      }
    }
    return { shop, shopify, plan, subscriber };
  }

  it("keeping the old price leaves the contract alone", async () => {
    const { shopify, subscriber } = await renewing("KEEP_OLD_PRICE");
    await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
    expect(shopify.state.drafts).toBe(0);
    expect(shopify.charges()[0].total).toBe(80);
    expect((await row(subscriber.id)).lockedPriceCents).toBe(4000);
  });

  it("apply at renewal changes the contract before the charge, per copy", async () => {
    const { shopify, subscriber } = await renewing("APPLY_AT_RENEWAL");
    await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
    expect(shopify.state.drafts).toBe(1);
    expect(shopify.charges()[0].total).toBe(100);
    expect((await row(subscriber.id)).lockedPriceCents).toBe(5000);
  });

  it("refuses a rise whose notice wasn't really sent: failed, unsure, skipped, still waiting or never written", async () => {
    const notices = [
      { status: "FAILED" as const, sentAt: null },
      { status: "UNSURE" as const, sentAt: null },
      { status: "SKIPPED" as const, sentAt: null },
      { status: "PENDING" as const, sentAt: null },
      null,
    ];
    for (const notice of notices) {
      const { shopify, subscriber } = await renewing("APPLY_AT_RENEWAL", { notice });
      await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
      expect(shopify.state.drafts).toBe(0);
      expect(shopify.charges()[0].total).toBe(80);
      expect((await row(subscriber.id)).lockedPriceCents).toBe(4000);
    }
  });

  it("refuses a rise to someone who signed up in the plan sync's lag at the old price, who got no notice", async () => {
    const { shop, shopify, plan } = await renewing("APPLY_AT_RENEWAL", { notice: null });
    await db().priceChange.updateMany({ where: { planId: plan.id }, data: { createdAt: days(-31) } });
    const lag = await newSubscriber(shop, shopify, plan, {
      termEndsAt: days(-1),
      createdAt: days(-31 + 0.001),
    });
    await renewIfDue(db(), env.DB, shopify.graphql, lag.id, NOW);
    expect(shopify.charges()).toHaveLength(1);
    expect(shopify.state.drafts).toBe(0);
    expect(shopify.charges()[0].total).toBe(40);
    expect((await row(lag.id)).lockedPriceCents).toBe(4000);
  });

  it("refuses a rise whose notice went out too late to give the notice period", async () => {
    const { shopify, subscriber } = await renewing("APPLY_AT_RENEWAL", {
      notice: { status: "SENT", sentAt: days(-10) },
    });
    await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
    expect(shopify.state.drafts).toBe(0);
    expect(shopify.charges()[0].total).toBe(80);
  });

  it("a notice sent a few hours after the rise was saved still counts", async () => {
    const { shopify, subscriber } = await renewing("APPLY_AT_RENEWAL", {
      notice: { status: "SENT", sentAt: new Date(NOW.getTime() - 29.8 * DAY) },
    });
    await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
    expect(shopify.state.drafts).toBe(1);
  });

  it("a price that comes down needs no notice", async () => {
    const { shopify, subscriber } = await renewing("APPLY_AT_RENEWAL", { newPriceCents: 3000, notice: null });
    await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
    expect(shopify.charges()[0].total).toBe(60);
    expect((await row(subscriber.id)).lockedPriceCents).toBe(3000);
  });

  it("not before its notice is up", async () => {
    const { shopify, subscriber } = await renewing("APPLY_AT_RENEWAL", {
      effectiveAt: days(5),
    });
    await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
    expect(shopify.state.drafts).toBe(0);
    expect(shopify.charges()[0].total).toBe(80);
  });

  it("not to someone who signed up since, who already pays it", async () => {
    const { shop, shopify, plan } = await renewing("APPLY_AT_RENEWAL");
    const newer = await newSubscriber(shop, shopify, plan, {
      termEndsAt: days(-1),
      createdAt: NOW,
    });
    await renewIfDue(db(), env.DB, shopify.graphql, newer.id, NOW);
    expect(shopify.state.drafts).toBe(0);
  });

  it("the latest change is the one that counts, so a merchant can take one back", async () => {
    const { shopify, plan, subscriber } = await renewing("APPLY_AT_RENEWAL");
    await db().priceChange.create({
      data: {
        planId: plan.id,
        newPriceCents: 4000,
        policy: "KEEP_OLD_PRICE",
        effectiveAt: NOW,
        createdAt: days(1),
      },
    });
    await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
    expect(shopify.state.drafts).toBe(0);
    expect(shopify.charges()[0].total).toBe(80);
  });

  it("never applies to a charge already attempted, including its retries", async () => {
    const { shopify, plan, subscriber } = await renewing(null);
    shopify.state.decline = "INSUFFICIENT_FUNDS";
    await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
    await deliverWebhooks(shopify);
    await db().priceChange.create({
      data: {
        planId: plan.id,
        newPriceCents: 5000,
        policy: "APPLY_AT_RENEWAL",
        effectiveAt: days(1),
      },
    });
    shopify.state.decline = null;
    const [attempt] = await attemptsOf(subscriber.id);
    await retryDue(db(), env.DB, shopify.graphql, attempt.id, days(3));
    expect(shopify.state.drafts).toBe(0);
    expect(shopify.charges()[0].total).toBe(80);
    expect((await row(subscriber.id)).lockedPriceCents).toBe(4000);
  });

  it("the crash after the new price and before the charge is safe to repeat", async () => {
    const { shopify, subscriber } = await renewing("APPLY_AT_RENEWAL");
    const contract = shopify.contracts.get(subscriber.contractGid!);
    contract.lines.nodes[0].currentPrice.amount = "50.0";
    await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
    expect(shopify.state.drafts).toBe(0);
    expect((await row(subscriber.id)).lockedPriceCents).toBe(5000);
  });

  it("updatePlan records the merchant's choice, and only when the price moved", async () => {
    const shop = await newShop();
    const plan = await newPlan(shop);
    const input = {
      name: "Plan",
      displayName: "Plan",
      billingMode: "PREPAID_BUNDLE",
      releasesPerTerm: 2,
      termMonths: 12,
      renewalRule: "TERM_DATE_HOLD_IF_LATE",
      startRule: "NEXT",
      priceCents: 4000,
      autoRenew: true,
      giftable: false,
      productGid: "gid://shopify/Product/1",
      productTitle: "Thing",
    } as const;
    await updatePlan(db(), shop.id, plan.id, input);
    expect(await db().priceChange.count({ where: { planId: plan.id } })).toBe(0);

    await updatePlan(db(), shop.id, plan.id, { ...input, priceCents: 5000 }, "APPLY_AT_RENEWAL", NOW);
    const [change] = await db().priceChange.findMany({ where: { planId: plan.id } });
    expect(change).toMatchObject({
      newPriceCents: 5000,
      policy: "APPLY_AT_RENEWAL",
      effectiveAt: days(30),
      noticeSentAt: null,
    });

    await updatePlan(db(), shop.id, plan.id, { ...input, priceCents: 6000 });
    expect(await db().priceChange.count({ where: { planId: plan.id } })).toBe(2);
    expect((await db().plan.findUniqueOrThrow({ where: { id: plan.id } })).priceCents).toBe(6000);
  });
});

describe("a chargeback", () => {
  it("pauses, holds even a paid release, and only the merchant ends it", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, { renewalRule: "TERM_DATE" });
    const subscriber = await newSubscriber(shop, shopify, plan, {
      releasesRemaining: 1,
      termEndsAt: days(-1),
    });
    const waiting = await newRelease(shop, 1, "READY", { productGid: null });
    await createDueDeliveries(env.DB, shop.id, waiting.id, NOW);
    expect((await deliveryOf(subscriber.id, waiting.id))?.status).toBe("PENDING");

    await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
    await deliverWebhooks(shopify);
    const orderGid = shopify.charges()[0].order!;
    await recordChargeback(db(), env.DB, shopify.graphql, orderGid, NOW);
    expect(await row(subscriber.id)).toMatchObject({
      status: "PAUSED",
      pausedReason: "CHARGEBACK",
      releasesRemaining: 3,
    });
    expect((await deliveryOf(subscriber.id, waiting.id))?.status).toBe("HELD");

    // A paid balance doesn't ship through a run, and the next release is held too.
    const next = await newRelease(shop, 2);
    await drain(shop, shopify, next.id);
    expect((await deliveryOf(subscriber.id, next.id))?.status).toBe("HELD");
    expect(shopify.orders).toHaveLength(0);

    // The system can't end it: a follow-up job finds a paused subscriber and leaves it.
    expect(
      await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, false, NOW),
    ).toEqual([]);
    expect((await row(subscriber.id)).pausedReason).toBe("CHARGEBACK");

    await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, true, NOW);
    expect(await row(subscriber.id)).toMatchObject({
      status: "ACTIVE",
      pausedReason: null,
      paymentProblemSince: null,
    });
    expect((await deliveryOf(subscriber.id, next.id))?.status).toBe("PENDING");
    expect(shopify.charges()).toHaveLength(1);
    await drain(shop, shopify, next.id);
    expect(shopify.orders).toHaveLength(1);
  });

  it("a dispute on someone else's order changes nothing", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop);
    const subscriber = await newSubscriber(shop, shopify, plan);
    await recordChargeback(db(), env.DB, shopify.graphql, "gid://shopify/Order/none", NOW);
    expect((await row(subscriber.id)).status).toBe("ACTIVE");
  });

  it("stays flagged through a cancellation, so the paid balance doesn't ship", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, { renewalRule: "TERM_DATE" });
    const subscriber = await newSubscriber(shop, shopify, plan, {
      termEndsAt: days(-1),
      releasesRemaining: 1,
    });
    await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
    await deliverWebhooks(shopify);
    await recordChargeback(db(), env.DB, shopify.graphql, shopify.charges()[0].order!, NOW);
    shopify.contracts.get(subscriber.contractGid!).status = "CANCELLED";
    const release = await newRelease(shop, 1);
    await db().subscription.update({
      where: { id: subscriber.id },
      data: { status: "CANCELLED" },
    });
    await drain(shop, shopify, release.id);
    expect((await deliveryOf(subscriber.id, release.id))?.status).toBe("HELD");
    expect(shopify.orders).toHaveLength(0);
  });
});

describe("ending a chargeback hold on a cancelled subscription", () => {
  /** Charged, disputed, then its contract is cancelled, with `paid` releases left. */
  async function cancelledUnderChargeback(
    paid: number,
    billingMode: "PER_RELEASE" | "PREPAID_BUNDLE" = "PREPAID_BUNDLE",
  ) {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, {
      renewalRule: "TERM_DATE",
      billingMode,
      termMonths: billingMode === "PER_RELEASE" ? null : 12,
    });
    const subscriber = await newSubscriber(shop, shopify, plan, {
      termEndsAt: days(300),
    });
    const contract = (await row(subscriber.id)).contractGid!;
    await shopify.graphql("BillingAttemptCreate", {
      contract,
      input: { idempotencyKey: `sign-up-${n}` },
    });
    await recordChargeback(db(), env.DB, shopify.graphql, shopify.charges()[0].order!, NOW);
    await db().subscription.update({
      where: { id: subscriber.id },
      data: { releasesRemaining: paid },
    });
    return { shop, shopify, subscriber, chargesBefore: shopify.state.creates };
  }

  it("clears the flag, stays cancelled, charges nothing, and the balance ships on the next release", async () => {
    const { shop, shopify, subscriber, chargesBefore } = await cancelledUnderChargeback(2);
    // Its Delivery on an open release is HELD, and the cancellation closes that one.
    const open = await newRelease(shop, 1, "READY", { productGid: null });
    await createDueDeliveries(env.DB, shop.id, open.id, NOW);
    expect((await deliveryOf(subscriber.id, open.id))?.status).toBe("HELD");
    await markCancelled(env.DB, subscriber.id, NOW);
    expect(await row(subscriber.id)).toMatchObject({
      status: "CANCELLED",
      pausedReason: "CHARGEBACK",
      releasesRemaining: 2,
    });
    expect((await deliveryOf(subscriber.id, open.id))?.status).toBe("CANCELLED");

    expect(
      await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, true, NOW),
    ).toEqual([]);
    expect(await row(subscriber.id)).toMatchObject({
      status: "CANCELLED",
      pausedReason: null,
      paymentProblemSince: null,
      releasesRemaining: 2,
    });
    expect((await listPaymentProblems(db(), shop.id)).rows).toEqual([]);

    const next = await newRelease(shop, 2);
    await drain(shop, shopify, next.id);
    expect((await deliveryOf(subscriber.id, next.id))?.status).toBe("ORDERED");
    expect(shopify.orders).toHaveLength(1);
    expect((await row(subscriber.id)).releasesRemaining).toBe(1);
    expect(shopify.state.creates).toBe(chargesBefore);
  });

  it("a release held since the cancellation ships at once when the hold ends", async () => {
    const { shop, shopify, subscriber, chargesBefore } = await cancelledUnderChargeback(1);
    await markCancelled(env.DB, subscriber.id, NOW);
    const release = await newRelease(shop, 1);
    await drain(shop, shopify, release.id);
    expect((await deliveryOf(subscriber.id, release.id))?.status).toBe("HELD");
    expect(shopify.orders).toHaveLength(0);

    const jobs = await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, true, NOW);
    expect(jobs.map((job) => job.data?.releaseId)).toEqual([release.id]);
    await drain(shop, shopify, release.id);
    expect((await deliveryOf(subscriber.id, release.id))?.status).toBe("ORDERED");
    expect(await row(subscriber.id)).toMatchObject({
      status: "CANCELLED",
      releasesRemaining: 0,
    });
    expect(shopify.state.creates).toBe(chargesBefore);
  });

  it("a failed renewal left over from before charges nothing, and the held release still goes at once", async () => {
    const { shop, shopify, subscriber, chargesBefore } = await cancelledUnderChargeback(1);
    const key = termChargeFor(days(-1));
    await db().billingAttempt.create({
      data: {
        subscriptionId: subscriber.id,
        chargeFor: key,
        idempotencyKey: billingAttemptKey(subscriber.id, key, 1),
        attempt: 1,
        result: "FAILED",
      },
    });
    await markCancelled(env.DB, subscriber.id, NOW);
    const release = await newRelease(shop, 1);
    await createDueDeliveries(env.DB, shop.id, release.id, NOW);
    const jobs = await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, true, NOW);
    expect(jobs.map((job) => job.data?.releaseId)).toEqual([release.id]);
    expect(shopify.state.creates).toBe(chargesBefore);
    expect(await attemptsOf(subscriber.id)).toHaveLength(1);
  });

  it("what the balance doesn't cover is closed and never charged, on either billing mode", async () => {
    for (const mode of ["PER_RELEASE", "PREPAID_BUNDLE"] as const) {
      const { shop, shopify, subscriber, chargesBefore } = await cancelledUnderChargeback(0, mode);
      await markCancelled(env.DB, subscriber.id, NOW);
      const release = await newRelease(shop, 1);
      await createDueDeliveries(env.DB, shop.id, release.id, NOW);
      expect((await deliveryOf(subscriber.id, release.id))?.status).toBe("HELD");
      expect(
        await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, true, NOW),
      ).toEqual([]);
      expect((await deliveryOf(subscriber.id, release.id))?.status).toBe("CANCELLED");
      expect(await row(subscriber.id)).toMatchObject({
        status: "CANCELLED",
        pausedReason: null,
        paymentProblemSince: null,
      });
      expect(shopify.state.creates).toBe(chargesBefore);
      // Nor does it come back as a charge on any later run.
      const next = await newRelease(shop, 2);
      await drain(shop, shopify, next.id);
      expect(await deliveryOf(subscriber.id, next.id)).toBeNull();
      expect(shopify.state.creates).toBe(chargesBefore);
    }
  });

  it("only the merchant ends it, and a cancelled subscription with no chargeback is left alone", async () => {
    const { shopify, subscriber } = await cancelledUnderChargeback(1);
    await markCancelled(env.DB, subscriber.id, NOW);
    await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, false, NOW);
    expect((await row(subscriber.id)).pausedReason).toBe("CHARGEBACK");

    const shop = await newShop();
    const plan = await newPlan(shop, { renewalRule: "TERM_DATE" });
    const plain = await newSubscriber(shop, shopify, plan, {
      status: "CANCELLED",
      termEndsAt: days(-1),
    });
    const before = shopify.state.creates;
    expect(
      await retryCharge(db(), env.DB, shopify.graphql, plain.id, true, NOW),
    ).toEqual([]);
    expect((await row(plain.id)).status).toBe("CANCELLED");
    expect(shopify.state.creates).toBe(before);
  });

  it("a contract reactivated under a chargeback stays flagged until the merchant ends it", async () => {
    const { shopify, subscriber } = await cancelledUnderChargeback(1);
    await db().subscription.update({
      where: { id: subscriber.id },
      data: { status: "ACTIVE" },
    });
    await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, false, NOW);
    expect((await row(subscriber.id)).pausedReason).toBe("CHARGEBACK");
  });
});

describe("the webhook routes only enqueue", () => {
  async function post(
    handler: (args: ActionFunctionArgs) => Promise<Response>,
    topic: string,
    shop: string,
    payload: object,
  ) {
    const body = JSON.stringify(payload);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.SHOPIFY_API_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const sent: { body: Job }[] = [];
    const response = await handler({
      request: new Request(`https://app.example.com/webhooks/${topic}`, {
        method: "POST",
        body,
        headers: {
          "X-Shopify-Hmac-Sha256": btoa(String.fromCharCode(...new Uint8Array(signature))),
          "X-Shopify-Topic": topic,
          "X-Shopify-Shop-Domain": shop,
          "X-Shopify-API-Version": "2026-10",
          "X-Shopify-Webhook-Id": `webhook-${++n}`,
        },
      }),
      context: {
        cloudflare: {
          env: {
            JOBS: {
              sendBatch: async (messages: { body: Job }[]) => {
                sent.push(...messages);
              },
            },
          },
        },
      },
    } as unknown as ActionFunctionArgs);
    return { status: response.status, jobs: sent.map((message) => message.body) };
  }

  it("a billing attempt's result becomes one job, keyed on the webhook", async () => {
    const attemptGid = "gid://shopify/SubscriptionBillingAttempt/1";
    const { status, jobs } = await post(
      billingWebhook,
      "subscription_billing_attempts/failure",
      "billing-hook.myshopify.com",
      { admin_graphql_api_id: attemptGid },
    );
    expect(status).toBe(200);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      type: "billing.settle",
      shop: "billing-hook.myshopify.com",
      data: { attemptGid },
    });
    expect(jobs[0].id).toContain(`:webhook-${n}`);
  });

  it("a chargeback becomes a job, and an inquiry doesn't", async () => {
    const shop = "billing-hook.myshopify.com";
    const chargeback = await post(disputeWebhook, "disputes/create", shop, {
      order_id: 42,
      type: "chargeback",
    });
    expect(chargeback.jobs[0]).toMatchObject({
      type: "billing.dispute",
      data: { orderGid: "gid://shopify/Order/42" },
    });
    const inquiry = await post(disputeWebhook, "disputes/create", shop, {
      order_id: 42,
      type: "inquiry",
    });
    expect(inquiry.status).toBe(200);
    expect(inquiry.jobs).toEqual([]);
  });
});

describe("contracts from Step 8, with no card and no origin order", () => {
  it("a future term date finds nothing, however often the tick looks", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop);
    const subscriber = await newSubscriber(shop, shopify, plan, {
      termEndsAt: days(300),
    });
    await install(shop);
    for (const find of [findRenewals, findRetries, findLostResults]) {
      expect(
        (await find(finderContext(NOW))).filter((job) =>
          job.id.includes(subscriber.id),
        ),
      ).toEqual([]);
    }
  });
});

describe("a gift is never charged", () => {
  const noMoney = (shopify: Shopify) => {
    expect(shopify.state.creates).toBe(0);
    expect(shopify.attempts.size).toBe(0);
  };

  for (const renewalRule of ["TERM_DATE_HOLD_IF_LATE", "TERM_DATE", "ON_DEPLETION"] as const) {
    it(`${renewalRule}: its releases ship, then the tick, an order and a renewal check leave it alone`, async () => {
      const shop = await newShop();
      const shopify = fakeShopify();
      const plan = await newPlan(shop, { renewalRule });
      const gift = await newSubscriber(shop, shopify, plan, {
        source: "GIFT",
        releasesRemaining: 2,
        termEndsAt: days(-1),
      });
      await install(shop);
      const first = await newRelease(shop, 1);
      const second = await newRelease(shop, 2);
      await drain(shop, shopify, first.id);
      expect((await row(gift.id)).releasesRemaining).toBe(1);
      await drain(shop, shopify, second.id);
      // Both paid releases have shipped and nothing remains: the point at which a bundle renews.
      expect((await row(gift.id)).releasesRemaining).toBe(0);
      expect(shopify.orders).toHaveLength(2);

      expect(renewalDue(await row(gift.id), plan, NOW)).toBe(false);
      expect(await renewIfDue(db(), env.DB, shopify.graphql, gift.id, NOW)).toBeNull();
      const context = finderContext(days(1));
      for (const finder of [findRenewals, findRetries, findLostResults]) {
        expect(jobsFor(await finder(context), gift.id)).toHaveLength(0);
      }
      noMoney(shopify);
      expect(await attemptsOf(gift.id)).toHaveLength(0);
    });
  }

  it("a per-release plan's gift is its one paid release: later releases are neither charged nor shipped", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, {
      billingMode: "PER_RELEASE",
      releasesPerTerm: 1,
      termMonths: null,
    });
    const gift = await newSubscriber(shop, shopify, plan, {
      source: "GIFT",
      releasesRemaining: 1,
    });
    const releases = [await newRelease(shop, 1), await newRelease(shop, 2), await newRelease(shop, 3)];
    for (const release of releases) await drain(shop, shopify, release.id);
    expect(shopify.orders).toHaveLength(1);
    expect(await db().delivery.count({ where: { subscriptionId: gift.id } })).toBe(1);
    noMoney(shopify);
  });

  describe("the ways a charge can be asked for", () => {
    // A gift that somehow has a failed term charge on record, and is flagged as a payment problem:
    // what every retry path would act on for an ordinary subscriber.
    async function failing(overrides: { status?: SubscriptionStatus; pausedReason?: string } = {}) {
      const shop = await newShop();
      const shopify = fakeShopify();
      const plan = await newPlan(shop, { renewalRule: "TERM_DATE" });
      const gift = await newSubscriber(shop, shopify, plan, {
        source: "GIFT",
        releasesRemaining: 1,
        termEndsAt: days(-1),
      });
      const chargeFor = termChargeFor(days(-1));
      await db().subscription.update({
        where: { id: gift.id },
        data: { paymentProblemSince: days(-2), ...overrides },
      });
      const attempt = await db().billingAttempt.create({
        data: {
          subscriptionId: gift.id,
          chargeFor,
          idempotencyKey: billingAttemptKey(gift.id, chargeFor, 1),
          attempt: 1,
          result: "FAILED",
          errorCode: "CARD_DECLINED",
          nextRetryAt: days(-1),
          createdAt: days(-2),
        },
      });
      return { shop, shopify, gift, attempt, chargeFor };
    }

    it("the scheduled retry", async () => {
      const { shopify, attempt } = await failing();
      await retryDue(db(), env.DB, shopify.graphql, attempt.id, NOW);
      noMoney(shopify);
    });

    it("the merchant's Retry charge, and the portal's try again", async () => {
      const { shopify, gift } = await failing({ status: "PAUSED", pausedReason: "FAILED_PAYMENT" });
      await retryCharge(db(), env.DB, shopify.graphql, gift.id, true, NOW);
      await retryCharge(db(), env.DB, shopify.graphql, gift.id, false, NOW);
      noMoney(shopify);
    });

    it("the buyer saving a new card, and the recipient saving one", async () => {
      const { shop, shopify, gift } = await failing();
      // The webhook finds subscriptions by the saving customer, who here is the gift's own customer.
      expect(await resumeAfterCardUpdate(db(), shop.shopDomain, gift.customerGid, NOW)).toEqual([]);
      await retryCharge(db(), env.DB, shopify.graphql, gift.id, false, NOW, true);
      await runResumeJob(
        db(),
        env.DB,
        shopify.graphql,
        { type: BILLING_RESUME_JOB, id: "x", shop: shop.shopDomain, data: { subscriptionId: gift.id, byMerchant: false, savedCard: true } },
        NOW,
      );
      noMoney(shopify);
    });

    it("a chargeback ended by the merchant", async () => {
      const { shopify, gift } = await failing({ status: "PAUSED", pausedReason: "CHARGEBACK" });
      await retryCharge(db(), env.DB, shopify.graphql, gift.id, true, NOW);
      noMoney(shopify);
      expect((await row(gift.id)).pausedReason).toBeNull();
    });

    it("a charge whose result never arrived is dropped, not sent again", async () => {
      const { shopify, gift, chargeFor } = await failing();
      const lost = await db().billingAttempt.create({
        data: {
          subscriptionId: gift.id,
          chargeFor,
          idempotencyKey: billingAttemptKey(gift.id, chargeFor, 2),
          attempt: 2,
          createdAt: days(-1),
        },
      });
      await recoverAttempt(db(), env.DB, shopify.graphql, lost.id, NOW);
      noMoney(shopify);
      expect(await db().billingAttempt.findUnique({ where: { id: lost.id } })).toBeNull();
    });
  });
});

describe("a contract paused in Shopify when a retry comes round", () => {
  it("stays a payment problem the merchant can see and retry, rather than an unpaid renewal nobody is told about", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, { renewalRule: "TERM_DATE" });
    const subscriber = await newSubscriber(shop, shopify, plan, { termEndsAt: days(-1) });
    shopify.state.decline = "INSUFFICIENT_FUNDS";
    await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
    await deliverWebhooks(shopify);
    const [failed] = await attemptsOf(subscriber.id);

    shopify.contracts.get(subscriber.contractGid!).status = "PAUSED";
    await retryDue(db(), env.DB, shopify.graphql, failed.id, days(3));
    expect((await row(subscriber.id)).paymentProblemSince).not.toBeNull();
    expect((await attemptsOf(subscriber.id))[0].nextRetryAt).toBeNull();

    shopify.contracts.get(subscriber.contractGid!).status = "ACTIVE";
    shopify.state.decline = null;
    await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, true, days(4));
    await deliverWebhooks(shopify);
    expect(shopify.charges()).toHaveLength(1);
    expect((await row(subscriber.id)).paymentProblemSince).toBeNull();
  });
});

describe("Step 9's edges", () => {
  const perRelease = (shop: TestShop) =>
    newPlan(shop, { billingMode: "PER_RELEASE", releasesPerTerm: 1, termMonths: null });

  it("a per-release contract with no address isn't charged for an order Shopify would refuse", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await perRelease(shop);
    const subscriber = await newSubscriber(shop, shopify, plan);
    const release = await newRelease(shop, 1);
    shopify.contracts.get(subscriber.contractGid!).deliveryMethod = {};
    await drain(shop, shopify, release.id);

    expect(shopify.attempts.size).toBe(0);
    const delivery = await deliveryOf(subscriber.id, release.id);
    expect(delivery).toMatchObject({ status: "PENDING", orderGid: null });
    expect(delivery?.orderError).toContain("no delivery address");
    expect((await row(subscriber.id)).paymentProblemSince).toBeNull();

    // Once it has one, choosing the product again is the retry, as for any refused order.
    shopify.contracts.get(subscriber.contractGid!).deliveryMethod = { address: { address1: "1 Test St" } };
    await db().delivery.updateMany({ where: { releaseId: release.id }, data: { orderError: null } });
    await drain(shop, shopify, release.id);
    expect(shopify.attempts.size).toBe(1);
  });

  it("a bundle's renewal doesn't need an address, because it buys no one order", async () => {
    const shop = await newShop();
    const shopify = fakeShopify();
    const plan = await newPlan(shop, { renewalRule: "TERM_DATE" });
    const subscriber = await newSubscriber(shop, shopify, plan, { termEndsAt: days(-1) });
    shopify.contracts.get(subscriber.contractGid!).deliveryMethod = {};
    await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
    expect(shopify.charges()).toHaveLength(1);
  });

  const heldEnv = { DB: env.DB, JOBS: { sendBatch: async () => {} } } as any;

  async function pausedOnPreorder() {
    const shop = await newShop("PREORDER_OPENS");
    const shopify = fakeShopify();
    const plan = await perRelease(shop);
    const subscriber = await newSubscriber(shop, shopify, plan);
    const release = await newRelease(shop, 5, "PREORDER");
    await newRelease(shop, 4, "SHIPPED");
    shopify.state.decline = "EXPIRED_CARD";
    await slice(shop, shopify, release.id);
    await db().release.update({ where: { id: release.id }, data: { runLeaseUntil: null } });
    await deliverWebhooks(shopify);
    expect(await row(subscriber.id)).toMatchObject({ status: "PAUSED", pausedReason: "FAILED_PAYMENT" });
    expect((await deliveryOf(subscriber.id, release.id))?.status).toBe("HELD");
    return { shop, shopify, plan, subscriber, release };
  }

  it("cancelling the release a paused subscriber's charge was for ends the problem, with nothing to press", async () => {
    const { shop, subscriber, release } = await pausedOnPreorder();
    expect((await moveRelease(db(), heldEnv, { ...shop, shopDomain: shop.shopDomain }, release.id, "cancel", NOW)).ok).toBe(true);
    expect(await row(subscriber.id)).toMatchObject({
      status: "ACTIVE",
      pausedReason: null,
      paymentProblemSince: null,
      releasesRemaining: 0,
    });
    expect((await deliveryOf(subscriber.id, release.id))?.status).toBe("CANCELLED");
    expect((await listPaymentProblems(db(), shop.id)).rows).toHaveLength(0);
  });

  it("but leaves a chargeback, another held release and a bundle's unpaid renewal as they are", async () => {
    const hold = await pausedOnPreorder();
    await db().subscription.update({ where: { id: hold.subscriber.id }, data: { pausedReason: "CHARGEBACK" } });
    await moveRelease(db(), heldEnv, { ...hold.shop, shopDomain: hold.shop.shopDomain }, hold.release.id, "cancel", NOW);
    expect(await row(hold.subscriber.id)).toMatchObject({ status: "PAUSED", pausedReason: "CHARGEBACK" });

    const two = await pausedOnPreorder();
    const other = await newRelease(two.shop, 6, "PREORDER");
    await db().delivery.create({ data: { subscriptionId: two.subscriber.id, releaseId: other.id, status: "HELD" } });
    await moveRelease(db(), heldEnv, { ...two.shop, shopDomain: two.shop.shopDomain }, two.release.id, "cancel", NOW);
    expect(await row(two.subscriber.id)).toMatchObject({ status: "PAUSED", pausedReason: "FAILED_PAYMENT" });

    const shop = await newShop("PREORDER_OPENS");
    const shopify = fakeShopify();
    const bundle = await newPlan(shop);
    const subscriber = await newSubscriber(shop, shopify, bundle, { status: "PAUSED" });
    await db().subscription.update({
      where: { id: subscriber.id },
      data: { pausedReason: "FAILED_PAYMENT", paymentProblemSince: NOW },
    });
    const release = await newRelease(shop, 1, "PREORDER");
    await db().delivery.create({ data: { subscriptionId: subscriber.id, releaseId: release.id, status: "HELD" } });
    await moveRelease(db(), heldEnv, { ...shop, shopDomain: shop.shopDomain }, release.id, "cancel", NOW);
    expect(await row(subscriber.id)).toMatchObject({ status: "PAUSED", pausedReason: "FAILED_PAYMENT" });
  });

  describe("a contract reactivated in Shopify", () => {
    const reactivated = (shopify: Shopify, subscriber: { contractGid: string | null }, sellingPlanGid: string | null) => {
      const graphql: Graphql = async (query, variables) =>
        query.includes("ContractForSync")
          ? {
              subscriptionContract: {
                id: subscriber.contractGid,
                status: "ACTIVE",
                createdAt: days(-100).toISOString(),
                customer: { id: "gid://shopify/Customer/1" },
                originOrder: null,
                customAttributes: [],
                lines: { nodes: [{ quantity: 1, sellingPlanId: sellingPlanGid, currentPrice: { amount: "40.0" } }] },
              },
            }
          : shopify.graphql(query, variables);
      return graphql;
    };

    it("isn't charged for a release already open, and joins the next one", async () => {
      const shop = await newShop();
      const shopify = fakeShopify();
      const plan = await perRelease(shop);
      const subscriber = await newSubscriber(shop, shopify, plan, { status: "CANCELLED" });
      const open = await newRelease(shop, 2);
      await syncContract(db(), env.DB, reactivated(shopify, subscriber, plan.sellingPlanGid), shop, subscriber.contractGid!, NOW);
      expect(await row(subscriber.id)).toMatchObject({ status: "ACTIVE", firstReleaseNumber: 3 });
      await drain(shop, shopify, open.id);
      expect(shopify.attempts.size).toBe(0);
      expect(await deliveryOf(subscriber.id, open.id)).toBeNull();

      const next = await newRelease(shop, 3);
      await drain(shop, shopify, next.id);
      expect(shopify.attempts.size).toBe(1);
    });

    it("keeps its place if it still has paid releases, which are still owed", async () => {
      const shop = await newShop();
      const shopify = fakeShopify();
      const plan = await newPlan(shop);
      const subscriber = await newSubscriber(shop, shopify, plan, { status: "CANCELLED", releasesRemaining: 1 });
      await newRelease(shop, 2);
      await syncContract(db(), env.DB, reactivated(shopify, subscriber, plan.sellingPlanGid), shop, subscriber.contractGid!, NOW);
      expect(await row(subscriber.id)).toMatchObject({ status: "ACTIVE", firstReleaseNumber: 1 });
    });

    describe("with its renewal already failed on this term", () => {
      async function failedRenewal() {
        const shop = await newShop();
        const shopify = fakeShopify();
        const plan = await newPlan(shop, { renewalRule: "TERM_DATE_HOLD_IF_LATE" });
        const subscriber = await newSubscriber(shop, shopify, plan, { termEndsAt: days(-30) });
        shopify.state.decline = "INSUFFICIENT_FUNDS";
        await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, days(-29));
        await deliverWebhooks(shopify, days(-29));
        await markCancelled(env.DB, subscriber.id, days(-20));
        shopify.state.decline = null;
        const before = shopify.attempts.size;
        await syncContract(db(), env.DB, reactivated(shopify, subscriber, plan.sellingPlanGid), shop, subscriber.contractGid!, NOW);
        return { shop, shopify, subscriber, before };
      }

      it("is flagged as a payment problem and charges nothing by itself, because that would give no notice", async () => {
        const { shop, shopify, subscriber, before } = await failedRenewal();
        expect(await row(subscriber.id)).toMatchObject({
          status: "PAUSED",
          pausedReason: "FAILED_PAYMENT",
          paymentProblemSince: NOW,
        });
        expect((await listPaymentProblems(db(), shop.id)).rows.map((r) => r.id)).toContain(subscriber.id);

        await install(shop);
        expect((await findRenewals({ env, db: db(), now: NOW })).filter((j) => j.data?.subscriptionId === subscriber.id)).toEqual([]);
        expect((await findRetries({ env, db: db(), now: NOW })).filter((j) => j.shop === shop.shopDomain)).toEqual([]);
        await renewIfDue(db(), env.DB, shopify.graphql, subscriber.id, NOW);
        expect(shopify.attempts.size).toBe(before);
        expect(shopify.charges()).toHaveLength(0);
      });

      it("a merchant's Retry charge is what renews it, once", async () => {
        const { shopify, subscriber } = await failedRenewal();
        await retryCharge(db(), env.DB, shopify.graphql, subscriber.id, true, NOW);
        await deliverWebhooks(shopify);
        expect(shopify.charges()).toHaveLength(1);
        expect(await row(subscriber.id)).toMatchObject({ status: "ACTIVE", paymentProblemSince: null, releasesRemaining: 2 });
      });

      it("isn't flagged with no failed attempt on this term, or an old one on a term since paid", async () => {
        const shop = await newShop();
        const shopify = fakeShopify();
        const plan = await newPlan(shop);
        const fresh = await newSubscriber(shop, shopify, plan, { status: "CANCELLED", termEndsAt: days(-5) });
        await db().billingAttempt.create({
          data: {
            subscriptionId: fresh.id,
            chargeFor: termChargeFor(days(-400)),
            idempotencyKey: billingAttemptKey(fresh.id, termChargeFor(days(-400)), 1),
            attempt: 1,
            result: "FAILED",
          },
        });
        await syncContract(db(), env.DB, reactivated(shopify, fresh, plan.sellingPlanGid), shop, fresh.contractGid!, NOW);
        expect(await row(fresh.id)).toMatchObject({ status: "ACTIVE", paymentProblemSince: null, pausedReason: null });
      });
    });

    it("stays held if a chargeback outlasted the cancellation", async () => {
      const shop = await newShop();
      const shopify = fakeShopify();
      const plan = await perRelease(shop);
      const subscriber = await newSubscriber(shop, shopify, plan, { status: "CANCELLED" });
      await db().subscription.update({
        where: { id: subscriber.id },
        data: { pausedReason: "CHARGEBACK", paymentProblemSince: NOW },
      });
      await syncContract(db(), env.DB, reactivated(shopify, subscriber, plan.sellingPlanGid), shop, subscriber.contractGid!, NOW);
      expect(await row(subscriber.id)).toMatchObject({ status: "PAUSED", pausedReason: "CHARGEBACK" });
    });
  });
});

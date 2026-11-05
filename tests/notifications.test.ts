/* eslint-disable @typescript-eslint/no-explicit-any -- fakes of Shopify's loosely typed responses */
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../app/db.server";
import { runFlowSlice, triggerFor } from "../app/flow.server";
import { redactCustomer, redactShop, recordDataRequest } from "../app/gdpr.server";
import { runMemberTagSlice } from "../app/member-tag.server";
import {
  CANCELLED_EVENT,
  EMAIL_JOB,
  flowJob,
  LAST_RELEASE_EVENT,
  memberTagJob,
  PAUSED_EVENT,
  STARTED_EVENT,
} from "../app/notification-jobs";
import { getOrCreateShop } from "../app/shop.server";
import { markCancelled, syncContract } from "../app/subscriptions.server";
import { jobHandlers, dueWorkFinders } from "../app/jobs/registry.server";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const db = () => createDb(env.DB);
let n = 0;
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

async function setupShop(planData: Record<string, unknown> = {}) {
  const domain = `notify${++n}.myshopify.com`;
  const shop = await getOrCreateShop(db(), domain);
  const plan = await db().plan.create({
    data: {
      shopId: shop.id,
      name: "Yearly",
      displayName: "Yearly subscription",
      priceCents: 4000,
      billingMode: "PREPAID_BUNDLE",
      releasesPerTerm: 2,
      termMonths: 12,
      sellingPlanGid: `gid://shopify/SellingPlan/${++n}`,
      ...planData,
    },
  });
  return { shop, domain, plan };
}
type Setup = Awaited<ReturnType<typeof setupShop>>;

const subscribe = (s: Setup, data: Record<string, unknown> = {}) =>
  db().subscription.create({
    data: {
      shopId: s.shop.id,
      planId: s.plan.id,
      contractGid: `gid://shopify/SubscriptionContract/${++n}`,
      customerGid: `gid://shopify/Customer/${++n}`,
      releasesRemaining: 1,
      ...data,
    },
  });

const event = (s: Setup, subscriptionId: string, type: string, payload: object = {}, age = 0.1) =>
  db().event.create({
    data: { id: `${type}:${++n}`, shopId: s.shop.id, subscriptionId, type, payload, createdAt: ago(age) },
  });

// ---- Flow ----------------------------------------------------------------------------------

function flowShopify(options: { fail?: boolean; refuse?: boolean } = {}) {
  const received: { handle: string; payload: any }[] = [];
  const graphql = async (_query: string, variables: any) => {
    if (options.fail) throw new Error("Admin API returned errors");
    received.push(variables);
    return {
      flowTriggerReceive: {
        userErrors: options.refuse ? [{ field: ["payload"], message: "refused" }] : [],
      },
    };
  };
  return { received, graphql };
}

const runFlow = (s: Setup, graphql: any, key = `k${++n}`) =>
  runFlowSlice(env.DB, async () => graphql, flowJob(s.domain, key), () => NOW);

describe("Flow triggers", () => {
  it("maps each event to a trigger with IDs and plan names only", () => {
    const base = { id: "e", payload: "{}", customerGid: "gid://shopify/Customer/42", displayName: "Yearly" };
    expect(triggerFor({ ...base, type: STARTED_EVENT })).toEqual({
      handle: "subscription-started",
      properties: { customer_id: 42, Plan: "Yearly" },
    });
    expect(triggerFor({ ...base, type: "billing.failed", payload: '{"nextRetryAt":"2026-11-10"}' })?.properties).toMatchObject({ "Will retry": true });
    expect(triggerFor({ ...base, type: "billing.failed", payload: '{"nextRetryAt":null}' })?.properties).toMatchObject({ "Will retry": false });
    expect(triggerFor({ ...base, type: PAUSED_EVENT })).toMatchObject({ handle: "subscription-paused-or-cancelled", properties: { Status: "paused", Reason: "failed payment" } });
    expect(triggerFor({ ...base, type: "billing.chargeback" })).toMatchObject({ handle: "subscription-paused-or-cancelled", properties: { Status: "paused", Reason: "chargeback" } });
    expect(triggerFor({ ...base, type: CANCELLED_EVENT })).toMatchObject({ handle: "subscription-paused-or-cancelled", properties: { Status: "cancelled" } });
    expect(triggerFor({ ...base, type: LAST_RELEASE_EVENT })?.handle).toBe("last-release-shipped");
    expect(triggerFor({ ...base, type: "billing.succeeded" })).toBeNull();
  });

  it("sends each event once, however often the job runs", async () => {
    const s = await setupShop();
    const sub = await subscribe(s);
    const started = await event(s, sub.id, STARTED_EVENT);
    await event(s, sub.id, "billing.succeeded"); // not a trigger
    const flow = flowShopify();
    await runFlow(s, flow.graphql);
    await runFlow(s, flow.graphql);
    await Promise.all([runFlow(s, flow.graphql), runFlow(s, flow.graphql)]);
    expect(flow.received).toEqual([
      { handle: "subscription-started", payload: { customer_id: Number(sub.customerGid.split("/").pop()), Plan: "Yearly subscription" } },
    ]);
    expect((await db().event.findUniqueOrThrow({ where: { id: started.id } })).sentToFlowAt).not.toBeNull();
  });

  it("gives the claim back when Flow can't be reached, and doesn't resend what Flow refused", async () => {
    const s = await setupShop();
    const sub = await subscribe(s);
    const down = await event(s, sub.id, STARTED_EVENT);
    await runFlow(s, flowShopify({ fail: true }).graphql);
    expect((await db().event.findUniqueOrThrow({ where: { id: down.id } })).sentToFlowAt).toBeNull();
    const flow = flowShopify();
    await runFlow(s, flow.graphql);
    expect(flow.received).toHaveLength(1);

    const t = await setupShop();
    const other = await subscribe(t);
    await event(t, other.id, STARTED_EVENT);
    const refusing = flowShopify({ refuse: true });
    await runFlow(t, refusing.graphql);
    await runFlow(t, refusing.graphql);
    expect(refusing.received).toHaveLength(1);
  });

  it("ignores old events and redacted customers", async () => {
    const s = await setupShop();
    const old = await subscribe(s);
    await event(s, old.id, STARTED_EVENT, {}, 5);
    const redacted = await subscribe(s, { customerGid: "redacted" });
    await event(s, redacted.id, STARTED_EVENT);
    const flow = flowShopify();
    await runFlow(s, flow.graphql);
    expect(flow.received).toHaveLength(0);
  });

  it("fires 'last release shipped' once, when nothing renews after the order", async () => {
    const s = await setupShop();
    const ending = await subscribe(s, { status: "CANCELLED", releasesRemaining: 0 });
    const renewing = await subscribe(s, { releasesRemaining: 0 });
    for (const sub of [ending, renewing]) {
      const rel = await db().release.create({ data: { shopId: s.shop.id, number: ++n, title: "R", status: "READY" } });
      await db().delivery.create({
        data: { subscriptionId: sub.id, releaseId: rel.id, status: "ORDERED", orderGid: `gid://shopify/Order/${++n}`, updatedAt: ago(0.1) },
      });
    }
    const flow = flowShopify();
    await runFlow(s, flow.graphql);
    await runFlow(s, flow.graphql);
    expect(flow.received.map((call) => call.handle)).toEqual(["last-release-shipped"]);
    expect(await db().event.count({ where: { shopId: s.shop.id, type: LAST_RELEASE_EVENT } })).toBe(1);
  });

  it("is written by the code paths: a started subscription and a cancelled one, once each", async () => {
    const s = await setupShop();
    const contract = {
      id: `gid://shopify/SubscriptionContract/${++n}`,
      status: "ACTIVE",
      createdAt: "2026-03-01T10:00:00Z",
      customer: { id: "gid://shopify/Customer/7" },
      originOrder: { id: "gid://shopify/Order/1", name: "#1" },
      lines: { nodes: [{ quantity: 1, sellingPlanId: s.plan.sellingPlanGid, currentPrice: { amount: "40.0" } }] },
    };
    const shop = { id: s.shop.id, shopDomain: s.domain, orderTiming: "READY_TO_SHIP" as const };
    const read = async () => ({ subscriptionContract: contract });
    const jobs = await syncContract(db(), env.DB, read, shop, contract.id);
    await syncContract(db(), env.DB, read, shop, contract.id);
    const sub = await db().subscription.findUniqueOrThrow({ where: { contractGid: contract.id } });
    expect(await db().event.count({ where: { subscriptionId: sub.id, type: STARTED_EVENT } })).toBe(1);
    // A new sign-up gets its welcome and its tag at once, not at the next tick.
    expect(jobs.map((job) => job.type)).toEqual(expect.arrayContaining([EMAIL_JOB, "member.tag"]));

    await markCancelled(env.DB, sub.id, NOW);
    await markCancelled(env.DB, sub.id, NOW);
    expect(await db().event.count({ where: { subscriptionId: sub.id, type: CANCELLED_EVENT } })).toBe(1);
  });
});

// ---- the member tag ------------------------------------------------------------------------

function tagShopify() {
  const calls: { op: string; id: string; tag: string }[] = [];
  const state = { missing: new Set<string>(), failing: false };
  const graphql = async (query: string, variables: any) => {
    if (state.failing) throw new Error("Admin API returned errors");
    const op = query.includes("tagsAdd") ? "tagsAdd" : "tagsRemove";
    calls.push({ op, id: variables.id, tag: variables.tags[0] });
    return {
      [op]: { userErrors: state.missing.has(variables.id) ? [{ message: "Customer does not exist" }] : [] },
    };
  };
  return { calls, graphql, state };
}

async function tags(s: Setup, graphql: any) {
  let job: any = memberTagJob(s.domain, `t${++n}`);
  do {
    job = await runMemberTagSlice(db(), env.DB, async () => graphql, job, () => NOW);
  } while (job);
}
const tagged = async (s: Setup) =>
  Object.fromEntries((await db().memberTag.findMany({ where: { shopId: s.shop.id } })).map((row) => [row.customerGid, row.tag]));

describe("the member discount tag", () => {
  it("is added for an active subscriber, once, and a repeat does nothing", async () => {
    const s = await setupShop();
    const sub = await subscribe(s);
    const shopify = tagShopify();
    await tags(s, shopify.graphql);
    await tags(s, shopify.graphql);
    expect(shopify.calls).toEqual([{ op: "tagsAdd", id: sub.customerGid, tag: "active-subscriber" }]);
    expect(await tagged(s)).toEqual({ [sub.customerGid]: "active-subscriber" });
  });

  it("is kept by a cancelled subscriber with paid releases left, and removed after the last one's order", async () => {
    const s = await setupShop();
    const sub = await subscribe(s, { status: "CANCELLED", releasesRemaining: 1 });
    const shopify = tagShopify();
    await tags(s, shopify.graphql); // tagged when it first looked
    expect((await tagged(s))[sub.customerGid]).toBe("active-subscriber");
    shopify.calls.length = 0;
    await tags(s, shopify.graphql);
    expect(shopify.calls).toEqual([]);
    await db().subscription.update({ where: { id: sub.id }, data: { releasesRemaining: 0 } }); // the last order was created
    await tags(s, shopify.graphql);
    expect(shopify.calls).toEqual([{ op: "tagsRemove", id: sub.customerGid, tag: "active-subscriber" }]);
    expect((await tagged(s))[sub.customerGid]).toBeNull();
    await tags(s, shopify.graphql);
    expect(shopify.calls).toHaveLength(1);
  });

  it("isn't removed while another of the customer's subscriptions still qualifies", async () => {
    const s = await setupShop();
    const customerGid = "gid://shopify/Customer/900";
    const first = await subscribe(s, { customerGid });
    await subscribe(s, { customerGid });
    const shopify = tagShopify();
    await tags(s, shopify.graphql);
    expect(shopify.calls).toHaveLength(1); // one customer, one tag, two subscriptions
    await db().subscription.update({ where: { id: first.id }, data: { status: "CANCELLED", releasesRemaining: 0 } });
    await tags(s, shopify.graphql);
    expect(shopify.calls).toHaveLength(1);
    expect((await tagged(s))[customerGid]).toBe("active-subscriber");
  });

  it("is never given for a chargeback or an ended subscription, and a paused one keeps it only while paid", async () => {
    const s = await setupShop();
    const chargeback = await subscribe(s, { status: "PAUSED", pausedReason: "CHARGEBACK", releasesRemaining: 2 });
    const ended = await subscribe(s, { status: "ENDED" });
    const pausedPaid = await subscribe(s, { status: "PAUSED", pausedReason: "FAILED_PAYMENT", releasesRemaining: 1 });
    const pausedOwing = await subscribe(s, { status: "PAUSED", pausedReason: "FAILED_PAYMENT", releasesRemaining: 0 });
    const shopify = tagShopify();
    await tags(s, shopify.graphql);
    expect(shopify.calls.map((call) => call.id)).toEqual([pausedPaid.customerGid]);
    expect([chargeback, ended, pausedOwing].length).toBe(3);
  });

  it("removes a chargeback's tag and works for a guest customer and a redacted one", async () => {
    const s = await setupShop();
    const sub = await subscribe(s); // a guest looks the same to the app: only an ID
    await subscribe(s, { customerGid: "redacted" });
    const shopify = tagShopify();
    await tags(s, shopify.graphql);
    expect(shopify.calls.map((call) => call.id)).toEqual([sub.customerGid]);
    await db().subscription.update({ where: { id: sub.id }, data: { status: "PAUSED", pausedReason: "CHARGEBACK" } });
    await tags(s, shopify.graphql);
    expect(shopify.calls.at(-1)).toMatchObject({ op: "tagsRemove", id: sub.customerGid });
  });

  it("moves a renamed tag, and removes tags when the merchant clears the setting", async () => {
    const s = await setupShop();
    const sub = await subscribe(s);
    const shopify = tagShopify();
    await tags(s, shopify.graphql);
    await db().shop.update({ where: { id: s.shop.id }, data: { memberDiscountTag: "member" } });
    await tags(s, shopify.graphql);
    expect(shopify.calls.slice(1)).toEqual([
      { op: "tagsRemove", id: sub.customerGid, tag: "active-subscriber" },
      { op: "tagsAdd", id: sub.customerGid, tag: "member" },
    ]);
    await db().shop.update({ where: { id: s.shop.id }, data: { memberDiscountTag: null } });
    await tags(s, shopify.graphql);
    expect(shopify.calls.at(-1)).toMatchObject({ op: "tagsRemove", tag: "member" });
    expect((await tagged(s))[sub.customerGid]).toBeNull();
  });

  it("corrects drift on a later tick, without one customer holding up the rest", async () => {
    const s = await setupShop();
    const a = await subscribe(s);
    const b = await subscribe(s);
    const shopify = tagShopify();
    shopify.state.failing = true;
    await tags(s, shopify.graphql);
    expect(await tagged(s)).toEqual({}); // nothing recorded, so the next tick tries again
    shopify.state.failing = false;
    await tags(s, shopify.graphql);
    expect(Object.keys(await tagged(s)).sort()).toEqual([a.customerGid, b.customerGid].sort());
  });

  it("treats a customer who no longer exists as done", async () => {
    const s = await setupShop();
    const sub = await subscribe(s);
    const shopify = tagShopify();
    shopify.state.missing.add(sub.customerGid);
    await tags(s, shopify.graphql);
    await tags(s, shopify.graphql);
    expect(shopify.calls).toHaveLength(1);
  });

  it("pages through many customers", async () => {
    const s = await setupShop();
    for (let i = 0; i < 60; i++) await subscribe(s);
    const shopify = tagShopify();
    await tags(s, shopify.graphql);
    expect(shopify.calls).toHaveLength(60);
    expect(Object.keys(await tagged(s))).toHaveLength(60);
  });
});

// ---- the tick and GDPR -------------------------------------------------------------------

describe("the hourly tick and the job handlers", () => {
  it("starts an email, a Flow and a tag job for each installed shop, with the hour in their IDs", async () => {
    const s = await setupShop();
    await env.DB.prepare(`INSERT INTO "OfflineSession" ("id", "data") VALUES (?, '{}')`).bind(`offline_${s.domain}`).run();
    const jobs = (
      await Promise.all(dueWorkFinders.map((find) => find({ env, db: db(), now: NOW })))
    ).flat().filter((job) => job.shop === s.domain && ["email.run", "flow.run", "member.tag"].includes(job.type));
    expect(jobs.map((job) => job.type).sort()).toEqual(["email.run", "flow.run", "member.tag"]);
    const hour = NOW.toISOString().slice(0, 13);
    expect(jobs.every((job) => job.id.endsWith(hour))).toBe(true);
    for (const type of ["email.run", "flow.run", "member.tag"]) expect(jobHandlers[type]).toBeTypeOf("function");
  });
});

describe("GDPR for emails and tags", () => {
  async function withData() {
    const s = await setupShop();
    const sub = await subscribe(s, { customerGid: "gid://shopify/Customer/5000" });
    const other = await subscribe(s);
    for (const who of [sub, other]) {
      await env.DB.prepare(`INSERT INTO "EmailSend" ("id","shopId","subscriptionId","kind","subject","status","updatedAt") VALUES (?,?,?,?,?, 'SENT', ?)`)
        .bind(`welcome:${who.id}:start`, s.shop.id, who.id, "welcome", "start", NOW.toISOString())
        .run();
      await env.DB.prepare(`INSERT INTO "MemberTag" ("id","shopId","customerGid","tag","updatedAt") VALUES (?,?,?,?,?)`)
        .bind(`${s.shop.id}:${who.customerGid}`, s.shop.id, who.customerGid, "active-subscriber", NOW.toISOString())
        .run();
    }
    return { s, sub, other };
  }

  it("customers/redact deletes that customer's email records and tag, and only theirs", async () => {
    const { s, sub, other } = await withData();
    await redactCustomer(db(), env.DB, s.domain, sub.customerGid);
    expect(await db().emailSend.count({ where: { subscriptionId: sub.id } })).toBe(0);
    expect(await db().emailSend.count({ where: { subscriptionId: other.id } })).toBe(1);
    expect(Object.keys(await tagged(s))).toEqual([other.customerGid]);
    await redactCustomer(db(), env.DB, s.domain, sub.customerGid); // a repeat finds nothing
  });

  it("shop/redact deletes them before the subscriptions they point to", async () => {
    const { s } = await withData();
    await redactShop(db(), env.DB, s.domain);
    expect(await db().emailSend.count({ where: { shopId: s.shop.id } })).toBe(0);
    expect(await db().memberTag.count({ where: { shopId: s.shop.id } })).toBe(0);
    expect(await db().subscription.count({ where: { shopId: s.shop.id } })).toBe(0);
  });

  it("customers/data_request says which emails were sent, not what they said", async () => {
    const { s, sub } = await withData();
    await recordDataRequest(db(), env.DB, s.domain, sub.customerGid, "req1");
    const row = await db().event.findFirstOrThrow({ where: { shopId: s.shop.id, type: "gdpr.data_request" } });
    const subscriptions = (row.payload as any).subscriptions;
    expect(subscriptions[0].emailSends).toEqual([{ kind: "welcome", status: "SENT", sentAt: null }]);
  });
});

describe("a gift's Flow triggers and member tag go to the recipient", () => {
  it("tags the recipient while paid releases remain, never the buyer, and takes it off with the last order", async () => {
    const s = await setupShop();
    const buyer = "gid://shopify/Customer/9001";
    const sub = await subscribe(s, { source: "GIFT", giftBuyerGid: buyer, releasesRemaining: 1 });
    const shopify = tagShopify();
    await tags(s, shopify.graphql);
    expect(shopify.calls).toEqual([{ op: "tagsAdd", id: sub.customerGid, tag: "active-subscriber" }]);
    // The gift stays ACTIVE (it never renews), but its last paid release has an order now.
    await db().subscription.update({ where: { id: sub.id }, data: { releasesRemaining: 0 } });
    await tags(s, shopify.graphql);
    expect(shopify.calls.at(-1)).toEqual({ op: "tagsRemove", id: sub.customerGid, tag: "active-subscriber" });
    expect(shopify.calls.every((call) => call.id !== buyer)).toBe(true);
  });

  it("starts and finishes for the recipient's customer ID, once", async () => {
    const s = await setupShop();
    const sub = await subscribe(s, { source: "GIFT", giftBuyerGid: "gid://shopify/Customer/9001", releasesRemaining: 0 });
    await event(s, sub.id, STARTED_EVENT);
    const rel = await db().release.create({ data: { shopId: s.shop.id, number: ++n, title: "R", status: "READY" } });
    await db().delivery.create({
      data: { subscriptionId: sub.id, releaseId: rel.id, status: "ORDERED", orderGid: `gid://shopify/Order/${++n}`, updatedAt: ago(0.1) },
    });
    const flow = flowShopify();
    await runFlow(s, flow.graphql);
    await runFlow(s, flow.graphql);
    const customer = Number(sub.customerGid.split("/").pop());
    expect(flow.received.map((call) => [call.handle, call.payload.customer_id]).sort()).toEqual([
      ["last-release-shipped", customer],
      ["subscription-started", customer],
    ]);
  });
});

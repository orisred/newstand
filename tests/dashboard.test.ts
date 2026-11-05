/* eslint-disable @typescript-eslint/no-explicit-any -- a fake of Shopify's loosely typed responses */
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  signupAmountCents,
  listConfirmations,
  listStockWarnings,
  listSubscribers,
  listUnsureEmails,
  parseCostCents,
  PORTAL_ADDRESS_EVENT,
  PORTAL_CANCELLED_EVENT,
  portalEvent,
  refreshDashboard,
  resolveUnsureEmail,
  revenueReport,
  setReleaseCosts,
  subscriberCounts,
  totalsBy,
} from "../app/dashboard.server";
import { createDb } from "../app/db.server";
import { markCancelled } from "../app/subscriptions.server";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const NOW = new Date("2026-11-05T12:00:00.000Z");
const db = () => createDb(env.DB);
let n = 0;
let releaseNumber = 100;

async function setup() {
  const k = ++n;
  const shop = await db().shop.create({ data: { shopDomain: `dash${k}.myshopify.com` } });
  const bundle = await db().plan.create({
    data: {
      shopId: shop.id,
      name: "Yearly",
      displayName: "Yearly subscription",
      billingMode: "PREPAID_BUNDLE",
      releasesPerTerm: 2,
      termMonths: 12,
      priceCents: 4000,
      giftable: true,
      productGid: `gid://shopify/Product/${k}`,
    },
  });
  const perRelease = await db().plan.create({
    data: { shopId: shop.id, name: "Per issue", displayName: "Per issue", billingMode: "PER_RELEASE", priceCents: 1500 },
  });
  const release = (number: number, extra: Record<string, unknown> = {}) =>
    db().release.create({ data: { shopId: shop.id, number, title: `Issue ${number}`, status: "SHIPPED", ...extra } });
  let s = 0;
  const subscribe = (planId: string, extra: Record<string, unknown> = {}) =>
    db().subscription.create({
      data: {
        shopId: shop.id,
        planId,
        customerGid: `gid://shopify/Customer/${k}-${++s}`,
        contractGid: `gid://shopify/SubscriptionContract/${k}-${s}`,
        releasesRemaining: 0,
        ...extra,
      },
    });
  const ship = (subscriptionId: string, releaseId: string, status = "ORDERED") =>
    db().delivery.create({ data: { subscriptionId, releaseId, status: status as any } });
  const pay = (subscriptionId: string, cents: number | null, at: string, result = "SUCCEEDED") =>
    db().billingAttempt.create({
      data: {
        subscriptionId,
        chargeFor: `term-${at}`,
        idempotencyKey: `${subscriptionId}:${at}:1`,
        attempt: 1,
        result: result as any,
        amountCents: cents,
        createdAt: new Date(at),
      },
    });
  return { shop, bundle, perRelease, release, subscribe, ship, pay };
}

describe("revenue per release", () => {
  it("recognizes a bundle's payment as its releases ship, and defers the rest", async () => {
    const t = await setup();
    const [r1, r2, r3] = await Promise.all([t.release(1), t.release(2), t.release(3)]);
    const sub = await t.subscribe(t.bundle.id, { signupCents: 4000 });
    await t.ship(sub.id, r1.id);
    await t.ship(sub.id, r2.id);

    const report = await revenueReport(db(), env.DB, t.shop.id);
    const byRelease = totalsBy(report.rows, "releaseId");
    expect(byRelease.get(r1.id)?.revenue).toBe(2000);
    expect(byRelease.get(r2.id)?.revenue).toBe(2000);
    expect(byRelease.get(r3.id)).toBeUndefined();
    expect(report.paid.total).toBe(4000);

    // A one-release bundle left over: the third release is not paid for yet.
    await t.ship(sub.id, r3.id);
    const again = await revenueReport(db(), env.DB, t.shop.id);
    expect(totalsBy(again.rows, "releaseId").get(r3.id)).toMatchObject({ revenue: 0, unpriced: 1 });
  });

  it("a renewal buys the next slots, in the order payments were made", async () => {
    const t = await setup();
    const rs = await Promise.all([1, 2, 3, 4].map((i) => t.release(i)));
    const sub = await t.subscribe(t.bundle.id, { signupCents: 4000 });
    await t.pay(sub.id, 3600, "2027-11-01T00:00:00.000Z"); // renewed at a discount
    for (const r of rs) await t.ship(sub.id, r.id);

    const byRelease = totalsBy((await revenueReport(db(), env.DB, t.shop.id)).rows, "releaseId");
    expect(rs.map((r) => byRelease.get(r.id)?.revenue)).toEqual([2000, 2000, 1800, 1800]);
  });

  it("a failed or pending attempt buys nothing", async () => {
    const t = await setup();
    const r1 = await t.release(1);
    const r2 = await t.release(2);
    const sub = await t.subscribe(t.perRelease.id, { signupCents: 1500 });
    await t.pay(sub.id, 1500, "2026-12-01T00:00:00.000Z", "FAILED");
    await t.pay(sub.id, 1500, "2026-12-02T00:00:00.000Z", "PENDING");
    await t.ship(sub.id, r1.id);
    await t.ship(sub.id, r2.id);

    const byRelease = totalsBy((await revenueReport(db(), env.DB, t.shop.id)).rows, "releaseId");
    expect(byRelease.get(r1.id)?.revenue).toBe(1500);
    expect(byRelease.get(r2.id)).toMatchObject({ revenue: 0, unpriced: 1 });
  });

  it("pay per release: the sign-up pays for the first release and each charge for the next shipped", async () => {
    const t = await setup();
    const rs = await Promise.all([1, 2, 5].map((i) => t.release(i)));
    const sub = await t.subscribe(t.perRelease.id, { signupCents: 1500 });
    await t.pay(sub.id, 1400, "2026-12-01T00:00:00.000Z");
    await t.pay(sub.id, 1400, "2027-01-01T00:00:00.000Z");
    for (const r of rs) await t.ship(sub.id, r.id);
    const byRelease = totalsBy((await revenueReport(db(), env.DB, t.shop.id)).rows, "releaseId");
    expect(rs.map((r) => byRelease.get(r.id)?.revenue)).toEqual([1500, 1400, 1400]);
  });

  it("counts a gift's sign-up payment (the buyer's order) as revenue for the gift's releases", async () => {
    const t = await setup();
    const [r1, r2] = await Promise.all([t.release(1), t.release(2)]);
    const gift = await t.subscribe(t.bundle.id, {
      source: "GIFT",
      giftBuyerGid: "gid://shopify/Customer/999",
      signupCents: 3800,
    });
    await t.ship(gift.id, r1.id);
    await t.ship(gift.id, r2.id);
    const rows = (await revenueReport(db(), env.DB, t.shop.id)).rows;
    expect(totalsBy(rows, "releaseId").get(r1.id)?.revenue).toBe(1900);
    expect(totalsBy(rows, "planId").get(t.bundle.id)?.revenue).toBe(3800);
  });

  it("leaves unread amounts and imported subscribers unpriced, and skips held and cancelled deliveries", async () => {
    const t = await setup();
    const [r1, r2, r3] = await Promise.all([t.release(1), t.release(2), t.release(3)]);
    const unread = await t.subscribe(t.perRelease.id);
    const imported = await t.subscribe(t.bundle.id, { source: "IMPORTED", signupCents: 9999 });
    const held = await t.subscribe(t.perRelease.id, { signupCents: 1500 });
    await t.ship(unread.id, r1.id);
    await t.ship(imported.id, r1.id);
    await t.ship(held.id, r2.id, "HELD");
    await t.ship(held.id, r3.id, "CANCELLED");

    const report = await revenueReport(db(), env.DB, t.shop.id);
    expect(totalsBy(report.rows, "releaseId").get(r1.id)).toMatchObject({ revenue: 0, unpriced: 2, orders: 2 });
    expect(totalsBy(report.rows, "releaseId").get(r2.id)).toBeUndefined();
    expect(report.paid.unread).toBe(1); // only `unread`'s own sign-up; the imported one isn't a payment
  });

  it("keeps one shop's payments away from another's", async () => {
    const a = await setup();
    const b = await setup();
    const r = await a.release(1);
    const sub = await a.subscribe(a.perRelease.id, { signupCents: 1500 });
    await a.ship(sub.id, r.id);
    expect((await revenueReport(db(), env.DB, b.shop.id)).rows).toEqual([]);
  });
});

describe("costs and profit per plan", () => {
  it("takes product cost per copy and shipping and handling per order, and says what has no costs", async () => {
    const t = await setup();
    const r1 = await t.release(1);
    const r2 = await t.release(2);
    expect(
      await setReleaseCosts(db(), t.shop.id, r1.id, {
        productCostCents: 400,
        shippingCostCents: 500,
        handlingCostCents: 100,
      }),
    ).toBe(true);
    const a = await t.subscribe(t.bundle.id, { signupCents: 4000, quantity: 2 });
    const b = await t.subscribe(t.bundle.id, { signupCents: 4000 });
    await t.ship(a.id, r1.id);
    await t.ship(b.id, r1.id);
    await t.ship(b.id, r2.id);

    const rows = (await revenueReport(db(), env.DB, t.shop.id)).rows;
    const plan = totalsBy(rows, "planId").get(t.bundle.id)!;
    // r1: a (2 copies) 800 + 500 + 100, b 400 + 500 + 100. r2 has no costs recorded.
    expect(plan.costs).toBe(800 + 600 + 1000);
    expect(plan.revenue).toBe(6000);
    expect(plan.uncosted).toBe(1);
    expect(totalsBy(rows, "releaseId").get(r2.id)?.uncosted).toBe(1);
  });

  it("refuses another shop's release", async () => {
    const a = await setup();
    const b = await setup();
    const r = await a.release(1);
    const none = { productCostCents: 1, shippingCostCents: null, handlingCostCents: null };
    expect(await setReleaseCosts(db(), b.shop.id, r.id, none)).toBe(false);
    expect((await db().release.findUniqueOrThrow({ where: { id: r.id } })).productCostCents).toBeNull();
  });

  it("parses money", () => {
    const parse = (v: string | null) => parseCostCents(v);
    expect(parse("")).toEqual({ cents: null });
    expect(parse(null)).toEqual({ cents: null });
    expect(parse("0")).toEqual({ cents: 0 });
    expect(parse("4.5")).toEqual({ cents: 450 });
    expect(parse("12.34")).toEqual({ cents: 1234 });
    for (const bad of ["-1", "1.234", "abc", "1,5", "99999999", "10001"]) expect(parse(bad)).toEqual({ error: true });
  });
});

describe("active counts and churn", () => {
  it("counts a finished gift as finished and never as live", async () => {
    const t = await setup();
    await t.subscribe(t.bundle.id, { status: "ACTIVE", releasesRemaining: 2 }); // live
    await t.subscribe(t.bundle.id, { status: "ACTIVE", releasesRemaining: 0 }); // bundle at 0 renews: live
    await t.subscribe(t.perRelease.id, { status: "ACTIVE", releasesRemaining: 0 }); // charges on the next release: live
    await t.subscribe(t.bundle.id, { source: "GIFT", releasesRemaining: 1 }); // gift with a release left: live
    await t.subscribe(t.bundle.id, { source: "GIFT", releasesRemaining: 0 }); // finished gift, still ACTIVE
    await t.subscribe(t.bundle.id, { status: "PAUSED", releasesRemaining: 1 });
    await t.subscribe(t.bundle.id, { status: "CANCELLED", releasesRemaining: 1 }); // still shipping
    await t.subscribe(t.bundle.id, { status: "CANCELLED", releasesRemaining: 0 });
    await t.subscribe(t.bundle.id, { status: "ENDED" });
    const noRenew = await db().plan.create({
      data: { shopId: t.shop.id, name: "One-off", displayName: "One-off", priceCents: 100, autoRenew: false },
    });
    await t.subscribe(noRenew.id, { releasesRemaining: 0 }); // never renews: finished

    const c = await subscriberCounts(env.DB, t.shop.id, NOW);
    expect(c).toMatchObject({ total: 10, live: 4, paused: 1, ending: 1, finished: 4, gifts: 2 });

    const live = await listSubscribers(env.DB, t.shop.id, "live", null);
    expect(live.rows).toHaveLength(4);
    expect(live.rows.every((row) => !row.finished)).toBe(true);
    const finished = await listSubscribers(env.DB, t.shop.id, "finished", null);
    expect(finished.rows).toHaveLength(4);
  });

  it("a gift that ships its last release moves from live to finished", async () => {
    const t = await setup();
    await t.subscribe(t.bundle.id, { source: "GIFT", releasesRemaining: 1 });
    expect(await subscriberCounts(env.DB, t.shop.id, NOW)).toMatchObject({ live: 1, finished: 0 });
    await env.DB.prepare(`UPDATE "Subscription" SET "releasesRemaining" = 0 WHERE "shopId" = ?`).bind(t.shop.id).run();
    expect(await subscriberCounts(env.DB, t.shop.id, NOW)).toMatchObject({ live: 0, finished: 1 });
  });

  it("churn counts cancellations in the last 30 days, not gifts, and separates the portal's", async () => {
    const t = await setup();
    const a = await t.subscribe(t.bundle.id, { releasesRemaining: 1 });
    const viaPortal = await t.subscribe(t.bundle.id, { releasesRemaining: 1 });
    const old = await t.subscribe(t.bundle.id, { releasesRemaining: 1 });
    const gift = await t.subscribe(t.bundle.id, { source: "GIFT", releasesRemaining: 1 });
    await t.subscribe(t.bundle.id, { releasesRemaining: 1 }); // stays
    await t.subscribe(t.bundle.id, { releasesRemaining: 1 }); // stays

    await markCancelled(env.DB, a.id, NOW);
    await markCancelled(env.DB, viaPortal.id, NOW);
    await portalEvent(env.DB, viaPortal.id, PORTAL_CANCELLED_EVENT, NOW);
    await markCancelled(env.DB, gift.id, NOW);
    await markCancelled(env.DB, old.id, new Date("2026-08-01T00:00:00.000Z"));
    // markCancelled stamps the event with the database's clock, so date the old one by hand.
    await env.DB.prepare(`UPDATE "Event" SET "createdAt" = ? WHERE "subscriptionId" = ?`)
      .bind("2026-08-01T00:00:00.000Z", old.id).run();
    await env.DB.prepare(`UPDATE "Event" SET "createdAt" = ? WHERE "type" = 'subscription.cancelled' AND "subscriptionId" <> ?`)
      .bind(NOW.toISOString(), old.id).run();

    const c = await subscriberCounts(env.DB, t.shop.id, NOW);
    expect(c).toMatchObject({ cancelled: 2, cancelledViaPortal: 1, live: 2 });
    expect(c.churnRate).toBeCloseTo(2 / 4);
  });

  it("has no churn rate with nobody to measure", async () => {
    const t = await setup();
    expect((await subscriberCounts(env.DB, t.shop.id, NOW)).churnRate).toBeNull();
  });
});

describe("subscriber list", () => {
  it("pages newest first and keeps shops apart", async () => {
    const t = await setup();
    const other = await setup();
    await other.subscribe(other.bundle.id);
    for (let i = 0; i < 27; i++) {
      await t.subscribe(t.bundle.id, { createdAt: new Date(NOW.getTime() - i * 60_000) });
    }
    const first = await listSubscribers(env.DB, t.shop.id, "all", null);
    expect(first.rows).toHaveLength(25);
    expect(first.next).not.toBeNull();
    const second = await listSubscribers(env.DB, t.shop.id, "all", first.next);
    expect(second.rows).toHaveLength(2);
    expect(second.next).toBeNull();
    expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(27);
  });

  it("shows which portal actions a subscriber took", async () => {
    const t = await setup();
    const sub = await t.subscribe(t.bundle.id);
    await t.subscribe(t.bundle.id);
    await portalEvent(env.DB, sub.id, PORTAL_ADDRESS_EVENT, NOW);
    const { rows } = await listSubscribers(env.DB, t.shop.id, "all", null);
    expect(rows.find((r) => r.id === sub.id)).toMatchObject({ portalAddress: 1, portalCancelled: 0 });
    expect(rows.filter((r) => !r.portalAddress && !r.portalCancelled)).toHaveLength(1);
  });

  it("writes a portal event once per moment and none for a missing subscription", async () => {
    const t = await setup();
    const sub = await t.subscribe(t.bundle.id);
    await portalEvent(env.DB, sub.id, PORTAL_ADDRESS_EVENT, NOW);
    await portalEvent(env.DB, sub.id, PORTAL_ADDRESS_EVENT, NOW);
    await portalEvent(env.DB, "missing", PORTAL_ADDRESS_EVENT, NOW);
    expect(await db().event.count({ where: { shopId: t.shop.id } })).toBe(1);
  });
});

describe("address confirmations", () => {
  it("counts a Delivery's confirmation, an email row's before the Delivery exists, and who changed it", async () => {
    const t = await setup();
    const release = await t.release(1, { status: "PREORDER", preorderOpensAt: new Date("2026-11-01T00:00:00.000Z") });
    const confirmedOnDelivery = await t.subscribe(t.bundle.id, { releasesRemaining: 2 });
    const confirmedOnEmail = await t.subscribe(t.bundle.id, { releasesRemaining: 2 });
    const unconfirmed = await t.subscribe(t.bundle.id, { releasesRemaining: 2 });
    const cancelled = await t.subscribe(t.bundle.id, { releasesRemaining: 2 });
    const notTold = await t.subscribe(t.bundle.id, { releasesRemaining: 2 });
    await db().delivery.create({
      data: { subscriptionId: confirmedOnDelivery.id, releaseId: release.id, addressConfirmedAt: new Date("2026-11-02T00:00:00.000Z") },
    });
    await db().delivery.create({ data: { subscriptionId: unconfirmed.id, releaseId: release.id } });
    await db().delivery.create({
      data: { subscriptionId: cancelled.id, releaseId: release.id, status: "CANCELLED", addressConfirmedAt: NOW },
    });
    const email = (sub: { id: string }, status: string, confirmed?: Date) =>
      db().emailSend.create({
        data: {
          id: `preorderAnnounced:${sub.id}:${release.id}`,
          shopId: t.shop.id,
          subscriptionId: sub.id,
          kind: "preorderAnnounced",
          subject: release.id,
          status: status as any,
          addressConfirmedAt: confirmed,
        },
      });
    await email(confirmedOnEmail, "SENT", new Date("2026-11-03T00:00:00.000Z"));
    await email(notTold, "FAILED");
    await portalEvent(env.DB, confirmedOnEmail.id, PORTAL_ADDRESS_EVENT, new Date("2026-11-03T00:00:00.000Z"));
    // Changed before the release was announced: not about this release.
    await portalEvent(env.DB, unconfirmed.id, PORTAL_ADDRESS_EVENT, new Date("2026-10-01T00:00:00.000Z"));

    const result = await listConfirmations(env.DB, t.shop.id, release.id);
    expect(result).toMatchObject({ total: 3, confirmed: 2, changed: 1, more: false });
    expect(result.rows.map((r) => r.id)).toEqual([
      unconfirmed.id, // not confirmed first
      expect.any(String),
      expect.any(String),
    ]);
    expect(result.rows.find((r) => r.id === confirmedOnEmail.id)).toMatchObject({ changed: 1 });
    expect(result.rows.find((r) => r.id === unconfirmed.id)).toMatchObject({ confirmedAt: null, changed: 0 });
  });

  it("shows nothing for another shop's release", async () => {
    const a = await setup();
    const b = await setup();
    const release = await a.release(1);
    const sub = await a.subscribe(a.bundle.id);
    await db().delivery.create({ data: { subscriptionId: sub.id, releaseId: release.id } });
    expect((await listConfirmations(env.DB, b.shop.id, release.id)).total).toBe(0);
  });
});

describe("UNSURE emails", () => {
  async function unsure(t: Awaited<ReturnType<typeof setup>>, status = "UNSURE") {
    const sub = await t.subscribe(t.bundle.id);
    const release = await t.release(++releaseNumber);
    return db().emailSend.create({
      data: {
        id: `preorderAnnounced:${sub.id}:${release.id}`,
        shopId: t.shop.id,
        subscriptionId: sub.id,
        kind: "preorderAnnounced",
        subject: release.id,
        status: status as any,
        reason: "lease_lapsed",
        leaseUntil: new Date(0),
      },
    });
  }

  it("lists the email, the subscriber and the release", async () => {
    const t = await setup();
    const email = await unsure(t);
    await unsure(t, "SENT");
    const { rows, more } = await listUnsureEmails(env.DB, t.shop.id);
    expect(more).toBe(false);
    expect(rows).toEqual([
      expect.objectContaining({ id: email.id, kind: "preorderAnnounced", subscriptionId: email.subscriptionId, number: expect.any(Number), title: expect.stringMatching(/^Issue/) }),
    ]);
  });

  it("sending again puts it back to pending, once", async () => {
    const t = await setup();
    const email = await unsure(t);
    expect(await resolveUnsureEmail(env.DB, t.shop.id, email.id, "resend", NOW)).toBe(true);
    const row = await db().emailSend.findUniqueOrThrow({ where: { id: email.id } });
    expect(row).toMatchObject({ status: "PENDING", reason: null, leaseUntil: null });
    expect(await resolveUnsureEmail(env.DB, t.shop.id, email.id, "resend", NOW)).toBe(false);
    expect((await listUnsureEmails(env.DB, t.shop.id)).rows).toEqual([]);
  });

  it("leaving it ends it for good and it is never sent", async () => {
    const t = await setup();
    const email = await unsure(t);
    expect(await resolveUnsureEmail(env.DB, t.shop.id, email.id, "leave", NOW)).toBe(true);
    expect(await db().emailSend.findUniqueOrThrow({ where: { id: email.id } })).toMatchObject({
      status: "SKIPPED",
      reason: "left_unsure",
    });
    // A second press, or "send again" on the same row afterwards, changes nothing.
    expect(await resolveUnsureEmail(env.DB, t.shop.id, email.id, "resend", NOW)).toBe(false);
    expect((await db().emailSend.findUniqueOrThrow({ where: { id: email.id } })).status).toBe("SKIPPED");
  });

  it("can't touch another shop's email or one that isn't UNSURE", async () => {
    const a = await setup();
    const b = await setup();
    const email = await unsure(a);
    const sent = await unsure(a, "SENT");
    expect(await resolveUnsureEmail(env.DB, b.shop.id, email.id, "resend", NOW)).toBe(false);
    expect(await resolveUnsureEmail(env.DB, a.shop.id, sent.id, "resend", NOW)).toBe(false);
    expect((await db().emailSend.findUniqueOrThrow({ where: { id: email.id } })).status).toBe("UNSURE");
    expect((await db().emailSend.findUniqueOrThrow({ where: { id: sent.id } })).status).toBe("SENT");
  });
});

describe("hourly refresh", () => {
  const money = (amount: string) => ({ currentSubtotalPriceSet: { shopMoney: { amount } } });
  const item = (plan: string | null, amount: string, quantity = 1) => ({
    quantity,
    sellingPlan: plan ? { sellingPlanId: plan } : null,
    discountedTotalSet: { shopMoney: { amount } },
  });
  const contract = (plans: string[], items: ReturnType<typeof item>[], quantity = 1) => ({
    lines: { nodes: plans.map((sellingPlanId) => ({ quantity, sellingPlanId })), pageInfo: { hasNextPage: false } },
    originOrder: { lineItems: { nodes: items, pageInfo: { hasNextPage: false } } },
  });

  it("reads unread payment amounts once, from the order and the contract", async () => {
    const t = await setup();
    const sub = await t.subscribe(t.bundle.id);
    const other = await t.subscribe(t.bundle.id, { signupCents: 4000 });
    const attempt = await t.pay(sub.id, null, "2026-12-01T00:00:00.000Z");
    await db().billingAttempt.update({ where: { id: attempt.id }, data: { orderGid: "gid://shopify/Order/1" } });
    const done = await t.pay(other.id, 111, "2026-12-01T00:00:00.000Z");
    await db().billingAttempt.update({ where: { id: done.id }, data: { orderGid: "gid://shopify/Order/2" } });
    const queries: string[] = [];
    const graphql = async (query: string, variables: any) => {
      queries.push(query);
      if (query.includes("DashboardOrders")) {
        return { nodes: variables.ids.map((id: string) => ({ id, ...money("36.50") })) };
      }
      if (query.includes("DashboardContracts")) {
        return { nodes: variables.ids.map((id: string) => ({ id, ...contract(["plan/A"], [item("plan/A", "40.00")]) })) };
      }
      return { nodes: [] };
    };

    await refreshDashboard(db(), env.DB, graphql as any, t.shop.shopDomain, NOW);
    expect((await db().billingAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).amountCents).toBe(3650);
    expect((await db().billingAttempt.findUniqueOrThrow({ where: { id: done.id } })).amountCents).toBe(111); // already read
    expect((await db().subscription.findUniqueOrThrow({ where: { id: sub.id } })).signupCents).toBe(4000);
    expect((await db().subscription.findUniqueOrThrow({ where: { id: other.id } })).signupCents).toBe(4000);

    // Nothing is left unread, so a second run asks Shopify about no payment.
    queries.length = 0;
    await refreshDashboard(db(), env.DB, graphql as any, t.shop.shopDomain, NOW);
    expect(queries.filter((q) => !q.includes("DashboardStock"))).toEqual([]);
  });

  it("counts only the contract's own line when the checkout also held a one-time product", () => {
    const order = [item("plan/A", "40.00"), item(null, "12.00")];
    expect(signupAmountCents(contract(["plan/A"], order))).toBe(4000);
    // A discount is already in the line's discounted total.
    expect(signupAmountCents(contract(["plan/A"], [item("plan/A", "36.00"), item(null, "12.00")]))).toBe(3600);
  });

  it("gives each of two plans on one order its own line, not the whole subtotal", () => {
    const order = [item("plan/A", "40.00"), item("plan/B", "15.00")];
    expect(signupAmountCents(contract(["plan/A"], order))).toBe(4000);
    expect(signupAmountCents(contract(["plan/B"], order))).toBe(1500);
  });

  it("leaves the amount unread when the line can't be identified, and never falls back to the subtotal", () => {
    // No order line carries the contract's plan.
    expect(signupAmountCents(contract(["plan/A"], [item(null, "40.00"), item("plan/Z", "9.00")]))).toBeNull();
    // Two copies on the contract but one on the order: another contract may share the plan.
    expect(signupAmountCents(contract(["plan/A"], [item("plan/A", "40.00")], 2))).toBeNull();
    // A contract line with no plan.
    expect(signupAmountCents(contract([], [item("plan/A", "40.00")]))).toBeNull();
    // More lines than one page shows.
    const paged = contract(["plan/A"], [item("plan/A", "40.00")]);
    paged.originOrder.lineItems.pageInfo.hasNextPage = true;
    expect(signupAmountCents(paged)).toBeNull();
    // No checkout order at all is the one case that stores 0.
    expect(signupAmountCents({ lines: contract([], []).lines, originOrder: null })).toBe(0);
  });

  it("stores only the subscription line for a checkout with a one-time product, and leaves an unidentified one NULL", async () => {
    const t = await setup();
    const withBackIssue = await t.subscribe(t.bundle.id);
    const unidentified = await t.subscribe(t.bundle.id);
    const graphql = async (query: string, variables: any) =>
      query.includes("DashboardContracts")
        ? {
            nodes: variables.ids.map((id: string) => ({
              id,
              ...(id === withBackIssue.contractGid
                ? contract(["plan/A"], [item("plan/A", "40.00"), item(null, "18.00")])
                : contract(["plan/A"], [item(null, "58.00")])),
            })),
          }
        : { nodes: [] };
    await refreshDashboard(db(), env.DB, graphql as any, t.shop.shopDomain, NOW);
    expect((await db().subscription.findUniqueOrThrow({ where: { id: withBackIssue.id } })).signupCents).toBe(4000);
    expect((await db().subscription.findUniqueOrThrow({ where: { id: unidentified.id } })).signupCents).toBeNull();
    expect((await revenueReport(db(), env.DB, t.shop.id)).paid.unread).toBe(1);
  });

  it("leaves a payment Shopify doesn't return unread, and treats a contract with no order as paid nothing", async () => {
    const t = await setup();
    const sub = await t.subscribe(t.bundle.id, { signupCents: 4000 });
    const attempt = await t.pay(sub.id, null, "2026-12-01T00:00:00.000Z");
    await db().billingAttempt.update({ where: { id: attempt.id }, data: { orderGid: "gid://shopify/Order/9" } });
    const apiContract = await t.subscribe(t.bundle.id);
    const graphql = async (query: string, variables: any) =>
      query.includes("DashboardContracts")
        ? { nodes: variables.ids.map((id: string) => ({ id, lines: contract([], []).lines, originOrder: null })) }
        : { nodes: variables.ids.map(() => null) };
    await refreshDashboard(db(), env.DB, graphql as any, t.shop.shopDomain, NOW);
    expect((await db().billingAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).amountCents).toBeNull();
    expect((await db().subscription.findUniqueOrThrow({ where: { id: apiContract.id } })).signupCents).toBe(0);
  });

  it("works out the lowest stock that would stop a sign-up, and warns", async () => {
    const t = await setup();
    const graphql = async (query: string) => {
      if (!query.includes("DashboardStock")) return { nodes: [] };
      return {
        nodes: [
          {
            id: t.bundle.productGid,
            variants: {
              nodes: [
                { inventoryPolicy: "DENY", inventoryQuantity: 7, inventoryItem: { tracked: true } },
                { inventoryPolicy: "DENY", inventoryQuantity: 3, inventoryItem: { tracked: true } },
                { inventoryPolicy: "CONTINUE", inventoryQuantity: -5, inventoryItem: { tracked: true } },
                { inventoryPolicy: "DENY", inventoryQuantity: 0, inventoryItem: { tracked: false } },
              ],
            },
          },
        ],
      };
    };
    await refreshDashboard(db(), env.DB, graphql as any, t.shop.shopDomain, NOW);
    expect(await listStockWarnings(db(), t.shop.id)).toEqual([
      expect.objectContaining({ id: t.bundle.id, stockLevel: 3 }),
    ]);
  });

  it("does not warn for stock that can't stop a sign-up, plenty of stock, or a plan that is off", async () => {
    const t = await setup();
    const make = (variants: any[]) => async (query: string) =>
      query.includes("DashboardStock") ? { nodes: [{ id: t.bundle.productGid, variants: { nodes: variants } }] } : { nodes: [] };
    await refreshDashboard(db(), env.DB, make([{ inventoryPolicy: "CONTINUE", inventoryQuantity: 0, inventoryItem: { tracked: true } }]) as any, t.shop.shopDomain, NOW);
    expect((await db().plan.findUniqueOrThrow({ where: { id: t.bundle.id } })).stockLevel).toBeNull();
    expect(await listStockWarnings(db(), t.shop.id)).toEqual([]);

    await refreshDashboard(db(), env.DB, make([{ inventoryPolicy: "DENY", inventoryQuantity: 500, inventoryItem: { tracked: true } }]) as any, t.shop.shopDomain, NOW);
    expect(await listStockWarnings(db(), t.shop.id)).toEqual([]);

    await refreshDashboard(db(), env.DB, make([{ inventoryPolicy: "DENY", inventoryQuantity: 0, inventoryItem: { tracked: true } }]) as any, t.shop.shopDomain, NOW);
    expect(await listStockWarnings(db(), t.shop.id)).toHaveLength(1);
    await db().plan.update({ where: { id: t.bundle.id }, data: { active: false } });
    expect(await listStockWarnings(db(), t.shop.id)).toEqual([]);
  });
});

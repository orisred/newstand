/* eslint-disable @typescript-eslint/no-explicit-any -- fakes of Cloudflare's and Shopify's loosely typed responses */
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../app/db.server";
import { signLinkToken, verifyLinkToken } from "../app/email-link.server";
import { renderEmail, type EmailData, type ShopCopy } from "../app/email-templates";
import {
  queueEmails,
  recordAddressConfirmation,
  runEmailSlice,
  staleReason,
} from "../app/emails.server";
import type { Job } from "../app/jobs/runner.server";
import { emailRunJob } from "../app/notification-jobs";
import { createDueDeliveries } from "../app/release-runs.server";
import { EMAIL_KEYS, getOrCreateShop, type EmailKey } from "../app/shop.server";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const db = () => createDb(env.DB);
let n = 0;
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const ahead = (days: number) => ago(-days);

// ---- fakes -------------------------------------------------------------------------------

const codeError = (code: string) => Object.assign(new Error(code), { code });

/** Cloudflare's send binding. `failures` are thrown by the next calls, in order. */
function mailer() {
  const sent: any[] = [];
  const failures: (Error | null)[] = [];
  return {
    sent,
    failures,
    binding: {
      send: async (message: any) => {
        const failure = failures.shift();
        if (failure) throw failure;
        sent.push(message);
        return { messageId: `message-${sent.length}` };
      },
    } as any,
  };
}

const testEnv = (m: ReturnType<typeof mailer>, extra: Record<string, string> = {}) => ({
  EMAIL: m.binding,
  EMAIL_FROM_ADDRESS: "no-reply@mail.test",
  SHOPIFY_API_SECRET: "test-secret",
  SHOPIFY_APP_URL: "https://app.example.com",
  ...extra,
});

/** Shopify: the shop's details and each customer's address (null: a customer with none, missing: deleted). */
function shopify(
  addresses: Record<string, string | null | undefined> = {},
  /** Delivery prices by contract ID, in dollars. A contract not listed has none ($0); `null` means it's gone. */
  shipping: Record<string, string | null> = {},
) {
  const calls: string[] = [];
  const graphql = async (query: string, variables: any) => {
    calls.push(query);
    return {
      shop: {
        name: "Test Zines",
        contactEmail: "owner@shop.test",
        primaryDomain: { url: "https://zines.test" },
        billingAddress: null,
      },
      nodes: variables.ids.map((id: string) =>
        id.includes("SubscriptionContract")
          ? shipping[id] === null
            ? null
            : { id, deliveryPrice: { amount: shipping[id] ?? "0.0" } }
          : addresses[id] === undefined
            ? null
            : { id, defaultEmailAddress: addresses[id] ? { emailAddress: addresses[id] } : null },
      ),
    };
  };
  return { graphql, calls };
}

async function setupShop(
  data: Record<string, unknown> = {},
  planData: Record<string, unknown> = {},
) {
  const domain = `mail${++n}.myshopify.com`;
  const shop = await getOrCreateShop(db(), domain);
  await db().shop.update({ where: { id: shop.id }, data });
  const plan = await db().plan.create({
    data: {
      shopId: shop.id,
      name: "Yearly",
      displayName: "Yearly subscription",
      priceCents: 4000,
      billingMode: "PREPAID_BUNDLE",
      releasesPerTerm: 2,
      termMonths: 12,
      ...planData,
    },
  });
  return { shop, domain, plan };
}

type Setup = Awaited<ReturnType<typeof setupShop>>;

async function subscribe(s: Setup, data: Record<string, unknown> = {}) {
  const customerGid = (data.customerGid as string) ?? `gid://shopify/Customer/${++n}`;
  return db().subscription.create({
    data: {
      shopId: s.shop.id,
      planId: s.plan.id,
      contractGid: `gid://shopify/SubscriptionContract/${++n}`,
      customerGid,
      releasesRemaining: 1,
      lockedPriceCents: 4000,
      createdAt: ago(100),
      ...data,
    },
  });
}

const release = (s: Setup, status: any, data: Record<string, unknown> = {}) => {
  const number = ++n;
  return db().release.create({
    data: {
      shopId: s.shop.id,
      number,
      title: `Zine ${number}`,
      status,
      preorderOpensAt: status === "PREORDER" ? ago(0.1) : null,
      ...data,
    },
  });
};

/** One slice, then whatever it chains to, until it stops. Returns every slice's follow-up. */
async function runAll(s: Setup, m: ReturnType<typeof mailer>, graphql: any, extra = {}, first?: Job) {
  const followUps: { delaySeconds: number }[] = [];
  let job: Job | null = first ?? emailRunJob(s.domain, `t${++n}`);
  for (let i = 0; job && i < 100; i++) {
    const next: Awaited<ReturnType<typeof runEmailSlice>> = await runEmailSlice(
      testEnv(m, extra) as any,
      db(),
      env.DB,
      async () => graphql,
      job,
      () => NOW,
    );
    if (next) followUps.push({ delaySeconds: next.delaySeconds });
    job = next && next.delaySeconds === 0 ? next.job : null;
  }
  return followUps;
}

const rows = (shopId: string, kind?: string) =>
  db().emailSend.findMany({
    where: { shopId, ...(kind ? { kind } : {}) },
    orderBy: { id: "asc" },
  });

/** A state in which each email is due, for the tests that go through every email. */
const SCENARIOS: Record<EmailKey, (s: Setup) => Promise<void>> = {
  welcome: async (s) => {
    await subscribe(s, { createdAt: ago(0.1) });
  },
  preorderAnnounced: async (s) => {
    await release(s, "PREORDER");
    await subscribe(s);
  },
  upcomingCharge: async (s) => {
    await subscribe(s, { termEndsAt: ahead(10) });
  },
  failedPayment: async (s) => {
    const sub = await subscribe(s, { paymentProblemSince: ago(0.5), status: "ACTIVE" });
    await db().event.create({
      data: {
        id: `billing.failed:${sub.id}`,
        shopId: s.shop.id,
        subscriptionId: sub.id,
        type: "billing.failed",
        payload: { nextRetryAt: ahead(3).toISOString() },
        createdAt: ago(0.1),
      },
    });
  },
  lastReleaseShipping: async (s) => {
    const sub = await subscribe(s, { status: "CANCELLED", releasesRemaining: 0 });
    const rel = await release(s, "READY");
    await db().delivery.create({
      data: {
        subscriptionId: sub.id,
        releaseId: rel.id,
        status: "ORDERED",
        orderGid: `gid://shopify/Order/${++n}`,
        updatedAt: ago(0.1),
      },
    });
  },
};

// ---- the emails: when each is due -----------------------------------------------------

describe("who is due each email", () => {
  for (const key of EMAIL_KEYS) {
    it(`${key}: queued when due, sent once, to the customer's address, from the shop`, async () => {
      const s = await setupShop({ releaseWordSingular: "drop", releaseWordPlural: "drops" });
      await SCENARIOS[key](s);
      const customer = (await db().subscription.findFirstOrThrow({ where: { shopId: s.shop.id } })).customerGid;
      const m = mailer();
      await runAll(s, m, shopify({ [customer]: "someone@example.test" }).graphql);
      expect(m.sent).toHaveLength(1);
      expect(m.sent[0]).toMatchObject({
        to: "someone@example.test",
        from: { email: "no-reply@mail.test", name: "Test Zines" },
        replyTo: "owner@shop.test",
      });
      expect((await rows(s.shop.id, key))[0]).toMatchObject({ status: "SENT", messageId: "message-1" });
      // The release word is the shop's, in the subject, text and HTML.
      const text = `${m.sent[0].subject} ${m.sent[0].text} ${m.sent[0].html}`;
      expect(text).not.toMatch(/issue/i);
    });

    it(`${key}: switched off means nothing sends, and switching it back on doesn't send the missed one`, async () => {
      const s = await setupShop({ emailsEnabled: { [key]: false } });
      await SCENARIOS[key](s);
      const customer = (await db().subscription.findFirstOrThrow({ where: { shopId: s.shop.id } })).customerGid;
      const m = mailer();
      const { graphql, calls } = shopify({ [customer]: "someone@example.test" });
      await runAll(s, m, graphql);
      expect(m.sent).toHaveLength(0);
      expect(calls).toHaveLength(0); // it never even looked the customer up
      expect((await rows(s.shop.id, key))[0]).toMatchObject({ status: "SKIPPED", reason: "switched_off" });

      await db().shop.update({ where: { id: s.shop.id }, data: { emailsEnabled: { [key]: true } } });
      await runAll(s, m, graphql);
      expect(m.sent).toHaveLength(0);
    });
  }

  it("a switch turned off after queueing still stops the email at send time", async () => {
    const s = await setupShop();
    await SCENARIOS.welcome(s);
    await queueEmails(env.DB, s.shop.id, NOW);
    await db().shop.update({ where: { id: s.shop.id }, data: { emailsEnabled: { welcome: false } } });
    const m = mailer();
    await runAll(s, m, shopify().graphql, {}, emailRunJob(s.domain, "q", { queued: true }));
    expect(m.sent).toHaveLength(0);
    expect((await rows(s.shop.id))[0]).toMatchObject({ status: "SKIPPED", reason: "switched_off" });
  });

  it("welcome goes to a new, active subscriber only: not an old, imported or cancelled one", async () => {
    const s = await setupShop();
    const fresh = await subscribe(s, { createdAt: ago(0.1) });
    await subscribe(s, { createdAt: ago(3) });
    await subscribe(s, { createdAt: ago(0.1), source: "IMPORTED" });
    await subscribe(s, { createdAt: ago(0.1), customerGid: "redacted" });
    await subscribe(s, { createdAt: ago(0.1), contractGid: null as any }).catch(() => {});
    await queueEmails(env.DB, s.shop.id, NOW);
    expect((await rows(s.shop.id, "welcome")).map((row) => row.subscriptionId)).toEqual([fresh.id]);
  });

  it("pre-order goes to everyone who will receive the release, with the right main button", async () => {
    const s = await setupShop();
    const rel = await release(s, "PREORDER");
    const active = await subscribe(s);
    const cancelledWithPaid = await subscribe(s, { status: "CANCELLED", releasesRemaining: 1 });
    const paused = await subscribe(s, {
      status: "PAUSED",
      pausedReason: "FAILED_PAYMENT",
      paymentProblemSince: ago(2),
    });
    const perRelease = await db().plan.create({
      data: { shopId: s.shop.id, name: "PR", displayName: "Per release", priceCents: 1000, billingMode: "PER_RELEASE" },
    });
    const atZero = await subscribe(s, { planId: perRelease.id, releasesRemaining: 0 });
    // Not these:
    await subscribe(s, { status: "CANCELLED", releasesRemaining: 0 });
    await subscribe(s, { status: "PAUSED", pausedReason: "CHARGEBACK", paymentProblemSince: ago(1) });
    await subscribe(s, { planId: perRelease.id, releasesRemaining: 0, paymentProblemSince: ago(1), status: "PAUSED", pausedReason: "FAILED_PAYMENT" });
    await subscribe(s, { createdAt: ago(0.01) }); // signed up after the announcement
    await subscribe(s, { status: "ENDED" });

    const customers = Object.fromEntries(
      (await db().subscription.findMany({ where: { shopId: s.shop.id } })).map((sub) => [
        sub.customerGid,
        `${sub.id}@example.test`,
      ]),
    );
    const m = mailer();
    await runAll(s, m, shopify(customers).graphql);
    const due = await rows(s.shop.id, "preorderAnnounced");
    expect(due.map((row) => row.subscriptionId).sort()).toEqual(
      [active.id, cancelledWithPaid.id, paused.id, atZero.id].sort(),
    );
    const byAddress = (id: string) => m.sent.find((message) => message.to === `${id}@example.test`);
    expect(byAddress(active.id).text).toContain("Confirm or update your delivery address");
    expect(byAddress(paused.id).text).toContain("Update your card");
    expect(byAddress(paused.id).text).not.toContain("Confirm or update your delivery address");
    // The address link names the subscription and the release, and nothing else.
    const url = /https:\/\/app\.example\.com\/l\/(\S+)/.exec(byAddress(active.id).text)![1];
    expect(await verifyLinkToken(testEnv(m) as any, url)).toMatchObject({ k: "address", s: active.id, r: rel.id });
    // Pay per release is also warned of its charge, with the release that triggers it.
    expect((await rows(s.shop.id, "upcomingCharge")).map((row) => row.subscriptionId)).toEqual([atZero.id]);
  });

  it("pre-order with orders created at the announcement says so and has no address button", async () => {
    const s = await setupShop({ orderTiming: "PREORDER_OPENS" });
    await release(s, "PREORDER");
    const sub = await subscribe(s);
    const m = mailer();
    await runAll(s, m, shopify({ [sub.customerGid]: "x@example.test" }).graphql);
    expect(m.sent[0].text).toContain("creating your order now");
    expect(m.sent[0].text).not.toContain("Confirm or update");
  });

  it("upcoming charge: a bundle's renewal 21 days ahead, a late renewal, and a per-release charge", async () => {
    const s = await setupShop();
    const soon = await subscribe(s, { termEndsAt: ahead(10) });
    await subscribe(s, { termEndsAt: ahead(30) });
    const late = await subscribe(s, { termEndsAt: ago(1), releasesRemaining: 1 });
    await subscribe(s, { termEndsAt: ago(1), releasesRemaining: 0 }); // charged now, no notice
    await subscribe(s, { termEndsAt: ahead(10), source: "GIFT" });
    await subscribe(s, { termEndsAt: ahead(10), status: "CANCELLED" });
    await queueEmails(env.DB, s.shop.id, NOW);
    const queued = await rows(s.shop.id, "upcomingCharge");
    expect(queued.map((row) => [row.subscriptionId, row.subject.split(":")[0]]).sort()).toEqual(
      [[soon.id, "on"], [late.id, "late"]].sort(),
    );

    const m = mailer();
    await runAll(s, m, shopify(Object.fromEntries([soon, late].map((sub) => [sub.customerGid, `${sub.id}@e.test`]))).graphql);
    const text = (id: string) => m.sent.find((message) => message.to === `${id}@e.test`).text;
    expect(text(soon.id)).toContain("we'll charge $40.00 plus any tax");
    expect(text(soon.id)).toContain("renew Yearly subscription for another 2 issues");
    expect(text(late.id)).toContain("hasn't shipped yet");
  });

  it("upcoming charge for a bundle that renews when releases run out comes with the last release's pre-order", async () => {
    const s = await setupShop({}, { renewalRule: "ON_DEPLETION" });
    await release(s, "PREORDER");
    const last = await subscribe(s, { releasesRemaining: 1 });
    await subscribe(s, { releasesRemaining: 2 });
    await queueEmails(env.DB, s.shop.id, NOW);
    expect((await rows(s.shop.id, "upcomingCharge")).map((row) => row.subscriptionId)).toEqual([last.id]);
  });

  it("failed payment: one email per failed try, saying when it retries or that it paused", async () => {
    const s = await setupShop();
    const sub = await subscribe(s, { paymentProblemSince: ago(1) });
    const fail = (id: string, nextRetryAt: string | null) =>
      db().event.create({
        data: { id, shopId: s.shop.id, subscriptionId: sub.id, type: "billing.failed", payload: { nextRetryAt }, createdAt: ago(0.1) },
      });
    await fail("billing.failed:a", ahead(3).toISOString());
    await db().event.create({ data: { id: "billing.failed:old", shopId: s.shop.id, subscriptionId: sub.id, type: "billing.failed", payload: {}, createdAt: ago(10) } });
    const m = mailer();
    const { graphql } = shopify({ [sub.customerGid]: "p@e.test" });
    await runAll(s, m, graphql);
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0].text).toContain("We'll try again on");
    await fail("billing.failed:b", null);
    await runAll(s, m, graphql);
    expect(m.sent).toHaveLength(2);
    expect(m.sent[1].text).toContain("paused");
    expect(m.sent[1].text).toContain("/l/");
  });

  it("last release: only when nothing renews after it, and only for the latest order", async () => {
    const s = await setupShop();
    const cancelled = await subscribe(s, { status: "CANCELLED", releasesRemaining: 0 });
    const renewing = await subscribe(s, { releasesRemaining: 0 });
    const stillPaid = await subscribe(s, { status: "CANCELLED", releasesRemaining: 1 });
    for (const sub of [cancelled, renewing, stillPaid]) {
      const rel = await release(s, "READY");
      await db().delivery.create({
        data: { subscriptionId: sub.id, releaseId: rel.id, status: "ORDERED", orderGid: `gid://shopify/Order/${++n}`, updatedAt: ago(0.1) },
      });
    }
    await queueEmails(env.DB, s.shop.id, NOW);
    expect((await rows(s.shop.id, "lastReleaseShipping")).map((row) => row.subscriptionId)).toEqual([cancelled.id]);
    // A plan without auto-renew ends after its last release too.
    const off = await setupShop({}, { autoRenew: false });
    const ending = await subscribe(off, { releasesRemaining: 0 });
    const rel = await release(off, "READY");
    await db().delivery.create({
      data: { subscriptionId: ending.id, releaseId: rel.id, status: "ORDERED", orderGid: `gid://shopify/Order/${++n}`, updatedAt: ago(0.1) },
    });
    await queueEmails(env.DB, off.shop.id, NOW);
    expect(await rows(off.shop.id, "lastReleaseShipping")).toHaveLength(1);
  });
});

describe("the amount a charge email states", () => {
  it("includes the contract's delivery price, so $15 plus $8 shipping reads $23, and $0 shipping adds nothing", async () => {
    const s = await setupShop({}, { priceCents: 1500 });
    const paid = await subscribe(s, { termEndsAt: ahead(10), lockedPriceCents: 1500, quantity: 2 });
    const free = await subscribe(s, { termEndsAt: ahead(10), lockedPriceCents: 1500 });
    const m = mailer();
    await runAll(
      s,
      m,
      shopify(
        { [paid.customerGid]: "p@e.test", [free.customerGid]: "f@e.test" },
        { [paid.contractGid!]: "8.0" },
      ).graphql,
    );
    const text = (to: string) => m.sent.find((message) => message.to === to).text;
    expect(text("p@e.test")).toContain("we'll charge $38.00 plus any tax"); // 2 copies at $15, and $8 once
    expect(text("f@e.test")).toContain("we'll charge $15.00 plus any tax");
  });

  it("does the same for the per-release and held variants, and the price-change notice's two prices", async () => {
    const s = await setupShop({}, { renewalRule: "ON_DEPLETION", priceCents: 1500 });
    await release(s, "PREORDER");
    const sub = await subscribe(s, { lockedPriceCents: 1500, releasesRemaining: 1 });
    await db().priceChange.create({
      data: { planId: s.plan.id, newPriceCents: 2000, policy: "APPLY_AT_RENEWAL", effectiveAt: ahead(30), createdAt: ago(0.2) },
    });
    const m = mailer();
    await runAll(s, m, shopify({ [sub.customerGid]: "x@e.test" }, { [sub.contractGid!]: "8.0" }).graphql);
    const texts = m.sent.map((message) => message.text).join("\n");
    expect(texts).toContain("we'll charge $23.00 plus any tax");
    expect(texts).toContain("goes from $23.00 to $28.00, each plus any tax");
  });

  it("states no amount for a contract that's gone", async () => {
    const s = await setupShop();
    const sub = await subscribe(s, { termEndsAt: ahead(10) });
    const m = mailer();
    await runAll(s, m, shopify({ [sub.customerGid]: "x@e.test" }, { [sub.contractGid!]: null }).graphql);
    expect(m.sent).toHaveLength(0);
    expect((await rows(s.shop.id, "upcomingCharge"))[0]).toMatchObject({ status: "SKIPPED", reason: "no_contract" });
  });
});

describe("the price-change notice", () => {
  async function change(s: Setup, data: Record<string, unknown> = {}) {
    return db().priceChange.create({
      data: { planId: s.plan.id, newPriceCents: 5000, policy: "APPLY_AT_RENEWAL", effectiveAt: ahead(30), createdAt: ago(0.2), ...data },
    });
  }

  it("reaches subscribers who signed up at the old price, is sent even with every email off, and is marked sent", async () => {
    const s = await setupShop({ emailsEnabled: Object.fromEntries(EMAIL_KEYS.map((key) => [key, false])) });
    const old = await subscribe(s, { lockedPriceCents: 4000 });
    await subscribe(s, { lockedPriceCents: 5000, createdAt: ago(0.1) }); // signed up at the new price
    await subscribe(s, { lockedPriceCents: 4000, status: "CANCELLED" });
    await subscribe(s, { lockedPriceCents: 4000, source: "GIFT" });
    const pc = await change(s);
    const m = mailer();
    await runAll(s, m, shopify({ [old.customerGid]: "o@e.test" }).graphql);
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0].text).toContain("from $40.00 to $50.00");
    expect(m.sent[0].subject).toBe("Price change for Yearly subscription");
    expect((await db().priceChange.findUniqueOrThrow({ where: { id: pc.id } })).noticeSentAt).not.toBeNull();
    // A repeat sends nothing new.
    await runAll(s, m, shopify({ [old.customerGid]: "o@e.test" }).graphql);
    expect(m.sent).toHaveLength(1);
  });

  it("is not marked sent while a subscriber's email is still waiting, and is marked at once when nobody needs it", async () => {
    const s = await setupShop();
    const sub = await subscribe(s);
    const pc = await change(s);
    const m = mailer();
    m.failures.push(codeError("E_RATE_LIMIT_EXCEEDED"));
    await runAll(s, m, shopify({ [sub.customerGid]: "o@e.test" }).graphql);
    expect((await db().priceChange.findUniqueOrThrow({ where: { id: pc.id } })).noticeSentAt).toBeNull();
    await runAll(s, m, shopify({ [sub.customerGid]: "o@e.test" }).graphql);
    expect((await db().priceChange.findUniqueOrThrow({ where: { id: pc.id } })).noticeSentAt).not.toBeNull();

    const none = await setupShop();
    const pc2 = await change(none);
    await runAll(none, mailer(), shopify().graphql);
    expect((await db().priceChange.findUniqueOrThrow({ where: { id: pc2.id } })).noticeSentAt).not.toBeNull();
  });

  it("is not sent for a change that was superseded or whose date has passed", async () => {
    const s = await setupShop();
    const sub = await subscribe(s);
    const first = await change(s, { createdAt: ago(0.4) });
    await change(s, { policy: "KEEP_OLD_PRICE", createdAt: ago(0.2) });
    await queueEmails(env.DB, s.shop.id, NOW);
    expect(await rows(s.shop.id, "priceChange")).toHaveLength(0);
    expect(first.id).toBeTruthy();
    expect(sub.id).toBeTruthy();
  });
});

// ---- exactly once, crashes and limits --------------------------------------------------

describe("sending once", () => {
  async function welcomeFor(count = 1) {
    const s = await setupShop();
    const addresses: Record<string, string> = {};
    for (let i = 0; i < count; i++) {
      const sub = await subscribe(s, { createdAt: ago(0.1) });
      addresses[sub.customerGid] = `${sub.id}@e.test`;
    }
    return { s, addresses };
  }

  it("a repeat of the job, or a second job, sends nothing new", async () => {
    const { s, addresses } = await welcomeFor();
    const m = mailer();
    const { graphql } = shopify(addresses);
    await runAll(s, m, graphql, {}, emailRunJob(s.domain, "same"));
    await runAll(s, m, graphql, {}, emailRunJob(s.domain, "same"));
    await runAll(s, m, graphql);
    await Promise.all([runAll(s, m, graphql), runAll(s, m, graphql)]);
    expect(m.sent).toHaveLength(1);
    expect(await rows(s.shop.id)).toHaveLength(1);
  });

  it("a crash after the claim, before any answer, is never sent again by itself", async () => {
    const { s, addresses } = await welcomeFor();
    await queueEmails(env.DB, s.shop.id, NOW);
    // The Worker died holding the claim: SENDING, and the lease has run out.
    await env.DB.prepare(`UPDATE "EmailSend" SET "status" = 'SENDING', "attempts" = 1, "leaseUntil" = ? WHERE "shopId" = ?`)
      .bind(ago(0.01).toISOString(), s.shop.id)
      .run();
    const m = mailer();
    await runAll(s, m, shopify(addresses).graphql, {}, emailRunJob(s.domain, "after", { queued: true }));
    expect(m.sent).toHaveLength(0);
    expect((await rows(s.shop.id))[0]).toMatchObject({ status: "UNSURE", reason: "lease_lapsed" });
  });

  it("a claim still within its lease is left alone", async () => {
    const { s, addresses } = await welcomeFor();
    await queueEmails(env.DB, s.shop.id, NOW);
    await env.DB.prepare(`UPDATE "EmailSend" SET "status" = 'SENDING', "leaseUntil" = ? WHERE "shopId" = ?`)
      .bind(ahead(0.01).toISOString(), s.shop.id)
      .run();
    const m = mailer();
    await runAll(s, m, shopify(addresses).graphql, {}, emailRunJob(s.domain, "within", { queued: true }));
    expect(m.sent).toHaveLength(0);
    expect((await rows(s.shop.id))[0].status).toBe("SENDING");
  });

  it("a crash before the claim leaves the row pending, so a later job sends it once", async () => {
    const { s, addresses } = await welcomeFor();
    await queueEmails(env.DB, s.shop.id, NOW);
    const m = mailer();
    await runAll(s, m, shopify(addresses).graphql, {}, emailRunJob(s.domain, "later", { queued: true }));
    expect(m.sent).toHaveLength(1);
  });

  it("a hiccup on Cloudflare's side retries later, and a failure that never ends gives up after five tries", async () => {
    const { s, addresses } = await welcomeFor();
    const m = mailer();
    const { graphql } = shopify(addresses);
    m.failures.push(codeError("E_INTERNAL_SERVER_ERROR"));
    await runAll(s, m, graphql);
    expect(m.sent).toHaveLength(0);
    expect((await rows(s.shop.id))[0]).toMatchObject({ status: "PENDING", attempts: 1, reason: "E_INTERNAL_SERVER_ERROR" });
    // Not before its retry time.
    await runAll(s, m, graphql);
    expect(m.sent).toHaveLength(0);
    await env.DB.prepare(`UPDATE "EmailSend" SET "leaseUntil" = NULL WHERE "shopId" = ?`).bind(s.shop.id).run();
    await runAll(s, m, graphql);
    expect(m.sent).toHaveLength(1);
    expect((await rows(s.shop.id))[0].status).toBe("SENT");

    const stuck = await welcomeFor();
    for (let i = 0; i < 5; i++) {
      m.failures.push(codeError("E_INTERNAL_SERVER_ERROR"));
      await env.DB.prepare(`UPDATE "EmailSend" SET "leaseUntil" = NULL WHERE "shopId" = ?`).bind(stuck.s.shop.id).run();
      await runAll(stuck.s, m, shopify(stuck.addresses).graphql);
    }
    expect((await rows(stuck.s.shop.id))[0]).toMatchObject({ status: "FAILED", attempts: 5 });
  });

  it("a refused address fails for good and the rest still go", async () => {
    const { s, addresses } = await welcomeFor(3);
    const m = mailer();
    m.failures.push(null, codeError("E_RECIPIENT_SUPPRESSED"));
    await runAll(s, m, shopify(addresses).graphql);
    const statuses = (await rows(s.shop.id)).map((row) => row.status).sort();
    expect(statuses).toEqual(["FAILED", "SENT", "SENT"]);
    expect((await rows(s.shop.id)).find((row) => row.status === "FAILED")!.reason).toBe("E_RECIPIENT_SUPPRESSED");
    await runAll(s, m, shopify(addresses).graphql);
    expect(m.sent).toHaveLength(2); // the failed one is not tried again
  });

  it("a rate limit stops the slice, keeps every attempt, and waits before the next", async () => {
    const { s, addresses } = await welcomeFor(3);
    const m = mailer();
    m.failures.push(null, codeError("E_RATE_LIMIT_EXCEEDED"));
    const followUps = await runAll(s, m, shopify(addresses).graphql);
    expect(followUps).toEqual([{ delaySeconds: 60 }]);
    expect(m.sent).toHaveLength(1);
    const pending = (await rows(s.shop.id)).filter((row) => row.status === "PENDING");
    expect(pending).toHaveLength(2);
    expect(pending.every((row) => row.attempts <= 1)).toBe(true);
    await runAll(s, m, shopify(addresses).graphql);
    expect(m.sent).toHaveLength(3);
    expect((await rows(s.shop.id)).every((row) => row.status === "SENT")).toBe(true);
  });

  it("a daily limit waits an hour, and a sender problem is not held against the customer", async () => {
    const { s, addresses } = await welcomeFor(1);
    const m = mailer();
    m.failures.push(codeError("E_DAILY_LIMIT_EXCEEDED"));
    expect(await runAll(s, m, shopify(addresses).graphql)).toEqual([{ delaySeconds: 3600 }]);
    m.failures.push(codeError("E_SENDER_NOT_VERIFIED"));
    expect(await runAll(s, m, shopify(addresses).graphql)).toEqual([{ delaySeconds: 3600 }]);
    expect((await rows(s.shop.id))[0]).toMatchObject({ status: "PENDING", attempts: 0 });
  });

  it("1,000 subscribers go out in slices, each exactly once", async () => {
    const s = await setupShop();
    const addresses: Record<string, string> = {};
    const stamp = NOW.toISOString();
    const statements = [];
    for (let i = 0; i < 1000; i++) {
      const gid = `gid://shopify/Customer/bulk${n}-${i}`;
      addresses[gid] = `bulk${i}@e.test`;
      statements.push(
        env.DB.prepare(
          `INSERT INTO "Subscription" ("id", "shopId", "planId", "contractGid", "customerGid", "releasesRemaining", "createdAt", "updatedAt")
           VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)`,
        ).bind(`bulk${n}-${i}`, s.shop.id, s.plan.id, `gid://shopify/SubscriptionContract/bulk${n}-${i}`, gid, stamp),
      );
    }
    for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100));
    const m = mailer();
    const shopifyFake = shopify(addresses);
    const followUps = await runAll(s, m, shopifyFake.graphql);
    expect(followUps.every((next) => next.delaySeconds === 0)).toBe(true); // 20 a slice, no waiting, and it ended itself
    expect(followUps).toHaveLength(50);
    expect(m.sent).toHaveLength(1000);
    expect(new Set(m.sent.map((message) => message.to)).size).toBe(1000);
    expect(shopifyFake.calls.length).toBeLessThanOrEqual(51); // one read a slice, not one a subscriber
  }, 60_000);
});

describe("who can be reached, and when it is still right to send", () => {
  it("skips a customer with no email, a deleted customer and a redacted one", async () => {
    const s = await setupShop();
    const none = await subscribe(s, { createdAt: ago(0.1) });
    const gone = await subscribe(s, { createdAt: ago(0.1) });
    await subscribe(s, { createdAt: ago(0.1), customerGid: "redacted" });
    const m = mailer();
    await runAll(s, m, shopify({ [none.customerGid]: null }).graphql);
    expect(m.sent).toHaveLength(0);
    const reasons = Object.fromEntries((await rows(s.shop.id)).map((row) => [row.subscriptionId, row.reason]));
    expect(reasons).toEqual({ [none.id]: "no_email", [gone.id]: "no_email" });
  });

  it("with a recipient allow-list set, mail reaches only those domains", async () => {
    const s = await setupShop();
    const test = await subscribe(s, { createdAt: ago(0.1) });
    const real = await subscribe(s, { createdAt: ago(0.1) });
    const m = mailer();
    await runAll(
      s,
      m,
      shopify({ [test.customerGid]: "t@mailinator.com", [real.customerGid]: "r@gmail.com" }).graphql,
      { EMAIL_RECIPIENT_DOMAINS: "Mailinator.com" },
    );
    expect(m.sent.map((message) => message.to)).toEqual(["t@mailinator.com"]);
    expect((await rows(s.shop.id)).find((row) => row.subscriptionId === real.id)!.reason).toBe("recipient_not_allowed");
  });

  it("a subscriber who cancelled or ended after queueing gets nothing inappropriate", async () => {
    const s = await setupShop();
    const rel = await release(s, "PREORDER");
    const welcome = await subscribe(s, { createdAt: ago(0.1) });
    const ended = await subscribe(s);
    const cancelled = await subscribe(s, { releasesRemaining: 1 });
    await queueEmails(env.DB, s.shop.id, NOW);
    await db().subscription.update({ where: { id: welcome.id }, data: { status: "CANCELLED" } });
    await db().subscription.update({ where: { id: ended.id }, data: { status: "ENDED" } });
    await db().subscription.update({ where: { id: cancelled.id }, data: { status: "CANCELLED", releasesRemaining: 0 } });
    const m = mailer();
    const customers = Object.fromEntries(
      (await db().subscription.findMany({ where: { shopId: s.shop.id } })).map((sub) => [sub.customerGid, "x@e.test"]),
    );
    await runAll(s, m, shopify(customers).graphql, {}, emailRunJob(s.domain, "stale", { queued: true }));
    expect(m.sent).toHaveLength(0);
    expect((await rows(s.shop.id)).map((row) => row.reason).sort()).toEqual(
      ["cancelled", "ended", "not_active"].sort(),
    );
    expect(rel.id).toBeTruthy();
  });

  it("staleReason: each email is judged on the state at send time", () => {
    const row: any = {
      kind: "failedPayment", subject: "s", status: "ACTIVE", customerGid: "gid://c/1", source: "NEW",
      releasesRemaining: 1, pausedReason: null, paymentProblemSince: "2026-11-01", autoRenew: 1,
    };
    const shop = { emailsEnabled: {} };
    const now = new Date();
    expect(staleReason(row, shop, { now })).toBeNull();
    expect(staleReason({ ...row, paymentProblemSince: null }, shop, { now })).toBe("resolved");
    expect(staleReason({ ...row, status: "CANCELLED" }, shop, { now })).toBe("not_active");
    expect(staleReason({ ...row, customerGid: "redacted" }, shop, { now })).toBe("ended");
    expect(staleReason({ ...row, kind: "welcome", status: "PAUSED" }, shop, { now })).toBe("not_active");
    expect(staleReason({ ...row, kind: "preorderAnnounced" }, shop, { now, release: { id: "r", title: "t", status: "READY" } })).toBe("release_moved_on");
    expect(staleReason({ ...row, kind: "preorderAnnounced", pausedReason: "CHARGEBACK" }, shop, { now, release: { id: "r", title: "t", status: "PREORDER" } })).toBe("chargeback");
    expect(staleReason({ ...row, kind: "upcomingCharge", subject: "late:2026-01-01", releasesRemaining: 0, paymentProblemSince: null }, shop, { now })).toBe("ship_started");
    expect(staleReason({ ...row, kind: "upcomingCharge", paymentProblemSince: null, autoRenew: 0 }, shop, { now })).toBe("not_renewing");
    expect(staleReason({ ...row, kind: "lastReleaseShipping", releasesRemaining: 0 }, shop, { now })).toBe("renewed");
    expect(staleReason({ ...row, kind: "lastReleaseShipping", releasesRemaining: 0, status: "CANCELLED" }, shop, { now })).toBeNull();
    const change = { id: "pc", planId: "p", newPriceCents: 1, effectiveAt: new Date(now.getTime() + 1e9) };
    expect(staleReason({ ...row, kind: "priceChange" }, { emailsEnabled: { welcome: false } }, { now, change, latestChange: change })).toBeNull();
    expect(staleReason({ ...row, kind: "priceChange" }, shop, { now, change, latestChange: { ...change, id: "newer" } })).toBe("superseded");
    expect(staleReason({ ...row, kind: "priceChange" }, shop, { now, change: { ...change, effectiveAt: new Date(now.getTime() - 1) }, latestChange: change })).toBe("too_late");
  });
});

// ---- copy ------------------------------------------------------------------------------

const PORTAL = "https://shopify.com/1/account/pages/customer-portal";

describe("copy", () => {
  const shop: ShopCopy = {
    name: "Cake <Zine> & Co",
    url: "https://cake.test",
    singular: "drop",
    plural: "drops",
    timezone: "America/New_York",
    address: "1 Main St, New York, NY",
  };
  const all: EmailData[] = [
    { kind: "welcome", plan: "Yearly" },
    { kind: "preorderAnnounced", release: "Zine 4", paused: false, ordersNow: false, addressUrl: "https://a.test/l/x", cardUrl: "https://a.test/l/y" },
    { kind: "preorderAnnounced", release: "Zine 4", paused: true, ordersNow: false, addressUrl: "https://a.test/l/x", cardUrl: "https://a.test/l/y" },
    { kind: "preorderAnnounced", release: "Zine 4", paused: false, ordersNow: true, addressUrl: "https://a.test/l/x", cardUrl: "https://a.test/l/y" },
    { kind: "upcomingCharge", plan: "Yearly", amount: "$40.00", portalUrl: PORTAL, when: { on: new Date("2027-03-01T10:00:00Z"), releases: 2 } },
    { kind: "upcomingCharge", plan: "Yearly", amount: "$40.00", portalUrl: PORTAL, when: { on: new Date("2027-03-01T10:00:00Z"), releases: 1 } },
    { kind: "upcomingCharge", plan: "Yearly", amount: "$40.00", portalUrl: PORTAL, when: { release: "Zine 4" } },
    { kind: "upcomingCharge", plan: "Yearly", amount: "$40.00", portalUrl: PORTAL, when: { held: new Date("2027-03-01T10:00:00Z") } },
    { kind: "failedPayment", plan: "Yearly", retryOn: new Date("2026-11-10T10:00:00Z"), cardUrl: "https://a.test/l/y" },
    { kind: "failedPayment", plan: "Yearly", retryOn: null, cardUrl: "https://a.test/l/y" },
    { kind: "lastReleaseShipping", plan: "Yearly", release: "Zine 4" },
    { kind: "priceChange", plan: "Yearly", oldAmount: "$40.00", newAmount: "$50.00", effectiveAt: new Date("2026-12-04T10:00:00Z"), portalUrl: PORTAL },
  ];

  it("uses the shop's release word and name, never a hard-coded one", () => {
    for (const data of all) {
      const { subject, text, html } = renderEmail(shop, data);
      expect(`${subject}\n${text}\n${html}`, data.kind).not.toMatch(/issue/i);
      expect(subject.length).toBeGreaterThan(0);
      expect(text).toContain("You're receiving this because you subscribe to Cake <Zine> & Co.");
      expect(text).toContain("1 Main St, New York, NY");
    }
    expect(renderEmail(shop, all[0]).text).toContain("Each drop ships on its own order");
    expect(renderEmail(shop, all[4]).text).toContain("another 2 drops");
    expect(renderEmail(shop, all[5]).text).toContain("another 1 drop.");
  });

  it("offers cancelling through the portal link, in the shop's release word, and no longer asks for a reply", () => {
    const withCancel = all.filter((d) => d.kind === "upcomingCharge" || d.kind === "priceChange");
    expect(withCancel).toHaveLength(5);
    for (const data of withCancel) {
      const { text, html } = renderEmail(shop, data);
      expect(text, data.kind).not.toMatch(/reply to this email/i);
      expect(text).toContain(`Turn off auto-renew or cancel: ${PORTAL}`);
      expect(html).toContain(`href="${PORTAL}"`);
      expect(html).toContain(">Turn off auto-renew or cancel</a>");
      expect(text).toContain("The drops you've already paid for still ship.");
    }
    // The emails that don't offer it don't carry the link.
    expect(renderEmail(shop, all[0]).text).not.toContain(PORTAL);
  });

  it("escapes everything in the HTML and keeps the subject to one line", () => {
    const rendered = renderEmail({ ...shop, name: `A"><script>x</script>` }, { kind: "welcome", plan: "<b>P</b>" });
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).not.toContain("<b>P</b>");
    expect(renderEmail(shop, { ...all[1], release: "a\nb" } as EmailData).subject).not.toMatch(/\n/);
  });

  it("the welcome email doesn't imply the checkout order ships a release", () => {
    expect(renderEmail(shop, all[0]).text).toContain("only records your payment: it doesn't ship a drop");
  });

  it("the pre-order email says the order is created when shipping starts, with the address as its main button", () => {
    const { text, html } = renderEmail(shop, all[1]);
    expect(text).toContain("as soon as it starts shipping");
    expect(text).toContain("We create your order then");
    expect(html).toContain(">Confirm or update your delivery address</a>");
  });

  it("dates follow the shop's timezone", () => {
    const late = renderEmail({ ...shop, timezone: "America/Los_Angeles" }, { kind: "upcomingCharge", plan: "P", amount: "$1.00", portalUrl: PORTAL, when: { on: new Date("2027-03-01T02:00:00Z"), releases: 1 } });
    expect(late.subject).toBe("Your P renews on February 28, 2027");
  });
});

// ---- the signed link ---------------------------------------------------------------------

describe("signed links", () => {
  const e = { SHOPIFY_API_SECRET: "k1" };

  it("round-trips, names only IDs, and expires after 30 days", async () => {
    const token = await signLinkToken(e, { k: "address", s: "sub1", r: "rel1" }, NOW);
    expect(await verifyLinkToken(e, token, ahead(29))).toMatchObject({ k: "address", s: "sub1", r: "rel1" });
    expect(await verifyLinkToken(e, token, ahead(31))).toBeNull();
    const body = JSON.parse(atob(token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")));
    expect(Object.keys(body).sort()).toEqual(["e", "k", "r", "s"]);
  });

  it("rejects a changed payload, a changed signature, another key and junk", async () => {
    const token = await signLinkToken(e, { k: "card", s: "sub1" }, NOW);
    const [body, signature] = token.split(".");
    const forged = btoa(JSON.stringify({ k: "card", s: "sub2", e: 9999999999 })).replace(/=+$/, "");
    expect(await verifyLinkToken(e, `${forged}.${signature}`, NOW)).toBeNull();
    expect(await verifyLinkToken(e, `${body}.${signature.slice(0, -2)}AA`, NOW)).toBeNull();
    expect(await verifyLinkToken({ SHOPIFY_API_SECRET: "k2" }, token, NOW)).toBeNull();
    for (const junk of ["", "x", "a.b.c", ".", "!!.!!"]) expect(await verifyLinkToken(e, junk, NOW)).toBeNull();
  });
});

// ---- address confirmation --------------------------------------------------------------

describe("address confirmation", () => {
  it("is recorded on the Delivery when it exists, and carried over to one made later", async () => {
    const s = await setupShop();
    const rel = await release(s, "PREORDER");
    const sub = await subscribe(s);
    const m = mailer();
    await runAll(s, m, shopify({ [sub.customerGid]: "c@e.test" }).graphql);
    expect(m.sent).toHaveLength(1);

    // The customer clicks before orders exist: there's no Delivery to mark yet.
    await recordAddressConfirmation(env.DB, sub.id, rel.id, ago(0.01));
    expect(await db().delivery.count({ where: { subscriptionId: sub.id } })).toBe(0);
    await db().release.update({ where: { id: rel.id }, data: { status: "READY" } });
    await createDueDeliveries(env.DB, s.shop.id, rel.id, NOW);
    const delivery = await db().delivery.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    expect(delivery.addressConfirmedAt?.getTime()).toBe(ago(0.01).getTime());

    // And clicking again later keeps the first time.
    await recordAddressConfirmation(env.DB, sub.id, rel.id, NOW);
    expect((await db().delivery.findUniqueOrThrow({ where: { id: delivery.id } })).addressConfirmedAt?.getTime()).toBe(ago(0.01).getTime());
  });
});

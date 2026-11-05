/* eslint-disable @typescript-eslint/no-explicit-any -- request and job fakes */
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../app/db.server";
import {
  DATA_REQUEST_EVENT,
  recordDataRequest,
  redactCustomer,
  redactShop,
} from "../app/gdpr.server";
import { jobHandlers } from "../app/jobs/registry.server";
import { action as compliance } from "../app/routes/webhooks.compliance";
import { action as contractHook } from "../app/routes/webhooks.subscription_contracts";
import { createDeliveryOrder } from "../app/release-orders.server";
import { getOrCreateShop } from "../app/shop.server";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const db = () => createDb(env.DB);
let n = 0;
const CUSTOMER = "gid://shopify/Customer/77";

async function setup() {
  const domain = `gdpr${++n}.myshopify.com`;
  const shop = await getOrCreateShop(db(), domain);
  const plan = await db().plan.create({
    data: { shopId: shop.id, name: "P", displayName: "P", priceCents: 100 },
  });
  const release = await db().release.create({
    data: { shopId: shop.id, number: 1, title: "R", status: "PREORDER" },
  });
  const subscribe = (customerGid: string) =>
    db().subscription.create({
      data: {
        shopId: shop.id,
        planId: plan.id,
        contractGid: `gid://shopify/SubscriptionContract/${++n}`,
        customerGid,
        releasesRemaining: 2,
        giftMessage: "Happy birthday",
        deliveries: {
          create: {
            releaseId: release.id,
            addressConfirmedAt: new Date(),
          },
        },
      },
      include: { deliveries: true },
    });
  const subscription = await subscribe(CUSTOMER);
  const other = await subscribe("gid://shopify/Customer/88");
  await db().event.create({
    data: {
      shopId: shop.id,
      subscriptionId: subscription.id,
      type: "test",
      payload: {},
    },
  });
  return { domain, shop, plan, release, subscription, other };
}

describe("recordDataRequest", () => {
  it("keeps what the app holds for the merchant, once, and nothing about others", async () => {
    const { domain, shop, subscription, other } = await setup();
    for (let i = 0; i < 2; i++) {
      await recordDataRequest(db(), env.DB, domain, CUSTOMER, "req-1");
    }
    const events = await db().event.findMany({
      where: { shopId: shop.id, type: DATA_REQUEST_EVENT },
    });
    expect(events).toHaveLength(1);
    const payload = events[0].payload as any;
    expect(payload.subscriptions.map((row: any) => row.id)).toEqual([subscription.id]);
    expect(payload.subscriptions[0].deliveries).toHaveLength(1);
    expect(JSON.stringify(payload)).not.toContain(other.id);
  });

  it("does nothing for a shop it doesn't know", async () => {
    await expect(
      recordDataRequest(db(), env.DB, "nobody.myshopify.com", CUSTOMER, "r"),
    ).resolves.toBeUndefined();
  });
});

describe("redactCustomer", () => {
  it("erases the customer, ends the subscription and leaves others alone", async () => {
    const { domain, shop, subscription, other } = await setup();
    await recordDataRequest(db(), env.DB, domain, CUSTOMER, "req-2");
    await redactCustomer(db(), env.DB, domain, CUSTOMER);

    const row = await db().subscription.findUniqueOrThrow({
      where: { id: subscription.id },
      include: { deliveries: true, events: true },
    });
    expect(row).toMatchObject({
      customerGid: "redacted",
      giftMessage: null,
      status: "ENDED",
    });
    // The contract ID stays, so a replayed webhook can't recreate it.
    expect(row.contractGid).toBe(subscription.contractGid);
    expect(row.deliveries[0]).toMatchObject({
      addressConfirmedAt: null,
      status: "CANCELLED",
    });
    expect(row.events).toHaveLength(0);
    expect(
      await db().event.count({ where: { shopId: shop.id, type: DATA_REQUEST_EVENT } }),
    ).toBe(0);

    const untouched = await db().subscription.findUniqueOrThrow({
      where: { id: other.id },
      include: { deliveries: true },
    });
    expect(untouched.customerGid).toBe("gid://shopify/Customer/88");
    expect(untouched.status).toBe("ACTIVE");
    expect(untouched.deliveries[0].addressConfirmedAt).not.toBeNull();
  });

  it("clears a gift buyer without ending the recipient's subscription", async () => {
    const { domain, other } = await setup();
    await db().subscription.update({
      where: { id: other.id },
      data: { giftBuyerGid: CUSTOMER },
    });
    await redactCustomer(db(), env.DB, domain, CUSTOMER);
    const row = await db().subscription.findUniqueOrThrow({ where: { id: other.id } });
    expect(row).toMatchObject({
      giftBuyerGid: null,
      giftMessage: null,
      status: "ACTIVE",
    });
  });

  it("a repeat changes nothing", async () => {
    const { domain, subscription } = await setup();
    await redactCustomer(db(), env.DB, domain, CUSTOMER);
    const before = await db().subscription.findUniqueOrThrow({
      where: { id: subscription.id },
    });
    await redactCustomer(db(), env.DB, domain, CUSTOMER);
    const after = await db().subscription.findUniqueOrThrow({
      where: { id: subscription.id },
    });
    expect(after).toEqual(before);
  });

  it("stops a pending order being created afterwards", async () => {
    const { domain, subscription } = await setup();
    await redactCustomer(db(), env.DB, domain, CUSTOMER);
    const graphql = async () => {
      throw new Error("no call expected");
    };
    expect(
      await createDeliveryOrder(db(), env.DB, graphql, subscription.deliveries[0].id),
    ).toBe("skipped");
  });
});

describe("redactShop", () => {
  it("deletes every row for the shop, respecting foreign keys, and only that shop", async () => {
    const { domain, shop, plan, subscription } = await setup();
    const kept = await setup();
    await db().billingAttempt.create({
      data: {
        subscriptionId: subscription.id,
        chargeFor: "release",
        idempotencyKey: `key-${++n}`,
        attempt: 1,
      },
    });
    await db().priceChange.create({
      data: {
        planId: plan.id,
        newPriceCents: 200,
        policy: "KEEP_OLD_PRICE",
        effectiveAt: new Date(),
      },
    });
    await db().jobRun.create({
      data: { key: `job-${++n}`, type: "t", shop: domain },
    });
    await db().offlineSession.create({
      data: { id: `offline_${domain}`, data: "[]" },
    });

    await redactShop(db(), env.DB, domain);
    await redactShop(db(), env.DB, domain);

    const shopId = shop.id;
    expect(await db().shop.count({ where: { id: shopId } })).toBe(0);
    expect(await db().plan.count({ where: { shopId } })).toBe(0);
    expect(await db().release.count({ where: { shopId } })).toBe(0);
    expect(await db().subscription.count({ where: { shopId } })).toBe(0);
    expect(await db().event.count({ where: { shopId } })).toBe(0);
    expect(
      await db().billingAttempt.count({ where: { subscriptionId: subscription.id } }),
    ).toBe(0);
    expect(await db().priceChange.count({ where: { planId: plan.id } })).toBe(0);
    expect(await db().jobRun.count({ where: { shop: domain } })).toBe(0);
    expect(await db().offlineSession.count({ where: { id: `offline_${domain}` } })).toBe(0);

    expect(await db().shop.count({ where: { id: kept.shop.id } })).toBe(1);
    expect(await db().subscription.count({ where: { shopId: kept.shop.id } })).toBe(2);
  });
});

async function hmac(body: string, secret = env.SHOPIFY_API_SECRET) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

async function deliver(
  action: (args: any) => Promise<Response>,
  topic: string,
  shop: string,
  payload: unknown,
  secret?: string,
) {
  const body = JSON.stringify(payload);
  const sent: any[] = [];
  const request = new Request("https://app.example.com/webhooks/x", {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Hmac-Sha256": await hmac(body, secret),
      "X-Shopify-Topic": topic,
      "X-Shopify-Shop-Domain": shop,
      "X-Shopify-API-Version": "2026-10",
      "X-Shopify-Webhook-Id": `webhook-${topic}-${shop}`,
    },
  });
  const context = {
    cloudflare: {
      env: { JOBS: { sendBatch: async (m: any[]) => sent.push(...m) } },
    },
  };
  let response: Response;
  try {
    response = await action({ request, context, params: {} });
  } catch (thrown) {
    if (!(thrown instanceof Response)) throw thrown;
    response = thrown;
  }
  return { status: response.status, jobs: sent.map((message) => message.body) };
}

describe("the compliance route", () => {
  const CASES: [string, unknown, string][] = [
    [
      "customers/data_request",
      {
        shop_domain: "x",
        customer: { id: 77, email: "a@example.com" },
        data_request: { id: 5 },
      },
      "customers_data_request",
    ],
    ["customers/redact", { shop_domain: "x", customer: { id: 77 } }, "customers_redact"],
    ["shop/redact", { shop_id: 1, shop_domain: "x" }, "shop_redact"],
  ];

  for (const [topic, payload, expected] of CASES) {
    it(`${topic}: a signed request is accepted and enqueued, without the email`, async () => {
      const { status, jobs } = await deliver(
        compliance,
        topic,
        "signed.myshopify.com",
        payload,
      );
      expect(status).toBe(200);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].data.topic).toBe(expected);
      expect(jobs[0].shop).toBeUndefined();
      expect(JSON.stringify(jobs[0])).not.toContain("example.com");
    });

    it(`${topic}: a bad signature gets a 401 and enqueues nothing`, async () => {
      const { status, jobs } = await deliver(
        compliance,
        topic,
        "signed.myshopify.com",
        payload,
        "wrong-secret",
      );
      expect(status).toBe(401);
      expect(jobs).toHaveLength(0);
    });
  }

  it("delivering the job does the work, through all three topics", async () => {
    const { domain, subscription, shop } = await setup();
    const run = async (topic: string, payload: unknown) => {
      const { jobs } = await deliver(compliance, topic, domain, payload);
      await jobHandlers[jobs[0].type](jobs[0], { db: db(), env } as any);
    };
    await run("customers/data_request", {
      customer: { id: 77 },
      data_request: { id: 9 },
    });
    expect(
      await db().event.count({ where: { shopId: shop.id, type: DATA_REQUEST_EVENT } }),
    ).toBe(1);
    await run("customers/redact", { customer: { id: 77 } });
    expect(
      (await db().subscription.findUniqueOrThrow({ where: { id: subscription.id } }))
        .customerGid,
    ).toBe("redacted");
    await run("shop/redact", { shop_id: 1 });
    expect(await db().shop.count({ where: { id: shop.id } })).toBe(0);
  });
});

describe("the contract route", () => {
  const PAYLOAD = {
    admin_graphql_api_id: "gid://shopify/SubscriptionContract/1",
    revision_id: "42",
  };

  it("keys the job on the webhook, so Shopify's retry runs once and a cancel still runs", async () => {
    const send = (topic: string) =>
      deliver(contractHook, topic, "s.myshopify.com", PAYLOAD);
    const created = await send("subscription_contracts/create");
    const retried = await send("subscription_contracts/create");
    // Cancelling a contract leaves its revision as it was.
    const cancelled = await send("subscription_contracts/update");
    expect(created.status).toBe(200);
    expect(created.jobs[0]).toEqual({
      type: "contract.sync",
      id: "contract.sync:gid://shopify/SubscriptionContract/1:webhook-subscription_contracts/create-s.myshopify.com",
      shop: "s.myshopify.com",
      data: { contractGid: PAYLOAD.admin_graphql_api_id },
    });
    expect(retried.jobs[0].id).toBe(created.jobs[0].id);
    expect(cancelled.jobs[0].id).not.toBe(created.jobs[0].id);
  });

  it("rejects a bad signature", async () => {
    const { status, jobs } = await deliver(
      contractHook,
      "subscription_contracts/create",
      "s.myshopify.com",
      PAYLOAD,
      "wrong-secret",
    );
    expect(status).toBe(401);
    expect(jobs).toHaveLength(0);
  });
});

describe("gifts and personal data", () => {
  const BUYER = "gid://shopify/Customer/9001";
  const RECIPIENT = "gid://shopify/Customer/9002";

  async function gift() {
    const ctx = await setup();
    const sub = await db().subscription.create({
      data: {
        shopId: ctx.shop.id,
        planId: ctx.plan.id,
        contractGid: `gid://shopify/SubscriptionContract/${++n}`,
        customerGid: RECIPIENT,
        source: "GIFT",
        giftBuyerGid: BUYER,
        giftMessage: "Happy birthday",
        releasesRemaining: 2,
        deliveries: { create: { releaseId: ctx.release.id, addressConfirmedAt: new Date() } },
      },
    });
    await db().emailSend.create({
      data: { id: `giftReceived:${sub.id}:start`, shopId: ctx.shop.id, subscriptionId: sub.id, kind: "giftReceived", subject: "start" },
    });
    return { ...ctx, gift: sub };
  }

  it("a data request from the buyer and from the recipient each get the gift and its message", async () => {
    const { domain, shop, gift: sub, other } = await gift();
    await recordDataRequest(db(), env.DB, domain, BUYER, "buyer-req");
    await recordDataRequest(db(), env.DB, domain, RECIPIENT, "recipient-req");
    for (const requestId of ["buyer-req", "recipient-req"]) {
      const event = await db().event.findFirstOrThrow({
        where: { shopId: shop.id, type: DATA_REQUEST_EVENT, id: { endsWith: requestId } },
      });
      const payload = event.payload as any;
      expect(payload.subscriptions.map((row: any) => row.id), requestId).toEqual([sub.id]);
      expect(payload.subscriptions[0]).toMatchObject({ source: "GIFT", giftMessage: "Happy birthday" });
      expect(payload.subscriptions[0].emailSends).toEqual([expect.objectContaining({ kind: "giftReceived" })]);
      expect(JSON.stringify(payload)).not.toContain(other.id);
    }
  });

  it("erasing the buyer clears them and the message, and the recipient keeps their gift", async () => {
    const { domain, gift: sub } = await gift();
    await redactCustomer(db(), env.DB, domain, BUYER);
    expect(await db().subscription.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({
      giftBuyerGid: null,
      giftMessage: null,
      customerGid: RECIPIENT,
      status: "ACTIVE",
    });
    expect(await db().emailSend.count({ where: { subscriptionId: sub.id } })).toBe(1);
  });

  it("erasing the recipient ends the gift, erases the message and their records, and the buyer's other subscriptions stay", async () => {
    const { domain, shop, plan, gift: sub } = await gift();
    const buyers = await db().subscription.create({
      data: {
        shopId: shop.id,
        planId: plan.id,
        contractGid: `gid://shopify/SubscriptionContract/${++n}`,
        customerGid: BUYER,
        releasesRemaining: 2,
      },
    });
    await redactCustomer(db(), env.DB, domain, RECIPIENT);
    expect(await db().subscription.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({
      customerGid: "redacted",
      giftMessage: null,
      status: "ENDED",
    });
    expect(await db().emailSend.count({ where: { subscriptionId: sub.id } })).toBe(0);
    expect(await db().subscription.findUniqueOrThrow({ where: { id: buyers.id } })).toMatchObject({
      customerGid: BUYER,
      status: "ACTIVE",
    });
  });
});

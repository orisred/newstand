import type { createDb } from "./db.server";
import { logEvent } from "./logger.server";

type Db = ReturnType<typeof createDb>;

export const GDPR_JOB = "gdpr";

export const DATA_REQUEST_EVENT = "gdpr.data_request";

/**
 * Keeps what the app holds on a customer as an Event for the merchant to hand over, keyed on
 * Shopify's request ID. The app stores Shopify IDs, statuses and dates, plus a gift message,
 * and no names, addresses or emails. Orders stay in Shopify.
 */
export async function recordDataRequest(
  db: Db,
  rawDb: D1Database,
  shopDomain: string,
  customerGid: string,
  requestId: string,
) {
  const shop = await db.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });
  if (!shop) return;
  const subscriptions = await db.subscription.findMany({
    where: {
      shopId: shop.id,
      OR: [{ customerGid }, { giftBuyerGid: customerGid }],
    },
    select: {
      id: true,
      contractGid: true,
      status: true,
      source: true,
      quantity: true,
      releasesRemaining: true,
      termEndsAt: true,
      lockedPriceCents: true,
      giftMessage: true,
      createdAt: true,
      plan: { select: { displayName: true } },
      deliveries: {
        select: {
          orderGid: true,
          orderName: true,
          status: true,
          addressConfirmedAt: true,
          release: { select: { number: true, title: true } },
        },
      },
    },
  });
  await rawDb
    .prepare(
      `INSERT INTO "Event" ("id", "shopId", "type", "payload")
       VALUES (?1, ?2, ?3, ?4) ON CONFLICT ("id") DO NOTHING`,
    )
    .bind(
      `${DATA_REQUEST_EVENT}:${shop.id}:${requestId}`,
      shop.id,
      DATA_REQUEST_EVENT,
      JSON.stringify({ requestId, customerGid, subscriptions }),
    )
    .run();
  logEvent("info", "gdpr.data_request", {
    shop: shopDomain,
    requestId,
    subscriptions: subscriptions.length,
  });
}

/**
 * Erases a customer's personal data and keeps the rest, so revenue and print-run counts stay
 * right. Their subscriptions end, because there's no one to ship to or charge. The contract ID
 * stays: it's what stops a replayed webhook or the tick creating the subscription again.
 */
export async function redactCustomer(
  db: Db,
  rawDb: D1Database,
  shopDomain: string,
  customerGid: string,
) {
  const shop = await db.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });
  if (!shop) return;
  const stamp = new Date().toISOString();
  const held = `SELECT "id" FROM "Subscription" WHERE "shopId" = ?1 AND "customerGid" = ?2`;
  await rawDb.batch([
    rawDb
      .prepare(
        `DELETE FROM "Event" WHERE "shopId" = ?1 AND ("subscriptionId" IN (${held})
           OR ("type" = '${DATA_REQUEST_EVENT}' AND json_extract("payload", '$.customerGid') = ?2))`,
      )
      .bind(shop.id, customerGid),
    rawDb
      .prepare(
        `UPDATE "Delivery" SET "addressConfirmedAt" = NULL, "orderError" = NULL,
           "status" = CASE WHEN "status" IN ('PENDING', 'HELD') THEN 'CANCELLED' ELSE "status" END,
           "updatedAt" = ?3
         WHERE "subscriptionId" IN (${held})`,
      )
      .bind(shop.id, customerGid, stamp),
    rawDb
      .prepare(
        `UPDATE "Subscription" SET "giftBuyerGid" = NULL, "giftMessage" = NULL, "updatedAt" = ?3
         WHERE "shopId" = ?1 AND "giftBuyerGid" = ?2`,
      )
      .bind(shop.id, customerGid, stamp),
    rawDb
      .prepare(
        `UPDATE "Subscription" SET "customerGid" = 'redacted', "giftMessage" = NULL,
           "pausedReason" = NULL, "status" = 'ENDED', "updatedAt" = ?3
         WHERE "shopId" = ?1 AND "customerGid" = ?2`,
      )
      .bind(shop.id, customerGid, stamp),
  ]);
  logEvent("info", "gdpr.customer_redacted", { shop: shopDomain });
}

/**
 * Deletes everything held for a shop, children first because D1 enforces foreign keys. One
 * batch, so it lands whole. Sent 48 hours after uninstall. Repeats find nothing to do.
 */
export async function redactShop(
  db: Db,
  rawDb: D1Database,
  shopDomain: string,
) {
  const shop = await db.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });
  const statements = [
    rawDb.prepare(`DELETE FROM "JobRun" WHERE "shop" = ?1`).bind(shopDomain),
    rawDb
      .prepare(`DELETE FROM "OfflineSession" WHERE "id" = ?1`)
      .bind(`offline_${shopDomain}`),
  ];
  if (shop) {
    const subscriptions = `(SELECT "id" FROM "Subscription" WHERE "shopId" = ?1)`;
    const plans = `(SELECT "id" FROM "Plan" WHERE "shopId" = ?1)`;
    statements.push(
      ...[
        `DELETE FROM "Event" WHERE "shopId" = ?1`,
        `DELETE FROM "BillingAttempt" WHERE "subscriptionId" IN ${subscriptions}`,
        `DELETE FROM "Delivery" WHERE "subscriptionId" IN ${subscriptions}`,
        `DELETE FROM "Subscription" WHERE "shopId" = ?1`,
        `DELETE FROM "PriceChange" WHERE "planId" IN ${plans}`,
        `DELETE FROM "Plan" WHERE "shopId" = ?1`,
        `DELETE FROM "Release" WHERE "shopId" = ?1`,
        `DELETE FROM "Shop" WHERE "id" = ?1`,
      ].map((sql) => rawDb.prepare(sql).bind(shop.id)),
    );
  }
  await rawDb.batch(statements);
  logEvent("info", "gdpr.shop_redacted", { hadData: Boolean(shop) });
}

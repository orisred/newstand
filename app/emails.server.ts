import type { createDb } from "./db.server";
import { linkUrl, portalUrl } from "./email-link.server";
import {
  EmailError,
  RATE_LIMITED,
  recipientAllowed,
  sendEmail,
} from "./email-send.server";
import {
  type EmailData,
  formatMoney,
  type ShopCopy,
  renderEmail,
} from "./email-templates";
import type { Job } from "./jobs/runner.server";
import { describeError, logEvent } from "./logger.server";
import type { Graphql } from "./plan-sync.server";
import { CHARGE_DUE, CHARGEBACK_HOLD, DUE_SUBSCRIPTION } from "./release-runs.server";
import { emailRunJob } from "./notification-jobs";
import { type EmailKey, isEmailEnabled } from "./shop.server";
import { IMPORT_HOLD } from "./subscriptions.server";

type Db = ReturnType<typeof createDb>;
type EmailEnv = Pick<
  Env,
  "EMAIL" | "EMAIL_FROM_ADDRESS" | "SHOPIFY_API_SECRET" | "SHOPIFY_APP_URL"
>;

// Each email goes out for something that just happened. These windows are how long after it
// the email is still worth sending, and what stops a first deploy, a toggle switched back on
// or a Worker that was down from mailing old news.
const WELCOME_WITHIN_DAYS = 2;
const PREORDER_WITHIN_DAYS = 7;
const FAILED_WITHIN_DAYS = 3;
const LAST_RELEASE_WITHIN_DAYS = 7;
const LATE_RENEWAL_WITHIN_DAYS = 7;
// California requires 15 to 45 days' notice before an annual auto-renewal. Three weeks sits inside it.
const RENEWAL_NOTICE_DAYS = 21;

// A slice is bounded by Cloudflare's limits, which it doesn't publish: sequential sends, a Shopify
// read per slice, and a backoff when it says slow down.
const EMAILS_PER_SLICE = 20;
const CLAIM_MS = 5 * 60 * 1000;
const RETRY_AFTER_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RATE_LIMIT_WAIT_SECONDS = 60;
const DAILY_LIMIT_WAIT_SECONDS = 3600;

// ---------------------------------------------------------------------------------------------
// Queueing: who is due which email. Every statement is idempotent (the row's ID is the key) and
// writes a SKIPPED row, not nothing, for an email the shop has switched off. So switching it back
// on later can't send what was missed, and a repeat of the job adds nothing.
// ---------------------------------------------------------------------------------------------

const enabled = (key: EmailKey) =>
  `COALESCE(json_extract(sh."emailsEnabled", '$.${key}'), 1) <> 0`;
const BASE = `s."shopId" = ?1 AND s."customerGid" <> 'redacted' AND s."contractGid" IS NOT NULL`;
const within = (column: string, days: number) =>
  `julianday(${column}) > julianday(?2) - ${days}`;
const PENDING_DELIVERY = `EXISTS (SELECT 1 FROM "Delivery" d
  WHERE d."subscriptionId" = s."id" AND d."status" = 'PENDING')`;
const RENEWING = `s."status" = 'ACTIVE' AND s."source" <> 'GIFT' AND s."paymentProblemSince" IS NULL
  AND p."autoRenew" = 1`;

function insertEmails(
  kind: EmailKey | "priceChange",
  subject: string,
  from: string,
  on: string | null,
) {
  return `INSERT INTO "EmailSend" ("id", "shopId", "subscriptionId", "kind", "subject", "status", "reason", "updatedAt")
    SELECT '${kind}:' || s."id" || ':' || ${subject}, s."shopId", s."id", '${kind}', ${subject},
      ${on ? `CASE WHEN ${on} THEN 'PENDING' ELSE 'SKIPPED' END` : `'PENDING'`},
      ${on ? `CASE WHEN ${on} THEN NULL ELSE 'switched_off' END` : "NULL"}, ?2
    ${from}
    ON CONFLICT DO NOTHING`;
}

// A subscription is joined to its shop and plan in all of these.
const SUBSCRIBER = `FROM "Subscription" s
  JOIN "Shop" sh ON sh."id" = s."shopId" JOIN "Plan" p ON p."id" = s."planId"`;
// The pre-order of a release that has just opened, for the subscribers who were already there.
const PREORDER = `FROM "Release" r
  JOIN "Shop" sh ON sh."id" = r."shopId"
  JOIN "Subscription" s ON s."shopId" = r."shopId"
  JOIN "Plan" p ON p."id" = s."planId"`;
const PREORDER_OPEN = `r."shopId" = ?1 AND r."status" = 'PREORDER'
  AND ${within(`r."preorderOpensAt"`, PREORDER_WITHIN_DAYS)}
  AND julianday(s."createdAt") < julianday(r."preorderOpensAt")`;

// Nothing will charge this subscriber after the release that just shipped.
const NOT_RENEWING = `(s."status" = 'CANCELLED' OR p."autoRenew" = 0 OR s."source" = 'GIFT')`;

/** The subscriptions whose last paid release's order was just created, with nothing to renew after it. */
export const LAST_RELEASE = `${SUBSCRIBER}
  JOIN "Delivery" d ON d."subscriptionId" = s."id"
  WHERE ${BASE} AND s."status" <> 'ENDED' AND NOT ${CHARGEBACK_HOLD}
    AND s."releasesRemaining" <= 0 AND ${NOT_RENEWING}
    AND d."orderGid" IS NOT NULL AND ${within(`d."updatedAt"`, LAST_RELEASE_WITHIN_DAYS)}
    AND d."id" = (SELECT d2."id" FROM "Delivery" d2
      WHERE d2."subscriptionId" = s."id" AND d2."orderGid" IS NOT NULL
      ORDER BY d2."updatedAt" DESC, d2."id" DESC LIMIT 1)`;

const QUEUES: string[] = [
  // Welcome: a new subscriber, not an imported or gifted one.
  insertEmails(
    "welcome",
    `'start'`,
    `${SUBSCRIBER}
     WHERE ${BASE} AND s."source" = 'NEW' AND s."status" = 'ACTIVE'
       AND ${within(`s."createdAt"`, WELCOME_WITHIN_DAYS)}`,
    enabled("welcome"),
  ),

  // Gift received: tells the recipient, whose subscription it is, and carries the buyer's message.
  insertEmails(
    "giftReceived",
    `'start'`,
    `${SUBSCRIBER}
     WHERE ${BASE} AND s."source" = 'GIFT' AND s."status" = 'ACTIVE'
       AND ${within(`s."createdAt"`, WELCOME_WITHIN_DAYS)}`,
    enabled("giftReceived"),
  ),

  // Pre-order announced: everyone who will receive the release, which is who a run would assign
  // (DUE_SUBSCRIPTION) and anyone who already has a Delivery on it. A chargeback gets nothing.
  insertEmails(
    "preorderAnnounced",
    `r."id"`,
    `${PREORDER}
     WHERE ${PREORDER_OPEN} AND ${BASE} AND s."status" <> 'ENDED' AND NOT ${CHARGEBACK_HOLD}
       AND (EXISTS (SELECT 1 FROM "Delivery" d WHERE d."subscriptionId" = s."id"
              AND d."releaseId" = r."id" AND d."status" <> 'CANCELLED')
         OR (${DUE_SUBSCRIPTION}))`,
    enabled("preorderAnnounced"),
  ),

  // Upcoming charge, three ways. Dated: a bundle that renews on a term date.
  insertEmails(
    "upcomingCharge",
    `'on:' || strftime('%Y-%m-%d', s."termEndsAt")`,
    `${SUBSCRIBER}
     WHERE ${BASE} AND ${RENEWING} AND p."billingMode" = 'PREPAID_BUNDLE'
       AND p."renewalRule" IN ('TERM_DATE', 'TERM_DATE_HOLD_IF_LATE')
       AND s."termEndsAt" IS NOT NULL
       AND julianday(s."termEndsAt") > julianday(?2)
       AND julianday(s."termEndsAt") <= julianday(?2) + ${RENEWAL_NOTICE_DAYS}
       AND julianday(s."createdAt") < julianday(s."termEndsAt") - ${RENEWAL_NOTICE_DAYS}
       -- Two or more paid releases left can't ship by then, so the hold rule won't charge on this date.
       AND (p."renewalRule" = 'TERM_DATE' OR s."releasesRemaining" <= 1)`,
    enabled("upcomingCharge"),
  ),
  // Undated: a charge that happens when a release starts shipping, which can have no date, so the
  // only warning there is comes with its pre-order. Not under PREORDER_OPENS: the charge is then
  // made the moment the pre-order opens, and Shopify's receipt is the notice.
  insertEmails(
    "upcomingCharge",
    `'release:' || r."id"`,
    `${PREORDER}
     WHERE ${PREORDER_OPEN} AND sh."orderTiming" = 'READY_TO_SHIP' AND ${BASE}
       AND s."firstReleaseNumber" <= r."number"
       AND ((${CHARGE_DUE})
         OR (${RENEWING} AND p."billingMode" = 'PREPAID_BUNDLE' AND s."releasesRemaining" = 1
             AND NOT ${PENDING_DELIVERY}
             AND (p."renewalRule" = 'ON_DEPLETION'
               -- A renewal already on hold charges with this release's order, which can be long after
               -- the term date and the one notice that went then.
               OR (p."renewalRule" = 'TERM_DATE_HOLD_IF_LATE'
                 AND julianday(s."termEndsAt") <= julianday(r."preorderOpensAt")))))`,
    enabled("upcomingCharge"),
  ),
  // Late: the term date passed with a paid release still to ship, so the renewal is on hold.
  insertEmails(
    "upcomingCharge",
    `'late:' || strftime('%Y-%m-%d', s."termEndsAt")`,
    `${SUBSCRIBER}
     WHERE ${BASE} AND ${RENEWING} AND p."billingMode" = 'PREPAID_BUNDLE'
       AND p."renewalRule" = 'TERM_DATE_HOLD_IF_LATE' AND s."termEndsAt" IS NOT NULL
       AND julianday(s."termEndsAt") <= julianday(?2)
       AND ${within(`s."termEndsAt"`, LATE_RENEWAL_WITHIN_DAYS)}
       AND s."releasesRemaining" > 0`,
    enabled("upcomingCharge"),
  ),

  // Failed payment: one per failed try, so the last one can say the subscription has paused.
  insertEmails(
    "failedPayment",
    `e."id"`,
    `FROM "Event" e
     JOIN "Subscription" s ON s."id" = e."subscriptionId"
     JOIN "Shop" sh ON sh."id" = s."shopId"
     WHERE e."type" = 'billing.failed' AND s."source" <> 'GIFT' AND ${BASE} AND ${within(`e."createdAt"`, FAILED_WITHIN_DAYS)}`,
    enabled("failedPayment"),
  ),

  // Last release: its order has just been created and nothing renews after it.
  insertEmails("lastReleaseShipping", `d."id"`, LAST_RELEASE, enabled("lastReleaseShipping")),

  // Price change: a rise reaches whoever signed up at the old price, before it takes effect. It has
  // no switch (see "Emails" in docs/DECISIONS.md): it is the notice behind the 30-day promise.
  insertEmails(
    "priceChange",
    `pc."id"`,
    `FROM "PriceChange" pc
     JOIN "Plan" p ON p."id" = pc."planId"
     JOIN "Shop" sh ON sh."id" = p."shopId"
     JOIN "Subscription" s ON s."planId" = p."id"
     WHERE p."shopId" = ?1 AND ${BASE}
       AND pc."policy" = 'APPLY_AT_RENEWAL' AND pc."noticeSentAt" IS NULL
       AND julianday(pc."effectiveAt") > julianday(?2)
       AND pc."id" = (SELECT x."id" FROM "PriceChange" x WHERE x."planId" = p."id"
         ORDER BY x."createdAt" DESC LIMIT 1)
       AND julianday(s."createdAt") <= julianday(pc."createdAt")
       AND s."lockedPriceCents" IS NOT NULL AND pc."newPriceCents" > s."lockedPriceCents"
       AND s."status" IN ('ACTIVE', 'PAUSED') AND s."source" <> 'GIFT' AND p."autoRenew" = 1`,
    null,
  ),
];

/** Writes a row for every email that's due. Safe to repeat, and cheap when nothing is. */
export async function queueEmails(rawDb: D1Database, shopId: string, now: Date) {
  await rawDb.batch(
    QUEUES.map((sql) => rawDb.prepare(sql).bind(shopId, now.toISOString())),
  );
}

/**
 * The price change's notice is sent once every row for it has settled. A change nobody needs
 * telling about is marked at once. A change whose date has passed is left alone. `now` is the
 * moment the rows were queued: a change saved after it hasn't had its rows written yet.
 */
async function markPriceNotices(rawDb: D1Database, shopId: string, now: Date) {
  await rawDb
    .prepare(
      `UPDATE "PriceChange" SET "noticeSentAt" = ?2
       WHERE "noticeSentAt" IS NULL AND "policy" = 'APPLY_AT_RENEWAL'
         AND julianday("effectiveAt") > julianday(?2) AND julianday("createdAt") <= julianday(?2)
         AND "planId" IN (SELECT "id" FROM "Plan" WHERE "shopId" = ?1)
         AND NOT EXISTS (SELECT 1 FROM "EmailSend" e WHERE e."kind" = 'priceChange'
           AND e."subject" = "PriceChange"."id" AND e."status" IN ('PENDING', 'SENDING'))`,
    )
    .bind(shopId, now.toISOString())
    .run();
}

// ---------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------

type Row = {
  id: string;
  kind: EmailKind;
  subject: string;
  attempts: number;
  subscriptionId: string;
  contractGid: string;
  status: string;
  customerGid: string;
  source: string;
  releasesRemaining: number;
  pausedReason: string | null;
  paymentProblemSince: string | null;
  quantity: number;
  giftMessage: string | null;
  lockedPriceCents: number | null;
  termEndsAt: string | null;
  createdAt: string;
  planId: string;
  displayName: string;
  priceCents: number;
  currency: string;
  autoRenew: number;
  releasesPerTerm: number;
};
type EmailKind = EmailKey | "priceChange";

type Shop = {
  id: string;
  shopDomain: string;
  releaseWordSingular: string;
  releaseWordPlural: string;
  emailsEnabled: unknown;
  timezone: string | null;
};

type Release = { id: string; title: string; status: string };
type PriceChange = { id: string; planId: string; newPriceCents: number; effectiveAt: Date };

const ENDED_OR_REDACTED = (row: Row) =>
  row.status === "ENDED" || row.customerGid === "redacted";

/**
 * Whether an email is still right to send, judged now, at the moment of sending. Whatever was true
 * when it was queued may not be: a subscriber can cancel, a release can move on, a card can be fixed.
 * Returns why not, or null.
 */
export function staleReason(
  row: Row,
  shop: Pick<Shop, "emailsEnabled">,
  extra: {
    release?: Release;
    change?: PriceChange;
    latestChange?: PriceChange;
    now: Date;
  },
): string | null {
  if (row.kind !== "priceChange" && !isEmailEnabled(shop.emailsEnabled, row.kind)) {
    return "switched_off";
  }
  if (ENDED_OR_REDACTED(row)) return "ended";
  const chargeback = row.pausedReason === "CHARGEBACK";
  switch (row.kind) {
    case "welcome":
      return row.status === "ACTIVE" ? null : "not_active";
    case "giftReceived":
      if (row.source !== "GIFT") return "not_gift";
      return row.status === "ACTIVE" ? null : "not_active";
    case "preorderAnnounced":
      if (extra.release?.status !== "PREORDER") return "release_moved_on";
      if (chargeback) return "chargeback";
      return row.status === "CANCELLED" && row.releasesRemaining <= 0 ? "cancelled" : null;
    case "upcomingCharge": {
      if (
        row.status !== "ACTIVE" ||
        row.source === "GIFT" ||
        !row.autoRenew ||
        row.paymentProblemSince
      ) {
        return "not_renewing";
      }
      if (row.subject.startsWith("release:") && extra.release?.status !== "PREORDER") {
        return "release_moved_on";
      }
      if (row.subject.startsWith("late:") && row.releasesRemaining <= 0) return "ship_started";
      return null;
    }
    case "failedPayment":
      // Nothing is ever charged for a gift, so a failure can't be its own.
      if (row.source === "GIFT") return "gift";
      if (row.status !== "ACTIVE" && row.status !== "PAUSED") return "not_active";
      return row.paymentProblemSince ? null : "resolved";
    case "lastReleaseShipping":
      if (chargeback) return "chargeback";
      return row.releasesRemaining > 0 ||
        (row.status === "ACTIVE" && row.autoRenew && row.source !== "GIFT")
        ? "renewed"
        : null;
    case "priceChange":
      if (row.source === "GIFT") return "gift";
      if (row.status !== "ACTIVE" && row.status !== "PAUSED") return "not_active";
      if (!extra.change || extra.latestChange?.id !== extra.change.id) return "superseded";
      return extra.change.effectiveAt <= extra.now ? "too_late" : null;
  }
}

/**
 * What a charge bills: each copy at the line price plus the contract's own delivery price, which a
 * charge adds (see "Renewals and charges" in docs/DECISIONS.md). Tax isn't known here, so the copy
 * says "plus any tax".
 */
const money = (row: Row, cents: number, shippingCents: number) =>
  formatMoney(cents * row.quantity + shippingCents, row.currency);

/** What the subscriber will be charged: the contract's price, or the new one once a rise has taken effect. */
function chargeCents(row: Row, change: PriceChange | undefined, on: Date) {
  const rises =
    change &&
    change.effectiveAt <= on &&
    new Date(row.createdAt) < change.effectiveAt &&
    row.lockedPriceCents !== change.newPriceCents;
  return rises ? change.newPriceCents : (row.lockedPriceCents ?? row.priceCents);
}

const statesAmount = (row: Row) => row.kind === "upcomingCharge" || row.kind === "priceChange";

type SendContext = {
  env: EmailEnv;
  releases: Map<string, Release>;
  latest: Map<string, PriceChange>;
  changes: Map<string, PriceChange>;
  events: Map<string, { nextRetryAt: string | null }>;
  deliveries: Map<string, string>;
  /** The contracts' delivery prices, in cents, by contract ID. */
  shipping: Map<string, number>;
  ordersNow: boolean;
  /** The customer account's portal page, for the emails that offer to cancel. */
  portalUrl: string;
  now: Date;
};

async function dataFor(row: Row, ctx: SendContext): Promise<EmailData> {
  const { env, now } = ctx;
  const release = (id: string) => ctx.releases.get(id)?.title ?? "your next release";
  const card = () => linkUrl(env, { k: "card", s: row.subscriptionId }, now);
  const shipping = ctx.shipping.get(row.contractGid) ?? 0;
  switch (row.kind) {
    case "welcome":
      return { kind: "welcome", plan: row.displayName };
    case "giftReceived":
      return {
        kind: "giftReceived",
        plan: row.displayName,
        message: row.giftMessage,
        portalUrl: ctx.portalUrl,
      };
    case "preorderAnnounced":
      return {
        kind: "preorderAnnounced",
        release: release(row.subject),
        // A hold is the merchant's, and there's nothing wrong with the card.
        paused: row.status === "PAUSED" && row.pausedReason !== IMPORT_HOLD,
        ordersNow: ctx.ordersNow,
        addressUrl: await linkUrl(
          env,
          { k: "address", s: row.subscriptionId, r: row.subject },
          now,
        ),
        cardUrl: await card(),
      };
    case "upcomingCharge": {
      const change = ctx.latest.get(row.planId);
      const [type, value] = [row.subject.split(":")[0], row.subject.slice(row.subject.indexOf(":") + 1)];
      if (type === "release") {
        return {
          kind: "upcomingCharge",
          plan: row.displayName,
          amount: money(row, chargeCents(row, change, now), shipping),
          portalUrl: ctx.portalUrl,
          when: { release: release(value) },
        };
      }
      const termEnd = new Date(row.termEndsAt ?? now);
      return {
        kind: "upcomingCharge",
        plan: row.displayName,
        amount: money(row, chargeCents(row, change, termEnd), shipping),
        portalUrl: ctx.portalUrl,
        when: type === "late" ? { held: termEnd } : { on: termEnd, releases: row.releasesPerTerm },
      };
    }
    case "failedPayment": {
      const retry = ctx.events.get(row.subject)?.nextRetryAt;
      return {
        kind: "failedPayment",
        plan: row.displayName,
        retryOn: retry ? new Date(retry) : null,
        cardUrl: await card(),
      };
    }
    case "lastReleaseShipping":
      return {
        kind: "lastReleaseShipping",
        plan: row.displayName,
        release: ctx.deliveries.get(row.subject) ?? "your last release",
        gift: row.source === "GIFT",
        portalUrl: ctx.portalUrl,
      };
    case "priceChange": {
      const change = ctx.changes.get(row.subject)!;
      return {
        kind: "priceChange",
        plan: row.displayName,
        oldAmount: money(row, row.lockedPriceCents ?? row.priceCents, shipping),
        newAmount: money(row, change.newPriceCents, shipping),
        effectiveAt: change.effectiveAt,
        portalUrl: ctx.portalUrl,
      };
    }
  }
}

type ShopifyShop = {
  name?: string;
  id?: string;
  primaryDomain?: { url?: string };
  billingAddress?: Record<string, string | null> | null;
};

const CONTEXT = `#graphql
  query EmailContext($ids: [ID!]!) {
    shop {
      id
      name
      contactEmail
      primaryDomain { url }
      billingAddress { address1 address2 city provinceCode zip countryCodeV2 }
    }
    nodes(ids: $ids) {
      ... on Customer { id defaultEmailAddress { emailAddress } }
      ... on SubscriptionContract { id deliveryPrice { amount } }
    }
  }`;

/** A display name that can't break a header or pretend to be an address. */
const fromName = (name: string, fallback: string) =>
  name.replace(/[\p{C}<>"@]/gu, "").trim().slice(0, 100) || fallback;

function copyOf(shop: Shop, data: ShopifyShop): ShopCopy {
  const address = data.billingAddress;
  return {
    name: fromName(data.name ?? "", shop.shopDomain),
    url: data.primaryDomain?.url ?? `https://${shop.shopDomain}`,
    singular: shop.releaseWordSingular,
    plural: shop.releaseWordPlural,
    timezone: shop.timezone,
    address: address
      ? [address.address1, address.address2, address.city, address.provinceCode, address.zip, address.countryCodeV2]
          .filter(Boolean)
          .join(", ")
      : null,
  };
}

const PAGE = `SELECT e."id", e."kind", e."subject", e."attempts", e."subscriptionId", s."contractGid",
    s."status", s."customerGid", s."source", s."releasesRemaining", s."pausedReason",
    s."paymentProblemSince", s."quantity", s."giftMessage", s."lockedPriceCents", s."termEndsAt", s."createdAt",
    p."id" AS "planId", p."displayName", p."priceCents", p."currency", p."autoRenew", p."releasesPerTerm"
  FROM "EmailSend" e
  JOIN "Subscription" s ON s."id" = e."subscriptionId"
  JOIN "Plan" p ON p."id" = s."planId"
  WHERE e."shopId" = ?1 AND e."status" = 'PENDING' AND (e."leaseUntil" IS NULL OR e."leaseUntil" <= ?2)
  ORDER BY e."id" LIMIT ?3`;

function settle(
  rawDb: D1Database,
  id: string,
  from: "PENDING" | "SENDING",
  status: "SENT" | "SKIPPED" | "FAILED" | "PENDING",
  fields: { reason?: string; messageId?: string; at: Date; retryAt?: Date; giveBackAttempt?: boolean },
) {
  return rawDb
    .prepare(
      `UPDATE "EmailSend" SET "status" = ?3, "reason" = ?4, "messageId" = COALESCE(?5, "messageId"),
         "sentAt" = CASE WHEN ?3 = 'SENT' THEN ?2 ELSE "sentAt" END, "leaseUntil" = ?6,
         "attempts" = "attempts" - ?7, "updatedAt" = ?2
       WHERE "id" = ?1 AND "status" = ?8`,
    )
    .bind(
      id,
      fields.at.toISOString(),
      status,
      fields.reason ?? null,
      fields.messageId ?? null,
      fields.retryAt?.toISOString() ?? null,
      fields.giveBackAttempt ? 1 : 0,
      from,
    )
    .run();
}

/**
 * One slice of a shop's emails. State-driven like a release run: the tick starts one every hour,
 * and it queues whatever is due, then sends a page of what's pending. A slice that fills its page
 * hands the next to a new job; one that meets Cloudflare's limit does the same after a wait, so a
 * limit never spends a queue retry. A lost message, a crash or a late subscriber is found again
 * by the next tick, because the rows, not the messages, say what is left.
 *
 * What a crash does to one email, which Cloudflare can't tell us about (it has no idempotency key):
 * - before the claim, the row is still PENDING and goes out later;
 * - between the claim and the answer, the row is left SENDING. It may have been sent, so it's
 *   never sent again by itself: after its lease it becomes UNSURE and is logged. A missing email
 *   was judged less bad than a second one;
 * - after the answer is stored, nothing is left to do.
 * Only the provider call sits between the claim and the answer: everything else is read first.
 */
export async function runEmailSlice(
  env: EmailEnv,
  db: Db,
  rawDb: D1Database,
  graphqlFor: () => Promise<Graphql>,
  job: Job,
  clock: () => Date = () => new Date(),
): Promise<{ job: Job; delaySeconds: number } | null> {
  const shop = await db.shop.findUnique({
    where: { shopDomain: String(job.shop) },
    select: {
      id: true,
      shopDomain: true,
      releaseWordSingular: true,
      releaseWordPlural: true,
      emailsEnabled: true,
      timezone: true,
      orderTiming: true,
    },
  });
  if (!shop) return null;
  const started = clock();
  const next = (delaySeconds: number) => ({
    delaySeconds,
    job: emailRunJob(shop.shopDomain, crypto.randomUUID(), { queued: true }),
  });

  if (job.data?.queued !== true) await queueEmails(rawDb, shop.id, started);

  const lapsed = await rawDb
    .prepare(
      `UPDATE "EmailSend" SET "status" = 'UNSURE', "reason" = 'lease_lapsed', "leaseUntil" = NULL, "updatedAt" = ?2
       WHERE "shopId" = ?1 AND "status" = 'SENDING' AND "leaseUntil" <= ?2`,
    )
    .bind(shop.id, started.toISOString())
    .run();
  if (lapsed.meta.changes > 0) {
    logEvent("warn", "email.unsure", { shopId: shop.id, count: lapsed.meta.changes });
  }

  const { results: rows } = await rawDb
    .prepare(PAGE)
    .bind(shop.id, started.toISOString(), EMAILS_PER_SLICE)
    .all<Row>();

  // Everything that's read for the page, in a few queries.
  const subjectOf = (prefix: string) => (row: Row) =>
    row.subject.startsWith(prefix) ? row.subject.slice(prefix.length) : null;
  const releaseIds = [
    ...new Set(
      rows.flatMap((row) =>
        row.kind === "preorderAnnounced"
          ? [row.subject]
          : row.kind === "upcomingCharge"
            ? (subjectOf("release:")(row) ?? [])
            : [],
      ),
    ),
  ];
  const planIds = [
    ...new Set(rows.filter((row) => row.kind === "upcomingCharge").map((row) => row.planId)),
  ];
  const ofKind = (kind: EmailKind) => rows.filter((row) => row.kind === kind).map((row) => row.subject);
  const [releases, events, deliveries, changeRows] = await Promise.all([
    releaseIds.length
      ? db.release.findMany({ where: { id: { in: releaseIds } }, select: { id: true, title: true, status: true } })
      : [],
    ofKind("failedPayment").length
      ? db.event.findMany({ where: { id: { in: ofKind("failedPayment") } }, select: { id: true, payload: true } })
      : [],
    ofKind("lastReleaseShipping").length
      ? db.delivery.findMany({
          where: { id: { in: ofKind("lastReleaseShipping") } },
          select: { id: true, release: { select: { title: true } } },
        })
      : [],
    ofKind("priceChange").length
      ? db.priceChange.findMany({ where: { id: { in: ofKind("priceChange") } } })
      : [],
  ]);
  const changes = new Map<string, PriceChange>(changeRows.map((change) => [change.id, change]));
  const latest = new Map<string, PriceChange>();
  for (const planId of new Set([...planIds, ...changeRows.map((change) => change.planId)])) {
    const change = await db.priceChange.findFirst({
      where: { planId },
      orderBy: { createdAt: "desc" },
    });
    if (change) latest.set(planId, change);
  }

  const ctx = {
    env,
    releases: new Map<string, Release>(releases.map((release) => [release.id, release])),
    latest,
    changes,
    events: new Map(
      events.map((event) => [
        event.id,
        { nextRetryAt: ((event.payload as { nextRetryAt?: string | null })?.nextRetryAt ?? null) },
      ]),
    ),
    deliveries: new Map(deliveries.map((delivery) => [delivery.id, delivery.release.title])),
    shipping: new Map<string, number>(),
    ordersNow: shop.orderTiming === "PREORDER_OPENS",
    portalUrl: "",
    now: started,
  };

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const due: Row[] = [];
  for (const row of rows) {
    const reason = staleReason(row, shop, {
      release: ctx.releases.get(row.kind === "preorderAnnounced" ? row.subject : (subjectOf("release:")(row) ?? "")),
      change: changes.get(row.subject),
      latestChange: latest.get(row.planId),
      now: started,
    });
    if (reason) {
      await settle(rawDb, row.id, "PENDING", "SKIPPED", { reason, at: started });
      skipped++;
    } else due.push(row);
  }

  let wait: number | null = null;
  if (due.length > 0) {
    const data = await (await graphqlFor())(CONTEXT, {
      ids: [
        ...new Set([
          ...due.map((row) => row.customerGid),
          // Only the emails that state an amount need their contract.
          ...due.filter(statesAmount).map((row) => row.contractGid),
        ]),
      ],
    });
    type Node = {
      id: string;
      defaultEmailAddress?: { emailAddress?: string };
      deliveryPrice?: { amount: string };
    };
    const nodes = (data.nodes as (Node | null)[]).filter((node): node is Node => Boolean(node));
    const customers = new Map<string, string | undefined>(
      nodes.map((node) => [node.id, node.defaultEmailAddress?.emailAddress]),
    );
    ctx.shipping = new Map(
      nodes.flatMap((node) =>
        node.deliveryPrice ? [[node.id, Math.round(Number(node.deliveryPrice.amount) * 100)] as const] : [],
      ),
    );
    const copy = copyOf(shop, data.shop);
    ctx.portalUrl = portalUrl(data.shop.id, shop.shopDomain);
    const replyTo = data.shop.contactEmail ?? undefined;

    for (const row of due) {
      const address = customers.get(row.customerGid);
      const skip = async (reason: string) => {
        await settle(rawDb, row.id, "PENDING", "SKIPPED", { reason, at: clock() });
        skipped++;
      };
      if (!address) {
        await skip("no_email");
        continue;
      }
      // An amount can't be stated without the contract's delivery price: a gone contract has no charge.
      if (statesAmount(row) && !ctx.shipping.has(row.contractGid)) {
        await skip("no_contract");
        continue;
      }
      // A safety for dev stores, whose customers have made-up addresses. See wrangler.jsonc.
      if (!recipientAllowed(env, address)) {
        await skip("recipient_not_allowed");
        continue;
      }
      const message = renderEmail(copy, await dataFor(row, ctx));
      const claim = await rawDb
        .prepare(
          `UPDATE "EmailSend" SET "status" = 'SENDING', "attempts" = "attempts" + 1, "leaseUntil" = ?3, "updatedAt" = ?2
           WHERE "id" = ?1 AND "status" = 'PENDING' AND ("leaseUntil" IS NULL OR "leaseUntil" <= ?2)`,
        )
        .bind(row.id, clock().toISOString(), new Date(clock().getTime() + CLAIM_MS).toISOString())
        .run();
      if (claim.meta.changes === 0) continue;

      try {
        const { messageId } = await sendEmail(env, {
          to: address,
          fromName: copy.name,
          replyTo,
          ...message,
        });
        await settle(rawDb, row.id, "SENDING", "SENT", { messageId, at: clock() });
        sent++;
      } catch (error) {
        const failure = error instanceof EmailError ? error : null;
        const code = failure?.code ?? "E_UNKNOWN";
        const fields = { emailId: row.id, kind: row.kind, code };
        if (failure?.kind === "wait") {
          // Not this message's fault, so it keeps its attempt and waits with the rest.
          await settle(rawDb, row.id, "SENDING", "PENDING", { reason: code, at: clock(), giveBackAttempt: true });
          logEvent("warn", "email.waiting", fields);
          wait = code === RATE_LIMITED ? RATE_LIMIT_WAIT_SECONDS : DAILY_LIMIT_WAIT_SECONDS;
          break;
        }
        if (failure?.kind === "retry" && row.attempts + 1 < MAX_ATTEMPTS) {
          await settle(rawDb, row.id, "SENDING", "PENDING", {
            reason: code,
            at: clock(),
            retryAt: new Date(clock().getTime() + RETRY_AFTER_MS),
          });
          logEvent("warn", "email.retry", fields);
          continue;
        }
        await settle(rawDb, row.id, "SENDING", "FAILED", { reason: code, at: clock() });
        logEvent("error", "email.failed", { ...fields, ...(failure ? {} : describeError(error)) });
        failed++;
      }
    }
  }

  await markPriceNotices(rawDb, shop.id, started);
  logEvent("info", "email.slice", { shopId: shop.id, sent, skipped, failed, waitSeconds: wait ?? 0 });
  if (wait !== null) return next(wait);
  return rows.length === EMAILS_PER_SLICE ? next(0) : null;
}

/** For Step 11: the customer confirmed the address a pre-order email linked to. Safe to repeat. */
export async function recordAddressConfirmation(
  rawDb: D1Database,
  subscriptionId: string,
  releaseId: string,
  now = new Date(),
) {
  const stamp = now.toISOString();
  await rawDb.batch([
    rawDb
      .prepare(
        `UPDATE "Delivery" SET "addressConfirmedAt" = COALESCE("addressConfirmedAt", ?3), "updatedAt" = ?3
         WHERE "subscriptionId" = ?1 AND "releaseId" = ?2 AND "status" <> 'CANCELLED'`,
      )
      .bind(subscriptionId, releaseId, stamp),
    // The Delivery doesn't exist yet when orders are created at ready to ship: the run copies this.
    rawDb
      .prepare(
        `UPDATE "EmailSend" SET "addressConfirmedAt" = COALESCE("addressConfirmedAt", ?3), "updatedAt" = ?3
         WHERE "id" = 'preorderAnnounced:' || ?1 || ':' || ?2`,
      )
      .bind(subscriptionId, releaseId, stamp),
  ]);
}

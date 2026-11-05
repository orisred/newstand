import type { createDb } from "./db.server";
import type { Job } from "./jobs/runner.server";
import { emailRunJob } from "./notification-jobs";
import { logEvent } from "./logger.server";
import type { View } from "./dashboard-format";
import type { Graphql } from "./plan-sync.server";

type Db = ReturnType<typeof createDb>;

// The merchant dashboard (Step 13). It reads records and never moves money: the only Shopify calls
// here are reads, and the only writes are to columns that nothing else uses to decide a charge.

export const DASHBOARD_JOB = "dashboard.refresh";
export const PORTAL_CANCELLED_EVENT = "portal.cancelled";
export const PORTAL_ADDRESS_EVENT = "portal.address_changed";

export const dashboardJob = (shop: string, key: string): Job => ({
  type: DASHBOARD_JOB,
  id: `${DASHBOARD_JOB}:${shop}:${key}`,
  shop,
});

/** Records a customer's portal action so the merchant can see it. No personal data: the type and the time. */
export function portalEvent(rawDb: D1Database, subscriptionId: string, type: string, now: Date) {
  return rawDb
    .prepare(
      `INSERT INTO "Event" ("id", "shopId", "subscriptionId", "type", "payload", "createdAt")
       SELECT ?1, "shopId", "id", ?2, '{}', ?3 FROM "Subscription" WHERE "id" = ?4
       ON CONFLICT DO NOTHING`,
    )
    .bind(`${type}:${subscriptionId}:${now.getTime()}`, type, now.toISOString(), subscriptionId)
    .run();
}

// ---- who counts as live -------------------------------------------------------------------------

/**
 * A subscription that is `ACTIVE` but will never get another release: a gift stays active after its last
 * release (it has nothing to renew into), and so does a plan without auto-renew. Both are finished, not
 * live. Needs `Subscription s` and `Plan p`. A pay-per-release plan at 0 isn't finished: it charges on the
 * next release.
 */
export const FINISHED_ACTIVE = `(s."status" = 'ACTIVE' AND s."releasesRemaining" <= 0
  AND (s."source" = 'GIFT' OR p."autoRenew" = 0))`;
/** Still receiving, or going to renew: active and not finished. */
export const LIVE = `(s."status" = 'ACTIVE' AND NOT ${FINISHED_ACTIVE})`;
/** Cancelled, but paid releases are still to ship. */
export const ENDING = `(s."status" = 'CANCELLED' AND s."releasesRemaining" > 0)`;
/** Nothing more will ship or be charged. */
export const FINISHED = `(s."status" = 'ENDED' OR (s."status" = 'CANCELLED' AND s."releasesRemaining" <= 0)
  OR ${FINISHED_ACTIVE})`;

const VIEW_WHERE: Record<View, string> = {
  all: "1 = 1",
  live: LIVE,
  paused: `s."status" = 'PAUSED'`,
  ending: ENDING,
  finished: FINISHED,
  gifts: `s."source" = 'GIFT'`,
};

const CHURN_DAYS = 30;

type Counts = { total: number; live: number; paused: number; ending: number; finished: number; gifts: number };
type Churn = { cancelled: number; viaPortal: number };

function countStatements(rawDb: D1Database, shopId: string, now: Date) {
  return [
    rawDb
      .prepare(
        `SELECT COUNT(*) AS "total",
           COALESCE(SUM(${LIVE}), 0) AS "live",
           COALESCE(SUM(s."status" = 'PAUSED'), 0) AS "paused",
           COALESCE(SUM(${ENDING}), 0) AS "ending",
           COALESCE(SUM(${FINISHED}), 0) AS "finished",
           COALESCE(SUM(s."source" = 'GIFT'), 0) AS "gifts"
         FROM "Subscription" s JOIN "Plan" p ON p."id" = s."planId" WHERE s."shopId" = ?1`,
      )
      .bind(shopId),
    // A gift's recipient can't leave, so a gift doesn't count as churn either way.
    rawDb
      .prepare(
        `SELECT COUNT(*) AS "cancelled",
           COALESCE(SUM(EXISTS (SELECT 1 FROM "Event" q WHERE q."subscriptionId" = e."subscriptionId"
             AND q."type" = '${PORTAL_CANCELLED_EVENT}')), 0) AS "viaPortal"
         FROM "Event" e JOIN "Subscription" s ON s."id" = e."subscriptionId"
         WHERE e."shopId" = ?1 AND e."type" = 'subscription.cancelled' AND s."source" <> 'GIFT'
           AND julianday(e."createdAt") > julianday(?2) - ${CHURN_DAYS}`,
      )
      .bind(shopId, now.toISOString()),
  ];
}

function toCounts([counts, churn]: [D1Result<Counts>, D1Result<Churn>]) {
  const c = counts.results[0];
  const cancelled = churn.results[0].cancelled;
  return {
    ...c,
    cancelled,
    cancelledViaPortal: churn.results[0].viaPortal,
    churnDays: CHURN_DAYS,
    // Of those who were renewing a month ago: still live now, plus the ones who cancelled since.
    churnRate: c.live + cancelled > 0 ? cancelled / (c.live + cancelled) : null,
  };
}

export async function subscriberCounts(rawDb: D1Database, shopId: string, now: Date) {
  return toCounts((await rawDb.batch(countStatements(rawDb, shopId, now))) as [D1Result<Counts>, D1Result<Churn>]);
}

export const SUBSCRIBERS_PER_PAGE = 25;

type ListRow = {
  id: string;
  customerGid: string;
  status: string;
  source: string;
  releasesRemaining: number;
  termEndsAt: string | null;
  createdAt: string;
  pausedReason: string | null;
  plan: string;
  billingMode: string;
  finished: number;
  portalCancelled: number;
  portalAddress: number;
};

function listStatement(rawDb: D1Database, shopId: string, view: View, before: string | null) {
  const [createdAt, id] = (before ?? "").split("|");
  const portal = (type: string) =>
    `EXISTS (SELECT 1 FROM "Event" q WHERE q."subscriptionId" = s."id" AND q."type" = '${type}')`;
  return rawDb
    .prepare(
      `SELECT s."id", s."customerGid", s."status", s."source", s."releasesRemaining", s."termEndsAt",
         s."createdAt", s."pausedReason", p."name" AS "plan", p."billingMode",
         ${FINISHED} AS "finished",
         ${portal(PORTAL_CANCELLED_EVENT)} AS "portalCancelled", ${portal(PORTAL_ADDRESS_EVENT)} AS "portalAddress"
       FROM "Subscription" s JOIN "Plan" p ON p."id" = s."planId"
       WHERE s."shopId" = ?1 AND ${VIEW_WHERE[view]}
         AND (?2 = '' OR (s."createdAt", s."id") < (?2, ?3))
       ORDER BY s."createdAt" DESC, s."id" DESC LIMIT ?4`,
    )
    .bind(shopId, createdAt ?? "", id ?? "", SUBSCRIBERS_PER_PAGE + 1);
}

function toPage(result: D1Result<ListRow>) {
  const rows = result.results.slice(0, SUBSCRIBERS_PER_PAGE);
  const last = rows[rows.length - 1];
  return {
    rows,
    next: result.results.length > SUBSCRIBERS_PER_PAGE ? `${last.createdAt}|${last.id}` : null,
  };
}

/** One page of subscribers, newest first. `before` is the last row's `createdAt|id`. */
export async function listSubscribers(rawDb: D1Database, shopId: string, view: View, before: string | null) {
  return toPage(await listStatement(rawDb, shopId, view, before).all<ListRow>());
}

/** The counts and one page in a single round trip, for the subscribers screen. */
export async function loadSubscribersPage(
  rawDb: D1Database,
  shopId: string,
  view: View,
  before: string | null,
  now: Date,
) {
  const [counts, churn, list] = await rawDb.batch([
    ...countStatements(rawDb, shopId, now),
    listStatement(rawDb, shopId, view, before),
  ]);
  return {
    counts: toCounts([counts, churn] as [D1Result<Counts>, D1Result<Churn>]),
    list: toPage(list as D1Result<ListRow>),
  };
}

const CUSTOMER_NAMES = `#graphql
  query DashboardCustomers($ids: [ID!]!) {
    nodes(ids: $ids) { ... on Customer { id displayName } }
  }`;

/** Names are read from Shopify for the page being shown and never stored. A failure just leaves the IDs. */
export async function customerNames(graphql: Graphql, gids: string[]) {
  const names = new Map<string, string>();
  const ids = [...new Set(gids.filter((gid) => gid.startsWith("gid://")))];
  if (ids.length === 0) return names;
  try {
    const { nodes } = await graphql(CUSTOMER_NAMES, { ids });
    for (const node of nodes as ({ id: string; displayName: string } | null)[]) {
      if (node?.displayName?.trim()) names.set(node.id, node.displayName.trim());
    }
  } catch (error) {
    logEvent("warn", "dashboard.names_failed", { count: ids.length });
  }
  return names;
}

export const customerLabel = (names: Map<string, string>, gid: string) =>
  gid === "redacted" ? "Redacted customer" : (names.get(gid) ?? `Customer ${gid.split("/").pop()}`);

// ---- one subscriber -----------------------------------------------------------------------------

export async function getSubscriber(db: Db, shopId: string, id: string) {
  const subscription = await db.subscription.findFirst({
    where: { id, shopId },
    select: {
      id: true,
      customerGid: true,
      giftBuyerGid: true,
      giftMessage: true,
      status: true,
      source: true,
      quantity: true,
      releasesRemaining: true,
      termEndsAt: true,
      pausedReason: true,
      paymentProblemSince: true,
      signupCents: true,
      createdAt: true,
      plan: {
        select: { id: true, name: true, displayName: true, billingMode: true, autoRenew: true, currency: true },
      },
    },
  });
  if (!subscription) return null;
  const [deliveries, attempts, events, emails] = await Promise.all([
    db.delivery.findMany({
      where: { subscriptionId: id },
      orderBy: { release: { number: "desc" } },
      take: 50,
      select: {
        status: true,
        orderGid: true,
        orderName: true,
        addressConfirmedAt: true,
        release: { select: { number: true, title: true } },
      },
    }),
    db.billingAttempt.findMany({
      where: { subscriptionId: id },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { result: true, attempt: true, errorCode: true, amountCents: true, createdAt: true },
    }),
    db.event.findMany({
      where: { subscriptionId: id, type: { in: [PORTAL_CANCELLED_EVENT, PORTAL_ADDRESS_EVENT] } },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { type: true, createdAt: true },
    }),
    db.emailSend.findMany({
      where: { subscriptionId: id },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, kind: true, status: true, reason: true, sentAt: true, createdAt: true },
    }),
  ]);
  return { subscription, deliveries, attempts, events, emails };
}

// ---- address confirmations ----------------------------------------------------------------------

export const CONFIRMATIONS_PER_PAGE = 50;

/**
 * Who has confirmed their address for a release. A subscriber counts if they hold a Delivery on it
 * (not cancelled) or were sent its pre-order email and the Delivery doesn't exist yet (the order is
 * created at ready to ship). The confirmation is on the Delivery, or on the email's row before that.
 * "Changed" means the portal's address change after the release was announced.
 */
export async function listConfirmations(rawDb: D1Database, shopId: string, releaseId: string) {
  const from = `FROM "Subscription" s
    JOIN "Release" r ON r."id" = ?2
    LEFT JOIN "Delivery" d ON d."subscriptionId" = s."id" AND d."releaseId" = ?2 AND d."status" <> 'CANCELLED'
    LEFT JOIN "EmailSend" m ON m."id" = 'preorderAnnounced:' || s."id" || ':' || ?2
    WHERE s."shopId" = ?1 AND r."shopId" = ?1 AND (d."id" IS NOT NULL OR m."status" = 'SENT')`;
  const confirmed = `COALESCE(d."addressConfirmedAt", m."addressConfirmedAt")`;
  const changed = `EXISTS (SELECT 1 FROM "Event" c WHERE c."subscriptionId" = s."id"
    AND c."type" = '${PORTAL_ADDRESS_EVENT}'
    AND julianday(c."createdAt") >= julianday(COALESCE(r."preorderOpensAt", r."createdAt")))`;
  const [summary, rows] = await rawDb.batch<Record<string, string | number | null>>([
    rawDb
      .prepare(
        `SELECT COUNT(*) AS "total", COALESCE(SUM(${confirmed} IS NOT NULL), 0) AS "confirmed",
           COALESCE(SUM(${changed}), 0) AS "changed" ${from}`,
      )
      .bind(shopId, releaseId),
    rawDb
      .prepare(
        `SELECT s."id", s."customerGid", s."status", ${confirmed} AS "confirmedAt", ${changed} AS "changed" ${from}
         ORDER BY ${confirmed} IS NOT NULL, s."createdAt" LIMIT ${CONFIRMATIONS_PER_PAGE}`,
      )
      .bind(shopId, releaseId),
  ]);
  const s = summary.results[0] as { total: number; confirmed: number; changed: number };
  return {
    ...s,
    more: s.total > CONFIRMATIONS_PER_PAGE,
    rows: rows.results as {
      id: string;
      customerGid: string;
      status: string;
      confirmedAt: string | null;
      changed: number;
    }[],
  };
}

// ---- revenue, costs and profit ------------------------------------------------------------------

/**
 * Every payment buys release slots: a bundle's sign-up or renewal buys `releasesPerTerm`, a pay-per-release
 * sign-up or charge buys one. A subscription's shipped releases (order created), oldest release first, use
 * its slots in the order they were paid for, and each slot is worth its payment divided by the slots that
 * payment bought. So a bundle's payment is recognized as its releases ship, and money for releases not yet
 * shipped is deferred. A gift's sign-up payment is the buyer's order and counts the same way.
 * Imported subscriptions have no payment in the app's records, so their releases are unpriced.
 */
const SLOT_PAYMENTS = `
  WITH pay AS (
    SELECT s."id" AS sid, 0 AS ord, s."id" AS pid, s."createdAt" AS ts, s."signupCents" AS amt,
      CASE WHEN p."billingMode" = 'PREPAID_BUNDLE' THEN p."releasesPerTerm" ELSE 1 END AS n
    FROM "Subscription" s JOIN "Plan" p ON p."id" = s."planId"
    WHERE s."shopId" = ?1 AND s."source" <> 'IMPORTED'
    UNION ALL
    SELECT b."subscriptionId", 1, b."id", b."createdAt", b."amountCents",
      CASE WHEN p."billingMode" = 'PREPAID_BUNDLE' THEN p."releasesPerTerm" ELSE 1 END
    FROM "BillingAttempt" b JOIN "Subscription" s ON s."id" = b."subscriptionId"
      JOIN "Plan" p ON p."id" = s."planId"
    WHERE s."shopId" = ?1 AND b."result" = 'SUCCEEDED'
  ), slots AS (
    SELECT sid, amt, n, SUM(n) OVER (PARTITION BY sid ORDER BY julianday(ts), ord, pid) AS hi FROM pay
  ), shipped AS (
    SELECT d."releaseId", s."planId", s."quantity",
      ROW_NUMBER() OVER (PARTITION BY d."subscriptionId" ORDER BY r."number") - 1 AS k, d."subscriptionId" AS sid,
      r."productCostCents" AS product, r."shippingCostCents" AS shipping, r."handlingCostCents" AS handling
    FROM "Delivery" d JOIN "Release" r ON r."id" = d."releaseId"
      JOIN "Subscription" s ON s."id" = d."subscriptionId"
    WHERE s."shopId" = ?1 AND d."status" IN ('ORDERED', 'FULFILLED')
  )`;

export type ReleasePlanRow = {
  releaseId: string;
  planId: string;
  orders: number;
  copies: number;
  revenue: number;
  unpriced: number;
  productCost: number;
  shippingCost: number;
  handlingCost: number;
  uncosted: number;
};

export async function revenueReport(db: Db, rawDb: D1Database, shopId: string) {
  const [byReleasePlan, paid] = await rawDb.batch<Record<string, number>>([
    rawDb
      .prepare(
        `${SLOT_PAYMENTS}
         SELECT sh."releaseId", sh."planId", COUNT(*) AS "orders", SUM(sh."quantity") AS "copies",
           COALESCE(SUM(sl."amt" * 1.0 / sl."n"), 0) AS "revenue",
           SUM(sl."amt" IS NULL) AS "unpriced",
           COALESCE(SUM(sh."product" * sh."quantity"), 0) AS "productCost",
           COALESCE(SUM(sh."shipping"), 0) AS "shippingCost",
           COALESCE(SUM(sh."handling"), 0) AS "handlingCost",
           SUM(sh."product" IS NULL OR sh."shipping" IS NULL OR sh."handling" IS NULL) AS "uncosted"
         FROM shipped sh LEFT JOIN slots sl
           ON sl.sid = sh.sid AND sh.k >= sl.hi - sl.n AND sh.k < sl.hi
         GROUP BY sh."releaseId", sh."planId"`,
      )
      .bind(shopId),
    // Everything paid in, to show how much of it is still waiting on releases to ship.
    rawDb
      .prepare(
        `${SLOT_PAYMENTS}
         SELECT COALESCE(SUM(amt), 0) AS "total", SUM(amt IS NULL) AS "unread" FROM pay`,
      )
      .bind(shopId),
  ]);
  const [releases, plans] = await Promise.all([
    db.release.findMany({
      where: { shopId, status: { not: "CANCELLED" } },
      orderBy: { number: "desc" },
      take: 50,
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        productCostCents: true,
        shippingCostCents: true,
        handlingCostCents: true,
      },
    }),
    db.plan.findMany({
      where: { shopId },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, currency: true },
    }),
  ]);
  return { rows: byReleasePlan.results as unknown as ReleasePlanRow[], paid: paid.results[0], releases, plans };
}

/** Rolls the per-release-and-plan rows up by release or by plan. Money is whole cents. */
export function totalsBy(rows: ReleasePlanRow[], key: "releaseId" | "planId") {
  const totals = new Map<
    string,
    { orders: number; revenue: number; costs: number; unpriced: number; uncosted: number }
  >();
  for (const row of rows) {
    const t = totals.get(row[key]) ?? { orders: 0, revenue: 0, costs: 0, unpriced: 0, uncosted: 0 };
    t.orders += row.orders;
    t.revenue += row.revenue;
    t.costs += row.productCost + row.shippingCost + row.handlingCost;
    t.unpriced += row.unpriced;
    t.uncosted += row.uncosted;
    totals.set(row[key], t);
  }
  for (const t of totals.values()) t.revenue = Math.round(t.revenue);
  return totals;
}

const MAX_COST_CENTS = 10_000_00;

/** "", "4", "4.5" or "4.50". Empty means not recorded; anything else is whole cents. */
export function parseCostCents(raw: FormDataEntryValue | null) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { cents: null };
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(text)) return { error: true as const };
  const [dollars, cents = ""] = text.split(".");
  const total = Number(dollars) * 100 + Number(cents.padEnd(2, "0"));
  return total <= MAX_COST_CENTS ? { cents: total } : { error: true as const };
}

export async function setReleaseCosts(
  db: Db,
  shopId: string,
  releaseId: string,
  costs: { productCostCents: number | null; shippingCostCents: number | null; handlingCostCents: number | null },
) {
  const { count } = await db.release.updateMany({ where: { id: releaseId, shopId }, data: costs });
  return count === 1;
}

// ---- the UNSURE alert ---------------------------------------------------------------------------

export const EMAIL_KIND_LABELS: Record<string, string> = {
  welcome: "Welcome",
  giftReceived: "Gift received",
  preorderAnnounced: "Pre-order announced",
  upcomingCharge: "Upcoming charge",
  failedPayment: "Failed payment",
  lastReleaseShipping: "Last release shipping",
  priceChange: "Price change notice",
};

const UNSURE_SHOWN = 10;

/** Emails that may or may not have gone out, for the merchant to decide on. */
export async function listUnsureEmails(rawDb: D1Database, shopId: string) {
  const { results } = await rawDb
    .prepare(
      `SELECT e."id", e."kind", e."subscriptionId", e."updatedAt", s."customerGid", r."number", r."title"
       FROM "EmailSend" e JOIN "Subscription" s ON s."id" = e."subscriptionId"
         LEFT JOIN "Release" r ON r."id" = e."subject"
       WHERE e."shopId" = ?1 AND e."status" = 'UNSURE' ORDER BY e."updatedAt" LIMIT ${UNSURE_SHOWN + 1}`,
    )
    .bind(shopId)
    .all<{
      id: string;
      kind: string;
      subscriptionId: string;
      updatedAt: string;
      customerGid: string;
      number: number | null;
      title: string | null;
    }>();
  return { rows: results.slice(0, UNSURE_SHOWN), more: results.length > UNSURE_SHOWN };
}

/**
 * The merchant's choice on an UNSURE email. Sending again puts the row back to PENDING for the next
 * email run, which judges it afresh (it can still be skipped as stale). Leaving it ends it for good.
 * Only an UNSURE row of this shop changes, so pressing twice, or on a row that moved on, does nothing.
 */
export async function resolveUnsureEmail(
  rawDb: D1Database,
  shopId: string,
  emailId: string,
  choice: "resend" | "leave",
  now = new Date(),
) {
  const result = await rawDb
    .prepare(
      `UPDATE "EmailSend" SET "status" = ?4, "reason" = ?5, "leaseUntil" = NULL, "updatedAt" = ?3
       WHERE "id" = ?1 AND "shopId" = ?2 AND "status" = 'UNSURE'`,
    )
    .bind(
      emailId,
      shopId,
      now.toISOString(),
      choice === "resend" ? "PENDING" : "SKIPPED",
      choice === "resend" ? null : "left_unsure",
    )
    .run();
  return result.meta.changes === 1;
}

export const resendJob = (shop: string) => emailRunJob(shop, `resend:${crypto.randomUUID()}`);

// ---- stock --------------------------------------------------------------------------------------

/** At or below this many, the warning says stock is running low. At 0 it says sign-ups are blocked. */
export const LOW_STOCK = 10;

export async function listStockWarnings(db: Db, shopId: string) {
  return db.plan.findMany({
    where: { shopId, active: true, stockLevel: { lte: LOW_STOCK } },
    select: { id: true, name: true, productTitle: true, stockLevel: true },
    orderBy: { stockLevel: "asc" },
    take: 10,
  });
}

// ---- the hourly refresh -------------------------------------------------------------------------

const ORDER_AMOUNTS = `#graphql
  query DashboardOrders($ids: [ID!]!) {
    nodes(ids: $ids) { ... on Order { id currentSubtotalPriceSet { shopMoney { amount } } } }
  }`;
const CONTRACT_AMOUNTS = `#graphql
  query DashboardContracts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on SubscriptionContract {
        id
        lines(first: 50) { nodes { quantity sellingPlanId } pageInfo { hasNextPage } }
        originOrder {
          lineItems(first: 100) {
            nodes { quantity sellingPlan { sellingPlanId } discountedTotalSet { shopMoney { amount } } }
            pageInfo { hasNextPage }
          }
        }
      }
    }
  }`;
const STOCK = `#graphql
  query DashboardStock($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        variants(first: 100) { nodes { inventoryPolicy inventoryQuantity inventoryItem { tracked } } }
      }
    }
  }`;

const PER_PAGE = 50;
const PAGES = 5;

const toCents = (money: { shopMoney: { amount: string } } | null | undefined) =>
  money ? Math.round(Number(money.shopMoney.amount) * 100) : null;

type ContractNode = {
  lines: { nodes: { quantity: number; sellingPlanId: string | null }[]; pageInfo: { hasNextPage: boolean } };
  originOrder: {
    lineItems: {
      nodes: {
        quantity: number;
        sellingPlan: { sellingPlanId: string } | null;
        discountedTotalSet: { shopMoney: { amount: string } };
      }[];
      pageInfo: { hasNextPage: boolean };
    };
  } | null;
};

/**
 * What the checkout charged for this contract's own lines: the origin order's lines for the contract's
 * selling plans, after discounts and before tax and shipping. The order can hold other things (a one-time
 * product, another plan's contract), so its subtotal is never used. A contract line has no link to its order
 * line, so they are matched by selling plan, and trusted only if the quantities agree. 0 means no checkout
 * order (made through the API); null means the lines can't be identified, so the amount stays unread.
 */
export function signupAmountCents(node: ContractNode): number | null {
  if (!node.originOrder) return 0;
  const { lines, originOrder } = node;
  if (lines.pageInfo.hasNextPage || originOrder.lineItems.pageInfo.hasNextPage) return null;
  const plans = new Set(lines.nodes.flatMap((line) => line.sellingPlanId ?? []));
  const matched = originOrder.lineItems.nodes.filter(
    (item) => item.sellingPlan && plans.has(item.sellingPlan.sellingPlanId),
  );
  const copies = lines.nodes.filter((l) => l.sellingPlanId).reduce((sum, l) => sum + l.quantity, 0);
  if (matched.length === 0 || matched.reduce((sum, item) => sum + item.quantity, 0) !== copies) return null;
  return matched.reduce((sum, item) => sum + (toCents(item.discountedTotalSet) ?? 0), 0);
}

/**
 * Reads what payments brought in, and the plans' stock, from Shopify and keeps them. State-driven:
 * it finds the payments still unread, so a missed hour, a retry or a second job changes nothing.
 * A billing order's amount is its subtotal after discounts, before tax and shipping, as of the read (a later
 * refund isn't reflected). Orders can only be read for 60 days without `read_all_orders`, so a payment
 * unread after that stays unread.
 */
export async function refreshDashboard(db: Db, rawDb: D1Database, graphql: Graphql, shopDomain: string, now = new Date()) {
  const shop = await db.shop.findUnique({ where: { shopDomain }, select: { id: true } });
  if (!shop) return;
  let priced = 0;

  for (let page = 0; page < PAGES; page++) {
    const { results: attempts } = await rawDb
      .prepare(
        `SELECT b."id", b."orderGid" FROM "BillingAttempt" b JOIN "Subscription" s ON s."id" = b."subscriptionId"
         WHERE s."shopId" = ?1 AND b."result" = 'SUCCEEDED' AND b."orderGid" IS NOT NULL
           AND b."orderGid" <> '' AND b."amountCents" IS NULL
         ORDER BY b."createdAt" DESC LIMIT ?2`,
      )
      .bind(shop.id, PER_PAGE)
      .all<{ id: string; orderGid: string }>();
    if (attempts.length === 0) break;
    const { nodes } = await graphql(ORDER_AMOUNTS, { ids: attempts.map((a) => a.orderGid) });
    const byOrder = new Map<string, number>();
    for (const node of nodes as ({ id: string; currentSubtotalPriceSet: never } | null)[]) {
      const cents = node && toCents(node.currentSubtotalPriceSet);
      if (node && cents !== null) byOrder.set(node.id, cents);
    }
    const updates = attempts.flatMap((a) =>
      byOrder.has(a.orderGid)
        ? [
            rawDb
              .prepare(`UPDATE "BillingAttempt" SET "amountCents" = ?2 WHERE "id" = ?1 AND "amountCents" IS NULL`)
              .bind(a.id, byOrder.get(a.orderGid)),
          ]
        : [],
    );
    if (updates.length) await rawDb.batch(updates);
    priced += updates.length;
    // Orders Shopify didn't return stay unread and come up again, so stop rather than loop on them.
    if (updates.length < attempts.length) break;
  }

  for (let page = 0; page < PAGES; page++) {
    const { results: signups } = await rawDb
      .prepare(
        `SELECT "id", "contractGid" FROM "Subscription"
         WHERE "shopId" = ?1 AND "signupCents" IS NULL AND "contractGid" IS NOT NULL AND "source" <> 'IMPORTED'
         ORDER BY "createdAt" DESC LIMIT ?2`,
      )
      .bind(shop.id, PER_PAGE)
      .all<{ id: string; contractGid: string }>();
    if (signups.length === 0) break;
    const { nodes } = await graphql(CONTRACT_AMOUNTS, { ids: signups.map((s) => s.contractGid) });
    const byContract = new Map<string, number>();
    for (const node of nodes as (({ id: string } & ContractNode) | null)[]) {
      const cents = node && signupAmountCents(node);
      if (node && cents !== null) byContract.set(node.id, cents);
    }
    const updates = signups.flatMap((s) =>
      byContract.has(s.contractGid)
        ? [
            rawDb
              .prepare(`UPDATE "Subscription" SET "signupCents" = ?2 WHERE "id" = ?1 AND "signupCents" IS NULL`)
              .bind(s.id, byContract.get(s.contractGid)),
          ]
        : [],
    );
    if (updates.length) await rawDb.batch(updates);
    priced += updates.length;
    if (updates.length < signups.length) break;
  }

  const plans = await db.plan.findMany({
    where: { shopId: shop.id, active: true, productGid: { not: null } },
    select: { id: true, productGid: true },
  });
  if (plans.length) {
    const { nodes } = await graphql(STOCK, { ids: [...new Set(plans.map((p) => p.productGid!))] });
    const level = new Map<string, number | null>();
    for (const node of nodes as ({
      id: string;
      variants: { nodes: { inventoryPolicy: string; inventoryQuantity: number | null; inventoryItem: { tracked: boolean } }[] };
    } | null)[]) {
      if (!node) continue;
      // Only a tracked variant that refuses to oversell can stop a sign-up.
      const blocking = node.variants.nodes.filter(
        (v) => v.inventoryItem.tracked && v.inventoryPolicy === "DENY" && v.inventoryQuantity !== null,
      );
      level.set(node.id, blocking.length ? Math.min(...blocking.map((v) => v.inventoryQuantity!)) : null);
    }
    const updates = plans.flatMap((p) =>
      level.has(p.productGid!)
        ? [
            rawDb
              .prepare(`UPDATE "Plan" SET "stockLevel" = ?2, "stockCheckedAt" = ?3 WHERE "id" = ?1`)
              .bind(p.id, level.get(p.productGid!), now.toISOString()),
          ]
        : [],
    );
    if (updates.length) await rawDb.batch(updates);
  }
  logEvent("info", "dashboard.refreshed", { shopId: shop.id, priced, plans: plans.length });
}

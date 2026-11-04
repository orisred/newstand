import type { createDb } from "./db.server";
import { billingAttemptKey } from "./jobs/idempotency.server";
import type { DueWorkFinder, Job } from "./jobs/runner.server";
import { describeError, logEvent } from "./logger.server";
import { PAUSED_EVENT } from "./notification-jobs";
import type { Graphql } from "./plan-sync.server";
import {
  addMonths,
  markCancelled,
  paymentOrderJob,
  releaseRunJob,
} from "./subscriptions.server";

type Db = ReturnType<typeof createDb>;

export const BILLING_SETTLE_JOB = "billing.settle";
export const BILLING_RECOVER_JOB = "billing.recover";
export const BILLING_RENEW_JOB = "billing.renew";
export const BILLING_RETRY_JOB = "billing.retry";
export const BILLING_RESUME_JOB = "billing.resume";
export const DISPUTE_JOB = "billing.dispute";

export const FAILED_PAYMENT = "FAILED_PAYMENT";
export const CHARGEBACK = "CHARGEBACK";

/** Days to wait before each retry: three tries, on days 0, 3 and 7, then a pause. */
const RETRY_AFTER_DAYS = [3, 4];
const DAY_MS = 24 * 60 * 60 * 1000;
/** A result still unknown after this is looked up: Shopify took about 2 seconds when measured. */
const LOST_RESULT_AFTER_MS = 10 * 60 * 1000;

/**
 * Failures a later try at the same card can't fix, or that card networks don't want retried. The
 * customer or merchant has to change something. Anything else, including a code added later, is
 * retried: a gateway's soft declines often arrive as a generic code. So is a contract with no
 * card at all, because that never reaches a card network and a retry picks up one added since.
 */
const NOT_WORTH_RETRYING = new Set([
  "ACTION_REQUIRED",
  "AMOUNT_TOO_LARGE",
  "AMOUNT_TOO_SMALL",
  "AUTHENTICATION_ERROR",
  "AUTHENTICATION_FAILED",
  "AUTHENTICATION_REQUIRED",
  "BUYER_CANCELED_PAYMENT_METHOD",
  "CANCELLED_PAYMENT",
  "CARD_NUMBER_INCORRECT",
  "CONFIRMATION_REJECTED",
  "CUSTOMER_INVALID",
  "CUSTOMER_NOT_FOUND",
  "EXPIRED_BUYER_ACTION",
  "EXPIRED_CARD",
  "EXPIRED_PAYMENT_METHOD",
  "FRAUD_SUSPECTED",
  "FREE_GIFT_CARD_NOT_ALLOWED",
  "INCORRECT_ADDRESS",
  "INCORRECT_CVC",
  "INCORRECT_NUMBER",
  "INCORRECT_PIN",
  "INCORRECT_ZIP",
  "INVALID_AMOUNT",
  "INVALID_BILLING_ADDRESS",
  "INVALID_CURRENCY",
  "INVALID_CUSTOMER_BILLING_AGREEMENT",
  "INVALID_CVC",
  "INVALID_EXPIRY_DATE",
  "INVALID_NUMBER",
  "INVALID_PAYMENT_METHOD",
  "INVALID_PURCHASE_TYPE",
  "INVALID_REQUEST",
  "INVALID_SHIPPING_ADDRESS",
  "INVOICE_ALREADY_PAID",
  "MERCHANT_RULE",
  "NON_TEST_ORDER_LIMIT_REACHED",
  "OFF_SESSION_REJECTED",
  "PAYMENT_METHOD_INCOMPATIBLE_WITH_GATEWAY_CONFIG",
  "PAYMENT_METHOD_UNSUPPORTED",
  "PAYMENT_PROVIDER_IS_NOT_ENABLED",
  "PURCHASE_TYPE_NOT_SUPPORTED",
  "RETRY_DECLINED",
  "TEST_MODE",
]);

export const worthRetrying = (code: string) => !NOT_WORTH_RETRYING.has(code);

const CONTRACT = `#graphql
  query ContractForCharge($id: ID!) {
    subscriptionContract(id: $id) {
      status
      deliveryPrice { amount }
      lines(first: 50) { nodes { id sellingPlanId currentPrice { amount } } }
    }
  }`;

const CREATE = `#graphql
  mutation BillingAttemptCreate($contract: ID!, $input: SubscriptionBillingAttemptInput!) {
    subscriptionBillingAttemptCreate(subscriptionContractId: $contract, subscriptionBillingAttemptInput: $input) {
      subscriptionBillingAttempt { id state { __typename } }
      userErrors { code }
    }
  }`;

const RESULT = `#graphql
  query BillingAttemptResult($id: ID!) {
    subscriptionBillingAttempt(id: $id) {
      id
      idempotencyKey
      completedAt
      state {
        __typename
        ... on SubscriptionBillingAttemptSuccessState { order { id } }
        ... on SubscriptionBillingAttemptFailedState {
          error {
            __typename
            ... on SubscriptionBillingAttemptGeneralError { code }
            ... on SubscriptionBillingAttemptInventoryError { code }
            ... on SubscriptionBillingAttemptPaymentError { code }
          }
        }
      }
    }
  }`;

const ATTEMPTS_ON_CONTRACT = `#graphql
  query AttemptsOnContract($id: ID!) {
    subscriptionContract(id: $id) {
      billingAttempts(first: 50, reverse: true) { nodes { id idempotencyKey } }
    }
  }`;

const DRAFT_OPEN = `#graphql
  mutation PriceDraftOpen($contract: ID!) {
    subscriptionContractUpdate(contractId: $contract) {
      draft { id }
      userErrors { message }
    }
  }`;

const DRAFT_LINE = `#graphql
  mutation PriceDraftLine($draft: ID!, $line: ID!, $input: SubscriptionLineUpdateInput!) {
    subscriptionDraftLineUpdate(draftId: $draft, lineId: $line, input: $input) {
      userErrors { message }
    }
  }`;

const DRAFT_COMMIT = `#graphql
  mutation PriceDraftCommit($draft: ID!) {
    subscriptionDraftCommit(draftId: $draft) {
      contract { id }
      userErrors { message }
    }
  }`;

const ORDER_CONTRACTS = `#graphql
  query DisputedOrder($id: ID!) {
    order(id: $id) { lineItems(first: 50) { nodes { contract { id } } } }
  }`;

/** The middle of a bundle renewal's key. It has no release, and a term renews once. */
export const termChargeFor = (termEndsAt: Date) => `term-${termEndsAt.getTime()}`;
const isTermCharge = (chargeFor: string) => chargeFor.startsWith("term-");

/** A subscription's first release, moved past every release that has reached its order step. */
const PAST_REACHED = `MAX("firstReleaseNumber", 1 + COALESCE((
  SELECT MAX(r."number") FROM "Release" r JOIN "Shop" sh ON sh."id" = r."shopId"
  WHERE r."shopId" = "Subscription"."shopId"
    AND (r."status" IN ('READY', 'SHIPPED')
      OR (r."status" = 'PREORDER' AND sh."orderTiming" = 'PREORDER_OPENS'))), 0))`;

/** Payload is IDs only. The ID makes a repeat do nothing. */
function eventStatement(
  rawDb: D1Database,
  key: string,
  type: string,
  shopId: string,
  subscriptionId: string,
  payload: Record<string, string | number | null>,
) {
  return rawDb
    .prepare(
      `INSERT INTO "Event" ("id", "shopId", "subscriptionId", "type", "payload")
       VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT ("id") DO NOTHING`,
    )
    .bind(`${type}:${key}`, shopId, subscriptionId, type, JSON.stringify(payload));
}

/**
 * Brings the contract's price in line with the plan's latest change, if the merchant chose to
 * apply it at renewal and its notice period is over. Only ever called before a charge's first
 * attempt, so a charge already attempted keeps the price it was attempted at. Safe to repeat: a
 * line already at the price is left alone.
 */
async function applyPriceChange(
  db: Db,
  graphql: Graphql,
  subscription: {
    id: string;
    contractGid: string;
    planId: string;
    sellingPlanGid: string | null;
    createdAt: Date;
    lockedPriceCents: number | null;
  },
  lines: { id: string; sellingPlanId: string | null; currentPrice: { amount: string } }[],
  now: Date,
) {
  const change = await db.priceChange.findFirst({
    where: { planId: subscription.planId },
    orderBy: { createdAt: "desc" },
  });
  if (
    !change ||
    change.policy !== "APPLY_AT_RENEWAL" ||
    change.effectiveAt > now ||
    subscription.createdAt >= change.effectiveAt ||
    subscription.lockedPriceCents === change.newPriceCents
  ) {
    return;
  }
  const stale = lines.filter(
    (line) =>
      line.sellingPlanId === subscription.sellingPlanGid &&
      Math.round(Number(line.currentPrice.amount) * 100) !== change.newPriceCents,
  );
  if (stale.length > 0) {
    const { subscriptionContractUpdate: opened } = await graphql(DRAFT_OPEN, {
      contract: subscription.contractGid,
    });
    if (opened.userErrors.length > 0) throw new Error("Shopify refused a contract draft");
    for (const line of stale) {
      const { subscriptionDraftLineUpdate: updated } = await graphql(DRAFT_LINE, {
        draft: opened.draft.id,
        line: line.id,
        input: { currentPrice: (change.newPriceCents / 100).toFixed(2) },
      });
      if (updated.userErrors.length > 0) throw new Error("Shopify refused a new line price");
    }
    const { subscriptionDraftCommit: committed } = await graphql(DRAFT_COMMIT, {
      draft: opened.draft.id,
    });
    if (committed.userErrors.length > 0) throw new Error("Shopify refused the new price");
  }
  await db.subscription.updateMany({
    where: { id: subscription.id },
    data: { lockedPriceCents: change.newPriceCents },
  });
  logEvent("info", "billing.price_applied", {
    subscriptionId: subscription.id,
    priceChangeId: change.id,
  });
}

export type ChargeResult =
  | "sent"
  | "already" // this try has finished, so it can't be sent again
  | "not_chargeable"
  | "contract_closed"
  | "contract_not_active";

/**
 * One try at one charge. The row goes in before Shopify hears of it, so a webhook always finds it
 * and a crash leaves it for `recoverAttempt`. The key is what makes this safe to repeat: Shopify
 * returns the existing attempt for a key it has seen (checked live), and only a real retry, which
 * only `retryDue` and `retryCharge` can ask for, gets a new attempt number.
 */
async function attemptCharge(
  db: Db,
  rawDb: D1Database,
  graphql: Graphql,
  subscriptionId: string,
  chargeFor: string,
  attempt: number,
  now: Date,
  allowPaused = false,
): Promise<ChargeResult> {
  const subscription = await db.subscription.findUnique({
    where: { id: subscriptionId },
    select: {
      status: true,
      source: true,
      pausedReason: true,
      contractGid: true,
      createdAt: true,
      lockedPriceCents: true,
      planId: true,
      plan: { select: { autoRenew: true, sellingPlanGid: true } },
    },
  });
  const contractGid = subscription?.contractGid;
  // The guard in front of all money: nothing below runs for anyone but these.
  if (
    !contractGid ||
    subscription.source === "GIFT" ||
    !subscription.plan.autoRenew ||
    !(
      subscription.status === "ACTIVE" ||
      (allowPaused &&
        subscription.status === "PAUSED" &&
        subscription.pausedReason === FAILED_PAYMENT)
    )
  ) {
    logEvent("info", "billing.not_chargeable", { subscriptionId, chargeFor });
    return "not_chargeable";
  }

  // Read fresh, because a cancellation whose webhook was lost isn't otherwise recovered.
  const { subscriptionContract: contract } = await graphql(CONTRACT, {
    id: contractGid,
  });
  if (contract?.status === "CANCELLED" || contract?.status === "EXPIRED") {
    await markCancelled(rawDb, subscriptionId, now);
    logEvent("info", "billing.contract_closed", { subscriptionId });
    return "contract_closed";
  }
  if (contract?.status !== "ACTIVE") {
    logEvent("warn", "billing.contract_not_active", { subscriptionId });
    return "contract_not_active";
  }

  const key = billingAttemptKey(subscriptionId, chargeFor, attempt);
  const existing = await db.billingAttempt.findUnique({
    where: { idempotencyKey: key },
    select: { result: true },
  });
  if (existing && existing.result !== "PENDING") return "already";

  if (!existing) {
    if (attempt === 1) {
      await applyPriceChange(
        db,
        graphql,
        {
          id: subscriptionId,
          contractGid,
          planId: subscription.planId,
          sellingPlanGid: subscription.plan.sellingPlanGid,
          createdAt: subscription.createdAt,
          lockedPriceCents: subscription.lockedPriceCents,
        },
        contract.lines.nodes,
        now,
      );
    }
    const stamp = now.toISOString();
    await rawDb.batch([
      rawDb
        .prepare(
          `INSERT INTO "BillingAttempt" ("id", "subscriptionId", "chargeFor", "idempotencyKey",
             "attempt", "createdAt", "updatedAt")
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) ON CONFLICT ("idempotencyKey") DO NOTHING`,
        )
        .bind(crypto.randomUUID(), subscriptionId, chargeFor, key, attempt, stamp),
      // This try replaces any that was scheduled.
      rawDb
        .prepare(
          `UPDATE "BillingAttempt" SET "nextRetryAt" = NULL, "updatedAt" = ?4
           WHERE "subscriptionId" = ?1 AND "chargeFor" = ?2 AND "attempt" < ?3
             AND "nextRetryAt" IS NOT NULL`,
        )
        .bind(subscriptionId, chargeFor, attempt, stamp),
      // A renewal at 0 starts its term with the next release: one that has already reached its
      // order step is an extra release, not part of this term. A release it then misses while
      // the payment fails is past this point, so it's HELD and ships late once paid. Only when it
      // first comes due: moving it on a retry could skip a release reached between the tries.
      ...(isTermCharge(chargeFor) && attempt === 1
        ? [
            rawDb
              .prepare(
                `UPDATE "Subscription" SET "updatedAt" = ?2, "firstReleaseNumber" = ${PAST_REACHED}
                 WHERE "id" = ?1 AND "releasesRemaining" = 0`,
              )
              .bind(subscriptionId, stamp),
          ]
        : []),
    ]);
  }
  const row = await db.billingAttempt.findUniqueOrThrow({
    where: { idempotencyKey: key },
    select: { id: true },
  });

  const { subscriptionBillingAttemptCreate: created } = await graphql(CREATE, {
    contract: contractGid,
    input: {
      idempotencyKey: key,
      // The subscription item isn't what ships, so its stock must not stop a renewal. No
      // `originTime`: left out, the order is fulfillable at once (checked live).
      inventoryPolicy: "ALLOW_OVERSELLING",
    },
  });
  const userErrors: { code: string | null }[] = created.userErrors;
  if (userErrors.length > 0) {
    await recordFailure(db, rawDb, row.id, userErrors[0].code ?? "REFUSED", now);
    return "sent";
  }
  const shopifyAttempt = created.subscriptionBillingAttempt;
  await db.billingAttempt.updateMany({
    where: { id: row.id, shopifyAttemptGid: null },
    data: { shopifyAttemptGid: shopifyAttempt.id },
  });
  logEvent("info", "billing.attempt_sent", {
    subscriptionId,
    chargeFor,
    attempt,
    attemptGid: shopifyAttempt.id,
    deliveryPrice: contract.deliveryPrice?.amount ?? null,
  });
  return "sent";
}

/**
 * Takes a result from Shopify, read fresh, so a webhook arriving twice, out of order or after a
 * lookup all end the same way. Returns the jobs to enqueue next, the same ones on a repeat.
 */
export async function settleAttempt(
  db: Db,
  rawDb: D1Database,
  graphql: Graphql,
  attemptGid: string,
  now = new Date(),
): Promise<Job[]> {
  const { subscriptionBillingAttempt: attempt } = await graphql(RESULT, {
    id: attemptGid,
  });
  const row =
    attempt?.idempotencyKey &&
    (await db.billingAttempt.findUnique({
      where: { idempotencyKey: attempt.idempotencyKey },
      select: { id: true },
    }));
  // The row goes in before Shopify is called, so this is a charge the app didn't make.
  if (!row) {
    logEvent("warn", "billing.unknown_attempt", { attemptGid });
    return [];
  }
  await db.billingAttempt.updateMany({
    where: { id: row.id, shopifyAttemptGid: null },
    data: { shopifyAttemptGid: attempt.id },
  });
  switch (attempt.state.__typename) {
    case "SubscriptionBillingAttemptSuccessState":
      return recordSuccess(
        db,
        rawDb,
        row.id,
        attempt.state.order?.id ?? null,
        new Date(attempt.completedAt ?? now),
        now,
      );
    case "SubscriptionBillingAttemptFailedState":
      await recordFailure(
        db,
        rawDb,
        row.id,
        attempt.state.error.code ?? "UNEXPECTED_ERROR",
        now,
      );
      return [];
    case "SubscriptionBillingAttemptActionRequiredState":
      // A bank wants the customer. Completing it later arrives as a success, and that still counts.
      await recordFailure(db, rawDb, row.id, "ACTION_REQUIRED", now);
      return [];
    default:
      return [];
  }
}

/**
 * The next three take ?1 subscription, ?2 attempt, ?3 stamp. With an attempt they run only until
 * that attempt is marked as succeeded, and marking it comes last in the batch, so one of any
 * number of repeats does the work. Without one they aren't tied to a payment.
 */
const NOT_YET_SUCCEEDED = `(?2 = '' OR EXISTS (
  SELECT 1 FROM "BillingAttempt" WHERE "id" = ?2 AND "result" <> 'SUCCEEDED'))`;

/** Lets the oldest HELD Deliveries go, as far as paid releases cover them. A chargeback keeps them. */
function releaseHeld(rawDb: D1Database, subscriptionId: string, stamp: string, attemptId = "") {
  return rawDb
    .prepare(
      `UPDATE "Delivery" SET "status" = 'PENDING', "updatedAt" = ?3
       WHERE "id" IN (
         SELECT d."id" FROM "Delivery" d JOIN "Release" r ON r."id" = d."releaseId"
         WHERE d."subscriptionId" = ?1 AND d."status" = 'HELD'
         ORDER BY r."number"
         LIMIT MAX(0, (SELECT "releasesRemaining" FROM "Subscription" WHERE "id" = ?1)
           - (SELECT COUNT(*) FROM "Delivery" WHERE "subscriptionId" = ?1 AND "status" = 'PENDING')))
       AND NOT EXISTS (SELECT 1 FROM "Subscription" WHERE "id" = ?1 AND "pausedReason" = '${CHARGEBACK}')
       AND ${NOT_YET_SUCCEEDED}`,
    )
    .bind(subscriptionId, attemptId, stamp);
}

/**
 * A bundle pays for N releases, not for all it missed, and a pay-per-release charge pays for one.
 * What paid releases don't cover isn't owed, so it's closed rather than left held.
 */
function dropHeld(rawDb: D1Database, subscriptionId: string, stamp: string, attemptId = "") {
  return rawDb
    .prepare(
      `UPDATE "Delivery" SET "status" = 'CANCELLED', "updatedAt" = ?3
       WHERE "subscriptionId" = ?1 AND "status" = 'HELD'
         AND NOT EXISTS (SELECT 1 FROM "Subscription" WHERE "id" = ?1 AND "pausedReason" = '${CHARGEBACK}')
         AND ${NOT_YET_SUCCEEDED}`,
    )
    .bind(subscriptionId, attemptId, stamp);
}

/**
 * One missed payment on a pay-per-release plan holds back what comes out while it lasts, and those
 * releases are skipped for good (decided by N, 2026-11-04). Ending the problem moves the subscriber
 * past them, even one still open, so the hourly scan can't assign it. The next release is normal.
 */
function skipMissed(rawDb: D1Database, subscriptionId: string, stamp: string, attemptId = "") {
  return rawDb
    .prepare(
      `UPDATE "Subscription" SET "firstReleaseNumber" = ${PAST_REACHED}, "updatedAt" = ?3
       WHERE "id" = ?1 AND "paymentProblemSince" IS NOT NULL AND ${NOT_YET_SUCCEEDED}`,
    )
    .bind(subscriptionId, attemptId, stamp);
}

/** The problem is over once nothing is held for it. Only the merchant ends a chargeback. */
function clearProblemWhenDone(rawDb: D1Database, subscriptionId: string, stamp: string, attemptId = "") {
  return rawDb
    .prepare(
      `UPDATE "Subscription" SET "paymentProblemSince" = NULL, "updatedAt" = ?3
       WHERE "id" = ?1 AND ("pausedReason" IS NULL OR "pausedReason" <> '${CHARGEBACK}')
         AND NOT EXISTS (SELECT 1 FROM "Delivery" WHERE "subscriptionId" = ?1 AND "status" = 'HELD')
         AND ${NOT_YET_SUCCEEDED}`,
    )
    .bind(subscriptionId, attemptId, stamp);
}

async function recordSuccess(
  db: Db,
  rawDb: D1Database,
  attemptId: string,
  orderGid: string | null,
  chargedAt: Date,
  now: Date,
): Promise<Job[]> {
  const row = await db.billingAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    select: {
      id: true,
      attempt: true,
      chargeFor: true,
      subscriptionId: true,
      subscription: {
        select: {
          shopId: true,
          termEndsAt: true,
          plan: { select: { releasesPerTerm: true, termMonths: true } },
          shop: { select: { shopDomain: true } },
        },
      },
    },
  });
  const { subscriptionId, subscription, chargeFor } = row;
  const renewal = isTermCharge(chargeFor);
  const { termEndsAt, plan } = subscription;
  // Measured from when it's paid, so a held or late renewal still buys a whole term and the next
  // charge can't land too soon after this one. See DECISIONS.md.
  const newTermEnd =
    renewal && plan.termMonths
      ? addMonths(
          termEndsAt && termEndsAt > chargedAt ? termEndsAt : chargedAt,
          plan.termMonths,
        ).toISOString()
      : null;
  const stamp = now.toISOString();
  await rawDb.batch([
    rawDb
      .prepare(
        `UPDATE "Subscription" SET
           "releasesRemaining" = "releasesRemaining" + ?4,
           "termEndsAt" = COALESCE(?5, "termEndsAt"),
           "status" = CASE WHEN "status" = 'PAUSED' AND "pausedReason" = '${FAILED_PAYMENT}' THEN 'ACTIVE' ELSE "status" END,
           "pausedReason" = CASE WHEN "pausedReason" = '${FAILED_PAYMENT}' THEN NULL ELSE "pausedReason" END,
           "updatedAt" = ?3
         WHERE "id" = ?1 AND ${NOT_YET_SUCCEEDED}`,
      )
      .bind(subscriptionId, attemptId, stamp, renewal ? plan.releasesPerTerm : 1, newTermEnd),
    releaseHeld(rawDb, subscriptionId, stamp, attemptId),
    dropHeld(rawDb, subscriptionId, stamp, attemptId),
    ...(renewal ? [] : [skipMissed(rawDb, subscriptionId, stamp, attemptId)]),
    clearProblemWhenDone(rawDb, subscriptionId, stamp, attemptId),
    eventStatement(rawDb, attemptId, "billing.succeeded", subscription.shopId, subscriptionId, {
      chargeFor,
      attempt: row.attempt,
      orderGid,
    }),
    rawDb
      .prepare(
        `UPDATE "BillingAttempt" SET "nextRetryAt" = NULL, "updatedAt" = ?3
         WHERE "subscriptionId" = ?1 AND "chargeFor" = ?2 AND "nextRetryAt" IS NOT NULL`,
      )
      .bind(subscriptionId, chargeFor, stamp),
    rawDb
      .prepare(
        `UPDATE "BillingAttempt" SET "result" = 'SUCCEEDED', "orderGid" = ?2, "errorCode" = NULL,
           "nextRetryAt" = NULL, "updatedAt" = ?3
         WHERE "id" = ?1 AND "result" <> 'SUCCEEDED'`,
      )
      .bind(attemptId, orderGid, stamp),
  ]);
  logEvent("info", "billing.succeeded", {
    subscriptionId,
    chargeFor,
    attempt: row.attempt,
    orderGid: orderGid ?? "",
  });
  return afterPayment(db, subscriptionId, subscription.shop.shopDomain, attemptId, orderGid);
}

/** What a payment sets moving. The IDs are stable, so a repeat of the settling job adds nothing. */
async function afterPayment(
  db: Db,
  subscriptionId: string,
  shop: string,
  key: string,
  orderGid: string | null,
) {
  const pending = await db.delivery.findMany({
    where: { subscriptionId, status: "PENDING" },
    distinct: ["releaseId"],
    select: { releaseId: true },
  });
  return [
    ...(orderGid ? [paymentOrderJob(shop, orderGid)] : []),
    ...pending.map(({ releaseId }) => releaseRunJob(shop, releaseId, `billing-${key}`)),
  ];
}

async function recordFailure(
  db: Db,
  rawDb: D1Database,
  attemptId: string,
  errorCode: string,
  now: Date,
) {
  const row = await db.billingAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    select: {
      attempt: true,
      chargeFor: true,
      subscriptionId: true,
      subscription: { select: { status: true, shopId: true } },
    },
  });
  const { subscriptionId, subscription, chargeFor, attempt } = row;
  const retryAfter =
    subscription.status === "ACTIVE" && worthRetrying(errorCode)
      ? RETRY_AFTER_DAYS[attempt - 1]
      : undefined;
  const nextRetryAt =
    retryAfter === undefined
      ? null
      : new Date(now.getTime() + retryAfter * DAY_MS).toISOString();
  const stamp = now.toISOString();
  const open = `EXISTS (SELECT 1 FROM "BillingAttempt" WHERE "id" = ?2 AND "result" = 'PENDING')`;
  const paused = retryAfter === undefined;
  await rawDb.batch([
    // The release this charge was for waits for the payment, visibly.
    rawDb
      .prepare(
        `UPDATE "Delivery" SET "status" = 'HELD', "updatedAt" = ?4
         WHERE "subscriptionId" = ?1 AND "releaseId" = ?3 AND "status" = 'PENDING' AND ${open}`,
      )
      .bind(subscriptionId, attemptId, chargeFor, stamp),
    rawDb
      .prepare(
        `UPDATE "Subscription" SET
           "paymentProblemSince" = COALESCE("paymentProblemSince", ?4),
           "status" = CASE WHEN ?3 = 1 AND "status" = 'ACTIVE' THEN 'PAUSED' ELSE "status" END,
           "pausedReason" = CASE WHEN ?3 = 1 AND "status" = 'ACTIVE' THEN '${FAILED_PAYMENT}' ELSE "pausedReason" END,
           "updatedAt" = ?4
         WHERE "id" = ?1 AND "status" IN ('ACTIVE', 'PAUSED') AND ${open}`,
      )
      .bind(subscriptionId, attemptId, paused ? 1 : 0, stamp),
    eventStatement(rawDb, attemptId, "billing.failed", subscription.shopId, subscriptionId, {
      chargeFor,
      attempt,
      errorCode,
      nextRetryAt,
    }),
    // For Flow, when the failure also paused the subscription.
    ...(paused && subscription.status === "ACTIVE"
      ? [eventStatement(rawDb, attemptId, PAUSED_EVENT, subscription.shopId, subscriptionId, { chargeFor })]
      : []),
    rawDb
      .prepare(
        `UPDATE "BillingAttempt" SET "result" = 'FAILED', "errorCode" = ?2, "nextRetryAt" = ?3,
           "updatedAt" = ?4
         WHERE "id" = ?1 AND "result" = 'PENDING'`,
      )
      .bind(attemptId, errorCode, nextRetryAt, stamp),
  ]);
  logEvent("warn", "billing.failed", { subscriptionId, chargeFor, attempt, errorCode, paused });
}

/**
 * For a result that never arrived. With a Shopify ID it just reads the result. Without one, a
 * crash came around the billing call, so it asks Shopify whether the charge got there. If it
 * didn't, the same key goes out now, unless the subscriber can't be charged any more.
 */
export async function recoverAttempt(
  db: Db,
  rawDb: D1Database,
  graphql: Graphql,
  attemptId: string,
  now = new Date(),
): Promise<Job[]> {
  const row = await db.billingAttempt.findUnique({
    where: { id: attemptId },
    select: {
      result: true,
      idempotencyKey: true,
      shopifyAttemptGid: true,
      chargeFor: true,
      attempt: true,
      subscriptionId: true,
      subscription: { select: { contractGid: true } },
    },
  });
  if (!row || row.result !== "PENDING") return [];
  let attemptGid = row.shopifyAttemptGid;
  if (!attemptGid && row.subscription.contractGid) {
    const { subscriptionContract: contract } = await graphql(ATTEMPTS_ON_CONTRACT, {
      id: row.subscription.contractGid,
    });
    attemptGid =
      (contract?.billingAttempts.nodes as { id: string; idempotencyKey: string }[] | undefined)?.find(
        ({ idempotencyKey }) => idempotencyKey === row.idempotencyKey,
      )?.id ?? null;
  }
  if (attemptGid) return settleAttempt(db, rawDb, graphql, attemptGid, now);

  const result = await attemptCharge(
    db,
    rawDb,
    graphql,
    row.subscriptionId,
    row.chargeFor,
    row.attempt,
    now,
    true,
  );
  // Shopify never heard of it, and it won't now. That's no failed card, so the row just goes.
  if (result === "not_chargeable" || result === "contract_closed") {
    await db.billingAttempt.deleteMany({
      where: { id: attemptId, result: "PENDING" },
    });
  }
  return [];
}

/** A bundle renewal's rule, in one place. A pay-per-release charge follows its release instead. */
export function renewalDue(
  subscription: {
    status: string;
    source: string;
    contractGid: string | null;
    termEndsAt: Date | null;
    releasesRemaining: number;
    paymentProblemSince: Date | null;
  },
  plan: { billingMode: string; autoRenew: boolean; renewalRule: string },
  now: Date,
) {
  if (
    plan.billingMode !== "PREPAID_BUNDLE" ||
    !plan.autoRenew ||
    subscription.status !== "ACTIVE" ||
    subscription.source === "GIFT" ||
    !subscription.contractGid ||
    !subscription.termEndsAt ||
    subscription.paymentProblemSince
  ) {
    return false;
  }
  const termOver = subscription.termEndsAt <= now;
  const outOfReleases = subscription.releasesRemaining <= 0;
  switch (plan.renewalRule) {
    case "TERM_DATE":
      return termOver;
    case "ON_DEPLETION":
      return outOfReleases;
    default:
      return termOver && outOfReleases;
  }
}

/**
 * Starts a bundle's renewal if its rule says it's due. Called right after an order is created,
 * because a held renewal is charged at that moment, and by the tick, which also catches a crash
 * in between. A term has one key, so both can run.
 */
export async function renewIfDue(
  db: Db,
  rawDb: D1Database,
  graphql: Graphql,
  subscriptionId: string,
  now = new Date(),
) {
  const subscription = await db.subscription.findUnique({
    where: { id: subscriptionId },
    select: {
      status: true,
      source: true,
      contractGid: true,
      termEndsAt: true,
      releasesRemaining: true,
      paymentProblemSince: true,
      plan: { select: { billingMode: true, autoRenew: true, renewalRule: true } },
    },
  });
  if (!subscription || !renewalDue(subscription, subscription.plan, now)) return null;
  return attemptCharge(
    db,
    rawDb,
    graphql,
    subscriptionId,
    termChargeFor(subscription.termEndsAt!),
    1,
    now,
  );
}

/** Who a run still has to charge for this release: PENDING, nothing paid, never tried for it. */
const chargeableOn = (releaseId: string) =>
  ({
    releaseId,
    status: "PENDING",
    orderError: null,
    subscription: {
      status: "ACTIVE",
      source: { not: "GIFT" },
      contractGid: { not: null },
      releasesRemaining: 0,
      paymentProblemSince: null,
      plan: { billingMode: "PER_RELEASE", autoRenew: true },
      billingAttempts: { none: { chargeFor: releaseId } },
    },
  }) as const;

/**
 * The run's charges for a release, at most `room` of them, so a charge never gets far ahead of
 * its order: `room` is what the run can still order right now. Returns how many went out, and how
 * many are still to go or still waiting for a result, which is what keeps the run going.
 */
export async function chargeRelease(
  db: Db,
  rawDb: D1Database,
  graphqlFor: () => Promise<Graphql>,
  releaseId: string,
  room: number,
  now: Date,
) {
  const inFlight = await db.billingAttempt.count({
    where: { chargeFor: releaseId, result: "PENDING" },
  });
  const allowed = room - inFlight;
  const due =
    allowed > 0
      ? await db.delivery.findMany({
          where: chargeableOn(releaseId),
          orderBy: { id: "asc" },
          take: allowed,
          select: { id: true, subscriptionId: true },
        })
      : [];
  let sent = 0;
  if (due.length > 0) {
    const graphql = await graphqlFor();
    for (const { id, subscriptionId } of due) {
      try {
        const result = await attemptCharge(
          db,
          rawDb,
          graphql,
          subscriptionId,
          releaseId,
          1,
          now,
        );
        if (result === "sent") sent++;
      } catch (error) {
        // Its row, if it got that far, is recovered by the tick. The next slice tries the rest.
        logEvent("error", "billing.charge_failed", {
          deliveryId: id,
          ...describeError(error),
        });
        break;
      }
    }
  }
  const unsent = await db.delivery.count({ where: chargeableOn(releaseId) });
  const waiting = await db.billingAttempt.count({
    where: { chargeFor: releaseId, result: "PENDING" },
  });
  return { sent, waiting: unsent + waiting };
}

/** A failed charge's next scheduled try. Its ID holds the row, so it only ever asks for one more. */
export async function retryDue(
  db: Db,
  rawDb: D1Database,
  graphql: Graphql,
  attemptId: string,
  now = new Date(),
) {
  const row = await db.billingAttempt.findUnique({
    where: { id: attemptId },
    select: {
      result: true,
      nextRetryAt: true,
      attempt: true,
      chargeFor: true,
      subscriptionId: true,
    },
  });
  if (!row || row.result !== "FAILED" || !row.nextRetryAt) return;
  const { subscriptionId, chargeFor } = row;
  const stillOwed =
    isTermCharge(chargeFor) ||
    (await db.delivery.count({
      where: { subscriptionId, releaseId: chargeFor, status: "HELD" },
    })) > 0;
  const result = stillOwed
    ? await attemptCharge(db, rawDb, graphql, subscriptionId, chargeFor, row.attempt + 1, now)
    : "not_chargeable";
  if (result === "sent" || result === "already") return;
  const stamp = now.toISOString();
  await rawDb.batch([
    rawDb
      .prepare(`UPDATE "BillingAttempt" SET "nextRetryAt" = NULL, "updatedAt" = ?2 WHERE "id" = ?1`)
      .bind(attemptId, stamp),
    // The release was cancelled, say: then nothing is owed.
    ...(isTermCharge(chargeFor) ? [] : [skipMissed(rawDb, subscriptionId, stamp)]),
    clearProblemWhenDone(rawDb, subscriptionId, stamp),
  ]);
}

/**
 * What recovery runs: a merchant's press now, and the portal's card update in Step 11. It ends a
 * chargeback if the merchant says so, then charges what's still owed, one charge at most, and if
 * nothing is, simply lifts the pause.
 */
export async function retryCharge(
  db: Db,
  rawDb: D1Database,
  graphql: Graphql,
  subscriptionId: string,
  byMerchant: boolean,
  now = new Date(),
): Promise<Job[]> {
  const subscription = await db.subscription.findUnique({
    where: { id: subscriptionId },
    select: {
      status: true,
      pausedReason: true,
      plan: { select: { billingMode: true } },
      shop: { select: { shopDomain: true } },
    },
  });
  if (!subscription) return [];
  const { status, pausedReason, plan, shop } = subscription;
  const chargeback = pausedReason === CHARGEBACK;
  // Only the merchant ends a chargeback, and it can outlast a cancellation.
  if (chargeback && !byMerchant) return [];
  if (status === "ENDED" || (!chargeback && status !== "ACTIVE" && status !== "PAUSED")) {
    return [];
  }
  const cancelled = status === "CANCELLED";
  const bundle = plan.billingMode === "PREPAID_BUNDLE";
  const stamp = now.toISOString();
  const lift = async (ending: boolean) => {
    await rawDb.batch([
      ...(ending
        ? [
            rawDb
              .prepare(
                `UPDATE "Subscription" SET "pausedReason" = NULL, "updatedAt" = ?2,
                   "status" = CASE WHEN "status" = 'PAUSED' THEN 'ACTIVE' ELSE "status" END
                 WHERE "id" = ?1`,
              )
              .bind(subscriptionId, stamp),
          ]
        : []),
      releaseHeld(rawDb, subscriptionId, stamp),
      ...(bundle || cancelled ? [dropHeld(rawDb, subscriptionId, stamp)] : []),
      ...(bundle ? [] : [skipMissed(rawDb, subscriptionId, stamp)]),
      clearProblemWhenDone(rawDb, subscriptionId, stamp),
    ]);
  };

  if (chargeback) await lift(true);
  // Cancelled means never charged again: paid releases ship, and that's all that's left to do.
  if (cancelled) {
    return afterPayment(db, subscriptionId, shop.shopDomain, crypto.randomUUID(), null);
  }
  const open = await db.billingAttempt.count({
    where: { subscriptionId, result: "PENDING" },
  });
  if (open > 0) return [];

  const owed = bundle
    ? await db.billingAttempt.findFirst({
        where: { subscriptionId },
        orderBy: { createdAt: "desc" },
        select: { chargeFor: true, result: true },
      })
    : await db.delivery.findFirst({
        where: { subscriptionId, status: "HELD" },
        orderBy: { release: { number: "asc" } },
        select: { releaseId: true },
      });
  const chargeFor = !owed
    ? null
    : "releaseId" in owed
      ? owed.releaseId
      : owed.result === "FAILED"
        ? owed.chargeFor
        : null;
  if (!chargeFor) {
    await lift(status === "PAUSED" && pausedReason === FAILED_PAYMENT);
    return afterPayment(db, subscriptionId, shop.shopDomain, crypto.randomUUID(), null);
  }
  const last = await db.billingAttempt.findFirst({
    where: { subscriptionId, chargeFor },
    orderBy: { attempt: "desc" },
    select: { attempt: true, result: true },
  });
  if (last?.result === "SUCCEEDED") return [];
  await attemptCharge(
    db,
    rawDb,
    graphql,
    subscriptionId,
    chargeFor,
    (last?.attempt ?? 0) + 1,
    now,
    true,
  );
  return [];
}

/**
 * A chargeback pauses and flags, and unlike a failed card it holds back paid releases too: the
 * customer is disputing what they paid, so shipping more only adds to the loss. The merchant ends
 * it, whichever way the dispute went. It finds the subscription through the order's lines, so it
 * covers the sign-up charge as well as a renewal.
 */
export async function recordChargeback(
  db: Db,
  rawDb: D1Database,
  graphql: Graphql,
  orderGid: string,
  now = new Date(),
) {
  const { order } = await graphql(ORDER_CONTRACTS, { id: orderGid });
  const contracts: string[] = [
    ...new Set<string>(
      (order?.lineItems.nodes as { contract: { id: string } | null }[] | undefined)?.flatMap(
        ({ contract }) => contract?.id ?? [],
      ) ?? [],
    ),
  ];
  const subscriptions = contracts.length
    ? await db.subscription.findMany({
        where: { contractGid: { in: contracts } },
        select: { id: true, shopId: true },
      })
    : [];
  const stamp = now.toISOString();
  for (const { id, shopId } of subscriptions) {
    await rawDb.batch([
      rawDb
        .prepare(
          `UPDATE "Delivery" SET "status" = 'HELD', "updatedAt" = ?2
           WHERE "subscriptionId" = ?1 AND "status" = 'PENDING'`,
        )
        .bind(id, stamp),
      rawDb
        .prepare(
          `UPDATE "BillingAttempt" SET "nextRetryAt" = NULL, "updatedAt" = ?2
           WHERE "subscriptionId" = ?1 AND "nextRetryAt" IS NOT NULL`,
        )
        .bind(id, stamp),
      rawDb
        .prepare(
          `UPDATE "Subscription" SET "pausedReason" = '${CHARGEBACK}',
             "paymentProblemSince" = COALESCE("paymentProblemSince", ?2),
             "status" = CASE WHEN "status" = 'ACTIVE' THEN 'PAUSED' ELSE "status" END,
             "updatedAt" = ?2
           WHERE "id" = ?1 AND "status" <> 'ENDED'`,
        )
        .bind(id, stamp),
      eventStatement(rawDb, `${id}:${orderGid}`, "billing.chargeback", shopId, id, { orderGid }),
    ]);
    logEvent("warn", "billing.chargeback", { subscriptionId: id, orderGid });
  }
  if (subscriptions.length === 0) logEvent("info", "billing.chargeback_ignored", { orderGid });
}

export const settleJob = (shop: string, attemptGid: string, webhookId: string): Job => ({
  type: BILLING_SETTLE_JOB,
  id: `${BILLING_SETTLE_JOB}:${attemptGid}:${webhookId}`,
  shop,
  data: { attemptGid },
});

/** `key` makes each press its own job. `byMerchant` is what lets it end a chargeback. */
export const resumeJob = (
  shop: string,
  subscriptionId: string,
  key: string,
  byMerchant = false,
): Job => ({
  type: BILLING_RESUME_JOB,
  id: `${BILLING_RESUME_JOB}:${subscriptionId}:${key}`,
  shop,
  data: { subscriptionId, byMerchant },
});

export const disputeJob = (shop: string, orderGid: string, webhookId: string): Job => ({
  type: DISPUTE_JOB,
  id: `${DISPUTE_JOB}:${orderGid}:${webhookId}`,
  shop,
  data: { orderGid },
});

const INSTALLED = `JOIN "Shop" sh ON sh."id" = s."shopId"
  JOIN "OfflineSession" o ON o."id" = 'offline_' || sh."shopDomain"`;

/**
 * Bundles whose renewal is due. The job checks again with `renewalDue`, as things may have moved.
 * Job IDs have the hour in them, as a run's do, so one that went DEAD never blocks the next hour's.
 */
export const findRenewals: DueWorkFinder = async ({ env, now }) => {
  const { results } = await env.DB.prepare(
    `SELECT s."id", sh."shopDomain" FROM "Subscription" s
     JOIN "Plan" p ON p."id" = s."planId"
     ${INSTALLED}
     WHERE s."status" = 'ACTIVE' AND s."source" <> 'GIFT' AND s."contractGid" IS NOT NULL
       AND s."paymentProblemSince" IS NULL AND s."termEndsAt" IS NOT NULL
       AND p."billingMode" = 'PREPAID_BUNDLE' AND p."autoRenew" = 1
       AND ((p."renewalRule" = 'TERM_DATE' AND s."termEndsAt" <= ?1)
         OR (p."renewalRule" = 'TERM_DATE_HOLD_IF_LATE' AND s."termEndsAt" <= ?1 AND s."releasesRemaining" <= 0)
         OR (p."renewalRule" = 'ON_DEPLETION' AND s."releasesRemaining" <= 0))`,
  )
    .bind(now.toISOString())
    .all<{ id: string; shopDomain: string }>();
  const hour = now.toISOString().slice(0, 13);
  return results.map(({ id, shopDomain }) => ({
    type: BILLING_RENEW_JOB,
    id: `${BILLING_RENEW_JOB}:${id}:${hour}`,
    shop: shopDomain,
    data: { subscriptionId: id },
  }));
};

/** Failed charges whose next try has come round. */
export const findRetries: DueWorkFinder = async ({ env, now }) => {
  const { results } = await env.DB.prepare(
    `SELECT b."id", sh."shopDomain" FROM "BillingAttempt" b
     JOIN "Subscription" s ON s."id" = b."subscriptionId"
     ${INSTALLED}
     WHERE b."nextRetryAt" <= ?1 AND b."result" = 'FAILED' AND s."status" = 'ACTIVE'`,
  )
    .bind(now.toISOString())
    .all<{ id: string; shopDomain: string }>();
  const hour = now.toISOString().slice(0, 13);
  return results.map(({ id, shopDomain }) => ({
    type: BILLING_RETRY_JOB,
    id: `${BILLING_RETRY_JOB}:${id}:${hour}`,
    shop: shopDomain,
    data: { attemptId: id },
  }));
};

/** Attempts with no result, because a webhook was lost or a crash came around the billing call. */
export const findLostResults: DueWorkFinder = async ({ env, now }) => {
  const { results } = await env.DB.prepare(
    `SELECT b."id", sh."shopDomain" FROM "BillingAttempt" b
     JOIN "Subscription" s ON s."id" = b."subscriptionId"
     ${INSTALLED}
     WHERE b."result" = 'PENDING' AND b."createdAt" <= ?1`,
  )
    .bind(new Date(now.getTime() - LOST_RESULT_AFTER_MS).toISOString())
    .all<{ id: string; shopDomain: string }>();
  const hour = now.toISOString().slice(0, 13);
  return results.map(({ id, shopDomain }) => ({
    type: BILLING_RECOVER_JOB,
    id: `${BILLING_RECOVER_JOB}:${id}:${hour}`,
    shop: shopDomain,
    data: { attemptId: id },
  }));
};

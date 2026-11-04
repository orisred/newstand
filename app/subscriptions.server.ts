import type { createDb } from "./db.server";
import type {
  OrderTiming,
  ReleaseStatus,
  StartRule,
} from "./generated/prisma/enums";
import type { Job } from "./jobs/runner.server";
import { logEvent } from "./logger.server";
import {
  CANCELLED_EVENT,
  emailRunJob,
  memberTagJob,
  STARTED_EVENT,
} from "./notification-jobs";
import type { Graphql } from "./plan-sync.server";

type Db = ReturnType<typeof createDb>;

export const CONTRACT_JOB = "contract.sync";
export const RECONCILE_JOB = "contracts.reconcile";
export const DELIVERY_ORDER_JOB = "delivery.order";
export const PAYMENT_ORDER_JOB = "payment_order.fulfill";
export const RELEASE_RUN_JOB = "release.run";
export const RELEASE_FIRE_JOB = "release.fire";

/**
 * A closed contract. Paid releases still ship, and a chargeback stays flagged, but nothing is
 * charged again, so what's held or waiting for a payment is closed too. Safe to repeat.
 */
export async function markCancelled(
  rawDb: D1Database,
  subscriptionId: string,
  now: Date,
) {
  const stamp = now.toISOString();
  await rawDb.batch([
    // For Flow, once: the ID is the subscription's, and it's only written by the call that closes it.
    rawDb
      .prepare(
        `INSERT INTO "Event" ("id", "shopId", "subscriptionId", "type", "payload")
         SELECT ?2 || ':' || "id", "shopId", "id", ?2, '{}' FROM "Subscription"
         WHERE "id" = ?1 AND "status" NOT IN ('CANCELLED', 'ENDED')
         ON CONFLICT DO NOTHING`,
      )
      .bind(subscriptionId, CANCELLED_EVENT),
    rawDb
      .prepare(
        `UPDATE "Delivery" SET "status" = 'CANCELLED', "updatedAt" = ?2
         WHERE "subscriptionId" = ?1 AND ("status" = 'HELD' OR ("status" = 'PENDING' AND EXISTS (
           SELECT 1 FROM "Subscription" WHERE "id" = ?1 AND "releasesRemaining" <= 0)))`,
      )
      .bind(subscriptionId, stamp),
    rawDb
      .prepare(
        `UPDATE "BillingAttempt" SET "nextRetryAt" = NULL, "updatedAt" = ?2
         WHERE "subscriptionId" = ?1 AND "nextRetryAt" IS NOT NULL`,
      )
      .bind(subscriptionId, stamp),
    rawDb
      .prepare(
        `UPDATE "Subscription" SET "status" = 'CANCELLED',
           "pausedReason" = CASE WHEN "pausedReason" = 'CHARGEBACK' THEN "pausedReason" END,
           "paymentProblemSince" = CASE WHEN "pausedReason" = 'CHARGEBACK' THEN "paymentProblemSince" END,
           "updatedAt" = ?2
         WHERE "id" = ?1 AND "status" <> 'ENDED'`,
      )
      .bind(subscriptionId, stamp),
  ]);
}

/** Flags a paid contract holding several plans. Becomes `MIXED_HANDLED` when the merchant has dealt with it. */
export const MIXED_PLANS_EVENT = "contract.mixed_plans";
export const MIXED_HANDLED_EVENT = "contract.mixed_plans.handled";

type ReleaseStep = {
  id: string;
  number: number;
  status: ReleaseStatus;
  preorderOpensAt: Date | null;
  cutoffAt: Date | null;
};

/**
 * Whether a release's orders are due, under the shop's order timing. A subscriber assigned
 * to a release at this step gets their order straight away. The run uses it too.
 */
export function orderStepReached(status: ReleaseStatus, timing: OrderTiming) {
  if (status === "READY" || status === "SHIPPED") return true;
  return status === "PREORDER" && timing === "PREORDER_OPENS";
}

// Status says whether a step has happened, because a scheduled release has dates before it
// has happened. The date only says whether it had happened by a time in the past, so a
// webhook handled late gets the same answer. A release with no date is treated as early.
function openedBy(release: ReleaseStep, at: Date) {
  return (
    (release.status === "PREORDER" ||
      release.status === "READY" ||
      release.status === "SHIPPED") &&
    (!release.preorderOpensAt || release.preorderOpensAt <= at)
  );
}

function pastCutoffBy(release: ReleaseStep, at: Date) {
  return (
    (release.status === "READY" || release.status === "SHIPPED") &&
    (!release.cutoffAt || release.cutoffAt <= at)
  );
}

/**
 * Which release a new subscriber gets first. Evaluated at the sign-up time, not when the
 * webhook is handled. Cancelled releases never count. "Current" is the latest release whose
 * pre-order had opened at sign-up.
 * - PREORDER_SWITCHOVER: the current release, whatever its status.
 * - CURRENT_IF_BEFORE_CUTOFF: the current release if it wasn't yet ready to ship at sign-up;
 *   otherwise the next.
 * - NEXT: always the next, the first one whose pre-order opens after sign-up.
 *
 * With no current release, or when waiting for the next, `release` is null until one has
 * opened: the subscriber has no Delivery, and `firstReleaseNumber` says which run they join.
 */
export function pickFirstRelease<T extends ReleaseStep>(
  rule: StartRule,
  releases: T[],
  signedUpAt: Date,
): { release: T | null; firstReleaseNumber: number } {
  const live = releases
    .filter((release) => release.status !== "CANCELLED")
    .sort((a, b) => a.number - b.number);
  const current = live.filter((release) => openedBy(release, signedUpAt)).at(-1);

  if (
    current &&
    (rule === "PREORDER_SWITCHOVER" ||
      (rule === "CURRENT_IF_BEFORE_CUTOFF" &&
        !pastCutoffBy(current, signedUpAt)))
  ) {
    return { release: current, firstReleaseNumber: current.number };
  }

  // Only a job handled late can find a later release already open.
  const after = current?.number ?? 0;
  const next = live.find(
    (release) => release.number > after && release.status !== "UNANNOUNCED",
  );
  return next
    ? { release: next, firstReleaseNumber: next.number }
    : { release: null, firstReleaseNumber: after + 1 };
}

/** Calendar months, keeping the day where it exists: Jan 31 plus one month is the end of February. */
export function addMonths(date: Date, months: number) {
  const result = new Date(date);
  result.setUTCMonth(result.getUTCMonth() + months);
  if (result.getUTCDate() !== date.getUTCDate()) result.setUTCDate(0);
  return result;
}

const CONTRACT = `#graphql
  query ContractForSync($id: ID!) {
    subscriptionContract(id: $id) {
      id
      status
      createdAt
      customer { id }
      originOrder { id name }
      lines(first: 50) { nodes { quantity sellingPlanId currentPrice { amount } } }
    }
  }`;

const CONTRACT_PAGE = `#graphql
  query ContractsForReconcile($after: String) {
    subscriptionContracts(first: 50, after: $after, reverse: true, sortKey: CREATED_AT) {
      nodes { id revisionId }
      pageInfo { hasNextPage endCursor }
    }
  }`;

/** The contract's status, in this app's terms. Null leaves the subscription as it is. */
function statusFor(
  contractStatus: string,
  current: string | null,
): "ACTIVE" | "CANCELLED" | null {
  // Billing owns pausing, and an ended or redacted subscription stays that way.
  if (current === "ENDED") return null;
  if (contractStatus === "CANCELLED" || contractStatus === "EXPIRED") {
    return current === "CANCELLED" ? null : "CANCELLED";
  }
  if (contractStatus === "ACTIVE") {
    return current === null || current === "CANCELLED" ? "ACTIVE" : null;
  }
  return current === null ? "ACTIVE" : null;
}

export function contractJob(shop: string, contractGid: string, revision: string): Job {
  return {
    type: CONTRACT_JOB,
    id: `${CONTRACT_JOB}:${contractGid}:${revision}`,
    shop,
    data: { contractGid },
  };
}

/** `attempt` is part of the ID: a new one runs again a job that found no product or was refused. */
export function deliveryOrderJob(shop: string, deliveryId: string, attempt: string): Job {
  return {
    type: DELIVERY_ORDER_JOB,
    id: `${DELIVERY_ORDER_JOB}:${deliveryId}:${attempt}`,
    shop,
    data: { deliveryId },
  };
}

/**
 * One slice of a release's run. `key` makes it a new job, because a run is state-driven: a
 * slice that died never blocks the next one. `progress` is where the slice before it stopped.
 */
export function releaseRunJob(
  shop: string,
  releaseId: string,
  key: string,
  progress: Record<string, string | number> = {},
): Job {
  return {
    type: RELEASE_RUN_JOB,
    id: `${RELEASE_RUN_JOB}:${releaseId}:${key}`,
    shop,
    data: { ...progress, releaseId },
  };
}

export function paymentOrderJob(shop: string, orderGid: string): Job {
  return {
    type: PAYMENT_ORDER_JOB,
    id: `${PAYMENT_ORDER_JOB}:${orderGid}`,
    shop,
    data: { orderGid },
  };
}

/**
 * Brings the app in line with one contract, read fresh from Shopify, so webhooks arriving
 * twice or out of order all end the same way. Returns the jobs to enqueue next: they're
 * enqueued after this commits, and a retry enqueues them again under the same IDs.
 *
 * The Subscription and its first Delivery are written in one batch, and the release is
 * chosen only by the batch that inserts the Subscription.
 *
 * Whether the first order is due is read after that write. Step 8 flips a release's status
 * and then lists its subscribers, so one of the two always sees the other: if this read
 * misses the flip, the run sees this Delivery. If both act, the Delivery's order is still
 * created once.
 */
export async function syncContract(
  db: Db,
  rawDb: D1Database,
  graphql: Graphql,
  shop: { id: string; shopDomain: string; orderTiming: OrderTiming },
  contractGid: string,
  now = new Date(),
): Promise<Job[]> {
  const { subscriptionContract: contract } = await graphql(CONTRACT, {
    id: contractGid,
  });
  if (!contract) {
    logEvent("info", "contract.ignored", { contractGid, reason: "not_found" });
    return [];
  }
  const lines = contract.lines.nodes as {
    quantity: number;
    sellingPlanId: string | null;
    currentPrice: { amount: string };
  }[];
  const planIds = [
    ...new Set(lines.flatMap((line) => line.sellingPlanId ?? [])),
  ];
  // A turned-off plan still counts: the customer has paid, so they get what they bought.
  const plans = planIds.length
    ? await db.plan.findMany({
        where: { shopId: shop.id, sellingPlanGid: { in: planIds } },
        select: {
          id: true,
          sellingPlanGid: true,
          billingMode: true,
          releasesPerTerm: true,
          termMonths: true,
          startRule: true,
        },
      })
    : [];
  if (plans.length === 0) {
    logEvent("info", "contract.ignored", { contractGid, reason: "no_plan" });
    return [];
  }
  if (plans.length > 1) {
    // A billing attempt charges a whole contract, so these can't be charged separately. No
    // subscription, and the order stays unfulfilled so the merchant sees it.
    await rawDb
      .prepare(
        `INSERT INTO "Event" ("id", "shopId", "type", "payload")
         VALUES (?1, ?2, ?3, ?4) ON CONFLICT ("id") DO NOTHING`,
      )
      .bind(
        `${MIXED_PLANS_EVENT}:${contractGid}`,
        shop.id,
        MIXED_PLANS_EVENT,
        JSON.stringify({
          contractGid,
          orderGid: contract.originOrder?.id ?? null,
          orderName: contract.originOrder?.name ?? null,
          planIds: plans.map((plan) => plan.id),
        }),
      )
      .run();
    logEvent("error", "contract.mixed_plans", {
      contractGid,
      plans: plans.length,
    });
    return [];
  }
  const [plan] = plans;

  let subscription = await db.subscription.findUnique({
    where: { contractGid },
    select: { id: true, status: true },
  });

  if (!subscription) {
    const signedUpAt = new Date(contract.createdAt);
    const releases = await db.release.findMany({
      where: { shopId: shop.id },
      select: {
        id: true,
        number: true,
        status: true,
        preorderOpensAt: true,
        cutoffAt: true,
      },
    });
    const { release, firstReleaseNumber } = pickFirstRelease(
      plan.startRule,
      releases,
      signedUpAt,
    );
    const planLines = lines.filter(
      (line) => line.sellingPlanId === plan.sellingPlanGid,
    );
    const stamp = now.toISOString();
    const id = crypto.randomUUID();
    await rawDb.batch([
      rawDb
        .prepare(
          `INSERT INTO "Subscription" ("id", "shopId", "planId", "contractGid", "customerGid", "status",
             "source", "quantity", "releasesRemaining", "firstReleaseNumber", "termEndsAt",
             "lockedPriceCents", "createdAt", "updatedAt")
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'NEW', ?7, ?8, ?9, ?10, ?11, ?12, ?12)
           ON CONFLICT ("contractGid") DO NOTHING`,
        )
        .bind(
          id,
          shop.id,
          plan.id,
          contractGid,
          contract.customer.id,
          statusFor(contract.status, null),
          planLines.reduce((total, line) => total + line.quantity, 0),
          plan.billingMode === "PER_RELEASE" ? 1 : plan.releasesPerTerm,
          firstReleaseNumber,
          plan.billingMode === "PREPAID_BUNDLE" && plan.termMonths
            ? addMonths(signedUpAt, plan.termMonths).toISOString()
            : null,
          Math.round(Number(planLines[0].currentPrice.amount) * 100),
          stamp,
        ),
      // For Flow. The ID is the contract's, so a lost race or a repeat adds nothing.
      rawDb
        .prepare(
          `INSERT INTO "Event" ("id", "shopId", "subscriptionId", "type", "payload")
           SELECT ?1, "shopId", "id", ?2, '{}' FROM "Subscription" WHERE "contractGid" = ?3
           ON CONFLICT DO NOTHING`,
        )
        .bind(`${STARTED_EVENT}:${contractGid}`, STARTED_EVENT, contractGid),
      // Only if the insert above won, so a lost race can't add a second first release.
      ...(release
        ? [
            rawDb
              .prepare(
                `INSERT INTO "Delivery" ("id", "subscriptionId", "releaseId", "updatedAt")
                 SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM "Subscription" WHERE "id" = ?2)
                 ON CONFLICT DO NOTHING`,
              )
              .bind(crypto.randomUUID(), id, release.id, stamp),
          ]
        : []),
    ]);
    subscription = await db.subscription.findUniqueOrThrow({
      where: { contractGid },
      select: { id: true, status: true },
    });
  } else {
    const status = statusFor(contract.status, subscription.status);
    if (status === "CANCELLED") {
      await markCancelled(rawDb, subscription.id, now);
    } else if (status) {
      await db.subscription.updateMany({
        where: { id: subscription.id, status: subscription.status },
        data: { status },
      });
    }
  }

  const pending = await db.delivery.findMany({
    where: { subscriptionId: subscription.id, status: "PENDING" },
    select: { id: true, release: { select: { status: true } } },
  });
  return [
    // The welcome email and the member tag needn't wait for the tick. Both read state, so they're repeatable.
    emailRunJob(shop.shopDomain, `signup:${contractGid}`),
    memberTagJob(shop.shopDomain, `signup:${contractGid}`),
    ...(contract.originOrder
      ? [paymentOrderJob(shop.shopDomain, contract.originOrder.id)]
      : []),
    ...pending
      .filter(({ release }) =>
        orderStepReached(release.status, shop.orderTiming),
      )
      .map(({ id }) => deliveryOrderJob(shop.shopDomain, id, "first")),
  ];
}

const MAX_RECONCILE_PAGES = 20;

/**
 * Finds contracts with no Subscription, for webhooks that never came: Shopify stops retrying
 * after a few hours, and a contract lost that way is a customer who paid and gets nothing.
 * Newest first, stopping at a page holding a known contract, so normally one read an hour.
 */
export async function findMissedContracts(db: Db, graphql: Graphql, shop: string) {
  const jobs: Job[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_RECONCILE_PAGES; page++) {
    const { subscriptionContracts: result } = await graphql(CONTRACT_PAGE, {
      after,
    });
    const nodes = result.nodes as { id: string; revisionId: string }[];
    const known = await db.subscription.findMany({
      where: { contractGid: { in: nodes.map((node) => node.id) } },
      select: { contractGid: true },
    });
    const knownIds = new Set(known.map((row) => row.contractGid));
    jobs.push(
      ...nodes
        .filter((node) => !knownIds.has(node.id))
        .map((node) => contractJob(shop, node.id, node.revisionId)),
    );
    if (knownIds.size > 0 || !result.pageInfo.hasNextPage) break;
    after = result.pageInfo.endCursor;
  }
  return jobs;
}

import { chargeRelease, renewIfDue } from "./billing.server";
import type { createDb } from "./db.server";
import type { DueWorkFinder, Job } from "./jobs/runner.server";
import { describeError, logEvent } from "./logger.server";
import type { Graphql } from "./plan-sync.server";
import {
  createDeliveryOrder,
  OrderBusy,
  OrderThrottled,
} from "./release-orders.server";
import {
  orderStepReached,
  RELEASE_FIRE_JOB,
  releaseRunJob,
} from "./subscriptions.server";

type Db = ReturnType<typeof createDb>;

// A slice's size bounds a queue message's work and subrequests, not the run's speed.
const ORDERS_PER_SLICE = 20;
// As long as a consumer can run, so the lease never lapses under a live slice.
const SLICE_LEASE_MS = 15 * 60 * 1000;
// A sleeping slice's message may arrive a moment early and must still get the lease.
const WAKE_SLACK_MS = 5000;
// Shopify gives no retry time, and limits differ by store, so this learns nothing about the
// limit: it waits, tries, and only backs off further if that try created nothing.
const THROTTLE_WAIT_SECONDS = 60;
const MAX_THROTTLE_WAIT_SECONDS = 900;
// What's left after a full pass is busy or failed. Longer than an order's 5-minute lease.
const PASS_WAIT_SECONDS = 360;
// Charges just sent answer in seconds, by webhook, and that webhook starts a slice of its own.
const CHARGE_WAIT_SECONDS = 30;
const MAX_PASSES = 3;

/**
 * Who a release is due to. Everything a run assigns goes through this.
 *
 * `releasesRemaining` counts paid releases with no order yet, and each PENDING Delivery has
 * a claim on one of them. So a subscriber normally joins a run only with a paid release left
 * over: `PAID_LEFT`, which spends what's paid for whatever the status, PAUSED and CANCELLED too.
 *
 * `CHARGE_DUE` is the other way in: a pay-per-release subscriber at 0, charged by the run. One
 * PENDING at a time, so a charge is only ever spent on the release it was for.
 *
 * While a payment is failing, a bundle's release is HELD and ships late once paid. A pay-per-release
 * subscriber gets nothing: what comes out meanwhile is skipped for good (decided by N, 2026-11-04).
 * A chargeback holds releases even if paid. Whatever else is at 0 sits this one out, and moving
 * `firstReleaseNumber` past it, at a renewal or when a payment problem ends, is what keeps it out
 * however long it stays open.
 */
const PAID_LEFT = `s."releasesRemaining" > (
    SELECT COUNT(*) FROM "Delivery" d
    WHERE d."subscriptionId" = s."id" AND d."status" = 'PENDING'
  )`;
const CHARGE_DUE = `p."billingMode" = 'PER_RELEASE' AND p."autoRenew" = 1
  AND s."status" = 'ACTIVE' AND s."source" <> 'GIFT'
  AND s."paymentProblemSince" IS NULL AND s."releasesRemaining" = 0
  AND NOT EXISTS (
    SELECT 1 FROM "Delivery" d
    WHERE d."subscriptionId" = s."id" AND d."status" = 'PENDING'
  )`;
const CHARGEBACK_HOLD = `COALESCE(s."pausedReason", '') = 'CHARGEBACK'`;
const SHIPPABLE = `NOT ${CHARGEBACK_HOLD} AND ((${PAID_LEFT}) OR (${CHARGE_DUE}))`;
const DUE_SUBSCRIPTION = `s."status" <> 'ENDED'
  AND s."contractGid" IS NOT NULL
  AND s."firstReleaseNumber" <= r."number"
  AND ((${SHIPPABLE})
    OR ${CHARGEBACK_HOLD}
    OR (p."billingMode" = 'PREPAID_BUNDLE' AND s."paymentProblemSince" IS NOT NULL
      AND s."status" IN ('ACTIVE', 'PAUSED')))`;

/**
 * Gives every due subscriber a Delivery on this release. One statement, so it's atomic and
 * needs no read first, and safe to repeat. It reads the status itself, so nothing is assigned
 * before the step is reached, which is the order the sign-up path relies on (`syncContract`).
 */
export async function createDueDeliveries(
  rawDb: D1Database,
  shopId: string,
  releaseId: string,
  now = new Date(),
) {
  const { meta } = await rawDb
    .prepare(
      `INSERT INTO "Delivery" ("id", "subscriptionId", "releaseId", "status", "updatedAt")
       SELECT lower(hex(randomblob(16))), s."id", r."id",
         CASE WHEN ${SHIPPABLE} THEN 'PENDING' ELSE 'HELD' END, ?3
       FROM "Release" r
       JOIN "Shop" sh ON sh."id" = r."shopId"
       JOIN "Subscription" s ON s."shopId" = r."shopId"
       JOIN "Plan" p ON p."id" = s."planId"
       WHERE r."id" = ?1 AND r."shopId" = ?2
         AND (r."status" = 'READY'
           OR (r."status" = 'PREORDER' AND sh."orderTiming" = 'PREORDER_OPENS'))
         AND ${DUE_SUBSCRIPTION}
       ON CONFLICT DO NOTHING`,
    )
    .bind(releaseId, shopId, now.toISOString())
    .run();
  return meta.changes;
}

/**
 * One slice of a run, which is a chain of these rather than a job per order.
 *
 * Being limited by Shopify isn't a failure: the slice finishes and returns the next one, set
 * to arrive later, so the queue's retries are never spent on it. Nothing depends on the chain
 * surviving: `findReleaseRuns` starts a new one every hour, whichever way the last one ended.
 * Every step reads what's still PENDING, so a repeat does nothing.
 *
 * Returns the next slice to enqueue, if any. The lease keeps it to one chain per release.
 */
export async function runReleaseSlice(
  db: Db,
  rawDb: D1Database,
  graphqlFor: () => Promise<Graphql>,
  job: Job,
  clock: () => Date = () => new Date(),
): Promise<{ job: Job; delaySeconds: number } | null> {
  const releaseId = String(job.data?.releaseId);
  const release = await db.release.findUnique({
    where: { id: releaseId },
    select: {
      shopId: true,
      status: true,
      productGid: true,
      shop: { select: { shopDomain: true, orderTiming: true } },
    },
  });
  if (!release || !orderStepReached(release.status, release.shop.orderTiming)) {
    return null;
  }

  const started = clock();
  const { count } = await db.release.updateMany({
    where: {
      id: releaseId,
      OR: [{ runLeaseUntil: null }, { runLeaseUntil: { lte: started } }],
    },
    data: { runLeaseUntil: new Date(started.getTime() + SLICE_LEASE_MS) },
  });
  if (count === 0) {
    logEvent("info", "release_run.chain_busy", { releaseId, jobId: job.id });
    return null;
  }

  const settle = async (delaySeconds = 0) => {
    await db.release.updateMany({
      where: { id: releaseId },
      data: {
        runLeaseUntil: delaySeconds
          ? new Date(clock().getTime() + delaySeconds * 1000 - WAKE_SLACK_MS)
          : null,
      },
    });
  };
  const next = async (
    delaySeconds: number,
    progress: Record<string, string | number>,
  ) => {
    await settle(delaySeconds);
    return {
      delaySeconds,
      job: releaseRunJob(
        release.shop.shopDomain,
        releaseId,
        crypto.randomUUID(),
        progress,
      ),
    };
  };

  try {
    // A shipped release is closed, so it only finishes what it already holds.
    const assigned =
      release.status === "SHIPPED"
        ? 0
        : await createDueDeliveries(rawDb, release.shopId, releaseId, started);
    if (!release.productGid) {
      logEvent("info", "release_run.no_product", { releaseId, assigned });
      await settle();
      return null;
    }

    const passes = Number(job.data?.passes ?? 0);
    const throttles = Number(job.data?.throttles ?? 0);
    let after = String(job.data?.after ?? "");
    // Refused orders stay out until the merchant chooses a product again.
    const runnable = {
      releaseId,
      status: "PENDING",
      orderError: null,
      subscription: {
        status: { not: "ENDED" },
        contractGid: { not: null },
        releasesRemaining: { gt: 0 },
      },
    } as const;
    const page = await db.delivery.findMany({
      where: { ...runnable, id: { gt: after } },
      orderBy: { id: "asc" },
      take: ORDERS_PER_SLICE,
      select: { id: true },
    });

    let created = 0;
    let missed = 0;
    const graphql = page.length ? await graphqlFor() : null;
    for (const { id } of page) {
      try {
        const result = await createDeliveryOrder(
          db,
          rawDb,
          graphql!,
          id,
          clock(),
        );
        if (result === "created" || result === "recovered") {
          created++;
          await renewAfterOrder(db, rawDb, graphql!, id, clock());
        }
      } catch (error) {
        if (error instanceof OrderThrottled) {
          // Only rounds that got nothing through count towards a longer wait.
          const rounds = created > 0 ? 1 : throttles + 1;
          const delay = Math.min(
            THROTTLE_WAIT_SECONDS * 2 ** (rounds - 1),
            MAX_THROTTLE_WAIT_SECONDS,
          );
          logEvent("info", "release_run.throttled", {
            releaseId,
            created,
            retryInSeconds: delay,
          });
          return await next(delay, { after, passes, throttles: rounds });
        }
        // One bad order mustn't hold up the rest. It's still PENDING, so a later pass retries it.
        missed++;
        if (!(error instanceof OrderBusy)) {
          logEvent("error", "release_run.order_failed", {
            releaseId,
            deliveryId: id,
            ...describeError(error),
          });
        }
      }
      after = id;
    }
    logEvent("info", "release_run.slice", {
      releaseId,
      assigned,
      created,
      missed,
    });

    if (page.length === ORDERS_PER_SLICE) {
      return await next(0, { after, passes });
    }
    // Charges follow the orders, and only as many as the run can order now, so a slow store never
    // has a charge waiting hours for its order. The webhook's slice makes the order.
    const paid = await db.delivery.count({ where: runnable });
    const charges = await chargeRelease(
      db,
      rawDb,
      graphqlFor,
      releaseId,
      ORDERS_PER_SLICE - paid,
      clock(),
    );
    const left = paid + charges.waiting;
    if (charges.sent > 0) {
      return await next(CHARGE_WAIT_SECONDS, { passes: 0 });
    }
    if (left > 0 && passes < MAX_PASSES) {
      return await next(charges.waiting > 0 ? CHARGE_WAIT_SECONDS : PASS_WAIT_SECONDS, {
        passes: passes + 1,
      });
    }
    if (left > 0)
      logEvent("warn", "release_run.left_for_tick", { releaseId, left });
    await settle();
    return null;
  } catch (error) {
    await settle().catch(() => {});
    throw error;
  }
}

/**
 * An order just took a bundle's last paid release, which is the moment a held renewal is charged.
 * A failure here is no failure of the order, and the tick finds the renewal anyway.
 */
export async function renewAfterOrder(
  db: Db,
  rawDb: D1Database,
  graphql: Graphql,
  deliveryId: string,
  now: Date,
) {
  const delivery = await db.delivery.findUnique({
    where: { id: deliveryId },
    select: { subscriptionId: true },
  });
  if (!delivery) return;
  await renewIfDue(db, rawDb, graphql, delivery.subscriptionId, now).catch((error) =>
    logEvent("error", "billing.renew_failed", {
      subscriptionId: delivery.subscriptionId,
      ...describeError(error),
    }),
  );
}

/**
 * What makes a run state-driven: every hour, each open release at its order step gets a slice,
 * whoever noticed it or didn't. That recovers a crash before the first enqueue, a lost message,
 * a chain that died, a late subscriber and a change of `orderTiming`. A slice finding nothing
 * to do is one small statement and one small read. A shipped release is closed, so it's only
 * included while it still has orders to make.
 */
export const findReleaseRuns: DueWorkFinder = async ({ env, now }) => {
  const { results } = await env.DB.prepare(
    `SELECT r."id", s."shopDomain" FROM "Release" r
     JOIN "Shop" s ON s."id" = r."shopId"
     JOIN "OfflineSession" o ON o."id" = 'offline_' || s."shopDomain"
     WHERE r."status" = 'READY'
       OR (r."status" = 'PREORDER' AND s."orderTiming" = 'PREORDER_OPENS')
       OR (r."status" = 'SHIPPED' AND r."productGid" IS NOT NULL AND EXISTS (
         SELECT 1 FROM "Delivery" d
         WHERE d."releaseId" = r."id" AND d."status" = 'PENDING' AND d."orderError" IS NULL))
     ORDER BY r."shopId", r."number"`,
  ).all<{ id: string; shopDomain: string }>();
  const hour = now.toISOString().slice(0, 13);
  return results.map(({ id, shopDomain }) =>
    releaseRunJob(shopDomain, id, hour),
  );
};

/** Scheduled releases with a step due. A manual release never fires from a date. */
export const findScheduledSteps: DueWorkFinder = async ({ env, now }) => {
  const { results } = await env.DB.prepare(
    `SELECT r."id", s."shopDomain" FROM "Release" r
     JOIN "Shop" s ON s."id" = r."shopId"
     JOIN "OfflineSession" o ON o."id" = 'offline_' || s."shopDomain"
     WHERE r."triggerMode" = 'SCHEDULED' AND (
       (r."status" = 'UNANNOUNCED' AND r."preorderOpensAt" <= ?1)
       OR (r."status" = 'PREORDER' AND r."cutoffAt" <= ?1))`,
  )
    .bind(now.toISOString())
    .all<{ id: string; shopDomain: string }>();
  const hour = now.toISOString().slice(0, 13);
  return results.map(({ id, shopDomain }) => ({
    type: RELEASE_FIRE_JOB,
    id: `${RELEASE_FIRE_JOB}:${id}:${hour}`,
    shop: shopDomain,
    data: { releaseId: id },
  }));
};

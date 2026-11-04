import type { createDb } from "./db.server";
import type { OrderTiming } from "./generated/prisma/enums";
import { enqueueJobs } from "./jobs/runner.server";
import { describeError, logEvent } from "./logger.server";
import {
  capitalize,
  RELEASE_ACTIONS,
  type ReleaseAction,
  type ReleaseStatus,
} from "./release-actions";
import { createDueDeliveries } from "./release-runs.server";
import { orderStepReached, releaseRunJob } from "./subscriptions.server";

type Db = ReturnType<typeof createDb>;

export const PAGE_SIZE = 25;

export const TITLE_MAX_LENGTH = 120;

export function parseTitle(raw: FormDataEntryValue | null) {
  const title = typeof raw === "string" ? raw.trim() : "";
  if (!title || title.length > TITLE_MAX_LENGTH || /\p{C}/u.test(title)) {
    return null;
  }
  return title;
}

/** Empty means no cap. Anything else must be a whole number from 1 to 1,000,000. */
export function parseQuantity(raw: FormDataEntryValue | null) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { quantity: null };
  const quantity = Number(text);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1_000_000) {
    return { error: true as const };
  }
  return { quantity };
}

/** The shop's releases, newest number first. One page, with the cursor for the next. */
export async function listReleases(db: Db, shopId: string, before?: number) {
  const rows = await db.release.findMany({
    where: { shopId, ...(before ? { number: { lt: before } } : {}) },
    orderBy: { number: "desc" },
    take: PAGE_SIZE + 1,
    select: {
      id: true,
      number: true,
      title: true,
      status: true,
      quantity: true,
      triggerMode: true,
      preorderOpensAt: true,
      cutoffAt: true,
      productGid: true,
      productTitle: true,
    },
  });
  const releases = rows.slice(0, PAGE_SIZE);
  return {
    releases,
    nextBefore:
      rows.length > PAGE_SIZE ? releases[releases.length - 1].number : null,
  };
}

/**
 * Creates the next release. `key` is the form's one-time token: it becomes part of the
 * ID, so a double-submitted form inserts once and the repeat reports `created: false`.
 * The number is the shop's highest plus one; if another create takes it first, retry.
 */
export async function createRelease(
  db: Db,
  shopId: string,
  input: { key: string; title: string; quantity: number | null },
) {
  const id = `${shopId}:${input.key}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const last = await db.release.findFirst({
      where: { shopId },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    try {
      await db.release.create({
        data: {
          id,
          shopId,
          number: (last?.number ?? 0) + 1,
          title: input.title,
          quantity: input.quantity,
        },
        select: { id: true },
      });
      return { created: true };
    } catch (error) {
      // A repeated key, or a number another request just took. Anything else is a bug.
      const taken = await db.release.findUnique({
        where: { id },
        select: { id: true },
      });
      if (taken) return { created: false };
      if (attempt === 2) throw error;
    }
  }
  throw new Error("unreachable");
}

/**
 * Each run's progress, for one page of releases, in one query. Nothing shows until a release's
 * order step is reached; before that a subscriber is simply assigned.
 */
export async function listRunProgress(
  db: Db,
  orderTiming: OrderTiming,
  releases: { id: string; status: ReleaseStatus }[],
) {
  const due = releases.filter(({ status }) =>
    orderStepReached(status, orderTiming),
  );
  if (due.length === 0) return {};
  const rows = await db.delivery.groupBy({
    by: ["releaseId", "status", "orderError"],
    where: {
      status: { in: ["PENDING", "ORDERED", "FULFILLED"] },
      releaseId: { in: due.map(({ id }) => id) },
    },
    _count: true,
  });
  const progress: Record<
    string,
    { ordered: number; waiting: number; refused: number; error: string | null }
  > = {};
  for (const row of rows) {
    const entry = (progress[row.releaseId] ??= {
      ordered: 0,
      waiting: 0,
      refused: 0,
      error: null,
    });
    if (row.status !== "PENDING") entry.ordered += row._count;
    else if (row.orderError) {
      entry.refused += row._count;
      entry.error ??= row.orderError;
    } else entry.waiting += row._count;
  }
  return progress;
}

const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;

/**
 * Sets the variant a release ships as, then runs the release, which picks up the orders that
 * were waiting for it. Picking the same variant again is how a merchant retries orders Shopify
 * refused, so their reasons are cleared here.
 */
export async function setReleaseProduct(
  db: Db,
  env: Pick<Env, "JOBS">,
  shop: { id: string; shopDomain: string; orderTiming: OrderTiming },
  releaseId: string,
  productGid: string,
  productTitle: string,
) {
  if (!VARIANT_GID.test(productGid)) return false;
  const { count } = await db.release.updateMany({
    where: { id: releaseId, shopId: shop.id },
    data: { productGid, productTitle: productTitle.slice(0, 255) },
  });
  if (count === 0) return false;
  const release = await db.release.findFirstOrThrow({
    where: { id: releaseId },
    select: { status: true },
  });
  if (!orderStepReached(release.status, shop.orderTiming)) return true;
  await db.delivery.updateMany({
    where: { releaseId, status: "PENDING", orderError: { not: null } },
    data: { orderError: null },
  });
  await enqueueJobs(env, [
    releaseRunJob(shop.shopDomain, releaseId, crypto.randomUUID()),
  ]);
  return true;
}

export type TransitionResult =
  { ok: true; message: string } | { ok: false; message: string };

const STATUS_LABEL: Record<ReleaseStatus, string> = {
  UNANNOUNCED: "unannounced",
  PREORDER: "in pre-order",
  READY: "ready to ship",
  SHIPPED: "shipped",
  CANCELLED: "cancelled",
};

/** A held lease means an order may exist that hasn't been stored yet, even after a crash. */
const NO_ORDERS = `NOT EXISTS (SELECT 1 FROM "Delivery" d WHERE d."releaseId" = ?1
  AND (d."orderGid" IS NOT NULL OR d."orderLeaseUntil" IS NOT NULL))`;

/**
 * Cancelling refuses a release with orders, which have used up paid releases, and takes its
 * PENDING Deliveries with it, in one batch, so those subscribers stay paid for the next release.
 * `createDeliveryOrder` only takes a lease on a PENDING Delivery, so a cancel racing a run has
 * one winner: if the lease came first this refuses, and if this came first the lease fails.
 */
async function cancelWithDeliveries(
  rawDb: D1Database,
  shopId: string,
  releaseId: string,
  now: Date,
) {
  const stamp = now.toISOString();
  const [flip] = await rawDb.batch([
    rawDb
      .prepare(
        `UPDATE "Release" SET "status" = 'CANCELLED', "updatedAt" = ?3
         WHERE "id" = ?1 AND "shopId" = ?2 AND "status" IN ('UNANNOUNCED', 'PREORDER')
           AND ${NO_ORDERS}`,
      )
      .bind(releaseId, shopId, stamp),
    rawDb
      .prepare(
        `UPDATE "Delivery" SET "status" = 'CANCELLED', "updatedAt" = ?3
         WHERE "releaseId" = ?1 AND "status" = 'PENDING' AND EXISTS (
           SELECT 1 FROM "Release" WHERE "id" = ?1 AND "shopId" = ?2 AND "status" = 'CANCELLED')`,
      )
      .bind(releaseId, shopId, stamp),
  ]);
  return flip.meta.changes;
}

/**
 * The one place a release changes status. It is a conditional update on the allowed
 * current statuses, so a double press or a stale tab changes nothing and gets a clear
 * message. It also stamps the dates, replacing any planned one: announcing sets
 * `preorderOpensAt`, ready to ship sets `cutoffAt`. So once a step has happened its date is
 * when it really happened, by button or by tick, however early or late that was, and a late
 * webhook gets the answer a prompt one got. Scoped to the shop.
 *
 * `scheduled` is for the tick: it fires only if the release is still scheduled and the date
 * still due, so a merchant's edit made while the job waited wins.
 */
export async function transitionRelease(
  db: Db,
  rawDb: D1Database,
  shopId: string,
  releaseId: string,
  action: ReleaseAction,
  word: string,
  now = new Date(),
  scheduled = false,
): Promise<TransitionResult> {
  const { from, to } = RELEASE_ACTIONS[action];
  const moved =
    action === "cancel"
      ? await cancelWithDeliveries(rawDb, shopId, releaseId, now)
      : (
          await db.release.updateMany({
            where: {
              id: releaseId,
              shopId,
              status: { in: [...from] },
              ...(scheduled
                ? {
                    triggerMode: "SCHEDULED" as const,
                    ...(action === "announce"
                      ? { preorderOpensAt: { lte: now } }
                      : { cutoffAt: { lte: now } }),
                  }
                : {}),
            },
            data: {
              status: to,
              ...(action === "announce" ? { preorderOpensAt: now } : {}),
              ...(action === "ready" ? { cutoffAt: now } : {}),
            },
          })
        ).count;
  if (moved === 1) {
    return {
      ok: true,
      message: `${capitalize(word)} is now ${STATUS_LABEL[to]}.`,
    };
  }

  const current = await db.release.findFirst({
    where: { id: releaseId, shopId },
    select: { status: true },
  });
  if (!current) return { ok: false, message: `That ${word} no longer exists.` };
  if (action === "cancel" && (from as readonly string[]).includes(current.status)) {
    return {
      ok: false,
      message: `Nothing changed: orders have been or are being created for this ${word}, so it can't be cancelled.`,
    };
  }
  return {
    ok: false,
    message:
      current.status === to
        ? `Nothing changed: this ${word} is already ${STATUS_LABEL[to]}.`
        : `Nothing changed: this ${word} is ${STATUS_LABEL[current.status]}, so it can't be moved there. Reload to see its latest status.`,
  };
}

type RunShop = {
  id: string;
  shopDomain: string;
  orderTiming: OrderTiming;
  releaseWordSingular: string;
};

/**
 * A step in a release's life, with what its run needs. The status flips first and the run lists
 * subscribers after it, which `syncContract` relies on. A crash after the flip is recovered by
 * the tick. Marking as shipped closes the release to new Deliveries, so anyone still due, say
 * after that crash, is assigned first.
 */
export async function moveRelease(
  db: Db,
  env: Pick<Env, "DB" | "JOBS">,
  shop: RunShop,
  releaseId: string,
  action: ReleaseAction,
  now = new Date(),
  scheduled = false,
) {
  if (action === "ship") {
    await createDueDeliveries(env.DB, shop.id, releaseId, now);
  }
  const result = await transitionRelease(
    db,
    env.DB,
    shop.id,
    releaseId,
    action,
    shop.releaseWordSingular,
    now,
    scheduled,
  );
  if (
    result.ok &&
    orderStepReached(RELEASE_ACTIONS[action].to, shop.orderTiming)
  ) {
    await enqueueJobs(env, [
      releaseRunJob(shop.shopDomain, releaseId, crypto.randomUUID()),
    ]).catch((error) =>
      // The status has moved, so the merchant's press worked. The tick starts the run.
      logEvent("error", "release_run.enqueue_failed", {
        releaseId,
        ...describeError(error),
      }),
    );
  }
  return result;
}

/** The tick's job: every step of a scheduled release that's due, in order. */
export async function fireScheduledRelease(
  db: Db,
  env: Pick<Env, "DB" | "JOBS">,
  shop: RunShop,
  releaseId: string,
  now = new Date(),
) {
  const release = await db.release.findFirst({
    where: { id: releaseId, shopId: shop.id, triggerMode: "SCHEDULED" },
    select: { status: true, preorderOpensAt: true, cutoffAt: true },
  });
  if (!release) return;
  let { status } = release;
  if (
    status === "UNANNOUNCED" &&
    release.preorderOpensAt &&
    release.preorderOpensAt <= now
  ) {
    const result = await moveRelease(db, env, shop, releaseId, "announce", now, true);
    if (result.ok) status = "PREORDER";
  }
  if (status === "PREORDER" && release.cutoffAt && release.cutoffAt <= now) {
    await moveRelease(db, env, shop, releaseId, "ready", now, true);
  }
}

export type ScheduleInput = {
  mode: "MANUAL" | "SCHEDULED";
  preorderOpensAt: Date | null;
  cutoffAt: Date | null;
};

const sameTime = (a: Date | null, b: Date | null) =>
  a?.getTime() === b?.getTime();

/**
 * Sets how a release moves on. A date is only a plan until its step happens, and then
 * `transitionRelease` replaces it, so a step that's happened can't be rescheduled. A date being
 * set must be in the future: to do it now, there's the button. A date left unchanged may have
 * passed while the tick hasn't come round yet, and the tick fires it, or both at once, in order.
 * Manual drops the plan, so no stale date is left on a step that hasn't happened.
 */
export async function scheduleRelease(
  db: Db,
  shopId: string,
  releaseId: string,
  word: string,
  input: ScheduleInput,
  now = new Date(),
): Promise<TransitionResult> {
  const release = await db.release.findFirst({
    where: { id: releaseId, shopId },
    select: { status: true, preorderOpensAt: true, cutoffAt: true },
  });
  if (!release) return { ok: false, message: `That ${word} no longer exists.` };
  const { status } = release;
  if (status !== "UNANNOUNCED" && status !== "PREORDER") {
    return {
      ok: false,
      message: `Nothing changed: this ${word} is ${STATUS_LABEL[status]}, so it has no steps left to schedule.`,
    };
  }
  const opened = status === "PREORDER";
  const preorderOpensAt = opened ? release.preorderOpensAt : input.preorderOpensAt;
  const { cutoffAt } = input;

  if (input.mode === "SCHEDULED") {
    const fail = (message: string) => ({ ok: false, message });
    if (!cutoffAt && (opened || !preorderOpensAt)) {
      return fail(
        opened
          ? `Choose the date this ${word} goes ready to ship.`
          : `Choose the date this ${word}'s pre-order opens.`,
      );
    }
    if (cutoffAt && !preorderOpensAt) {
      return fail("A ready to ship date needs a pre-order date before it.");
    }
    if (cutoffAt && preorderOpensAt && cutoffAt <= preorderOpensAt) {
      return fail("The ready to ship date must be after the pre-order date.");
    }
    const passed = (date: Date | null, stored: Date | null) =>
      date && date <= now && !sameTime(date, stored);
    if (
      (!opened && passed(preorderOpensAt, release.preorderOpensAt)) ||
      passed(cutoffAt, release.cutoffAt)
    ) {
      return fail(
        "That date has passed. Choose a later one, or use the button to do it now.",
      );
    }
  }

  // Only if no step has fired since the read above.
  const { count } = await db.release.updateMany({
    where: { id: releaseId, shopId, status },
    data:
      input.mode === "SCHEDULED"
        ? { triggerMode: "SCHEDULED", preorderOpensAt, cutoffAt }
        : {
            triggerMode: "MANUAL",
            cutoffAt: null,
            preorderOpensAt: opened ? release.preorderOpensAt : null,
          },
  });
  return count === 1
    ? {
        ok: true,
        message:
          input.mode === "SCHEDULED"
            ? `Dates saved for this ${word}.`
            : `This ${word} now moves on when you press its buttons.`,
      }
    : {
        ok: false,
        message: `Nothing changed: this ${word} just moved on. Reload to see its latest status.`,
      };
}

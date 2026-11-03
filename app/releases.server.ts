import type { createDb } from "./db.server";
import type { OrderTiming } from "./generated/prisma/enums";
import { enqueueJobs } from "./jobs/runner.server";
import {
  capitalize,
  RELEASE_ACTIONS,
  type ReleaseAction,
  type ReleaseStatus,
} from "./release-actions";
import { deliveryOrderJob, orderStepReached } from "./subscriptions.server";

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
 * Orders waiting on the merchant, for one page of releases. An order is only waiting once its
 * step has been reached; before that a subscriber is simply assigned.
 */
export async function listWaitingOrders(
  db: Db,
  orderTiming: OrderTiming,
  releases: { id: string; status: ReleaseStatus }[],
) {
  const due = releases.filter(({ status }) =>
    orderStepReached(status, orderTiming),
  );
  if (due.length === 0) return {};
  const rows = await db.delivery.groupBy({
    by: ["releaseId", "orderError"],
    where: { status: "PENDING", releaseId: { in: due.map(({ id }) => id) } },
    _count: true,
  });
  const waiting: Record<string, { count: number; error: string | null }> = {};
  for (const row of rows) {
    const entry = (waiting[row.releaseId] ??= { count: 0, error: null });
    entry.count += row._count;
    entry.error ??= row.orderError;
  }
  return waiting;
}

const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;

/**
 * Sets the variant a release ships as, then queues the orders that were waiting for it or that
 * Shopify refused. Picking the same variant again is how a merchant retries those. Each job
 * is safe to repeat, because `createDeliveryOrder` never creates a second order.
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
  const waiting = await db.delivery.findMany({
    where: { releaseId, status: "PENDING" },
    select: { id: true },
  });
  // A new try each time, or a repeat of a job that's already done would be skipped.
  const attempt = crypto.randomUUID();
  await enqueueJobs(
    env as Env,
    waiting.map(({ id }) =>
      deliveryOrderJob(shop.shopDomain, id, attempt),
    ),
  );
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

/**
 * The one place a release changes status. It is a conditional update on the allowed
 * current statuses, so a double press or a stale tab changes nothing and gets a clear
 * message. It also stamps the dates: announcing sets `preorderOpensAt`, ready to ship
 * sets `cutoffAt`. A release has neither until then. Scoped to the shop.
 */
export async function transitionRelease(
  db: Db,
  shopId: string,
  releaseId: string,
  action: ReleaseAction,
  word: string,
  now = new Date(),
): Promise<TransitionResult> {
  const { from, to } = RELEASE_ACTIONS[action];
  const { count } = await db.release.updateMany({
    where: { id: releaseId, shopId, status: { in: [...from] } },
    data: {
      status: to,
      ...(action === "announce" ? { preorderOpensAt: now } : {}),
      ...(action === "ready" ? { cutoffAt: now } : {}),
    },
  });
  if (count === 1) {
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
  return {
    ok: false,
    message:
      current.status === to
        ? `Nothing changed: this ${word} is already ${STATUS_LABEL[to]}.`
        : `Nothing changed: this ${word} is ${STATUS_LABEL[current.status]}, so it can't be moved there. Reload to see its latest status.`,
  };
}

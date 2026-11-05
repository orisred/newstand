import type { DueWorkFinder } from "./jobs/runner.server";
import { logEvent } from "./logger.server";

export const PRUNE_JOB = "maintenance.prune";

const DAY_MS = 24 * 60 * 60 * 1000;
// A queue keeps a message at most 14 days and Shopify retries a webhook for hours, so nothing older than
// this can still arrive as a repeat of what it recorded.
const KEEP_DAYS = 30;
// A dead job never ran to the end, and its row says which and holds the message, so it stays longer.
const KEEP_DEAD_DAYS = 90;
const PER_PASS = 1000;
const PASSES = 20;

/** Once a day. A missed day only means a slightly bigger next one. */
export const findPruneWork: DueWorkFinder = async ({ now }) =>
  now.getUTCHours() === 3
    ? [{ type: PRUNE_JOB, id: `${PRUNE_JOB}:${now.toISOString().slice(0, 10)}` }]
    : [];

async function inPasses(run: () => Promise<number>) {
  let total = 0;
  for (let pass = 0; pass < PASSES; pass++) {
    const removed = await run();
    total += removed;
    if (removed < PER_PASS) break;
  }
  return total;
}

/**
 * What's safe to delete, and why. See "Pruning" in docs/DECISIONS.md.
 *
 * `JobRun`: a row only stops a job with the same ID running again. Hourly jobs have the hour in their ID, and
 * the rest read state afresh, so even a repeat after pruning changes nothing. The exception is `contract.sync`,
 * kept whole: the hourly check enqueues every contract with no Subscription under its revision, and the row is
 * what stops one the merchant has dealt with (flagged, refunded) being read again and perhaps made a subscription.
 *
 * `ImportRow`: a row with a contract (`DONE`) stays, because each later dry run compares against it, and so do the
 * latest run's and any running one's. What's left is a report nobody can open any more.
 */
export async function pruneOldRows(rawDb: D1Database, now = new Date()) {
  const before = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
  const jobs = await inPasses(async () => {
    const { meta } = await rawDb
      .prepare(
        `DELETE FROM "JobRun" WHERE "key" IN (
           SELECT "key" FROM "JobRun" WHERE "type" <> 'contract.sync' AND (
             ("status" IN ('DONE', 'CLAIMED') AND "updatedAt" < ?1) OR ("status" = 'DEAD' AND "updatedAt" < ?2))
           LIMIT ${PER_PASS})`,
      )
      .bind(before(KEEP_DAYS), before(KEEP_DEAD_DAYS))
      .run();
    return meta.changes;
  });
  const rows = await inPasses(async () => {
    const { meta } = await rawDb
      .prepare(
        `DELETE FROM "ImportRow" WHERE "id" IN (
           SELECT i."id" FROM "ImportRow" i JOIN "ImportRun" r ON r."id" = i."runId"
           WHERE i."state" <> 'DONE' AND julianday(i."updatedAt") < julianday(?1)
             AND r."status" IN ('READ', 'DONE')
             AND EXISTS (SELECT 1 FROM "ImportRun" n WHERE n."shopId" = r."shopId" AND n."createdAt" > r."createdAt")
           LIMIT ${PER_PASS})`,
      )
      .bind(before(KEEP_DAYS))
      .run();
    return meta.changes;
  });
  const limits = await rawDb
    .prepare(`DELETE FROM "RateLimit" WHERE "windowEndsAt" < ?1`)
    .bind(now.toISOString())
    .run();
  logEvent("info", "prune.done", { jobs, rows, limits: limits.meta.changes });
}

/**
 * A job's effect is once-only because of the unique key in JobRun, not because of the
 * queue: Cloudflare Queues delivers at least once.
 *
 * A claim is a lease. It ends early when the job fails, and on its own after a crash, so
 * a retry can always run the job again. That means a job can run twice if it crashes
 * after its effect but before it's marked done, so anything outside D1 needs its own key
 * too: billing attempts send billingAttemptKey to Shopify.
 */

// Longer than a queue consumer can run (15 minutes), so a lease never lapses under a live job.
const LEASE_MS = 16 * 60 * 1000;

export type Claim =
  | { status: "claimed"; owner: string }
  | { status: "done" }
  | { status: "dead" }
  | { status: "busy"; retryInSeconds: number };

interface ClaimableJob {
  id: string;
  type: string;
  shop?: string;
}

/**
 * The key for one try at charging one subscription for one release. A redelivered job
 * must reuse it, so Shopify ignores the repeat. Only a new try, after a failed charge,
 * gets a new attempt number.
 */
export function billingAttemptKey(
  subscriptionId: string,
  chargeFor: string, // the release ID, or term-<ms> for a bundle renewal, which has no release
  attempt: number,
) {
  return `${subscriptionId}:${chargeFor}:${attempt}`;
}

export async function claimJob(db: D1Database, job: ClaimableJob): Promise<Claim> {
  const owner = crypto.randomUUID();
  const now = new Date();
  const claimed = await db
    .prepare(
      `INSERT INTO "JobRun" ("key", "type", "shop", "owner", "leaseExpiresAt", "updatedAt")
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT ("key") DO UPDATE SET
         "owner" = excluded."owner",
         "leaseExpiresAt" = excluded."leaseExpiresAt",
         "runs" = "runs" + 1,
         "updatedAt" = excluded."updatedAt"
       WHERE "status" = 'CLAIMED' AND "leaseExpiresAt" <= ?6
       RETURNING "key"`,
    )
    .bind(
      job.id,
      job.type,
      job.shop ?? null,
      owner,
      new Date(now.getTime() + LEASE_MS).toISOString(),
      now.toISOString(),
    )
    .first();
  if (claimed) return { status: "claimed", owner };

  const row = await db
    .prepare(`SELECT "status", "leaseExpiresAt" FROM "JobRun" WHERE "key" = ?1`)
    .bind(job.id)
    .first<{ status: string; leaseExpiresAt: string }>();
  if (row?.status === "DONE") return { status: "done" };
  if (row?.status === "DEAD") return { status: "dead" };
  const leaseEndsIn = row ? Date.parse(row.leaseExpiresAt) - now.getTime() : 0;
  return { status: "busy", retryInSeconds: Math.max(1, Math.ceil(leaseEndsIn / 1000)) };
}

/** Marks a job done. Run it in one `DB.batch` with the job's own writes, so both land or neither. */
export function completeJobStatement(db: D1Database, key: string, owner: string) {
  return db
    .prepare(
      `UPDATE "JobRun" SET "status" = 'DONE', "owner" = NULL, "leaseExpiresAt" = NULL,
         "lastError" = NULL, "updatedAt" = ?3
       WHERE "key" = ?1 AND "owner" = ?2 AND "status" = 'CLAIMED'`,
    )
    .bind(key, owner, new Date().toISOString());
}

/** Ends the lease of a job that failed, so its retry can claim it straight away. */
export async function releaseJob(
  db: D1Database,
  key: string,
  owner: string,
  lastError: string,
) {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE "JobRun" SET "leaseExpiresAt" = ?3, "lastError" = ?4, "updatedAt" = ?3
       WHERE "key" = ?1 AND "owner" = ?2 AND "status" = 'CLAIMED'`,
    )
    .bind(key, owner, now, lastError)
    .run();
}

/** Records a job that used up its retries. A job already done stays done. */
export async function markJobDead(
  db: D1Database,
  job: { key: string; type: string; shop?: string; body: string },
) {
  await db
    .prepare(
      `INSERT INTO "JobRun" ("key", "type", "shop", "status", "body", "updatedAt")
       VALUES (?1, ?2, ?3, 'DEAD', ?4, ?5)
       ON CONFLICT ("key") DO UPDATE SET
         "status" = 'DEAD', "owner" = NULL, "leaseExpiresAt" = NULL,
         "body" = excluded."body", "updatedAt" = excluded."updatedAt"
       WHERE "status" <> 'DONE'`,
    )
    .bind(job.key, job.type, job.shop ?? null, job.body, new Date().toISOString())
    .run();
}

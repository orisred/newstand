import { createDb } from "../db.server";
import { describeError, logEvent } from "../logger.server";
import {
  claimJob,
  completeJobStatement,
  markJobDead,
  releaseJob,
} from "./idempotency.server";

const SEND_BATCH_LIMIT = 100;
const MAX_RETRY_DELAY_SECONDS = 3600;

export interface Job {
  type: string;
  /** The idempotency key. Work with the same ID runs once, however often it's enqueued. */
  id: string;
  shop?: string;
  /** Row IDs only. Never tokens or customer data. */
  data?: Record<string, string | number | boolean>;
}

export interface JobContext {
  env: Env;
  /** Created per tick or batch. Never keep it at module scope. */
  db: ReturnType<typeof createDb>;
}

/**
 * Does one job. Statements it returns are committed in one batch with the job's done
 * mark. It may run again if a crash cuts it off, so outside effects need their own keys.
 */
export type JobHandler = (
  job: Job,
  context: JobContext,
) => Promise<D1PreparedStatement[] | void>;

/**
 * Finds work that's due, from what's in the database rather than from the time since
 * the last tick, so a missed tick catches up on the next one.
 */
export type DueWorkFinder = (
  context: JobContext & { now: Date },
) => Promise<Job[]>;

/** Enqueues jobs. For merchant actions as well as the tick. Safe to repeat for the same IDs. */
export async function enqueueJobs(
  env: Pick<Env, "JOBS">,
  jobs: Job[],
  delaySeconds?: number,
) {
  for (let i = 0; i < jobs.length; i += SEND_BATCH_LIMIT) {
    const messages = jobs
      .slice(i, i + SEND_BATCH_LIMIT)
      .map((body) => (delaySeconds ? { body, delaySeconds } : { body }));
    await env.JOBS.sendBatch(messages);
  }
}

/** The hourly tick: finds due work and enqueues it, and does none of it. */
export async function runTick(
  env: Env,
  controller: Pick<ScheduledController, "cron" | "scheduledTime">,
  finders: DueWorkFinder[],
) {
  const context = { env, db: createDb(env.DB), now: new Date(controller.scheduledTime) };
  let enqueued = 0;
  let failed = 0;
  for (const find of finders) {
    try {
      const jobs = await find(context);
      await enqueueJobs(env, jobs);
      enqueued += jobs.length;
    } catch (error) {
      failed++;
      logEvent("error", "tick.finder_failed", {
        finder: find.name,
        ...describeError(error),
      });
    }
  }
  logEvent(failed ? "error" : "info", "tick.done", {
    cron: controller.cron,
    enqueued,
    failed,
  });
}

/** Each message is settled on its own, so one bad job doesn't retry the rest of the batch. */
export async function consumeJobs(
  batch: MessageBatch<unknown>,
  env: Env,
  handlers: Record<string, JobHandler>,
) {
  const context = { env, db: createDb(env.DB) };
  for (const message of batch.messages) {
    await runMessage(message, context, handlers);
  }
}

async function runMessage(
  message: Message<unknown>,
  context: JobContext,
  handlers: Record<string, JobHandler>,
) {
  const body = message.body as Partial<Job> | null;
  const fields = {
    jobType: body?.type,
    jobId: body?.id,
    shop: body?.shop,
    messageId: message.id,
    attempt: message.attempts,
  };
  const handler = body?.type ? handlers[body.type] : undefined;
  if (!handler || !body?.id) {
    logEvent("error", "job.invalid", fields);
    message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    return;
  }
  const job = body as Job;

  const db = context.env.DB;
  let owner: string | undefined;
  try {
    const claim = await claimJob(db, job);
    if (claim.status === "done" || claim.status === "dead") {
      logEvent("info", "job.duplicate_skipped", { ...fields, jobStatus: claim.status });
      message.ack();
      return;
    }
    if (claim.status === "busy") {
      // Another delivery holds it, or crashed holding it. Look again when its lease ends.
      logEvent("info", "job.busy", { ...fields, retryInSeconds: claim.retryInSeconds });
      message.retry({ delaySeconds: claim.retryInSeconds });
      return;
    }
    owner = claim.owner;

    const startedAt = Date.now();
    const writes = (await handler(job, context)) ?? [];
    const results = await db.batch([
      ...writes,
      completeJobStatement(db, job.id, owner),
    ]);
    logEvent("info", "job.done", {
      ...fields,
      durationMs: Date.now() - startedAt,
      // False only if this run outlived its lease, which the lease length rules out.
      markedDone: results[results.length - 1].meta.changes === 1,
    });
    message.ack();
  } catch (error) {
    const errorFields = describeError(error);
    logEvent("error", "job.failed", { ...fields, ...errorFields });
    message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    if (owner) {
      await releaseJob(db, job.id, owner, String(errorFields.errorName)).catch(
        (releaseError) =>
          // Not fatal: the lease lapses on its own and the retry runs then.
          logEvent("error", "job.release_failed", {
            ...fields,
            ...describeError(releaseError),
          }),
      );
    }
  }
}

/**
 * Consumes the dead-letter queue: makes the failure visible and keeps the message in
 * D1, so it isn't lost when the queue's own retention ends.
 */
export async function consumeDeadJobs(batch: MessageBatch<unknown>, env: Env) {
  for (const message of batch.messages) {
    const job = message.body as Partial<Job> | null;
    const fields = {
      jobType: job?.type,
      jobId: job?.id,
      shop: job?.shop,
      messageId: message.id,
    };
    logEvent("error", "job.dead", fields);
    try {
      await markJobDead(env.DB, {
        key: job?.id ?? message.id,
        type: job?.type ?? "unknown",
        shop: job?.shop,
        body: JSON.stringify(message.body),
      });
      message.ack();
    } catch (error) {
      logEvent("error", "job.dead_not_recorded", { ...fields, ...describeError(error) });
      message.retry();
    }
  }
}

// 1, 2, 4, 8, then 16 minutes: about half an hour to ride out a Shopify or D1 outage.
function retryDelaySeconds(attempts: number) {
  return Math.min(60 * 2 ** (attempts - 1), MAX_RETRY_DELAY_SECONDS);
}

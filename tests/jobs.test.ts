import {
  applyD1Migrations,
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
} from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  billingAttemptKey,
  claimJob,
} from "../app/jobs/idempotency.server";
import {
  consumeDeadJobs,
  consumeJobs,
  enqueueJobs,
  runTick,
  type DueWorkFinder,
  type Job,
  type JobHandler,
} from "../app/jobs/runner.server";
import { logEvent } from "../app/logger.server";
import { createDb } from "../app/db.server";
import { getOrCreateShop } from "../app/shop.server";
import { contractJob, SIGNUP_DEAD_EVENT } from "../app/subscriptions.server";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const QUEUE = "release-subscriptions-jobs";
let nextId = 0;

function testJob(overrides: Partial<Job> = {}): Job {
  return {
    type: "test",
    id: `test:${++nextId}`,
    shop: "jobs.myshopify.com",
    ...overrides,
  };
}

/** Delivers bodies as one batch and returns what the consumer did with each message. */
async function deliver(
  bodies: unknown[],
  handlers: Record<string, JobHandler>,
  attempts = 1,
) {
  const batch = createMessageBatch<unknown>(
    QUEUE,
    bodies.map((body, i) => ({
      id: `message-${++nextId}-${i}`,
      timestamp: new Date(),
      attempts,
      body,
    })),
  );
  // getQueueResult doesn't report the delay, so record it from the calls.
  const retries = batch.messages.map((message) => vi.spyOn(message, "retry"));
  const ctx = createExecutionContext();
  await consumeJobs(batch, env, handlers);
  return {
    batch,
    result: await getQueueResult(batch, ctx),
    retryDelays: retries.flatMap((retry) =>
      retry.mock.calls.map(([options]) => options?.delaySeconds),
    ),
  };
}

async function jobRun(key: string) {
  return env.DB.prepare(`SELECT * FROM "JobRun" WHERE "key" = ?1`)
    .bind(key)
    .first<{
      status: string;
      runs: number;
      owner: string | null;
      lastError: string | null;
      body: string | null;
    }>();
}

/** Every JSON log line written while `run` runs. */
async function captureLogs(run: () => Promise<unknown>) {
  const lines: string[] = [];
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((line: string) => {
      lines.push(line);
    });
  }
  await run();
  return lines.map(
    (line) => JSON.parse(line) as Record<string, string | number>,
  );
}

describe("duplicate delivery", () => {
  it("runs a job enqueued from the tick once when it is delivered twice", async () => {
    const job = testJob({ id: "tick-job" });
    const sent: { body: Job }[] = [];
    const tickEnv = {
      DB: env.DB,
      JOBS: {
        sendBatch: async (messages: { body: Job }[]) => {
          sent.push(...messages);
        },
      },
    } as unknown as Env;
    const handler = vi.fn(async () => {});
    const finder: DueWorkFinder = async () => [job];

    await runTick(tickEnv, { cron: "0 * * * *", scheduledTime: Date.now() }, [
      finder,
    ]);

    expect(handler).not.toHaveBeenCalled();
    expect(sent.map(({ body }) => body)).toEqual([job]);

    const first = await deliver([sent[0].body], { test: handler });
    const second = await deliver([sent[0].body], { test: handler });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(first.result.explicitAcks).toHaveLength(1);
    expect(second.result.explicitAcks).toHaveLength(1);
    expect(await jobRun(job.id)).toMatchObject({ status: "DONE", runs: 1 });
  });

  it("runs it once when both copies are in the same batch", async () => {
    const job = testJob();
    const handler = vi.fn(async () => {});

    const { result } = await deliver([job, job], { test: handler });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.explicitAcks).toHaveLength(2);
  });

  it("runs it once when both copies arrive at the same time", async () => {
    const job = testJob();
    let finish = () => {};
    const handler = vi.fn(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );

    const first = deliver([job], { test: handler });
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());
    const second = await deliver([job], { test: handler });

    // The second copy doesn't run or get dropped: it comes back after the lease.
    expect(second.result.explicitAcks).toHaveLength(0);
    expect(second.result.retryMessages).toHaveLength(1);
    expect(second.retryDelays[0]).toBeGreaterThan(0);

    finish();
    await first;
    const third = await deliver([job], { test: handler });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(third.result.explicitAcks).toHaveLength(1);
  });

  it("supports the billing attempt idempotency key", async () => {
    const key = billingAttemptKey("subscription1", "release1", 2);
    expect(key).toBe("subscription1:release1:2");

    const handler = vi.fn(async () => {});
    const job = testJob({ id: key });
    await deliver([job], { test: handler });
    await deliver([job], { test: handler });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(await jobRun(key)).toMatchObject({ status: "DONE" });
  });
});

describe("failure and retry", () => {
  it("runs a job again on retry after it fails having claimed its key", async () => {
    const job = testJob();
    const handler = vi
      .fn<JobHandler>()
      .mockRejectedValueOnce(new TypeError("boom"))
      .mockResolvedValueOnce(undefined);

    const first = await deliver([job], { test: handler });
    expect(first.result.explicitAcks).toHaveLength(0);
    expect(first.result.retryMessages).toHaveLength(1);
    expect(await jobRun(job.id)).toMatchObject({
      status: "CLAIMED",
      lastError: "TypeError",
    });

    const second = await deliver([job], { test: handler }, 2);
    expect(second.result.explicitAcks).toHaveLength(1);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(await jobRun(job.id)).toMatchObject({
      status: "DONE",
      runs: 2,
      lastError: null,
    });
  });

  it("doesn't leave a job stuck when a crash stops it after claiming", async () => {
    const job = testJob();
    const handler = vi.fn(async () => {});
    // A crash: claimed, and nothing ever releases or completes it.
    const claim = await claimJob(env.DB, job);
    expect(claim.status).toBe("claimed");

    // While the lease runs, a retry waits rather than running alongside it.
    const during = await deliver([job], { test: handler }, 2);
    expect(handler).not.toHaveBeenCalled();
    expect(during.retryDelays[0]).toBeGreaterThan(900);

    await env.DB.prepare(
      `UPDATE "JobRun" SET "leaseExpiresAt" = ?2 WHERE "key" = ?1`,
    )
      .bind(job.id, new Date(Date.now() - 1000).toISOString())
      .run();

    const after = await deliver([job], { test: handler }, 3);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(after.result.explicitAcks).toHaveLength(1);
    expect(await jobRun(job.id)).toMatchObject({ status: "DONE", runs: 2 });
  });

  it("settles each message on its own", async () => {
    const good = testJob();
    const bad = testJob({ type: "bad" });
    const { batch, result } = await deliver([bad, good], {
      test: async () => {},
      bad: async () => {
        throw new Error("boom");
      },
    });

    expect(result.explicitAcks).toEqual([batch.messages[1].id]);
    expect(result.retryMessages.map(({ msgId }) => msgId)).toEqual([
      batch.messages[0].id,
    ]);
  });

  it("backs off between retries", async () => {
    const job = testJob();
    const handlers = {
      test: async () => {
        throw new Error("boom");
      },
    };
    const delays = [];
    for (const attempts of [1, 2, 3, 4, 5, 20]) {
      const { retryDelays } = await deliver([job], handlers, attempts);
      delays.push(retryDelays[0]);
    }
    expect(delays).toEqual([60, 120, 240, 480, 960, 3600]);
  });

  it("commits a job's writes and its done mark together", async () => {
    const shopDomain = "atomic.myshopify.com";
    const job = testJob();
    const insertShop = () =>
      env.DB.prepare(
        `INSERT INTO "Shop" ("id", "shopDomain", "updatedAt") VALUES (?1, ?2, ?3)`,
      ).bind(crypto.randomUUID(), shopDomain, new Date().toISOString());
    const shops = () =>
      env.DB.prepare(`SELECT COUNT(*) AS n FROM "Shop" WHERE "shopDomain" = ?1`)
        .bind(shopDomain)
        .first<number>("n");

    // The second insert breaks the unique key, so nothing from this run may land.
    const failing = await deliver([job], {
      test: async () => [insertShop(), insertShop()],
    });
    expect(failing.result.retryMessages).toHaveLength(1);
    expect(await shops()).toBe(0);
    expect((await jobRun(job.id))?.status).toBe("CLAIMED");

    await deliver([job], { test: async () => [insertShop()] }, 2);
    expect(await shops()).toBe(1);
    expect((await jobRun(job.id))?.status).toBe("DONE");
  });
});

describe("a job that exhausts its retries", () => {
  it("is logged, recorded with its message and never run again", async () => {
    const job = testJob({ data: { releaseId: "release1" } });
    const handler = vi.fn<JobHandler>(async () => {
      throw new RangeError("boom");
    });

    // max_retries is 5 in wrangler.jsonc, so 6 deliveries before the dead-letter queue.
    for (let attempts = 1; attempts <= 6; attempts++) {
      const { result } = await deliver([job], { test: handler }, attempts);
      expect(result.retryMessages).toHaveLength(1);
    }
    expect(handler).toHaveBeenCalledTimes(6);

    const dlq = createMessageBatch<unknown>(`${QUEUE}-dlq`, [
      { id: "dead-1", timestamp: new Date(), attempts: 1, body: job },
    ]);
    const ctx = createExecutionContext();
    const logs = await captureLogs(() => consumeDeadJobs(dlq, env));
    const result = await getQueueResult(dlq, ctx);

    expect(result.explicitAcks).toEqual(["dead-1"]);
    expect(logs).toContainEqual({
      level: "error",
      event: "job.dead",
      jobType: "test",
      jobId: job.id,
      shop: job.shop,
      messageId: "dead-1",
    });
    const row = await jobRun(job.id);
    expect(row).toMatchObject({ status: "DEAD", lastError: "RangeError" });
    expect(JSON.parse(row?.body ?? "")).toEqual(job);

    const later = await deliver([job], { test: handler });
    expect(handler).toHaveBeenCalledTimes(6);
    expect(later.result.explicitAcks).toHaveLength(1);
  });

  it("records a message it can't read under the message ID", async () => {
    const dlq = createMessageBatch<unknown>(`${QUEUE}-dlq`, [
      { id: "dead-unreadable", timestamp: new Date(), attempts: 1, body: "junk" },
    ]);
    await captureLogs(() => consumeDeadJobs(dlq, env));

    expect(await jobRun("dead-unreadable")).toMatchObject({
      status: "DEAD",
      body: '"junk"',
    });
  });

  it("flags a sign-up whose contract job went dead, and not one that has its subscription since", async () => {
    const shopDomain = `dead${crypto.randomUUID()}.myshopify.com`;
    const shop = await getOrCreateShop(createDb(env.DB), shopDomain);
    const dead = (contractGid: string, id: string) =>
      captureLogs(() =>
        consumeDeadJobs(
          createMessageBatch<unknown>(`${QUEUE}-dlq`, [
            { id, timestamp: new Date(), attempts: 1, body: contractJob(shopDomain, contractGid, id) },
          ]),
          env,
        ),
      );
    await dead("gid://shopify/SubscriptionContract/901", "dead-c1");
    const flags = () => createDb(env.DB).event.findMany({ where: { shopId: shop.id, type: SIGNUP_DEAD_EVENT } });
    expect(await flags()).toHaveLength(1);
    expect((await flags())[0].payload).toMatchObject({ contractGid: "gid://shopify/SubscriptionContract/901" });

    // A flag handled by mistake comes back if the job goes dead again.
    await createDb(env.DB).event.updateMany({ where: { shopId: shop.id }, data: { type: "contract.mixed_plans.handled" } });
    await dead("gid://shopify/SubscriptionContract/901", "dead-c2");
    expect(await flags()).toHaveLength(1);

    const plan = await createDb(env.DB).plan.create({
      data: { shopId: shop.id, name: "P", displayName: "P", priceCents: 100 },
    });
    await createDb(env.DB).subscription.create({
      data: {
        shopId: shop.id,
        planId: plan.id,
        contractGid: "gid://shopify/SubscriptionContract/902",
        customerGid: "gid://shopify/Customer/1",
        releasesRemaining: 1,
      },
    });
    await dead("gid://shopify/SubscriptionContract/902", "dead-c3");
    expect(await flags()).toHaveLength(1);
  });

  it("doesn't mark a job dead when another copy already finished it", async () => {
    const job = testJob();
    await deliver([job], { test: async () => {} });

    const dlq = createMessageBatch<unknown>(`${QUEUE}-dlq`, [
      { id: "dead-duplicate", timestamp: new Date(), attempts: 1, body: job },
    ]);
    await captureLogs(() => consumeDeadJobs(dlq, env));

    expect((await jobRun(job.id))?.status).toBe("DONE");
  });

  it("retries a message with an unknown type or no ID, so it reaches the dead-letter queue", async () => {
    const { result } = await deliver(
      [testJob({ type: "unknown" }), { type: "test" }, null],
      { test: async () => {} },
    );

    expect(result.explicitAcks).toHaveLength(0);
    expect(result.retryMessages).toHaveLength(3);
  });
});

describe("the tick", () => {
  it("keeps going when a finder fails, and logs the failure", async () => {
    const sendBatch = vi.fn(async () => {});
    const tickEnv = { DB: env.DB, JOBS: { sendBatch } } as unknown as Env;
    const logs = await captureLogs(() =>
      runTick(tickEnv, { cron: "0 * * * *", scheduledTime: Date.now() }, [
        async function broken() {
          throw new Error("boom");
        },
        async () => [testJob()],
      ]),
    );

    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "tick.finder_failed",
        finder: "broken",
        errorName: "Error",
      }),
    );
    expect(logs).toContainEqual({
      level: "error",
      event: "tick.done",
      cron: "0 * * * *",
      enqueued: 1,
      failed: 1,
    });
  });

  it("sends a merchant action's jobs in batches the queue accepts", async () => {
    const sendBatch = vi.fn<(messages: { body: Job }[]) => Promise<void>>(
      async () => {},
    );
    const jobs = Array.from({ length: 250 }, () => testJob());

    await enqueueJobs({ JOBS: { sendBatch } } as unknown as Env, jobs);

    expect(sendBatch.mock.calls.map(([messages]) => messages.length)).toEqual([
      100, 100, 50,
    ]);
    expect(sendBatch.mock.calls.flatMap(([m]) => m.map((x) => x.body))).toEqual(
      jobs,
    );
  });
});

describe("the database client", () => {
  it("is created per batch and shared within it", async () => {
    const clients: unknown[] = [];
    const handlers = {
      test: async (_job: Job, { db }: { db: unknown }) => {
        clients.push(db);
      },
    };

    await deliver([testJob(), testJob()], handlers);
    await deliver([testJob()], handlers);

    expect(clients[0]).toBe(clients[1]);
    expect(clients[2]).not.toBe(clients[0]);
  });
});

describe("logging", () => {
  it("writes JSON with the job type, job ID and shop", async () => {
    const job = testJob();
    const logs = await captureLogs(() =>
      deliver([job], { test: async () => {} }),
    );

    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "info",
        event: "job.done",
        jobType: "test",
        jobId: job.id,
        shop: job.shop,
        attempt: 1,
        markedDone: true,
      }),
    );
  });

  it("keeps tokens and customer data out when a job fails", async () => {
    const job = testJob({ data: { note: "jane@example.com" } });
    const lines: string[] = [];
    vi.spyOn(console, "info").mockImplementation((l) => lines.push(l));
    vi.spyOn(console, "error").mockImplementation((l) => lines.push(l));

    await deliver([job], {
      test: async () => {
        throw new Error("shpat_secret for jane@example.com");
      },
    });

    const failed = lines.map((l) => JSON.parse(l)).find((l) => l.event === "job.failed");
    expect(failed).toMatchObject({ jobId: job.id, errorName: "Error" });
    expect(lines.join("\n")).not.toMatch(/shpat_secret|jane@example\.com/);
  });

  it("logs an HTTP status from a thrown response", async () => {
    const logs = await captureLogs(() =>
      deliver([testJob()], {
        test: async () => {
          throw new Response(null, { status: 500 });
        },
      }),
    );

    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "job.failed",
        errorName: "Response",
        errorStatus: 500,
      }),
    );
  });

  it("drops fields named for secrets or customer data", async () => {
    const logs = await captureLogs(async () =>
      logEvent("info", "test.event", {
        shop: "a.myshopify.com",
        accessToken: "x",
        customerEmail: "x",
        shippingAddress: "x",
      }),
    );

    expect(logs).toEqual([
      { level: "info", event: "test.event", shop: "a.myshopify.com" },
    ]);
  });
});

import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../app/db.server";
import { claimJob } from "../app/jobs/idempotency.server";
import { findPruneWork, PRUNE_JOB, pruneOldRows } from "../app/prune.server";
import { getOrCreateShop } from "../app/shop.server";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const db = () => createDb(env.DB);
const NOW = new Date("2027-06-01T03:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
let n = 0;

const jobRow = async (type: string, status: string, updatedAt: string, key = `${type}:${++n}`) => {
  await env.DB.prepare(`INSERT INTO "JobRun" ("key", "type", "status", "updatedAt") VALUES (?1, ?2, ?3, ?4)`)
    .bind(key, type, status, updatedAt)
    .run();
  return key;
};
const exists = async (key: string) => (await db().jobRun.count({ where: { key } })) === 1;

describe("pruning JobRun", () => {
  it("removes old finished rows of the jobs that can't repeat harmfully, and keeps recent ones", async () => {
    const old: string[] = [];
    for (const type of [
      "email.run", "flow.run", "member.tag", "dashboard.refresh", "contracts.reconcile", "release.run",
      "billing.card_updated", "billing.resume", "billing.settle", "billing.renew", "billing.retry", "gdpr",
    ]) {
      old.push(await jobRow(type, "DONE", ago(31)));
    }
    const lapsed = await jobRow("email.run", "CLAIMED", ago(31));
    const recent = await jobRow("email.run", "DONE", ago(29));
    await pruneOldRows(env.DB, NOW);
    for (const key of [...old, lapsed]) expect(await exists(key)).toBe(false);
    expect(await exists(recent)).toBe(true);
  });

  it("keeps every contract job, which is what stops the hourly check re-running a flagged contract", async () => {
    const key = await jobRow("contract.sync", "DONE", ago(400));
    const dead = await jobRow("contract.sync", "DEAD", ago(400));
    await pruneOldRows(env.DB, NOW);
    expect(await exists(key)).toBe(true);
    expect(await exists(dead)).toBe(true);
  });

  it("keeps a dead job for longer, because it says what failed, and then lets it go", async () => {
    const young = await jobRow("payment_order.fulfill", "DEAD", ago(60));
    const old = await jobRow("payment_order.fulfill", "DEAD", ago(91));
    await pruneOldRows(env.DB, NOW);
    expect(await exists(young)).toBe(true);
    expect(await exists(old)).toBe(false);
  });

  it("clears a backlog bigger than one pass", async () => {
    const statements = Array.from({ length: 1500 }, () =>
      env.DB.prepare(`INSERT INTO "JobRun" ("key", "type", "status", "updatedAt") VALUES (?1, 'flow.run', 'DONE', ?2)`).bind(
        `backlog-${++n}`,
        ago(40),
      ),
    );
    await env.DB.batch(statements);
    await pruneOldRows(env.DB, NOW);
    expect(await db().jobRun.count({ where: { key: { startsWith: "backlog-" } } })).toBe(0);
  });

  it("a pruned job that repeats runs again, which is why only repeatable ones are pruned", async () => {
    const key = await jobRow("flow.run", "DONE", ago(31));
    await pruneOldRows(env.DB, NOW);
    expect((await claimJob(env.DB, { id: key, type: "flow.run" })).status).toBe("claimed");
  });

  it("runs once a day, in one hour", async () => {
    const find = (at: string) => findPruneWork({ env, db: db(), now: new Date(at) });
    expect(await find("2027-06-01T02:00:00Z")).toEqual([]);
    const [job] = await find("2027-06-01T03:00:00Z");
    expect(job).toMatchObject({ type: PRUNE_JOB, id: `${PRUNE_JOB}:2027-06-01` });
  });
});

describe("pruning ImportRow", () => {
  async function runs(shopId: string) {
    const make = (id: string, status: string, createdAt: string) =>
      env.DB.prepare(
        `INSERT INTO "ImportRun" ("id", "shopId", "status", "settings", "createdAt", "updatedAt") VALUES (?1, ?2, ?3, '{}', ?4, ?4)`,
      )
        .bind(id, shopId, status, createdAt)
        .run();
    const older = `run-${++n}`;
    const latest = `run-${++n}`;
    await make(older, "READ", ago(60));
    await make(latest, "READ", ago(40));
    return { older, latest };
  }
  const row = async (shopId: string, runId: string, state: string, updatedAt: string) => {
    const id = `row-${++n}`;
    await env.DB.prepare(
      `INSERT INTO "ImportRow" ("id", "shopId", "key", "runId", "state", "updatedAt") VALUES (?1, ?2, ?1, ?3, ?4, ?5)`,
    )
      .bind(id, shopId, runId, state, updatedAt)
      .run();
    return id;
  };
  const there = async (id: string) => (await db().importRow.count({ where: { id } })) === 1;

  it("removes what an older dry run left, and keeps what a contract or the latest report depends on", async () => {
    const shop = await getOrCreateShop(db(), `prune${++n}.myshopify.com`);
    const { older, latest } = await runs(shop.id);
    const stale = await row(shop.id, older, "READ", ago(40));
    const skipped = await row(shop.id, older, "SKIPPED", ago(40));
    const imported = await row(shop.id, older, "DONE", ago(400)); // its key is compared by every later dry run
    const report = await row(shop.id, latest, "READ", ago(40));
    const young = await row(shop.id, older, "READ", ago(5));
    await pruneOldRows(env.DB, NOW);
    expect(await there(stale)).toBe(false);
    expect(await there(skipped)).toBe(false);
    expect(await there(imported)).toBe(true);
    expect(await there(report)).toBe(true);
    expect(await there(young)).toBe(true);
  });

  it("leaves a real run that is still going alone, and another shop's runs out of the comparison", async () => {
    const shop = await getOrCreateShop(db(), `prune${++n}.myshopify.com`);
    const { older } = await runs(shop.id);
    await env.DB.prepare(`UPDATE "ImportRun" SET "status" = 'IMPORTING' WHERE "id" = ?1`).bind(older).run();
    const going = await row(shop.id, older, "QUEUED", ago(40));
    const other = await getOrCreateShop(db(), `prune${++n}.myshopify.com`);
    const only = `run-${++n}`;
    await env.DB.prepare(
      `INSERT INTO "ImportRun" ("id", "shopId", "status", "settings", "createdAt", "updatedAt") VALUES (?1, ?2, 'READ', '{}', ?3, ?3)`,
    )
      .bind(only, other.id, ago(60))
      .run();
    const lone = await row(other.id, only, "READ", ago(40));
    await pruneOldRows(env.DB, NOW);
    expect(await there(going)).toBe(true);
    expect(await there(lone)).toBe(true);
  });
});

describe("pruning RateLimit", () => {
  it("removes windows that have ended", async () => {
    await env.DB.prepare(`INSERT INTO "RateLimit" ("key", "windowEndsAt") VALUES ('ended', ?1), ('open', ?2)`)
      .bind(ago(1), ago(-1))
      .run();
    await pruneOldRows(env.DB, NOW);
    expect(await db().rateLimit.count({ where: { key: "ended" } })).toBe(0);
    expect(await db().rateLimit.count({ where: { key: "open" } })).toBe(1);
  });
});

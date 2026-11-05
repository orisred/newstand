import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../app/db.server";
import { loadSubscribersPage, revenueReport } from "../app/dashboard.server";
import { releasesPageData } from "../app/releases.server";
import { getOrCreateShop } from "../app/shop.server";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

type Fn = (...args: unknown[]) => unknown;
const RUNS = new Set<string | symbol>(["all", "first", "run", "raw"]);

/** Counts the statements that reach D1: one per statement run, so a batch counts each of its statements. */
function counting(db: D1Database) {
  const state = { statements: 0, roundTrips: 0, sql: [] as string[] };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        if (key === "__real") return target;
        const value = Reflect.get(target, key, target) as unknown;
        if (key === "bind") return (...args: unknown[]) => wrap((value as Fn).apply(target, args) as D1PreparedStatement);
        if (RUNS.has(key)) {
          return (...args: unknown[]) => {
            state.statements++;
            state.roundTrips++;
            return (value as Fn).apply(target, args);
          };
        }
        return typeof value === "function" ? (value as Fn).bind(target) : value;
      },
    });
  const proxy = new Proxy(db, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (key === "prepare") {
        return (sql: string) => {
          state.sql.push(sql.slice(0, 70).replace(/\s+/g, " "));
          return wrap(target.prepare(sql));
        };
      }
      if (key === "batch") {
        return (statements: (D1PreparedStatement & { __real?: D1PreparedStatement })[]) => {
          state.statements += statements.length;
          state.roundTrips++;
          return target.batch(statements.map((statement) => statement.__real ?? statement));
        };
      }
      return typeof value === "function" ? (value as Fn).bind(target) : value;
    },
  });
  return { db: proxy, state };
}

describe("admin page queries", () => {
  it("the releases page reads with a handful of small D1 calls", async () => {
    const real = createDb(env.DB);
    const shop = await getOrCreateShop(real, "count.myshopify.com");
    for (let i = 1; i <= 30; i++) {
      await real.release.create({ data: { shopId: shop.id, number: i, title: `Issue ${i}`, status: "SHIPPED" } });
    }
    const { db: raw, state } = counting(env.DB);
    const db = createDb(raw);
    const full = await getOrCreateShop(db, "count.myshopify.com");
    const data = await releasesPageData(db, raw, full);
    expect(data.releases).toHaveLength(25);
    // The shop row, a page of releases, run progress, payment problems (and their last attempts),
    // flagged sign-ups, UNSURE emails and stock warnings. Raise this only on purpose.
    console.log(`releases page: ${state.statements} D1 statements\n${state.sql.join("\n")}`);
    expect(state.statements).toBeLessThanOrEqual(9);
  });

  it("the subscribers and revenue pages read in one round trip each, apart from their lists", async () => {
    const shop = await createDb(env.DB).shop.findUniqueOrThrow({ where: { shopDomain: "count.myshopify.com" } });
    const first = counting(env.DB);
    await loadSubscribersPage(first.db, shop.id, "all", null, new Date());
    expect(first.state.roundTrips).toBe(1);

    const second = counting(env.DB);
    await revenueReport(createDb(second.db), second.db, shop.id);
    console.log(`revenue page: ${second.state.statements} D1 statements`);
    expect(second.state.statements).toBeLessThanOrEqual(6);
  });
});

import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "../app/db.server";
import {
  createPlan,
  getPlan,
  listPlans,
  parsePlan,
  parsePriceCents,
  requestSync,
  retrySync,
  setPlanActive,
  updatePlan,
  type PlanInput,
} from "../app/plans.server";
import { getOrCreateShop } from "../app/shop.server";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const db = () => createDb(env.DB);
let n = 0;
const newShop = () => getOrCreateShop(db(), `plans${++n}.myshopify.com`);

function form(fields: Record<string, string | boolean>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === false) continue;
    data.set(key, value === true ? "on" : value);
  }
  return data;
}

const bundle = {
  name: "Yearly",
  displayName: "Yearly subscription",
  billingMode: "PREPAID_BUNDLE",
  releasesPerTerm: "2",
  termMonths: "12",
  renewalRule: "TERM_DATE_HOLD_IF_LATE",
  startRule: "PREORDER_SWITCHOVER",
  price: "40",
  autoRenew: true,
  productGid: "gid://shopify/Product/123",
  productTitle: "Zine subscription",
};

function valid(overrides: Partial<Record<string, string | boolean>> = {}) {
  const parsed = parsePlan(form({ ...bundle, ...overrides }));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.values;
}

describe("parsePlan", () => {
  it("reads a tier's perk text, keeping its line breaks, and its own customer tag", () => {
    const plan = valid({
      description: "  Reader-level print subscription\r\n\r\n\r\nPlus:   early access  ",
      memberTag: " member-insider ",
    });
    expect(plan.description).toBe("Reader-level print subscription\n\nPlus: early access");
    expect(plan.memberTag).toBe("member-insider");
    expect(valid({ description: "   ", memberTag: "" })).toMatchObject({ description: null, memberTag: null });
  });

  it("refuses a tag Shopify would split, and markup or control characters in the perk text", () => {
    const errors = (fields: Record<string, string>) => {
      const parsed = parsePlan(form({ ...bundle, ...fields }));
      return parsed.ok ? {} : parsed.errors;
    };
    expect(errors({ memberTag: "member, insider" })).toHaveProperty("memberTag");
    expect(errors({ memberTag: "x".repeat(41) })).toHaveProperty("memberTag");
    expect(errors({ description: "<b>perks</b>" })).toHaveProperty("description");
    expect(errors({ description: "bell\u0007" })).toHaveProperty("description");
    expect(errors({ description: "x".repeat(501) })).toHaveProperty("description");
  });

  it("reads a bundle", () => {
    expect(valid()).toEqual({
      name: "Yearly",
      displayName: "Yearly subscription",
      description: null,
      memberTag: null,
      billingMode: "PREPAID_BUNDLE",
      releasesPerTerm: 2,
      termMonths: 12,
      renewalRule: "TERM_DATE_HOLD_IF_LATE",
      startRule: "PREORDER_SWITCHOVER",
      priceCents: 4000,
      autoRenew: true,
      giftable: false,
      productGid: "gid://shopify/Product/123",
      productTitle: "Zine subscription",
    });
  });

  it("gives a per-release plan one release and no term, whatever the form says", () => {
    const plan = valid({
      billingMode: "PER_RELEASE",
      releasesPerTerm: "9",
      termMonths: "12",
      renewalRule: "",
    });
    expect(plan).toMatchObject({
      releasesPerTerm: 1,
      termMonths: null,
      renewalRule: "TERM_DATE_HOLD_IF_LATE",
    });
  });

  it("reads the checkboxes, which are absent when off", () => {
    expect(valid({ autoRenew: false, giftable: true })).toMatchObject({
      autoRenew: false,
      giftable: true,
    });
  });

  it("rejects bad input, naming the field", () => {
    const cases: [Record<string, string | boolean>, string][] = [
      [{ name: " " }, "name"],
      [{ name: "x".repeat(81) }, "name"],
      [{ displayName: "<b>Yearly</b>" }, "displayName"],
      [{ billingMode: "WEEKLY" }, "billingMode"],
      [{ releasesPerTerm: "0" }, "releasesPerTerm"],
      [{ releasesPerTerm: "2.5" }, "releasesPerTerm"],
      [{ releasesPerTerm: "101" }, "releasesPerTerm"],
      [{ termMonths: "" }, "termMonths"],
      [{ termMonths: "37" }, "termMonths"],
      [{ renewalRule: "NEVER" }, "renewalRule"],
      [{ renewalRule: "" }, "renewalRule"],
      [{ startRule: "SOON" }, "startRule"],
      [{ price: "0" }, "price"],
      [{ price: "-5" }, "price"],
      [{ price: "12.345" }, "price"],
      [{ price: "abc" }, "price"],
      [{ productGid: "" }, "product"],
      [{ productGid: "gid://shopify/Collection/1" }, "product"],
    ];
    for (const [fields, field] of cases) {
      const parsed = parsePlan(form({ ...bundle, ...fields }));
      expect(parsed.ok, JSON.stringify(fields)).toBe(false);
      expect(Object.keys(parsed.ok ? {} : parsed.errors)).toContain(field);
    }
  });

  it("keeps an existing plan's billing mode, releases and term", () => {
    const parsed = parsePlan(
      form({
        ...bundle,
        billingMode: "PER_RELEASE",
        releasesPerTerm: "9",
        termMonths: "3",
      }),
      { billingMode: "PREPAID_BUNDLE", releasesPerTerm: 2, termMonths: 12 },
    );
    expect(parsed.ok && parsed.values).toMatchObject({
      billingMode: "PREPAID_BUNDLE",
      releasesPerTerm: 2,
      termMonths: 12,
    });
  });

  it("turns prices into whole cents", () => {
    expect(parsePriceCents("25")).toBe(2500);
    expect(parsePriceCents("25.5")).toBe(2550);
    expect(parsePriceCents("0.07")).toBe(7);
    expect(parsePriceCents("0.00")).toBeNull();
  });
});

describe("creating, editing and turning plans on and off", () => {
  it("creates once, however often the same form is submitted", async () => {
    const shop = await newShop();
    const input: PlanInput = valid();
    const first = await createPlan(db(), shop.id, "key-aaaaaaaa", input);
    const second = await createPlan(db(), shop.id, "key-aaaaaaaa", input);
    expect(first.created).toBe(true);
    expect(second).toEqual({ created: false, id: first.id });
    expect(await listPlans(db(), shop.id)).toHaveLength(1);
  });

  it("starts out not synced and active, with its product", async () => {
    const shop = await newShop();
    const { id } = await createPlan(db(), shop.id, "key-bbbbbbbb", valid());
    expect(await getPlan(db(), shop.id, id)).toMatchObject({
      syncStatus: "NOT_SYNCED",
      active: true,
      productGid: "gid://shopify/Product/123",
      productTitle: "Zine subscription",
    });
  });

  it("only shows and changes a shop's own plans", async () => {
    const mine = await newShop();
    const theirs = await newShop();
    const { id } = await createPlan(db(), theirs.id, "key-cccccccc", valid());

    expect(await listPlans(db(), mine.id)).toEqual([]);
    expect(await getPlan(db(), mine.id, id)).toBeNull();
    expect(await updatePlan(db(), mine.id, id, valid({ price: "1" }))).toBe(
      false,
    );
    expect(await setPlanActive(db(), mine.id, id, false)).toBe(false);

    const untouched = await getPlan(db(), theirs.id, id);
    expect(untouched).toMatchObject({ priceCents: 4000, active: true });
  });

  it("edits the price and names but never the billing mode, releases or term", async () => {
    const shop = await newShop();
    const { id } = await createPlan(db(), shop.id, "key-dddddddd", valid());
    await db().plan.update({ where: { id }, data: { syncStatus: "SYNCED" } });

    // The route parses with the existing plan, so the shape can't change.
    const parsed = parsePlan(
      form({
        ...bundle,
        price: "55.50",
        name: "Renamed",
        billingMode: "PER_RELEASE",
        termMonths: "3",
      }),
      { billingMode: "PREPAID_BUNDLE", releasesPerTerm: 2, termMonths: 12 },
    );
    if (!parsed.ok) throw new Error("invalid");
    expect(await updatePlan(db(), shop.id, id, parsed.values)).toBe(true);

    const row = await db().plan.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      name: "Renamed",
      priceCents: 5550,
      billingMode: "PREPAID_BUNDLE",
      termMonths: 12,
      syncStatus: "NOT_SYNCED",
      syncRevision: 2,
    });
  });

  it("turns a plan off and on without deleting it", async () => {
    const shop = await newShop();
    const { id } = await createPlan(db(), shop.id, "key-eeeeeeee", valid());
    await setPlanActive(db(), shop.id, id, false);
    expect(await getPlan(db(), shop.id, id)).toMatchObject({
      active: false,
      syncStatus: "NOT_SYNCED",
    });
    await setPlanActive(db(), shop.id, id, true);
    expect(await getPlan(db(), shop.id, id)).toMatchObject({ active: true });
  });
});

describe("queueing a sync", () => {
  const queue = () => {
    const sendBatch = vi.fn(async (messages: unknown[]) => void messages);
    return { sendBatch, env: { JOBS: { sendBatch } } as unknown as Env };
  };

  it("uses a job ID that holds the plan's revision, and the shop's own ID", async () => {
    const shop = await newShop();
    const { id } = await createPlan(db(), shop.id, "key-ffffffff", valid());
    const { sendBatch, env: fakeEnv } = queue();
    const ref = { id: shop.id, shopDomain: "plans.myshopify.com" };

    await requestSync(fakeEnv, db(), ref, id);
    await requestSync(fakeEnv, db(), ref, id);
    await retrySync(fakeEnv, db(), ref, id);

    const ids = sendBatch.mock.calls.map(
      ([messages]) => (messages as { body: { id: string } }[])[0].body.id,
    );
    // Asking twice for the same state repeats an ID, which runs once; a retry is new.
    expect(ids).toEqual([
      `plan.sync:${id}:1`,
      `plan.sync:${id}:1`,
      `plan.sync:${id}:2`,
    ]);
    expect(await getPlan(db(), shop.id, id)).toMatchObject({
      syncStatus: "NOT_SYNCED",
    });
    expect(sendBatch.mock.calls[0][0]).toEqual([
      {
        body: {
          type: "plan.sync",
          id: `plan.sync:${id}:1`,
          shop: "plans.myshopify.com",
          data: { planId: id, shopId: shop.id },
        },
      },
    ]);
  });

  it("queues nothing for another shop's plan", async () => {
    const mine = await newShop();
    const theirs = await newShop();
    const { id } = await createPlan(db(), theirs.id, "key-gggggggg", valid());
    const { sendBatch, env: fakeEnv } = queue();

    const ref = { id: mine.id, shopDomain: "mine.myshopify.com" };
    expect(await requestSync(fakeEnv, db(), ref, id)).toBe(false);
    expect(await retrySync(fakeEnv, db(), ref, id)).toBe(false);
    expect(sendBatch).not.toHaveBeenCalled();
    expect(
      (await db().plan.findUniqueOrThrow({ where: { id } })).syncRevision,
    ).toBe(1);
  });
});

describe("D1 queries for a page load", () => {
  /** Counts the statements Prisma sends to D1. */
  function counted() {
    let count = 0;
    const proxy = new Proxy(env.DB, {
      get(target, property) {
        const value = Reflect.get(target, property) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (property === "prepare") count++;
          if (property === "batch") count += (args[0] as unknown[]).length;
          return value.apply(target, args);
        };
      },
    });
    return { db: createDb(proxy), count: () => count };
  }

  it("the plans list takes 2 queries after sign-in, and the edit form 2", async () => {
    const shop = await newShop();
    const { id } = await createPlan(db(), shop.id, "key-hhhhhhhh", valid());
    const list = counted();
    const found = await getOrCreateShop(list.db, `plans${n}.myshopify.com`);
    await listPlans(list.db, found.id);
    expect(list.count()).toBe(2);

    const edit = counted();
    await getOrCreateShop(edit.db, `plans${n}.myshopify.com`);
    await getPlan(edit.db, shop.id, id);
    expect(edit.count()).toBe(2);
  });
});

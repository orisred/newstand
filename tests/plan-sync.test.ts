/* eslint-disable @typescript-eslint/no-explicit-any -- a fake of Shopify's loosely typed responses */
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "../app/db.server";
import {
  cycleOf,
  describeDifferences,
  groupCreateInput,
  groupUpdateInput,
  SELLING_PLAN_APP_ID,
  SyncBusy,
  syncPlan,
  type Graphql,
  type ShopifyGroup,
  type SyncablePlan,
} from "../app/plan-sync.server";
import {
  createPlan,
  parsePlan,
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
const newShop = () => getOrCreateShop(db(), `sync${++n}.myshopify.com`);

function input(fields: Record<string, string> = {}): PlanInput {
  const data = new FormData();
  Object.entries({
    name: "Yearly",
    displayName: "Yearly subscription",
    billingMode: "PREPAID_BUNDLE",
    releasesPerTerm: "2",
    termMonths: "12",
    renewalRule: "TERM_DATE_HOLD_IF_LATE",
    startRule: "PREORDER_SWITCHOVER",
    price: "40",
    productGid: "gid://shopify/Product/1",
    productTitle: "Zine",
    ...fields,
  }).forEach(([key, value]) => data.set(key, value));
  const parsed = parsePlan(data);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.values;
}

async function newPlan(fields: Record<string, string> = {}) {
  const shop = await newShop();
  const { id } = await createPlan(
    db(),
    shop.id,
    `key-${++n}-aaaaaa`,
    input(fields),
  );
  return { shop, id };
}

let next = 0; // across fakes, so IDs stay unique in the shared test database

/** An in-memory Shopify: the selling plan group operations the sync uses. */
function fakeShopify() {
  const groups = new Map<string, ShopifyGroup>();
  /** Products the sync has touched: whether they require a plan, and how many variants don't ship. */
  const products = new Map<
    string,
    { requiresSellingPlan: boolean; unshippable: number }
  >();
  const productOf = (id: string) => {
    if (!products.has(id))
      products.set(id, { requiresSellingPlan: false, unshippable: 0 });
    return products.get(id)!;
  };
  const calls: string[] = [];
  const hooks: {
    ignoreUpdates?: boolean;
    refuse?: string;
    failOn?: string;
    after?: Record<string, () => Promise<void>>;
  } = {};

  const policyOf = (fields: Record<string, any>) => ({
    name: fields.name,
    options: fields.options,
    category: fields.category,
    billingPolicy: {
      minCycles: null,
      maxCycles: null,
      ...fields.billingPolicy.recurring,
    },
    deliveryPolicy: { cutoff: null, ...fields.deliveryPolicy.recurring },
    pricingPolicies: fields.pricingPolicies.map((policy: any) => ({
      adjustmentType: policy.fixed.adjustmentType,
      adjustmentValue: {
        amount: String(Number(policy.fixed.adjustmentValue.fixedValue)),
        currencyCode: "USD",
      },
    })),
  });

  const graphql: Graphql = async (query, variables = {}) => {
    const operation = /(?:query|mutation) (\w+)/.exec(query)![1];
    calls.push(operation);
    if (hooks.failOn === operation) throw new Error("Shopify is down");
    const v = variables as any;
    const result = await (async () => {
      switch (operation) {
        case "PlanGroupById":
          return {
            shop: { currencyCode: "USD" },
            sellingPlanGroup: groups.get(v.id) ?? null,
          };
        case "PlanGroupByCode": {
          // Shopify's search is loose and breaks on an unquoted value with colons in it.
          const quoted = /^merchant_code:"(.+)"$/.exec(String(v.query));
          const code = quoted?.[1];
          return {
            shop: { currencyCode: "USD" },
            sellingPlanGroups: {
              nodes: code
                ? [...groups.values()].filter(
                    (g) => g.merchantCode?.split(":")[0] === code.split(":")[0],
                  )
                : [],
            },
          };
        }
        case "PlanGroupCreate": {
          if (hooks.refuse)
            return {
              sellingPlanGroupCreate: {
                userErrors: [{ message: hooks.refuse }],
              },
            };
          const id = `gid://shopify/SellingPlanGroup/${++next}`;
          const group: ShopifyGroup = {
            id,
            name: v.input.name,
            appId: v.input.appId,
            merchantCode: v.input.merchantCode,
            options: v.input.options,
            sellingPlans: {
              nodes: v.input.sellingPlansToCreate.map((fields: any) => ({
                id: `gid://shopify/SellingPlan/${++next}`,
                ...policyOf(fields),
              })),
            },
            products: {
              nodes: v.resources.productIds.map((p: string) => ({ id: p })),
            },
          };
          groups.set(id, group);
          return {
            sellingPlanGroupCreate: {
              sellingPlanGroup: {
                id,
                sellingPlans: {
                  nodes: [{ id: group.sellingPlans.nodes[0].id }],
                },
              },
              userErrors: [],
            },
          };
        }
        case "PlanGroupUpdate": {
          if (!hooks.ignoreUpdates) {
            const group = groups.get(v.id)!;
            group.name = v.input.name;
            group.appId = v.input.appId;
            for (const fields of v.input.sellingPlansToUpdate) {
              const target = group.sellingPlans.nodes.find(
                (p) => p.id === fields.id,
              )!;
              Object.assign(target, policyOf(fields));
            }
          }
          return { sellingPlanGroupUpdate: { userErrors: [] } };
        }
        case "PlanGroupAddProducts": {
          const group = groups.get(v.id)!;
          group.products.nodes.push(
            ...v.productIds.map((id: string) => ({ id })),
          );
          return { sellingPlanGroupAddProducts: { userErrors: [] } };
        }
        case "PlanGroupRemoveProducts": {
          const group = groups.get(v.id)!;
          group.products.nodes = group.products.nodes.filter(
            (p) => !v.productIds.includes(p.id),
          );
          return { sellingPlanGroupRemoveProducts: { userErrors: [] } };
        }
        case "PlanProducts": {
          const attachedTo = (id: string) =>
            [...groups.values()].filter((g) =>
              g.products.nodes.some((p) => p.id === id),
            ).length;
          return {
            nodes: v.ids.map((id: string) => {
              const state = productOf(id);
              return {
                id,
                requiresSellingPlan: state.requiresSellingPlan,
                sellingPlanGroupsCount: { count: attachedTo(id) },
                variants: {
                  nodes: [...Array(state.unshippable).fill(false), true].map(
                    (requiresShipping) => ({
                      inventoryItem: { requiresShipping },
                    }),
                  ),
                },
              };
            }),
          };
        }
        case "PlanProductRequires":
          productOf(v.product.id).requiresSellingPlan =
            v.product.requiresSellingPlan;
          return { productUpdate: { userErrors: [] } };
      }
      throw new Error(`unexpected ${operation}`);
    })();
    await hooks.after?.[operation]?.();
    return result;
  };
  return {
    graphql,
    groups,
    products,
    calls,
    hooks,
    count: (op: string) => calls.filter((c) => c === op).length,
  };
}

const row = (id: string) => db().plan.findUniqueOrThrow({ where: { id } });

describe("the selling plan payload", () => {
  const base: SyncablePlan = {
    id: "plan1",
    displayName: "Yearly subscription",
    billingMode: "PREPAID_BUNDLE",
    termMonths: 12,
    priceCents: 4050,
    currency: "USD",
    active: true,
    productGid: "gid://shopify/Product/1",
    sellingPlanGroupGid: null,
  };

  it("a bundle: its term is the schedule, and the customer sees its display name", () => {
    const create = groupCreateInput(base);
    expect(create).toEqual({
      name: "Yearly subscription",
      appId: SELLING_PLAN_APP_ID,
      merchantCode: "plan1",
      options: ["Subscription"],
      sellingPlansToCreate: [
        {
          name: "Yearly subscription",
          category: "SUBSCRIPTION",
          options: ["Yearly subscription"],
          billingPolicy: { recurring: { interval: "YEAR", intervalCount: 1 } },
          deliveryPolicy: {
            recurring: {
              interval: "YEAR",
              intervalCount: 1,
              intent: "FULFILLMENT_BEGIN",
              preAnchorBehavior: "ASAP",
            },
          },
          pricingPolicies: [
            {
              fixed: {
                adjustmentType: "PRICE",
                adjustmentValue: { fixedValue: "40.50" },
              },
            },
          ],
        },
      ],
    });
  });

  it("a per-release plan: one year, with no cycle limit, anchor or cutoff to act on", () => {
    const plan = {
      ...base,
      billingMode: "PER_RELEASE" as const,
      termMonths: null,
    };
    const [selling] = groupCreateInput(plan).sellingPlansToCreate;
    expect(selling.billingPolicy).toEqual({
      recurring: { interval: "YEAR", intervalCount: 1 },
    });
    expect(JSON.stringify(selling)).not.toMatch(
      /anchors|cutoff|minCycles|maxCycles/,
    );
  });

  it("turns terms into intervals", () => {
    const bundle = (termMonths: number) =>
      cycleOf({ billingMode: "PREPAID_BUNDLE", termMonths });
    expect(bundle(12)).toEqual({ interval: "YEAR", intervalCount: 1 });
    expect(bundle(24)).toEqual({ interval: "YEAR", intervalCount: 2 });
    expect(bundle(18)).toEqual({ interval: "MONTH", intervalCount: 18 });
    expect(bundle(6)).toEqual({ interval: "MONTH", intervalCount: 6 });
    expect(cycleOf({ billingMode: "PER_RELEASE", termMonths: null })).toEqual({
      interval: "YEAR",
      intervalCount: 1,
    });
  });

  it("an update carries the selling plan's ID and the same fields", () => {
    const update = groupUpdateInput(base, "gid://shopify/SellingPlan/9");
    expect(update.sellingPlansToUpdate[0]).toMatchObject({
      id: "gid://shopify/SellingPlan/9",
      name: "Yearly subscription",
    });
  });
});

describe("syncPlan", () => {
  it("creates the group, stores its IDs and reads it back", async () => {
    const { shop, id } = await newPlan();
    const shopify = fakeShopify();

    const result = await syncPlan(db(), shopify.graphql, shop.id, id);

    expect(result).toEqual({ status: "SYNCED", message: null });
    const [group] = [...shopify.groups.values()];
    expect(await row(id)).toMatchObject({
      syncStatus: "SYNCED",
      syncMessage: null,
      sellingPlanGroupGid: group.id,
      sellingPlanGid: group.sellingPlans.nodes[0].id,
      currency: "USD",
      syncLeaseUntil: null,
    });
    expect(group.products.nodes).toEqual([{ id: "gid://shopify/Product/1" }]);
    // find, create, settle the product, then read back
    expect(shopify.calls).toEqual([
      "PlanGroupByCode",
      "PlanGroupCreate",
      "PlanProducts",
      "PlanProductRequires",
      "PlanGroupById",
    ]);
  });

  it("running again changes nothing and makes no second group", async () => {
    const { shop, id } = await newPlan();
    const shopify = fakeShopify();
    await syncPlan(db(), shopify.graphql, shop.id, id);
    await syncPlan(db(), shopify.graphql, shop.id, id);
    await syncPlan(db(), shopify.graphql, shop.id, id);

    expect(shopify.groups.size).toBe(1);
    expect(shopify.count("PlanGroupCreate")).toBe(1);
    expect(shopify.count("PlanGroupUpdate")).toBe(0);
    expect((await row(id)).syncStatus).toBe("SYNCED");
  });

  it("pushes an edited price and name to the existing group", async () => {
    const { shop, id } = await newPlan();
    const shopify = fakeShopify();
    await syncPlan(db(), shopify.graphql, shop.id, id);

    await updatePlan(db(), shop.id, id, {
      ...input(),
      displayName: "Annual",
      priceCents: 5500,
    });
    await syncPlan(db(), shopify.graphql, shop.id, id);

    const [group] = [...shopify.groups.values()];
    expect(group.name).toBe("Annual");
    expect(group.sellingPlans.nodes[0].name).toBe("Annual");
    expect(
      group.sellingPlans.nodes[0].pricingPolicies[0].adjustmentValue?.amount,
    ).toBe("55");
    expect(shopify.groups.size).toBe(1);
    expect((await row(id)).syncStatus).toBe("SYNCED");
  });

  it("turning a plan off takes it off its product but keeps the group", async () => {
    const { shop, id } = await newPlan();
    const shopify = fakeShopify();
    await syncPlan(db(), shopify.graphql, shop.id, id);

    await setPlanActive(db(), shop.id, id, false);
    await syncPlan(db(), shopify.graphql, shop.id, id);
    const [group] = [...shopify.groups.values()];
    expect(group.products.nodes).toEqual([]);
    expect(shopify.groups.size).toBe(1);
    expect(shopify.calls.some((c) => /Delete/.test(c))).toBe(false);
    expect((await row(id)).syncStatus).toBe("SYNCED");

    await setPlanActive(db(), shop.id, id, true);
    await syncPlan(db(), shopify.graphql, shop.id, id);
    expect(group.products.nodes).toEqual([{ id: "gid://shopify/Product/1" }]);
  });

  it("moves the plan when its product is changed", async () => {
    const { shop, id } = await newPlan();
    const shopify = fakeShopify();
    await syncPlan(db(), shopify.graphql, shop.id, id);
    await updatePlan(db(), shop.id, id, {
      ...input(),
      productGid: "gid://shopify/Product/2",
    });
    await syncPlan(db(), shopify.graphql, shop.id, id);
    expect([...shopify.groups.values()][0].products.nodes).toEqual([
      { id: "gid://shopify/Product/2" },
    ]);
  });

  it("recovers when Shopify made the group but D1 lost its ID: the retry adopts it", async () => {
    const { shop, id } = await newPlan();
    const shopify = fakeShopify();
    // The write that stores the group's IDs fails once, after Shopify created the group.
    const failing = createDb(env.DB);
    let failed = false;
    const original = failing.plan.updateMany.bind(failing.plan);
    vi.spyOn(failing.plan, "updateMany").mockImplementation(((args: {
      data: object;
    }) => {
      if (!failed && "sellingPlanGroupGid" in args.data) {
        failed = true;
        return Promise.reject(new Error("D1 unavailable"));
      }
      return original(args as never);
    }) as never);

    await expect(
      syncPlan(failing, shopify.graphql, shop.id, id),
    ).rejects.toThrow("D1 unavailable");

    expect(shopify.groups.size).toBe(1);
    expect(await row(id)).toMatchObject({
      sellingPlanGroupGid: null,
      syncStatus: "ERROR",
      syncLeaseUntil: null, // the merchant or the queue can retry at once
    });

    const result = await syncPlan(db(), shopify.graphql, shop.id, id);

    expect(result?.status).toBe("SYNCED");
    expect(shopify.groups.size).toBe(1);
    expect(shopify.count("PlanGroupCreate")).toBe(1);
    const [group] = [...shopify.groups.values()];
    expect((await row(id)).sellingPlanGroupGid).toBe(group.id);
  });

  it("adopts the right group when the shop has several plans, even though Shopify's search is loose", async () => {
    const shop = await newShop();
    const a = await createPlan(db(), shop.id, `key-${++n}-aaaaaa`, input());
    const b = await createPlan(
      db(),
      shop.id,
      `key-${++n}-bbbbbb`,
      input({ displayName: "Other" }),
    );
    const shopify = fakeShopify();
    await syncPlan(db(), shopify.graphql, shop.id, a.id);
    await syncPlan(db(), shopify.graphql, shop.id, b.id);
    const lost = await row(b.id);
    await db().plan.update({
      where: { id: b.id },
      data: { sellingPlanGroupGid: null, sellingPlanGid: null },
    });

    await syncPlan(db(), shopify.graphql, shop.id, b.id);

    expect(shopify.groups.size).toBe(2);
    expect((await row(b.id)).sellingPlanGroupGid).toBe(
      lost.sellingPlanGroupGid,
    );
    expect((await row(a.id)).sellingPlanGroupGid).not.toBe(
      lost.sellingPlanGroupGid,
    );
  });

  it("leaves a retryable error when Shopify doesn't answer, then finishes on retry", async () => {
    const { shop, id } = await newPlan();
    const shopify = fakeShopify();
    shopify.hooks.failOn = "PlanGroupCreate";

    await expect(syncPlan(db(), shopify.graphql, shop.id, id)).rejects.toThrow(
      "Shopify is down",
    );
    expect(await row(id)).toMatchObject({
      syncStatus: "ERROR",
      sellingPlanGroupGid: null,
      syncMessage: "Couldn't reach Shopify. The sync will try again.",
    });

    shopify.hooks.failOn = undefined;
    await syncPlan(db(), shopify.graphql, shop.id, id);
    expect(shopify.groups.size).toBe(1);
    expect((await row(id)).syncStatus).toBe("SYNCED");
  });

  it("stores Shopify's refusal for the merchant and doesn't retry it", async () => {
    const { shop, id } = await newPlan();
    const shopify = fakeShopify();
    shopify.hooks.refuse = "Name can't be blank";

    expect(await syncPlan(db(), shopify.graphql, shop.id, id)).toBeNull();
    expect(await row(id)).toMatchObject({
      syncStatus: "ERROR",
      syncMessage: "Shopify refused the change: Name can't be blank",
    });
  });

  it("reports a mismatch when Shopify doesn't hold what was written", async () => {
    const { shop, id } = await newPlan();
    const shopify = fakeShopify();
    await syncPlan(db(), shopify.graphql, shop.id, id);
    shopify.hooks.ignoreUpdates = true;
    await updatePlan(db(), shop.id, id, { ...input(), priceCents: 9900 });

    const result = await syncPlan(db(), shopify.graphql, shop.id, id);

    expect(result?.status).toBe("MISMATCH");
    const saved = await row(id);
    expect(saved.syncStatus).toBe("MISMATCH");
    expect(saved.syncMessage).toContain("Price");
    expect(saved.syncMessage).toContain("9900");
  });

  it("finds a change made in Shopify's admin and puts it back", async () => {
    const { shop, id } = await newPlan();
    const shopify = fakeShopify();
    await syncPlan(db(), shopify.graphql, shop.id, id);
    const [group] = [...shopify.groups.values()];
    group.sellingPlans.nodes[0].name = "Edited in Shopify";
    group.products.nodes.push({ id: "gid://shopify/Product/99" });

    await syncPlan(db(), shopify.graphql, shop.id, id);

    expect(group.sellingPlans.nodes[0].name).toBe("Yearly subscription");
    expect(group.products.nodes).toEqual([{ id: "gid://shopify/Product/1" }]);
    expect((await row(id)).syncStatus).toBe("SYNCED");
  });

  it("won't run two syncs of one plan at once", async () => {
    const { shop, id } = await newPlan();
    const shopify = fakeShopify();
    let second: Promise<unknown> | undefined;
    shopify.hooks.after = {
      PlanGroupCreate: async () => {
        second = syncPlan(db(), shopify.graphql, shop.id, id).catch((e) => e);
        expect(await second).toBeInstanceOf(SyncBusy);
      },
    };
    await syncPlan(db(), shopify.graphql, shop.id, id);
    expect(shopify.groups.size).toBe(1);
  });

  it("doesn't mark a plan in sync when it was edited during the sync", async () => {
    const { shop, id } = await newPlan();
    const shopify = fakeShopify();
    shopify.hooks.after = {
      PlanGroupCreate: async () => {
        await updatePlan(db(), shop.id, id, { ...input(), priceCents: 7000 });
      },
    };

    await syncPlan(db(), shopify.graphql, shop.id, id);

    expect(await row(id)).toMatchObject({
      syncStatus: "NOT_SYNCED",
      syncLeaseUntil: null,
    });
    shopify.hooks.after = {};
    await syncPlan(db(), shopify.graphql, shop.id, id);
    expect((await row(id)).syncStatus).toBe("SYNCED");
    expect(
      [...shopify.groups.values()][0].sellingPlans.nodes[0].pricingPolicies[0]
        .adjustmentValue?.amount,
    ).toBe("70");
  });

  it("takes over a lapsed lease", async () => {
    const { shop, id } = await newPlan();
    await db().plan.update({
      where: { id },
      data: {
        syncStatus: "SYNCING",
        syncLeaseUntil: new Date(Date.now() - 1000),
      },
    });
    const shopify = fakeShopify();
    expect((await syncPlan(db(), shopify.graphql, shop.id, id))?.status).toBe(
      "SYNCED",
    );
  });

  it("does nothing for another shop's plan", async () => {
    const { id } = await newPlan();
    const other = await newShop();
    const shopify = fakeShopify();
    expect(await syncPlan(db(), shopify.graphql, other.id, id)).toBeNull();
    expect(shopify.calls).toEqual([]);
    expect((await row(id)).syncStatus).toBe("NOT_SYNCED");
  });
});

describe("the product a plan is attached to", () => {
  const product = "gid://shopify/Product/1";

  it("requires a plan, so it can't be bought one time, and tags groups with the app ID", async () => {
    const { shop, id } = await newPlan();
    const shopify = fakeShopify();
    await syncPlan(db(), shopify.graphql, shop.id, id);
    expect(shopify.products.get(product)?.requiresSellingPlan).toBe(true);
    expect([...shopify.groups.values()][0].appId).toBe(SELLING_PLAN_APP_ID);
  });

  it("puts the app ID on a group made before it existed", async () => {
    const { shop, id } = await newPlan();
    const shopify = fakeShopify();
    await syncPlan(db(), shopify.graphql, shop.id, id);
    const [group] = [...shopify.groups.values()];
    group.appId = null;
    const result = await syncPlan(db(), shopify.graphql, shop.id, id);
    expect(group.appId).toBe(SELLING_PLAN_APP_ID);
    expect(result?.status).toBe("SYNCED");
  });

  it("goes back to selling normally when its last plan is turned off", async () => {
    const { shop, id } = await newPlan();
    const shopify = fakeShopify();
    await syncPlan(db(), shopify.graphql, shop.id, id);
    await setPlanActive(db(), shop.id, id, false);
    await syncPlan(db(), shopify.graphql, shop.id, id);
    expect(shopify.products.get(product)?.requiresSellingPlan).toBe(false);
    await setPlanActive(db(), shop.id, id, true);
    await syncPlan(db(), shopify.graphql, shop.id, id);
    expect(shopify.products.get(product)?.requiresSellingPlan).toBe(true);
  });

  it("keeps requiring a plan while another plan is still on it", async () => {
    const shop = await newShop();
    const make = async () =>
      (await createPlan(db(), shop.id, `key-${++n}-aaaaaa`, input())).id;
    const [a, b] = [await make(), await make()];
    const shopify = fakeShopify();
    await syncPlan(db(), shopify.graphql, shop.id, a);
    await syncPlan(db(), shopify.graphql, shop.id, b);
    await setPlanActive(db(), shop.id, a, false);
    await syncPlan(db(), shopify.graphql, shop.id, a);
    expect(shopify.products.get(product)?.requiresSellingPlan).toBe(true);
    await setPlanActive(db(), shop.id, b, false);
    await syncPlan(db(), shopify.graphql, shop.id, b);
    expect(shopify.products.get(product)?.requiresSellingPlan).toBe(false);
  });

  it("releases the old product and requires a plan on the new one when the plan moves", async () => {
    const { shop, id } = await newPlan();
    const shopify = fakeShopify();
    await syncPlan(db(), shopify.graphql, shop.id, id);
    await updatePlan(db(), shop.id, id, {
      ...input(),
      productGid: "gid://shopify/Product/2",
    });
    await syncPlan(db(), shopify.graphql, shop.id, id);
    expect(shopify.products.get(product)?.requiresSellingPlan).toBe(false);
    expect(
      shopify.products.get("gid://shopify/Product/2")?.requiresSellingPlan,
    ).toBe(true);
  });

  it("a sync dying right after it removes a plan doesn't leave the product unbuyable", async () => {
    const { shop, id } = await newPlan();
    const shopify = fakeShopify();
    await syncPlan(db(), shopify.graphql, shop.id, id);
    await setPlanActive(db(), shop.id, id, false);
    shopify.hooks.after = {
      PlanGroupRemoveProducts: () => {
        shopify.hooks.after = {};
        throw new Error("crashed");
      },
    };
    await expect(syncPlan(db(), shopify.graphql, shop.id, id)).rejects.toThrow("crashed");
    await syncPlan(db(), shopify.graphql, shop.id, id, new Date(Date.now() + 10 * 60 * 1000));
    expect([...shopify.groups.values()][0].products.nodes).toEqual([]);
    expect(shopify.products.get(product)?.requiresSellingPlan).toBe(false);
  });

  it("reports a variant that doesn't ship, because checkout wouldn't ask for an address", async () => {
    const { shop, id } = await newPlan();
    const shopify = fakeShopify();
    shopify.products.set(product, {
      requiresSellingPlan: false,
      unshippable: 2,
    });
    const result = await syncPlan(db(), shopify.graphql, shop.id, id);
    expect(result?.status).toBe("MISMATCH");
    expect(result?.message).toMatch(/2 variant\(s\).*shipping address/);
    expect((await row(id)).syncStatus).toBe("MISMATCH");
  });

  it("doesn't call shipping on a product the plan has left", async () => {
    const { shop, id } = await newPlan();
    const shopify = fakeShopify();
    await syncPlan(db(), shopify.graphql, shop.id, id);
    shopify.products.get(product)!.unshippable = 1;
    await setPlanActive(db(), shop.id, id, false);
    const result = await syncPlan(db(), shopify.graphql, shop.id, id);
    expect(result?.status).toBe("SYNCED");
  });
});

describe("describeDifferences", () => {
  it("is empty for a group that matches, whatever the order of its products", async () => {
    const { shop, id } = await newPlan();
    const shopify = fakeShopify();
    await syncPlan(db(), shopify.graphql, shop.id, id);
    const [group] = [...shopify.groups.values()];
    const plan = {
      ...(await row(id)),
      productGid: "gid://shopify/Product/1",
    } as SyncablePlan;
    expect(describeDifferences(plan, group, "USD")).toEqual([]);
  });

  it("names each thing that differs", async () => {
    const { shop, id } = await newPlan();
    const shopify = fakeShopify();
    await syncPlan(db(), shopify.graphql, shop.id, id);
    const [group] = [...shopify.groups.values()];
    group.sellingPlans.nodes[0].billingPolicy = {
      interval: "MONTH",
      intervalCount: 1,
      minCycles: null,
      maxCycles: 3,
    };
    const differences = describeDifferences(
      (await row(id)) as SyncablePlan,
      group,
      "USD",
    );
    expect(differences.join("\n")).toMatch(/Billing interval/);
    expect(differences.join("\n")).toMatch(/Billing cycle limits/);
  });
});

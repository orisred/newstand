import type { createDb } from "./db.server";
import { logEvent } from "./logger.server";

type Db = ReturnType<typeof createDb>;

/** Runs one Admin API operation and returns its `data`. Throws on transport or GraphQL errors. */
export type Graphql = (
  query: string,
  variables?: Record<string, unknown>,
) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Shopify is limiting the Admin API. Nothing is wrong with the request. */
class AdminThrottled extends Error {}
export const isThrottled = (error: unknown) => error instanceof AdminThrottled;

/** Wraps the app library's Admin API client. GraphQL errors (including throttling) throw, so the job retries. */
export function graphqlOf(admin: {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}): Graphql {
  return async (query, variables) => {
    const body = (await (await admin.graphql(query, { variables })).json()) as {
      data?: unknown;
      errors?: unknown;
    };
    if (body.errors && /"THROTTLED"|"networkStatusCode":429/.test(JSON.stringify(body.errors))) {
      throw new AdminThrottled("Admin API is limiting requests");
    }
    if (body.errors || !body.data) throw new Error("Admin API returned errors");
    return body.data;
  };
}

/** The name of the option customers pick between on a product. Not a release word. */
export const GROUP_OPTION_NAME = "Subscription";

/**
 * Set on every group. Liquid exposes it as `selling_plan_group.app_id`, which is how the theme
 * block shows only this app's plans. The block compares against the same string.
 */
export const SELLING_PLAN_APP_ID = "release-subscriptions";

/** Long enough for a sync to finish; short enough that a crashed one doesn't block a retry. */
const LEASE_MS = 2 * 60 * 1000;

/** Shopify refused the request. Retrying the same thing won't help, so the job doesn't retry. */
export class SyncRefused extends Error {}
/** Another sync of this plan is running. The job retries once it has finished. */
export class SyncBusy extends Error {}

export type SyncablePlan = {
  id: string;
  displayName: string;
  billingMode: "PER_RELEASE" | "PREPAID_BUNDLE";
  termMonths: number | null;
  priceCents: number;
  currency: string;
  active: boolean;
  productGid: string | null;
  sellingPlanGroupGid: string | null;
};

/**
 * One billing and delivery interval, and the only schedule Shopify holds for the plan.
 *
 * The app creates every later charge and order itself, so this schedule drives nothing:
 * Shopify never bills a contract on its own (only a billing attempt from the app does),
 * and the delivery policy only labels the contract. The values are chosen so the contract's
 * dates stay meaningful and out of the way:
 * - a bundle: its term, so the contract's next billing date is the term date;
 * - pay per release: 12 months, because releases don't follow a schedule. Not `YEAR` x 1, which a
 *   12-month bundle has: Shopify puts plans with the same cycle on one contract, and nothing stops
 *   both in one cart where the cart rule can't run (N, 2026-11-05; "Cutover and install").
 * No anchors, cutoff or cycle limits, so nothing caps how many cycles the app can bill.
 */
export function cycleOf(
  plan: Pick<SyncablePlan, "billingMode" | "termMonths">,
) {
  if (plan.billingMode !== "PREPAID_BUNDLE") return { interval: "MONTH", intervalCount: 12 };
  const months = plan.termMonths;
  if (!months) return { interval: "YEAR", intervalCount: 1 };
  return months % 12 === 0
    ? { interval: "YEAR", intervalCount: months / 12 }
    : { interval: "MONTH", intervalCount: months };
}

const dollars = (cents: number) => (cents / 100).toFixed(2);

function sellingPlanFields(plan: SyncablePlan) {
  const cycle = cycleOf(plan);
  return {
    name: plan.displayName,
    category: "SUBSCRIPTION",
    options: [plan.displayName],
    billingPolicy: { recurring: { ...cycle } },
    deliveryPolicy: {
      recurring: {
        ...cycle,
        intent: "FULFILLMENT_BEGIN",
        preAnchorBehavior: "ASAP",
      },
    },
    // The plan's price replaces the product's price at checkout, for every cycle.
    pricingPolicies: [
      {
        fixed: {
          adjustmentType: "PRICE",
          adjustmentValue: { fixedValue: dollars(plan.priceCents) },
        },
      },
    ],
  };
}

/** The group is named for what the customer sees; `merchantCode` ties it back to the plan. */
export function groupCreateInput(plan: SyncablePlan) {
  return {
    name: plan.displayName,
    appId: SELLING_PLAN_APP_ID,
    merchantCode: plan.id,
    options: [GROUP_OPTION_NAME],
    sellingPlansToCreate: [sellingPlanFields(plan)],
  };
}

export function groupUpdateInput(plan: SyncablePlan, sellingPlanGid: string) {
  return {
    name: plan.displayName,
    appId: SELLING_PLAN_APP_ID,
    sellingPlansToUpdate: [{ id: sellingPlanGid, ...sellingPlanFields(plan) }],
  };
}

const GROUP_FIELDS = `
  id name appId merchantCode options
  sellingPlans(first: 10) { nodes {
    id name options category
    billingPolicy { ... on SellingPlanRecurringBillingPolicy { interval intervalCount minCycles maxCycles } }
    deliveryPolicy { ... on SellingPlanRecurringDeliveryPolicy { interval intervalCount intent preAnchorBehavior cutoff } }
    pricingPolicies { ... on SellingPlanFixedPricingPolicy { adjustmentType adjustmentValue { ... on MoneyV2 { amount currencyCode } } } }
  } }
  products(first: 50) { nodes { id } }`;

const FIND_GROUP = `#graphql
  query PlanGroupById($id: ID!) {
    shop { currencyCode }
    sellingPlanGroup(id: $id) { ${GROUP_FIELDS} }
  }`;

const FIND_GROUP_BY_CODE = `#graphql
  query PlanGroupByCode($query: String!) {
    shop { currencyCode }
    sellingPlanGroups(first: 50, query: $query) { nodes { ${GROUP_FIELDS} } }
  }`;

const CREATE_GROUP = `#graphql
  mutation PlanGroupCreate($input: SellingPlanGroupInput!, $resources: SellingPlanGroupResourceInput) {
    sellingPlanGroupCreate(input: $input, resources: $resources) {
      sellingPlanGroup { id sellingPlans(first: 1) { nodes { id } } }
      userErrors { message }
    }
  }`;

const UPDATE_GROUP = `#graphql
  mutation PlanGroupUpdate($id: ID!, $input: SellingPlanGroupInput!) {
    sellingPlanGroupUpdate(id: $id, input: $input) {
      sellingPlanGroup { id }
      userErrors { message }
    }
  }`;

const ADD_PRODUCTS = `#graphql
  mutation PlanGroupAddProducts($id: ID!, $productIds: [ID!]!) {
    sellingPlanGroupAddProducts(id: $id, productIds: $productIds) {
      sellingPlanGroup { id }
      userErrors { message }
    }
  }`;

const REMOVE_PRODUCTS = `#graphql
  mutation PlanGroupRemoveProducts($id: ID!, $productIds: [ID!]!) {
    sellingPlanGroupRemoveProducts(id: $id, productIds: $productIds) {
      removedProductIds
      userErrors { message }
    }
  }`;

const PRODUCT_STATE = `#graphql
  query PlanProducts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        requiresSellingPlan
        sellingPlanGroupsCount { count }
        variants(first: 100) { nodes { inventoryItem { requiresShipping } } }
      }
    }
  }`;

const SET_REQUIRES_PLAN = `#graphql
  mutation PlanProductRequires($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id }
      userErrors { message }
    }
  }`;

export type ShopifyGroup = {
  id: string;
  name: string;
  appId: string | null;
  merchantCode: string | null;
  options: string[];
  sellingPlans: {
    nodes: {
      id: string;
      name: string;
      options: string[];
      category: string;
      billingPolicy: Record<string, unknown> | null;
      deliveryPolicy: Record<string, unknown> | null;
      pricingPolicies: {
        adjustmentType?: string;
        adjustmentValue?: { amount?: string; currencyCode?: string };
      }[];
    }[];
  };
  products: { nodes: { id: string }[] };
};

const quote = (value: unknown) => JSON.stringify(value);

/**
 * Every way the Shopify group differs from the plan, in words for the merchant. Empty means
 * they match. Compares what the customer sees (names, price), the schedule and the products.
 */
export function describeDifferences(
  plan: SyncablePlan,
  group: ShopifyGroup,
  currency: string,
) {
  const differences: string[] = [];
  const check = (label: string, shopify: unknown, app: unknown) => {
    if (JSON.stringify(shopify) !== JSON.stringify(app)) {
      differences.push(
        `${label}: Shopify has ${quote(shopify)}, expected ${quote(app)}`,
      );
    }
  };

  check("Group name", group.name, plan.displayName);
  check("Group code", group.merchantCode, plan.id);
  check("Group app ID", group.appId, SELLING_PLAN_APP_ID);
  check("Group options", group.options, [GROUP_OPTION_NAME]);

  const plans = group.sellingPlans.nodes;
  if (plans.length !== 1) {
    differences.push(
      `Shopify has ${plans.length} selling plans in the group, expected 1`,
    );
  } else {
    const [selling] = plans;
    const expected = sellingPlanFields(plan);
    const cycle = cycleOf(plan);
    check("Selling plan name", selling.name, expected.name);
    check("Selling plan options", selling.options, expected.options);
    check("Category", selling.category, expected.category);
    const billing = selling.billingPolicy as Record<string, unknown> | null;
    check(
      "Billing interval",
      [billing?.interval, billing?.intervalCount],
      [cycle.interval, cycle.intervalCount],
    );
    check(
      "Billing cycle limits",
      [billing?.minCycles ?? null, billing?.maxCycles ?? null],
      [null, null],
    );
    const delivery = selling.deliveryPolicy as Record<string, unknown> | null;
    check(
      "Delivery interval",
      [delivery?.interval, delivery?.intervalCount],
      [cycle.interval, cycle.intervalCount],
    );
    check(
      "Delivery intent",
      [delivery?.intent, delivery?.preAnchorBehavior, delivery?.cutoff ?? null],
      ["FULFILLMENT_BEGIN", "ASAP", null],
    );
    const [pricing] = selling.pricingPolicies;
    check(
      "Price",
      pricing
        ? [
            pricing.adjustmentType,
            Math.round(Number(pricing.adjustmentValue?.amount) * 100),
            pricing.adjustmentValue?.currencyCode,
          ]
        : null,
      ["PRICE", plan.priceCents, currency],
    );
  }

  const wanted = desiredProducts(plan);
  const attached = group.products.nodes.map((node) => node.id).sort();
  check("Products", attached, wanted);
  return differences;
}

/** An inactive plan is on no product, but stays in Shopify so subscribers aren't affected. */
function desiredProducts(plan: SyncablePlan) {
  return plan.active && plan.productGid ? [plan.productGid] : [];
}

async function run(
  graphql: Graphql,
  query: string,
  variables: Record<string, unknown>,
  key: string,
) {
  const data = await graphql(query, variables);
  const errors: { message: string }[] = data[key]?.userErrors ?? [];
  if (errors.length > 0) {
    throw new SyncRefused(errors.map((error) => error.message).join("; "));
  }
  return data[key];
}

/**
 * Keeps the product from being bought outside a plan, and says when it can't ship.
 * - A product with plans must require one, or a one-time purchase makes an order with no
 *   subscription behind it. Set when a plan is attached.
 * - A product losing its last selling plan group goes back to selling normally, because one that
 *   requires a plan and has none can't be bought at all. This runs just before the group comes off, so
 *   it still counts that group, and so a sync dying between the two leaves a product that can be bought:
 *   its retry still sees the plan on it, which it wouldn't if the plan had already come off.
 * - The subscription item must be shippable so checkout always asks for an address; a variant
 *   that isn't is reported as a difference, since the app can't fix it without changing stock.
 */
async function settleProducts(
  graphql: Graphql,
  attached: string[],
  detached: string[],
) {
  const ids = [...attached, ...detached];
  if (ids.length === 0) return [];
  type State = {
    id: string;
    requiresSellingPlan: boolean;
    sellingPlanGroupsCount: { count: number };
    variants: { nodes: { inventoryItem: { requiresShipping: boolean } }[] };
  };
  const { nodes } = (await graphql(PRODUCT_STATE, { ids })) as {
    nodes: (State | null)[];
  };
  const differences: string[] = [];
  for (const product of nodes) {
    if (!product) continue;
    const isAttached = attached.includes(product.id);
    const wantRequired = isAttached || product.sellingPlanGroupsCount.count > 1;
    if (product.requiresSellingPlan !== wantRequired) {
      await run(
        graphql,
        SET_REQUIRES_PLAN,
        { product: { id: product.id, requiresSellingPlan: wantRequired } },
        "productUpdate",
      );
    }
    const unshippable = product.variants.nodes.filter(
      (variant) => !variant.inventoryItem.requiresShipping,
    ).length;
    if (isAttached && unshippable > 0) {
      differences.push(
        `${unshippable} variant(s) of the product aren't marked as physical products, so checkout wouldn't ask for a shipping address. Turn on "This is a physical product" for them in Shopify`,
      );
    }
  }
  return differences;
}

async function findGroup(graphql: Graphql, plan: SyncablePlan) {
  if (plan.sellingPlanGroupGid) {
    const data = await graphql(FIND_GROUP, { id: plan.sellingPlanGroupGid });
    if (data.sellingPlanGroup) {
      return {
        group: data.sellingPlanGroup as ShopifyGroup,
        currency: data.shop.currencyCode as string,
      };
    }
  }
  // No stored group, or it was deleted in Shopify. A group this plan made earlier whose ID
  // never reached D1 is found by its code, so a retry can't create a second one. The code
  // has colons in it, so it must be quoted, and the search is loose, so match exactly after.
  const data = await graphql(FIND_GROUP_BY_CODE, {
    query: `merchant_code:${JSON.stringify(plan.id)}`,
  });
  const found = (data.sellingPlanGroups.nodes as ShopifyGroup[]).find(
    (group) => group.merchantCode === plan.id,
  );
  return { group: found ?? null, currency: data.shop.currencyCode as string };
}

export type SyncResult = {
  status: "SYNCED" | "MISMATCH";
  message: string | null;
};

/**
 * Brings the plan's Shopify selling plan group in line with the plan, then reads it back.
 *
 * Order of writes, because D1 and Shopify can't share a transaction:
 * 1. claim the plan (a lease) in D1, so two syncs never run together;
 * 2. find the group: by its stored ID, else by its `merchantCode` (the plan ID), which
 *    recovers a group Shopify made whose ID never reached D1;
 * 3. create or update it in Shopify;
 * 4. store the group and selling plan IDs in D1 right away, before anything else can fail;
 * 5. fix the attached products, read the group back and compare;
 * 6. write the result, but only if the plan wasn't edited meanwhile.
 * Each step can be repeated safely, so any failure leaves a state a retry finishes.
 */
export async function syncPlan(
  db: Db,
  graphql: Graphql,
  shopId: string,
  planId: string,
  now = new Date(),
): Promise<SyncResult | null> {
  const claimed = await db.plan.updateMany({
    where: {
      id: planId,
      shopId,
      OR: [{ syncLeaseUntil: null }, { syncLeaseUntil: { lt: now } }],
    },
    data: {
      syncStatus: "SYNCING",
      syncLeaseUntil: new Date(now.getTime() + LEASE_MS),
    },
  });
  if (claimed.count === 0) {
    const exists = await db.plan.findFirst({
      where: { id: planId, shopId },
      select: { id: true },
    });
    if (!exists) return null; // deleted or not this shop's: nothing to do
    throw new SyncBusy("Another sync of this plan is running");
  }

  const plan = await db.plan.findFirstOrThrow({
    where: { id: planId, shopId },
    select: {
      id: true,
      displayName: true,
      billingMode: true,
      termMonths: true,
      priceCents: true,
      currency: true,
      active: true,
      productGid: true,
      sellingPlanGroupGid: true,
      syncRevision: true,
    },
  });

  const finish = async (data: {
    syncStatus: "SYNCED" | "MISMATCH" | "ERROR";
    syncMessage: string | null;
    syncedAt?: Date;
  }) => {
    // An edit during the sync bumped the revision and set NOT_SYNCED: leave that, so the
    // plan doesn't claim to be in sync with a state it has already moved past.
    await db.plan.updateMany({
      where: { id: planId, shopId, syncRevision: plan.syncRevision },
      data,
    });
    await db.plan.updateMany({
      where: { id: planId, shopId },
      data: { syncLeaseUntil: null },
    });
  };

  try {
    const { group: existing, currency } = await findGroup(graphql, plan);
    const subject: SyncablePlan = { ...plan, currency };
    const wanted = desiredProducts(subject);
    let groupId: string;
    let sellingPlanId: string;

    if (!existing) {
      const created = await run(
        graphql,
        CREATE_GROUP,
        { input: groupCreateInput(subject), resources: { productIds: wanted } },
        "sellingPlanGroupCreate",
      );
      groupId = created.sellingPlanGroup.id;
      sellingPlanId = created.sellingPlanGroup.sellingPlans.nodes[0].id;
    } else {
      groupId = existing.id;
      const [first] = existing.sellingPlans.nodes;
      if (!first) {
        throw new SyncRefused(
          "The group in Shopify has no selling plan. Delete the group in Shopify's purchase options, then sync again.",
        );
      }
      sellingPlanId = first.id;
      const stale = describeDifferences(subject, existing, currency).filter(
        (line) => !line.startsWith("Products"),
      );
      if (stale.length > 0) {
        await run(
          graphql,
          UPDATE_GROUP,
          { id: groupId, input: groupUpdateInput(subject, sellingPlanId) },
          "sellingPlanGroupUpdate",
        );
      }
    }

    // Before anything else can fail: from here a retry updates this group.
    await db.plan.updateMany({
      where: { id: planId, shopId },
      data: {
        sellingPlanGroupGid: groupId,
        sellingPlanGid: sellingPlanId,
        currency,
      },
    });

    let extra: string[] = [];
    if (existing) {
      const attached = existing.products.nodes.map((node) => node.id);
      extra = attached.filter((id) => !wanted.includes(id));
      const missing = wanted.filter((id) => !attached.includes(id));
      if (extra.length > 0) {
        await settleProducts(graphql, [], extra);
        await run(
          graphql,
          REMOVE_PRODUCTS,
          { id: groupId, productIds: extra },
          "sellingPlanGroupRemoveProducts",
        );
      }
      if (missing.length > 0) {
        await run(
          graphql,
          ADD_PRODUCTS,
          { id: groupId, productIds: missing },
          "sellingPlanGroupAddProducts",
        );
      }
    }

    const productIssues = await settleProducts(graphql, wanted, []);

    const back = await graphql(FIND_GROUP, { id: groupId });
    const group = back.sellingPlanGroup as ShopifyGroup | null;
    const differences = group
      ? describeDifferences(subject, group, back.shop.currencyCode)
      : ["Shopify doesn't return the group after it was written"];
    differences.push(...productIssues);

    if (differences.length === 0) {
      await finish({
        syncStatus: "SYNCED",
        syncMessage: null,
        syncedAt: new Date(),
      });
      return { status: "SYNCED", message: null };
    }
    const message =
      `Shopify differs from this plan. ${differences.join(". ")}.`.slice(
        0,
        1000,
      );
    await finish({
      syncStatus: "MISMATCH",
      syncMessage: message,
      syncedAt: new Date(),
    });
    return { status: "MISMATCH", message };
  } catch (error) {
    const refused = error instanceof SyncRefused;
    await finish({
      syncStatus: "ERROR",
      syncMessage: refused
        ? `Shopify refused the change: ${error.message}`.slice(0, 1000)
        : "Couldn't reach Shopify. The sync will try again.",
    });
    logEvent(refused ? "warn" : "error", "plan.sync_failed", {
      planId,
      refused,
    });
    // A refusal won't change on retry; anything else might.
    if (!refused) throw error;
    return null;
  }
}

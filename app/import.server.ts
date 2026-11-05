import type { createDb } from "./db.server";
import type { DueWorkFinder, Job } from "./jobs/runner.server";
import { describeError, logEvent } from "./logger.server";
import { cycleOf, type Graphql, isThrottled } from "./plan-sync.server";
import {
  addMonths,
  IMPORT_HOLD,
  IMPORT_MARKER,
  orderStepReached,
} from "./subscriptions.server";

type Db = ReturnType<typeof createDb>;

/**
 * Rebuilds subscribers from another app, from Shopify's order history and a contacts export. See
 * "Migration import" in docs/DECISIONS.md. The dry run writes only `ImportRun` and `ImportRow`. The
 * real run reads each customer again before it creates anything, so an old report is never trusted.
 */

export const IMPORT_READ_JOB = "import.read";
export const IMPORT_CREATE_JOB = "import.create";

/** The upcoming-charge notice goes out this many days before a term date, so anything sooner misses it. */
export const NOTICE_DAYS = 21;
/** Releasing a hold puts a term date at least this far off, so the notice goes out first. */
const RELEASE_NOTICE_DAYS = NOTICE_DAYS + 1;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A renewal lands near its term date. An order earlier than this before it is a second subscription. */
const RENEWAL_WINDOW_DAYS = 60;
const ORDERS_PER_PAGE = 5;
const MAX_ORDER_PAGES = 20;
const READS_PER_SLICE = 20;
const CREATES_PER_SLICE = 20;
const CONTACTS_PER_REQUEST = 50;
const LEASE_MS = 5 * 60 * 1000;
const WAIT_SECONDS = 60;
const MAX_ATTEMPTS = 5;

export const CATEGORIES_IMPORTED = [
  "READY",
  "HOLD_TERM_PAST",
  "HOLD_RENEWAL_SOON",
  "HOLD_DEPLETED",
  "HOLD_ZERO_PRICE",
  "CANCELLED_OWED",
] as const;

export type Category =
  | (typeof CATEGORIES_IMPORTED)[number]
  | "NO_CUSTOMER"
  | "DUPLICATE_CONTACT"
  | "NO_ORDERS"
  | "UNRECOGNIZED_PLAN"
  | "HISTORY_TOO_LONG"
  | "LAPSED"
  | "CANCELLED_NOTHING_OWED"
  | "GIFT"
  | "ADDRESS_NOT_ALLOWED"
  | "NO_ADDRESS"
  | "REDACTED"
  | "ALREADY_SUBSCRIBED"
  | "CURRENCY_DIFFERS"
  | "PLAN_NOT_READY"
  | "IMPORTED_UNDER_ANOTHER_KEY"
  | "READ_FAILED";

export type Flag =
  | "NO_CARD"
  | "CARD_EXPIRED"
  | "SEVERAL_CARDS"
  | "STATUS_UNKNOWN"
  | "TWO_SUBSCRIPTIONS"
  | "QUANTITY_ABOVE_ONE"
  | "PRICE_DIFFERS_FROM_PLAN"
  | "CHARGES_AT_NEXT_RELEASE"
  | "PREORDER_SKIPPED"
  | "PREORDER_EMAIL_MISSED"
  | "OPEN_RELEASE_SKIPPED"
  | "DATES_ONLY"
  | "ISSUE_NOT_FOUND"
  | "OVER_SHIPPED"
  | "CARRIED_OVER"
  | "HISTORY_BEFORE_LIST"
  | "SHIPPED_AFTER_TERM"
  | "UNRECOGNIZED_LINES"
  | "PARTIAL_REFUND"
  | "PAID_SHIPPING"
  | "PRICE_CHANGE_PENDING"
  | "ADDRESS_FROM_ORDER"
  | "CONTRACT_EXISTS"
  | "CHANGED_SINCE_DRY_RUN"
  | "RENEWED_SINCE_IMPORT";

// ---- settings -----------------------------------------------------------------------------------

export type ImportSettings = {
  /** `match` holds what an order line can be known by: selling plan name, SKU, product or variant ID. */
  plans: { planId: string; match: string[] }[];
  /** Releases shipped under the old app. `match` is empty if no order shows who received it. */
  issues: { number: number; title: string; shippedAt: string; match: string[] }[];
  /** Line properties that mark a purchase as a gift. */
  giftKeys: string[];
  /** Whether the export says who has cancelled. */
  statusKnown: boolean;
};

const tokens = (raw: string) =>
  raw.split(",").map((part) => part.trim()).filter(Boolean);

/**
 * Reads the form. An issue is one line: `number | title | shipped date | what its order lines match`,
 * and the last part is optional. Returns what's wrong rather than guessing.
 */
export function parseSettings(input: {
  plans: Record<string, string>;
  issues: string;
  giftKeys: string;
  statusKnown: boolean;
}): { ok: true; settings: ImportSettings } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const plans = Object.entries(input.plans)
    .map(([planId, raw]) => ({ planId, match: tokens(raw).map((t) => t.toLowerCase()) }))
    .filter((plan) => plan.match.length > 0);
  if (plans.length === 0) errors.push("Say which order lines mean at least one plan.");

  const issues: ImportSettings["issues"] = [];
  input.issues
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line, index) => {
      const [number, title, shipped, match = ""] = line.split("|").map((part) => part.trim());
      const at = new Date(`${shipped}T00:00:00.000Z`);
      if (!/^\d+$/.test(number ?? "") || Number(number) < 1 || !title || Number.isNaN(at.getTime())) {
        errors.push(`Line ${index + 1} of the shipped list needs: number | title | YYYY-MM-DD.`);
        return;
      }
      if (issues.some((issue) => issue.number === Number(number))) {
        errors.push(`Number ${number} is in the shipped list twice.`);
        return;
      }
      issues.push({
        number: Number(number),
        title,
        shippedAt: at.toISOString(),
        match: tokens(match).map((t) => t.toLowerCase()),
      });
    });

  return errors.length
    ? { ok: false, errors }
    : {
        ok: true,
        settings: {
          plans,
          issues,
          giftKeys: tokens(input.giftKeys).map((t) => t.toLowerCase()),
          statusKnown: input.statusKnown,
        },
      };
}

// ---- reading a customer -------------------------------------------------------------------------

const ADDRESS_FIELDS = `firstName lastName company address1 address2 city provinceCode zip countryCode: countryCodeV2 phone`;
const ORDER_FIELDS = `
  id name processedAt test cancelledAt displayFinancialStatus
  totalShippingPriceSet { shopMoney { amount } }
  shippingAddress { ${ADDRESS_FIELDS} }
  lineItems(first: 20) { nodes {
    currentQuantity sku
    product { id } variant { id } sellingPlan { name }
    customAttributes { key }
    discountedUnitPriceAfterAllDiscountsSet { presentmentMoney { amount currencyCode } }
  } }`;

const CUSTOMER = `#graphql
  query ImportCustomer($id: ID!, $size: Int!) {
    customer(id: $id) {
      id firstName lastName
      defaultAddress { ${ADDRESS_FIELDS} }
      paymentMethods(first: 10, showRevoked: false) { nodes {
        id
        instrument { ... on CustomerCreditCard { expiryMonth expiryYear } }
      } }
      subscriptionContracts(first: 50, reverse: true) {
        pageInfo { hasNextPage }
        nodes { id customAttributes { key value } }
      }
      orders(first: $size, sortKey: PROCESSED_AT, reverse: true) {
        pageInfo { hasNextPage endCursor }
        nodes { ${ORDER_FIELDS} }
      }
    }
  }`;

const MORE_ORDERS = `#graphql
  query ImportOrders($id: ID!, $size: Int!, $after: String) {
    customer(id: $id) {
      orders(first: $size, after: $after, sortKey: PROCESSED_AT, reverse: true) {
        pageInfo { hasNextPage endCursor }
        nodes { ${ORDER_FIELDS} }
      }
    }
  }`;

export type Address = Record<string, string | null> & { countryCode: string | null };
export type OrderNode = {
  id: string;
  name: string;
  processedAt: string;
  test: boolean;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  totalShippingPriceSet?: { shopMoney: { amount: string } };
  shippingAddress: Address | null;
  lineItems: {
    nodes: {
      currentQuantity: number;
      sku: string | null;
      product: { id: string } | null;
      variant: { id: string } | null;
      sellingPlan: { name: string } | null;
      customAttributes: { key: string }[];
      discountedUnitPriceAfterAllDiscountsSet: {
        presentmentMoney: { amount: string; currencyCode: string };
      };
    }[];
  };
};
export type CustomerRead = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  defaultAddress: Address | null;
  paymentMethods: {
    nodes: { id: string; instrument?: { expiryMonth?: number; expiryYear?: number } | null }[];
  };
  subscriptionContracts: {
    nodes: { id: string; customAttributes: { key: string; value: string | null }[] }[];
  };
  orders: OrderNode[];
  historyComplete: boolean;
};

/** Everything the import knows about a customer, fresh. Used, then dropped: nothing personal is kept. */
export async function readCustomer(graphql: Graphql, id: string): Promise<CustomerRead | null> {
  const { customer } = await graphql(CUSTOMER, { id, size: ORDERS_PER_PAGE });
  if (!customer) return null;
  const orders: OrderNode[] = [...customer.orders.nodes];
  let { hasNextPage, endCursor } = customer.orders.pageInfo;
  for (let page = 1; hasNextPage && page < MAX_ORDER_PAGES; page++) {
    const more = await graphql(MORE_ORDERS, { id, size: ORDERS_PER_PAGE, after: endCursor });
    if (!more.customer) return null; // erased between pages
    orders.push(...more.customer.orders.nodes);
    ({ hasNextPage, endCursor } = more.customer.orders.pageInfo);
  }
  // Finding a marker is what stops a second contract, so a list cut short can't be trusted either.
  return {
    ...customer,
    orders,
    historyComplete: !hasNextPage && !customer.subscriptionContracts.pageInfo?.hasNextPage,
  };
}

// ---- the rules: one pure function ---------------------------------------------------------------

export type AnalysisPlan = {
  id: string;
  sellingPlanGid: string | null;
  productGid: string | null;
  billingMode: string;
  releasesPerTerm: number;
  termMonths: number | null;
  renewalRule: string;
  priceCents: number;
  currency: string;
  autoRenew: boolean;
};

export type AnalysisContext = {
  settings: ImportSettings;
  plans: AnalysisPlan[];
  /** The app's own releases. */
  releases: { number: number; status: "UNANNOUNCED" | "PREORDER" | "READY" | "SHIPPED" | "CANCELLED" }[];
  orderTiming: "READY_TO_SHIP" | "PREORDER_OPENS";
  allowedCountries: string[];
  cancelled: boolean;
  /** Plans this customer already has a live subscription on, from this app's own checkout. */
  livePlanIds: Set<string>;
  /** Plans whose latest change is a price rise not yet in effect. */
  pendingPricePlanIds: Set<string>;
  now: Date;
};

export type Facts = {
  lastOrderGid?: string;
  lastOrderName?: string;
  lastPurchaseAt?: string;
  purchases?: number;
  quantity?: number;
  priceCents?: number;
  /** What the purchases counted paid for, in all. */
  paid?: number;
  received?: number[];
  /** What earlier purchases had left when the last one was made. */
  carriedOver?: number;
  /** Purchases from before the shipped list starts, left out because what they were used for can't be seen. */
  uncountedPurchases?: number;
  remaining?: number;
  firstReleaseNumber?: number;
  termEndsAt?: string | null;
  /** When the next charge would come: a date, or what it waits for. */
  nextCharge?: "ON_TERM_DATE" | "NEXT_RELEASE" | "WHEN_RELEASES_RUN_OUT" | "HELD" | "NEVER";
  addressCountry?: string | null;
};

export type RowResult = {
  /** Null when there's no purchase to import: the row is about the contact. */
  key: string | null;
  planId: string | null;
  category: Category;
  flags: Flag[];
  facts: Facts;
  /** For the real run only. Never stored. */
  paymentMethodId?: string | null;
  address?: Address | null;
};

type Purchase = {
  order: OrderNode;
  at: string;
  quantity: number;
  priceCents: number;
  currency: string;
  gift: boolean;
};

const idOf = (gid: string) => gid.split("/").pop() ?? gid;
const timeOf = (iso: string) => new Date(iso).getTime();

/** What an order line can be known by, lowercased. */
const lineNames = (line: OrderNode["lineItems"]["nodes"][number]) =>
  [
    line.sellingPlan?.name,
    line.sku,
    line.product && idOf(line.product.id),
    line.variant && idOf(line.variant.id),
  ].flatMap((name) => (name ? [name.toLowerCase()] : []));

/**
 * One customer's purchases on one plan, as separate subscriptions. A later order continues the
 * subscription whose term is ending by then; an order well inside every term is a second one. A plan
 * with no term can't be told apart, so it's one subscription.
 */
function chainsOf(purchases: Purchase[], termMonths: number | null) {
  const chains: Purchase[][] = [];
  for (const purchase of [...purchases].sort((a, b) => a.at.localeCompare(b.at))) {
    const chain =
      termMonths === null
        ? chains[0]
        : chains
            .map((candidate) => ({
              candidate,
              ends: addMonths(new Date(candidate.at(-1)!.at), termMonths).getTime(),
            }))
            .filter(({ ends }) => new Date(purchase.at).getTime() >= ends - RENEWAL_WINDOW_DAYS * DAY_MS)
            .sort((a, b) => a.ends - b.ends)[0]?.candidate;
    if (chain) chain.push(purchase);
    else chains.push([purchase]);
  }
  return chains;
}

/**
 * "If you were charged for 2 you should get 2" (N, 2026-11-05). Walks one subscription's purchases and
 * the listed releases in date order, keeping a balance: a purchase adds what it paid for, and a release
 * they received takes one off, never going below 0. It has to be a running balance, because a release
 * while the balance is 0 was no part of what any purchase paid for: one known only by its date wasn't
 * theirs at all, and one seen on an order is a free copy (`OVER_SHIPPED`). Neither uses up a later purchase.
 *
 * A release known only by its date also stops counting at the end of the latest purchase's term (N,
 * 2026-11-05): with nothing to prove they got it, an extra copy beats shorting someone. An order is proof,
 * so one seen on an order counts whenever it came.
 *
 * A purchase from before the list starts can't be counted, because what it was used for can't be seen.
 * So the walk starts at the first purchase inside the list, or at the last purchase if none is. A list
 * that doesn't reach back then gives what the last purchases alone say, and is flagged, and the merchant
 * can list more. Counting those purchases instead would hand out a free release for each one.
 */
function walkBalance(
  chain: Purchase[],
  paidEach: number,
  termMonths: number | null,
  issues: ImportSettings["issues"],
  orders: OrderNode[],
) {
  const listStart = Math.min(Infinity, ...issues.map((issue) => timeOf(issue.shippedAt)));
  const inList = chain.filter((purchase) => timeOf(purchase.at) >= listStart);
  const counted = inList.length > 0 ? inList : [chain.at(-1)!];
  const startAt = timeOf(counted[0].at);
  const lastPurchase = counted.at(-1)!;

  type Step =
    | { at: number; buy: Purchase }
    | { at: number; issue: number; seen: "order" | "date" | "missing" };
  const steps: Step[] = counted.map((buy) => ({ at: timeOf(buy.at), buy }));
  for (const issue of issues) {
    const shippedAt = timeOf(issue.shippedAt);
    if (issue.match.length === 0) {
      if (shippedAt >= startAt) steps.push({ at: shippedAt, issue: issue.number, seen: "date" });
      continue;
    }
    const onOrders = orders
      .filter(
        (order) =>
          timeOf(order.processedAt) >= startAt &&
          order.lineItems.nodes.some((line) => lineNames(line).some((name) => issue.match.includes(name))),
      )
      .map((order) => timeOf(order.processedAt));
    if (onOrders.length > 0) {
      steps.push({ at: Math.min(...onOrders), issue: issue.number, seen: "order" });
    } else if (shippedAt >= startAt) {
      steps.push({ at: shippedAt, issue: issue.number, seen: "missing" });
    }
  }
  // A purchase and a release at one moment: bought first, as shipping on the day they bought counts.
  steps.sort((a, b) => a.at - b.at || Number("buy" in b) - Number("buy" in a));

  const flags: Flag[] = [];
  const received: number[] = [];
  let balance = 0;
  let paid = 0;
  let carriedOver = 0;
  let termEnd = Infinity;
  for (const step of steps) {
    if ("buy" in step) {
      if (step.buy === lastPurchase) carriedOver = balance;
      balance += paidEach;
      paid += paidEach;
      if (termMonths) termEnd = addMonths(new Date(step.buy.at), termMonths).getTime();
    } else if (step.seen === "missing") {
      if (balance > 0) flags.push("ISSUE_NOT_FOUND");
    } else if (step.seen === "date" && step.at >= termEnd) {
      if (balance > 0) flags.push("SHIPPED_AFTER_TERM");
    } else if (balance > 0) {
      balance--;
      received.push(step.issue);
      if (step.seen === "date") flags.push("DATES_ONLY");
    } else if (step.seen === "order") {
      received.push(step.issue);
      flags.push("OVER_SHIPPED");
    }
  }
  if (carriedOver > 0) flags.push("CARRIED_OVER");
  if (chain.some((purchase) => timeOf(purchase.at) < listStart)) flags.push("HISTORY_BEFORE_LIST");
  return {
    balance,
    paid,
    carriedOver,
    received: received.sort((a, b) => a - b),
    uncounted: chain.length - counted.length,
    flags,
  };
}

/**
 * What a customer's history says, one result per subscription found. The balance comes from `walkBalance`,
 * and `termEndsAt`, the copies and the price from the last purchase. Nothing here reads a clock or a database.
 */
export function analyzeCustomer(customer: CustomerRead, context: AnalysisContext): RowResult[] {
  const { settings, now } = context;
  const single = (category: Category, flags: Flag[] = []): RowResult[] => [
    { key: null, planId: null, category, flags, facts: {} },
  ];
  if (!customer.historyComplete) return single("HISTORY_TOO_LONG");

  // A test order isn't a purchase on a real store, and the app's own checkouts on a test gateway are test orders.
  const orders = customer.orders.filter((order) => !order.test && !order.cancelledAt);
  if (orders.length === 0) return single("NO_ORDERS");

  const matchFor = new Map<string, string>();
  for (const plan of settings.plans) for (const name of plan.match) matchFor.set(name, plan.planId);

  const byPlan = new Map<string, Purchase[]>();
  let unrecognized = false;
  for (const order of orders) {
    const paid =
      order.displayFinancialStatus === "PAID" ||
      order.displayFinancialStatus === "PARTIALLY_REFUNDED";
    const lines = new Map<string, OrderNode["lineItems"]["nodes"]>();
    for (const line of order.lineItems.nodes) {
      const planId = lineNames(line).map((name) => matchFor.get(name)).find(Boolean);
      if (planId) lines.set(planId, [...(lines.get(planId) ?? []), line]);
      else if (line.sellingPlan) unrecognized = true;
    }
    if (!paid) continue;
    for (const [planId, planLines] of lines) {
      const kept = planLines.filter((line) => line.currentQuantity > 0);
      if (kept.length === 0) continue;
      const money = kept[0].discountedUnitPriceAfterAllDiscountsSet.presentmentMoney;
      byPlan.set(planId, [
        ...(byPlan.get(planId) ?? []),
        {
          order,
          at: order.processedAt,
          quantity: kept.reduce((total, line) => total + line.currentQuantity, 0),
          priceCents: Math.round(Number(money.amount) * 100),
          currency: money.currencyCode,
          gift: kept.some((line) =>
            line.customAttributes.some(({ key }) => settings.giftKeys.includes(key.toLowerCase())),
          ),
        },
      ]);
    }
  }
  if (byPlan.size === 0) return single("UNRECOGNIZED_PLAN");

  const found = [...byPlan].flatMap(([planId, purchases]) => {
    const plan = context.plans.find((candidate) => candidate.id === planId);
    return chainsOf(purchases, plan?.billingMode === "PREPAID_BUNDLE" ? (plan.termMonths ?? null) : null)
      .map((chain) => ({ planId, plan, chain }));
  });

  const keyOf = (planId: string, chain: Purchase[]) =>
    `${idOf(customer.id)}:${idOf(planId)}:${idOf(chain[0].order.id)}`;
  const markers = customer.subscriptionContracts.nodes.flatMap((contract) =>
    contract.customAttributes.flatMap(({ key, value }) =>
      key === IMPORT_MARKER && value ? [value] : [],
    ),
  );
  // A marker no chain here explains means this customer was imported under a key that has since changed:
  // a corrected plan mapping, or a first order refunded or cancelled. A chain with no exact match of its
  // own may be that same subscription, and a second contract would charge them twice, so it stays out.
  // A marker that is still among these keys, as with an early renewal that starts a new chain, says nothing
  // against a chain beside it.
  const keys = new Set(found.map(({ planId, chain }) => keyOf(planId, chain)));
  const importedElsewhere = markers.some((marker) => !keys.has(marker));

  return found.map(({ planId, plan, chain }) => {
    const last = chain.at(-1)!;
    const key = keyOf(planId, chain);
    const flags = new Set<Flag>();
    const facts: Facts = {
      lastOrderGid: last.order.id,
      lastOrderName: last.order.name,
      lastPurchaseAt: last.at,
      purchases: chain.length,
      quantity: last.quantity,
      priceCents: last.priceCents,
    };
    const result = (category: Category): RowResult => ({
      key,
      planId,
      category,
      flags: [...flags],
      facts,
    });
    if (unrecognized) flags.add("UNRECOGNIZED_LINES");
    if (found.length > 1) flags.add("TWO_SUBSCRIPTIONS");
    if (markers.includes(key)) flags.add("CONTRACT_EXISTS");
    else if (importedElsewhere) return result("IMPORTED_UNDER_ANOTHER_KEY");
    if (!plan) return result("PLAN_NOT_READY");
    if (last.gift) return result("GIFT");
    if (last.currency !== plan.currency) return result("CURRENCY_DIFFERS");
    if (context.livePlanIds.has(planId)) return result("ALREADY_SUBSCRIBED");
    if (!plan.sellingPlanGid || !plan.productGid) return result("PLAN_NOT_READY");

    const walked = walkBalance(
      chain,
      plan.billingMode === "PER_RELEASE" ? 1 : plan.releasesPerTerm,
      plan.billingMode === "PREPAID_BUNDLE" ? plan.termMonths : null,
      settings.issues,
      orders,
    );
    for (const flag of walked.flags) flags.add(flag);
    const { paid, received, balance: remaining } = walked;
    const termEndsAt =
      plan.billingMode === "PREPAID_BUNDLE" && plan.termMonths
        ? addMonths(new Date(last.at), plan.termMonths)
        : null;

    // Past everything already shipped or at its order step, so the hour after an import can't make
    // an order. A pay-per-release subscriber at 0 is also kept out of an open pre-order, because
    // they'd be charged when it ships and that pre-order's notice has already gone.
    const shippedThrough = Math.max(0, ...settings.issues.map((issue) => issue.number));
    const open = context.releases.filter((release) => release.status !== "CANCELLED");
    const reached = Math.max(
      0,
      ...open.flatMap((release) =>
        orderStepReached(release.status, context.orderTiming) ? [release.number] : [],
      ),
    );
    const preorder = Math.max(
      0,
      ...open.flatMap((release) =>
        release.status === "PREORDER" && !orderStepReached(release.status, context.orderTiming)
          ? [release.number]
          : [],
      ),
    );
    let firstReleaseNumber = Math.max(shippedThrough, reached) + 1;
    if (reached > shippedThrough && remaining > 0) flags.add("OPEN_RELEASE_SKIPPED");
    const perReleaseAtZero = plan.billingMode === "PER_RELEASE" && remaining === 0;
    if (preorder >= firstReleaseNumber) {
      if (perReleaseAtZero && plan.autoRenew) {
        firstReleaseNumber = preorder + 1;
        flags.add("PREORDER_SKIPPED");
      } else if (remaining > 0) {
        flags.add("PREORDER_EMAIL_MISSED");
      }
    }
    Object.assign(facts, {
      paid,
      received,
      carriedOver: walked.carriedOver,
      uncountedPurchases: walked.uncounted,
      remaining,
      firstReleaseNumber,
      termEndsAt: termEndsAt?.toISOString() ?? null,
    } satisfies Facts);

    if (context.cancelled) {
      facts.nextCharge = "NEVER";
      if (remaining === 0) return result("CANCELLED_NOTHING_OWED");
    } else if (!settings.statusKnown) {
      flags.add("STATUS_UNKNOWN");
    }
    const termOver = termEndsAt !== null && termEndsAt <= now;
    const finished =
      remaining === 0 && (termOver || (!plan.autoRenew && !context.cancelled));
    if (finished && !context.cancelled) {
      facts.nextCharge = "NEVER";
      return result("LAPSED");
    }

    const address = customer.defaultAddress ?? last.order.shippingAddress;
    facts.addressCountry = address?.countryCode ?? null;
    if (!customer.defaultAddress && address) flags.add("ADDRESS_FROM_ORDER");
    if (!address) return result("NO_ADDRESS");
    if (!address.countryCode || !context.allowedCountries.includes(address.countryCode)) {
      return result("ADDRESS_NOT_ALLOWED");
    }

    if (last.quantity > 1) flags.add("QUANTITY_ABOVE_ONE");
    if (last.priceCents !== plan.priceCents) flags.add("PRICE_DIFFERS_FROM_PLAN");
    if (last.order.displayFinancialStatus === "PARTIALLY_REFUNDED") flags.add("PARTIAL_REFUND");
    if (Number(last.order.totalShippingPriceSet?.shopMoney.amount ?? 0) > 0) flags.add("PAID_SHIPPING");
    if (context.pendingPricePlanIds.has(planId)) flags.add("PRICE_CHANGE_PENDING");

    const withCard = (category: Category): RowResult => {
      const cards = customer.paymentMethods.nodes;
      const live = (card: (typeof cards)[number]) => {
        const { expiryMonth, expiryYear } = card.instrument ?? {};
        return !expiryYear || !expiryMonth || new Date(Date.UTC(expiryYear, expiryMonth, 1)) > now;
      };
      const card = cards.find(live) ?? cards[0];
      if (category !== "CANCELLED_OWED") {
        if (!card) flags.add("NO_CARD");
        else if (!live(card)) flags.add("CARD_EXPIRED");
        if (cards.length > 1) flags.add("SEVERAL_CARDS");
      }
      return {
        ...result(category),
        paymentMethodId: category === "CANCELLED_OWED" ? null : (card?.id ?? null),
        address: address && {
          ...address,
          firstName: address.firstName ?? customer.firstName ?? null,
          lastName: address.lastName ?? customer.lastName ?? null,
        },
      };
    };

    if (context.cancelled) return withCard("CANCELLED_OWED");

    // Who'd be charged too soon or with no notice if they came in live: on hold for a human instead.
    if (plan.autoRenew) {
      const hold = (category: Category) => {
        facts.nextCharge = "HELD";
        return withCard(category);
      };
      if (last.priceCents === 0) return hold("HOLD_ZERO_PRICE");
      if (termOver) return hold("HOLD_TERM_PAST");
      const depleting =
        plan.billingMode === "PREPAID_BUNDLE" &&
        plan.renewalRule === "ON_DEPLETION" &&
        (remaining === 0 || (remaining === 1 && preorder >= firstReleaseNumber));
      if (depleting) return hold("HOLD_DEPLETED");
      if (
        plan.renewalRule !== "ON_DEPLETION" &&
        termEndsAt &&
        termEndsAt.getTime() - now.getTime() < NOTICE_DAYS * DAY_MS
      ) {
        return hold("HOLD_RENEWAL_SOON");
      }
    }
    if (perReleaseAtZero && plan.autoRenew) flags.add("CHARGES_AT_NEXT_RELEASE");
    facts.nextCharge = !plan.autoRenew
      ? "NEVER"
      : plan.billingMode === "PER_RELEASE"
        ? "NEXT_RELEASE"
        : plan.renewalRule === "ON_DEPLETION"
          ? "WHEN_RELEASES_RUN_OUT"
          : "ON_TERM_DATE";
    return withCard("READY");
  });
}

/** What a report compares between the dry run and the real run. */
const compared = (row: { category: string | null; facts: Facts }) =>
  JSON.stringify([
    row.category,
    row.facts.lastOrderGid,
    row.facts.remaining,
    row.facts.termEndsAt,
    row.facts.quantity,
    row.facts.priceCents,
    row.facts.firstReleaseNumber,
  ]);

// ---- starting ------------------------------------------------------------------------------------

const SCOPES = `#graphql
  query ImportScopes { currentAppInstallation { accessScopes { handle } } }`;

export async function hasAllOrders(graphql: Graphql) {
  const { currentAppInstallation } = await graphql(SCOPES);
  return (currentAppInstallation.accessScopes as { handle: string }[]).some(
    ({ handle }) => handle === "read_all_orders",
  );
}

/**
 * A new dry run. Refused while a real run is going, and if a number in the shipped list belongs to a
 * release that hasn't shipped, because it would stand in the way of filling the list in. Without
 * `read_all_orders`, older orders are silently missing, so the run is refused rather than wrong.
 */
export async function startRun(
  db: Db,
  graphql: Graphql,
  shopId: string,
  settings: ImportSettings,
): Promise<{ runId: string } | { error: string }> {
  if (await db.importRun.count({ where: { shopId, status: "IMPORTING" } })) {
    return { error: "A real run is still going. Wait for it to finish." };
  }
  if (!(await hasAllOrders(graphql))) {
    return { error: "The app needs the read_all_orders permission, or orders older than 60 days can't be read." };
  }
  const clash = await db.release.findFirst({
    where: {
      shopId,
      number: { in: settings.issues.map((issue) => issue.number) },
      status: { not: "SHIPPED" },
    },
    select: { number: true },
  });
  if (clash) {
    return { error: `Release ${clash.number} exists here and hasn't shipped, so it can't also be in the shipped list.` };
  }
  const id = crypto.randomUUID();
  await db.importRun.create({ data: { id, shopId, settings } });
  return { runId: id };
}

export type Contact = { number: number; email: string; cancelled: boolean };

/**
 * One batch of contacts from the browser, which keeps the export to itself and sends only each
 * contact's email and whether they cancelled. The email is used to find the customer and dropped:
 * it reaches neither D1, nor a log, nor a queue. Checked live: a malformed address is simply not found,
 * with no GraphQL error, so one bad line can't fail its batch; case and surrounding spaces don't matter.
 */
export async function addContacts(
  rawDb: D1Database,
  graphql: Graphql,
  shopId: string,
  runId: string,
  contacts: Contact[],
) {
  const batch = contacts.slice(0, CONTACTS_PER_REQUEST);
  const withEmail = batch.filter((contact) => contact.email.includes("@"));
  const found = new Map<number, string>();
  if (withEmail.length > 0) {
    const query = `query ImportContacts(${withEmail.map((_, i) => `$e${i}: String!`).join(", ")}) {
      ${withEmail.map((_, i) => `c${i}: customerByIdentifier(identifier: { emailAddress: $e${i} }) { id }`).join("\n")}
    }`;
    const data = await graphql(query, Object.fromEntries(withEmail.map((c, i) => [`e${i}`, c.email])));
    withEmail.forEach((contact, i) => {
      if (data[`c${i}`]) found.set(contact.number, data[`c${i}`].id);
    });
  }
  const stamp = new Date().toISOString();
  await rawDb.batch(
    batch.map((contact) => {
      const customerGid = found.get(contact.number) ?? null;
      return rawDb
        .prepare(
          `INSERT INTO "ImportRow" ("id", "shopId", "key", "runId", "contactNumber", "customerGid",
             "contactCancelled", "state", "category", "updatedAt")
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
           ON CONFLICT ("shopId", "key") DO UPDATE SET "customerGid" = excluded."customerGid",
             "contactCancelled" = excluded."contactCancelled", "state" = excluded."state",
             "category" = excluded."category", "updatedAt" = excluded."updatedAt"`,
        )
        .bind(
          crypto.randomUUID(),
          shopId,
          `contact:${runId}:${contact.number}`,
          runId,
          contact.number,
          customerGid,
          contact.cancelled ? 1 : 0,
          customerGid ? "TO_READ" : "READ",
          customerGid ? null : "NO_CUSTOMER",
          stamp,
        );
    }),
  );
}

const sliceJob = (type: string, shop: string, runId: string, key: string): Job => ({
  type,
  id: `${type}:${runId}:${key}`,
  shop,
  data: { runId },
});

/** The browser has sent every contact. */
export async function beginRead(db: Db, shop: { id: string; shopDomain: string }, runId: string, now = new Date()) {
  const { count } = await db.importRun.updateMany({
    where: { id: runId, shopId: shop.id, status: "COLLECTING" },
    data: { status: "READING" },
  });
  return count ? [sliceJob(IMPORT_READ_JOB, shop.shopDomain, runId, String(now.getTime()))] : [];
}

/**
 * The real run. Fills in the shipped releases, so a later release's number follows them and everyone's
 * `firstReleaseNumber` means something, and queues who the report says can come in. Marking them is one
 * batch with the run's status, so a repeat does nothing.
 */
export async function beginImport(
  db: Db,
  rawDb: D1Database,
  shop: { id: string; shopDomain: string },
  runId: string,
  now = new Date(),
) {
  const run = await db.importRun.findFirst({
    where: { id: runId, shopId: shop.id, status: "READ" },
    select: { settings: true },
  });
  if (!run) return [];
  const settings = run.settings as ImportSettings;
  const stamp = now.toISOString();
  await rawDb.batch([
    ...settings.issues.map((issue) =>
      rawDb
        .prepare(
          `INSERT INTO "Release" ("id", "shopId", "number", "title", "status", "preorderOpensAt",
             "cutoffAt", "shipAt", "updatedAt")
           VALUES (?1, ?2, ?3, ?4, 'SHIPPED', ?5, ?5, ?5, ?6)
           ON CONFLICT ("shopId", "number") DO NOTHING`,
        )
        .bind(crypto.randomUUID(), shop.id, issue.number, issue.title, issue.shippedAt, stamp),
    ),
    rawDb
      .prepare(
        `UPDATE "ImportRow" SET "state" = 'QUEUED', "updatedAt" = ?2
         WHERE "runId" = ?1 AND "state" = 'READ'
           AND "category" IN (${CATEGORIES_IMPORTED.map((c) => `'${c}'`).join(", ")})`,
      )
      .bind(runId, stamp),
    rawDb
      .prepare(
        `UPDATE "ImportRun" SET "status" = 'IMPORTING', "importedAt" = ?2, "updatedAt" = ?2
         WHERE "id" = ?1 AND "status" = 'READ'`,
      )
      .bind(runId, stamp),
  ]);
  return [sliceJob(IMPORT_CREATE_JOB, shop.shopDomain, runId, String(now.getTime()))];
}

// ---- context for the rules -----------------------------------------------------------------------

async function shopContext(db: Db, shopId: string, settings: ImportSettings, now: Date) {
  const [shop, plans, releases, changes] = await Promise.all([
    db.shop.findUniqueOrThrow({
      where: { id: shopId },
      select: { allowedCountries: true, orderTiming: true },
    }),
    db.plan.findMany({ where: { shopId } }),
    db.release.findMany({ where: { shopId }, select: { number: true, status: true } }),
    db.priceChange.findMany({
      where: { plan: { shopId } },
      orderBy: { createdAt: "desc" },
      select: { planId: true, policy: true, effectiveAt: true },
    }),
  ]);
  const latest = new Map<string, (typeof changes)[number]>();
  for (const change of changes) if (!latest.has(change.planId)) latest.set(change.planId, change);
  return {
    settings,
    plans,
    releases,
    orderTiming: shop.orderTiming,
    allowedCountries: shop.allowedCountries as string[],
    pendingPricePlanIds: new Set(
      [...latest.values()]
        .filter((change) => change.policy === "APPLY_AT_RENEWAL" && change.effectiveAt > now)
        .map((change) => change.planId),
    ),
    now,
  };
}

const livePlans = async (db: Db, shopId: string, customerGid: string) =>
  new Set(
    (
      await db.subscription.findMany({
        where: {
          shopId,
          customerGid,
          source: { not: "IMPORTED" },
          status: { in: ["ACTIVE", "PAUSED"] },
        },
        select: { planId: true },
      })
    ).map((row) => row.planId),
  );

// ---- the dry run's slices ------------------------------------------------------------------------

/**
 * Reads a page of contacts and writes what it found. Writes only `ImportRow`. A row already imported
 * keeps what it is, and is flagged if the customer has bought again since, which is a renewal in the
 * old app and a double charge coming unless someone looks.
 */
export async function runReadSlice(
  db: Db,
  rawDb: D1Database,
  graphqlFor: () => Promise<Graphql>,
  job: Job,
  clock: () => Date = () => new Date(),
): Promise<{ job: Job; delaySeconds: number } | null> {
  const runId = String(job.data?.runId);
  const run = await db.importRun.findUnique({
    where: { id: runId },
    select: { status: true, shopId: true, settings: true },
  });
  if (run?.status !== "READING") return null;
  const now = clock();
  const shop = await db.shop.findUniqueOrThrow({
    where: { id: run.shopId },
    select: { shopDomain: true },
  });
  const rows = await db.importRow.findMany({
    where: { runId, state: "TO_READ" },
    orderBy: { contactNumber: "asc" },
    take: READS_PER_SLICE,
    select: { id: true, key: true, customerGid: true, contactNumber: true, attempts: true },
  });
  const settings = run.settings as ImportSettings;
  const context = rows.length ? await shopContext(db, run.shopId, settings, now) : null;
  const graphql = rows.length ? await graphqlFor() : null;

  for (const row of rows) {
    // An earlier row in this page may have taken it as a duplicate.
    const current = await db.importRow.findUnique({ where: { id: row.id }, select: { state: true } });
    if (current?.state !== "TO_READ") continue;
    const customerGid = row.customerGid!;
    try {
      const siblings = await db.importRow.findMany({
        where: { runId, customerGid, state: "TO_READ" },
        select: { id: true, contactCancelled: true },
      });
      const customer = await readCustomer(graphql!, customerGid);
      const results = customer
        ? analyzeCustomer(customer, {
            ...context!,
            // Two lines for one person that disagree can't be told apart, so no line charges them.
            cancelled: siblings.some((sibling) => sibling.contactCancelled),
            livePlanIds: await livePlans(db, run.shopId, customerGid),
          })
        : ([{ key: null, planId: null, category: "REDACTED", flags: [], facts: {} }] satisfies RowResult[]);
      const stamp = now.toISOString();
      const others = siblings.filter((sibling) => sibling.id !== row.id);
      await rawDb.batch([
        ...others.map(({ id }) =>
          rawDb
            .prepare(
              `UPDATE "ImportRow" SET "state" = 'READ', "category" = 'DUPLICATE_CONTACT', "updatedAt" = ?2 WHERE "id" = ?1`,
            )
            .bind(id, stamp),
        ),
        ...results.map((result) =>
          result.key
            ? rawDb
                .prepare(
                  `INSERT INTO "ImportRow" ("id", "shopId", "key", "runId", "contactNumber", "customerGid",
                     "contactCancelled", "planId", "state", "category", "flags", "facts", "updatedAt")
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'READ', ?9, ?10, ?11, ?12)
                   ON CONFLICT ("shopId", "key") DO UPDATE SET
                     "runId" = excluded."runId",
                     "contactNumber" = excluded."contactNumber",
                     "contactCancelled" = excluded."contactCancelled",
                     "updatedAt" = excluded."updatedAt",
                     "flags" = CASE WHEN "state" <> 'DONE' THEN excluded."flags"
                       WHEN json_extract("facts", '$.lastOrderGid') <> ?13 THEN '["RENEWED_SINCE_IMPORT"]'
                       ELSE "flags" END,
                     "category" = CASE WHEN "state" = 'DONE' THEN "category" ELSE excluded."category" END,
                     "planId" = CASE WHEN "state" = 'DONE' THEN "planId" ELSE excluded."planId" END,
                     "facts" = CASE WHEN "state" = 'DONE' THEN "facts" ELSE excluded."facts" END,
                     "error" = CASE WHEN "state" = 'DONE' THEN "error" END,
                     "attempts" = CASE WHEN "state" = 'DONE' THEN "attempts" ELSE 0 END,
                     "state" = CASE WHEN "state" = 'DONE' THEN 'DONE' ELSE 'READ' END`,
                )
                .bind(
                  crypto.randomUUID(),
                  run.shopId,
                  result.key,
                  runId,
                  row.contactNumber,
                  customerGid,
                  siblings.some((sibling) => sibling.contactCancelled) ? 1 : 0,
                  result.planId,
                  result.category,
                  JSON.stringify(result.flags),
                  JSON.stringify(result.facts),
                  stamp,
                  result.facts.lastOrderGid ?? "",
                )
            : rawDb
                .prepare(
                  `UPDATE "ImportRow" SET "state" = 'READ', "category" = ?2, "flags" = ?3, "updatedAt" = ?4 WHERE "id" = ?1`,
                )
                .bind(row.id, result.category, JSON.stringify(result.flags), stamp),
        ),
        // Its findings have their own rows now.
        ...(results.some((result) => result.key)
          ? [rawDb.prepare(`DELETE FROM "ImportRow" WHERE "id" = ?1`).bind(row.id)]
          : []),
      ]);
    } catch (error) {
      // Nothing was written for this row, so the next slice reads it again. Being limited uses no
      // attempts. A row that keeps failing ends in a category of its own, or the report never finishes.
      const attempts = row.attempts + (isThrottled(error) ? 0 : 1);
      const gaveUp = attempts >= MAX_ATTEMPTS;
      await db.importRow.updateMany({
        where: { id: row.id },
        data: gaveUp ? { state: "READ", category: "READ_FAILED", attempts } : { attempts },
      });
      logEvent("warn", gaveUp ? "import.read_failed" : "import.read_waiting", {
        runId,
        rowId: row.id,
        ...describeError(error),
      });
      if (gaveUp) continue;
      return {
        job: sliceJob(IMPORT_READ_JOB, shop.shopDomain, runId, String(now.getTime())),
        delaySeconds: WAIT_SECONDS,
      };
    }
  }

  const left = await db.importRow.count({ where: { runId, state: "TO_READ" } });
  if (left > 0) {
    return {
      job: sliceJob(IMPORT_READ_JOB, shop.shopDomain, runId, String(now.getTime())),
      delaySeconds: 0,
    };
  }
  await db.importRun.updateMany({
    where: { id: runId, status: "READING" },
    data: { status: "READ", readAt: now },
  });
  logEvent("info", "import.read_done", { runId });
  return null;
}

// ---- the real run's slices -----------------------------------------------------------------------

const PLAN_VARIANT = `#graphql
  query ImportPlanVariant($id: ID!) { product(id: $id) { variants(first: 1) { nodes { id } } } }`;

const CREATE_CONTRACT = `#graphql
  mutation ImportContractCreate($input: SubscriptionContractAtomicCreateInput!) {
    subscriptionContractAtomicCreate(input: $input) {
      contract { id }
      userErrors { field code message }
    }
  }`;

/** Shopify's way of saying slow down when it comes back as a userError rather than a GraphQL error. */
const isLimited = (error: { message?: string | null }) =>
  /too many|rate limit|throttl/i.test(error.message ?? "");

class ContractThrottled extends Error {}

/**
 * Creates one contract and its Subscription, from a fresh read. Shopify doesn't dedupe this call:
 * the same input twice makes two contracts, with or without `@idempotent` (checked live). So:
 * 1. the row is leased by the caller, so two runs never create at once;
 * 2. the customer's contracts are read for this row's marker, which finds one whose ID never reached D1;
 * 3. the contract is created carrying the marker, which is also what stops a webhook or the hourly
 *    check treating it as a sign-up, whichever comes first (`syncContract`);
 * 4. the Subscription and the row's result go in one batch.
 * A retry can't come soon after a create: after an error it waits 60 seconds, and after a crash the
 * 5-minute lease has to lapse first. The next slice then finds the contract at step 2. On the dev store a
 * new contract's marker was back on a read about 5 seconds later, the soonest measured; Shopify promises
 * nothing about this read, so a second contract would need it to lag past those waits.
 */
export async function importRow(
  db: Db,
  rawDb: D1Database,
  graphql: Graphql,
  row: {
    id: string;
    key: string;
    shopId: string;
    customerGid: string;
    contactCancelled: boolean;
    category: string | null;
    facts: unknown;
    planId: string | null;
  },
  context: Omit<AnalysisContext, "cancelled" | "livePlanIds">,
  variantFor: (productGid: string) => Promise<string | null>,
  now: Date,
): Promise<"done" | "skipped" | "failed"> {
  const stamp = now.toISOString();
  const finish = async (
    state: "SKIPPED" | "FAILED",
    fields: { category?: string; flags?: string[]; facts?: Facts; error?: string },
  ) => {
    await rawDb
      .prepare(
        `UPDATE "ImportRow" SET "state" = ?2, "category" = COALESCE(?3, "category"),
           "flags" = COALESCE(?4, "flags"), "facts" = COALESCE(?5, "facts"), "error" = ?6,
           "leaseUntil" = NULL, "updatedAt" = ?7
         WHERE "id" = ?1`,
      )
      .bind(
        row.id,
        state,
        fields.category ?? null,
        fields.flags ? JSON.stringify(fields.flags) : null,
        fields.facts ? JSON.stringify(fields.facts) : null,
        fields.error ?? null,
        stamp,
      )
      .run();
    return state === "SKIPPED" ? ("skipped" as const) : ("failed" as const);
  };

  const customer = await readCustomer(graphql, row.customerGid);
  if (!customer) return finish("SKIPPED", { category: "REDACTED", flags: [], facts: {} });
  const results = analyzeCustomer(customer, {
    ...context,
    cancelled: row.contactCancelled,
    livePlanIds: await livePlans(db, row.shopId, row.customerGid),
  });
  const fresh = results.find((result) => result.key === row.key);
  if (!fresh) {
    return finish("SKIPPED", { category: results[0]?.category ?? "NO_ORDERS", flags: ["CHANGED_SINCE_DRY_RUN"] });
  }
  const existing = customer.subscriptionContracts.nodes.find((contract) =>
    contract.customAttributes.some(({ key, value }) => key === IMPORT_MARKER && value === row.key),
  );
  const flags = new Set<Flag>(fresh.flags);
  const dryRun = { category: row.category, facts: row.facts as Facts };
  if (compared(dryRun) !== compared(fresh)) flags.add("CHANGED_SINCE_DRY_RUN");

  if (!(CATEGORIES_IMPORTED as readonly string[]).includes(fresh.category)) {
    if (existing) {
      // An earlier try made a contract and died, and this customer no longer belongs in. Nothing can
      // charge a contract with no Subscription, but someone should look at it.
      return finish("FAILED", {
        category: fresh.category,
        flags: [...flags],
        facts: fresh.facts,
        error: "contract_exists_but_not_importable",
      });
    }
    return finish("SKIPPED", { category: fresh.category, flags: [...flags], facts: fresh.facts });
  }

  const plan = context.plans.find((candidate) => candidate.id === fresh.planId)!;
  const facts = fresh.facts;
  const cancelled = fresh.category === "CANCELLED_OWED";
  let contractGid = existing?.id ?? null;
  if (!contractGid) {
    const variant = await variantFor(plan.productGid!);
    if (!variant) {
      return finish("FAILED", { category: fresh.category, flags: [...flags], facts, error: "plan_product_has_no_variant" });
    }
    const cycle = cycleOf(plan as Parameters<typeof cycleOf>[0]);
    const term = facts.termEndsAt ? new Date(facts.termEndsAt) : null;
    // Only a label: Shopify bills nothing by itself. It can't be in the past.
    const nextBilling = term && term > now ? term : addMonths(now, 12);
    const { address1, address2, city, company, firstName, lastName, phone, provinceCode, zip, countryCode } =
      fresh.address!;
    const started = Date.now();
    const { subscriptionContractAtomicCreate: created } = await graphql(CREATE_CONTRACT, {
      input: {
        customerId: row.customerGid,
        currencyCode: plan.currency,
        nextBillingDate: nextBilling.toISOString(),
        contract: {
          status: cancelled ? "CANCELLED" : "ACTIVE",
          ...(fresh.paymentMethodId ? { paymentMethodId: fresh.paymentMethodId } : {}),
          billingPolicy: cycle,
          deliveryPolicy: cycle,
          // It sticks and bills on every renewal. Shipping is included through a free rate.
          deliveryPrice: "0.00",
          deliveryMethod: {
            shipping: {
              address: { address1, address2, city, company, firstName, lastName, phone, provinceCode, zip, countryCode },
            },
          },
          customAttributes: [{ key: IMPORT_MARKER, value: row.key }],
        },
        lines: [
          {
            line: {
              productVariantId: variant,
              sellingPlanId: plan.sellingPlanGid,
              quantity: facts.quantity,
              currentPrice: (facts.priceCents! / 100).toFixed(2),
            },
          },
        ],
      },
    });
    const errors: { field: string[] | null; code: string | null; message: string | null }[] = created.userErrors;
    if (errors.some(isLimited)) throw new ContractThrottled();
    if (errors.length > 0 || !created.contract) {
      const first = errors[0];
      logEvent("warn", "import.contract_refused", { rowId: row.id, code: first?.code ?? "" });
      return finish("FAILED", {
        category: fresh.category,
        flags: [...flags],
        facts,
        // Shopify's message can quote an address, so it stays out of this.
        error: [first?.code ?? "REFUSED", ...(first?.field ?? [])].join(" "),
      });
    }
    contractGid = created.contract.id as string;
    logEvent("info", "import.contract_created", { rowId: row.id, contractGid, ms: Date.now() - started });
  }

  const subscriptionId = crypto.randomUUID();
  const held = fresh.category.startsWith("HOLD_");
  await rawDb.batch([
    // Only while the row still names this customer: a redaction since then has cleared it, and the
    // contract must then not become a subscription for someone erased.
    rawDb
      .prepare(
        `INSERT INTO "Subscription" ("id", "shopId", "planId", "contractGid", "customerGid", "status", "source",
           "quantity", "releasesRemaining", "firstReleaseNumber", "termEndsAt", "lockedPriceCents", "pausedReason",
           "importedBalance", "noCardSince", "createdAt", "updatedAt")
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'IMPORTED', ?7, ?8, ?9, ?10, ?11, ?12, ?8, ?13, ?14, ?14
         WHERE EXISTS (SELECT 1 FROM "ImportRow" WHERE "id" = ?15 AND "customerGid" = ?5)
         ON CONFLICT ("contractGid") DO NOTHING`,
      )
      .bind(
        subscriptionId,
        row.shopId,
        plan.id,
        contractGid,
        row.customerGid,
        cancelled ? "CANCELLED" : held ? "PAUSED" : "ACTIVE",
        facts.quantity,
        facts.remaining,
        facts.firstReleaseNumber,
        facts.termEndsAt ?? null,
        facts.priceCents,
        held ? IMPORT_HOLD : null,
        !cancelled && !fresh.paymentMethodId ? stamp : null,
        stamp,
        row.id,
      ),
    rawDb
      .prepare(
        `UPDATE "ImportRow" SET "state" = 'DONE', "contractGid" = ?2, "category" = ?3, "flags" = ?4, "facts" = ?5,
           "subscriptionId" = (SELECT "id" FROM "Subscription" WHERE "contractGid" = ?2),
           "leaseUntil" = NULL, "error" = NULL, "updatedAt" = ?6
         WHERE "id" = ?1`,
      )
      .bind(row.id, contractGid, fresh.category, JSON.stringify([...flags]), JSON.stringify(facts), stamp),
  ]);
  return "done";
}

/**
 * One slice of the real run. Each row gets a lease and a fresh read. Being limited isn't failing:
 * the slice stops and the next one comes later. Only the same row going wrong again and again ends in
 * `FAILED`. `findImportWork` starts a new chain each hour, so a dead chain never ends the run.
 */
export async function runCreateSlice(
  db: Db,
  rawDb: D1Database,
  graphqlFor: () => Promise<Graphql>,
  job: Job,
  clock: () => Date = () => new Date(),
): Promise<{ job: Job; delaySeconds: number } | null> {
  const runId = String(job.data?.runId);
  const run = await db.importRun.findUnique({
    where: { id: runId },
    select: { status: true, shopId: true, settings: true },
  });
  if (run?.status !== "IMPORTING") return null;
  const now = clock();
  const shop = await db.shop.findUniqueOrThrow({
    where: { id: run.shopId },
    select: { shopDomain: true },
  });
  const next = (delaySeconds: number) => ({
    job: sliceJob(IMPORT_CREATE_JOB, shop.shopDomain, runId, String(now.getTime())),
    delaySeconds,
  });
  const claimable = {
    runId,
    OR: [{ state: "QUEUED" as const }, { state: "CREATING" as const, leaseUntil: { lte: now } }],
  };
  const rows = await db.importRow.findMany({
    where: claimable,
    orderBy: { contactNumber: "asc" },
    take: CREATES_PER_SLICE,
  });

  if (rows.length > 0) {
    const context = await shopContext(db, run.shopId, run.settings as ImportSettings, now);
    const graphql = await graphqlFor();
    const variants = new Map<string, string | null>();
    const variantFor = async (productGid: string) => {
      if (!variants.has(productGid)) {
        const { product } = await graphql(PLAN_VARIANT, { id: productGid });
        variants.set(productGid, product?.variants.nodes[0]?.id ?? null);
      }
      return variants.get(productGid)!;
    };
    for (const row of rows) {
      const { count } = await db.importRow.updateMany({
        where: { id: row.id, ...claimable },
        data: { state: "CREATING", leaseUntil: new Date(now.getTime() + LEASE_MS) },
      });
      if (count === 0 || !row.customerGid) continue;
      try {
        await importRow(db, rawDb, graphql, { ...row, customerGid: row.customerGid }, context, variantFor, clock());
      } catch (error) {
        const throttled = error instanceof ContractThrottled || isThrottled(error);
        const attempts = row.attempts + (throttled ? 0 : 1);
        // The contract may or may not exist. Back to the queue, and the next try looks before creating.
        await db.importRow.updateMany({
          where: { id: row.id },
          data:
            attempts >= MAX_ATTEMPTS
              ? { state: "FAILED", error: "unexpected", attempts, leaseUntil: null }
              : { state: "QUEUED", attempts, leaseUntil: null },
        });
        logEvent("warn", "import.create_waiting", { runId, rowId: row.id, throttled, ...describeError(error) });
        return next(WAIT_SECONDS);
      }
    }
  }

  const left = await db.importRow.count({
    where: { runId, state: { in: ["QUEUED", "CREATING"] } },
  });
  if (left > 0) return next(rows.length > 0 ? 0 : WAIT_SECONDS);
  await db.importRun.updateMany({
    where: { id: runId, status: "IMPORTING" },
    data: { status: "DONE" },
  });
  logEvent("info", "import.create_done", { runId });
  return null;
}

/** Runs with work left, each hour, so a lost message or a dead chain only costs that hour. */
export const findImportWork: DueWorkFinder = async ({ env, now }) => {
  const { results } = await env.DB.prepare(
    `SELECT r."id", r."status", s."shopDomain" FROM "ImportRun" r
     JOIN "Shop" s ON s."id" = r."shopId"
     JOIN "OfflineSession" o ON o."id" = 'offline_' || s."shopDomain"
     WHERE r."status" IN ('READING', 'IMPORTING')`,
  ).all<{ id: string; status: string; shopDomain: string }>();
  const hour = now.toISOString().slice(0, 13);
  return results.map(({ id, status, shopDomain }) =>
    sliceJob(status === "READING" ? IMPORT_READ_JOB : IMPORT_CREATE_JOB, shopDomain, id, hour),
  );
};

// ---- after the import ----------------------------------------------------------------------------

/**
 * A merchant lets a held subscriber go live. A term date inside the notice period moves out, so the
 * upcoming-charge notice goes first and the charge can't land without it. Bundles on `ON_DEPLETION` at 0
 * have no date to move and are due at once, which the button says. Only a hold can be released here.
 */
export async function releaseImportHold(
  rawDb: D1Database,
  shopId: string,
  subscriptionId: string,
  now = new Date(),
) {
  const earliest = new Date(now.getTime() + RELEASE_NOTICE_DAYS * DAY_MS).toISOString();
  const { meta } = await rawDb
    .prepare(
      `UPDATE "Subscription" SET "status" = 'ACTIVE', "pausedReason" = NULL, "updatedAt" = ?4,
         "termEndsAt" = CASE WHEN "termEndsAt" IS NOT NULL AND julianday("termEndsAt") < julianday(?3)
           THEN ?3 ELSE "termEndsAt" END
       WHERE "id" = ?1 AND "shopId" = ?2 AND "status" = 'PAUSED' AND "pausedReason" = '${IMPORT_HOLD}'`,
    )
    .bind(subscriptionId, shopId, earliest, now.toISOString())
    .run();
  return meta.changes === 1;
}

const ROWS_PER_PAGE = 50;

export type ReportRow = {
  id: string;
  contactNumber: number | null;
  customerGid: string | null;
  planId: string | null;
  state: string;
  category: string | null;
  flags: string;
  facts: string;
  contractGid: string | null;
  subscriptionId: string | null;
  error: string | null;
};

const REPORT_COLUMNS = `"id", "contactNumber", "customerGid", "planId", "state", "category", "flags", "facts",
  "contractGid", "subscriptionId", "error"`;

/** The latest run, its counts and a page of its rows. One round trip. */
export async function importPage(
  db: Db,
  rawDb: D1Database,
  shopId: string,
  filter: string | null,
  page: number,
) {
  const run = await db.importRun.findFirst({
    where: { shopId },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, settings: true, readAt: true, importedAt: true, createdAt: true },
  });
  if (!run) return { run: null, counts: [], rows: [] as ReportRow[], more: false, toCheck: null };
  const [counts, rows, toCheck] = await rawDb.batch<Record<string, unknown>>([
    rawDb
      .prepare(
        `SELECT "state", "category", COUNT(*) AS "n" FROM "ImportRow" WHERE "runId" = ?1
         GROUP BY "state", "category" ORDER BY "category"`,
      )
      .bind(run.id),
    rawDb
      .prepare(
        `SELECT ${REPORT_COLUMNS} FROM "ImportRow" WHERE "runId" = ?1 AND (?2 IS NULL OR "category" = ?2)
         ORDER BY "contactNumber", "key" LIMIT ?3 OFFSET ?4`,
      )
      .bind(run.id, filter, ROWS_PER_PAGE + 1, page * ROWS_PER_PAGE),
    rawDb
      .prepare(
        `SELECT COALESCE(SUM(instr("flags", 'CARRIED_OVER') > 0), 0) AS "carried",
           COALESCE(SUM(instr("flags", 'HISTORY_BEFORE_LIST') > 0), 0) AS "beforeList"
         FROM "ImportRow" WHERE "runId" = ?1`,
      )
      .bind(run.id),
  ]);
  return {
    run,
    counts: counts.results as { state: string; category: string | null; n: number }[],
    rows: (rows.results as unknown as ReportRow[]).slice(0, ROWS_PER_PAGE),
    more: rows.results.length > ROWS_PER_PAGE,
    toCheck: toCheck.results[0] as { carried: number; beforeList: number },
  };
}

/** Every row of a run, for the export. */
export async function reportRows(db: Db, rawDb: D1Database, shopId: string, runId: string) {
  const owned = await db.importRun.count({ where: { id: runId, shopId } });
  if (!owned) return null;
  const { results } = await rawDb
    .prepare(`SELECT ${REPORT_COLUMNS} FROM "ImportRow" WHERE "runId" = ?1 ORDER BY "contactNumber", "key"`)
    .bind(runId)
    .all<ReportRow>();
  return results;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- a fake of Shopify's loosely typed responses */
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { findRenewals, renewalDue, renewIfDue, settleAttempt } from "../app/billing.server";
import { revenueReport, subscriberCounts, totalsBy } from "../app/dashboard.server";
import { createDb } from "../app/db.server";
import { recordDataRequest, redactCustomer, redactShop } from "../app/gdpr.server";
import { contactsFrom, parseCsv } from "../app/import-csv";
import {
  addContacts,
  analyzeCustomer,
  type AnalysisContext,
  type AnalysisPlan,
  beginImport,
  beginRead,
  type CustomerRead,
  findImportWork,
  type ImportSettings,
  type OrderNode,
  parseSettings,
  readCustomer,
  releaseImportHold,
  runCreateSlice,
  runReadSlice,
  startRun,
} from "../app/import.server";
import type { Job } from "../app/jobs/runner.server";
import { type Graphql, graphqlOf } from "../app/plan-sync.server";
import { getOrCreateShop } from "../app/shop.server";
import {
  findMissedContracts,
  IMPORT_HOLD,
  IMPORT_MARKER,
  syncContract,
} from "../app/subscriptions.server";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const db = () => createDb(env.DB);
const NOW = new Date("2027-06-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const SUB_VARIANT = "gid://shopify/ProductVariant/500";
const ISSUE_VARIANT = "gid://shopify/ProductVariant/600";

const bundle: AnalysisPlan = {
  id: "plan-b",
  sellingPlanGid: "gid://shopify/SellingPlan/1",
  productGid: "gid://shopify/Product/1",
  billingMode: "PREPAID_BUNDLE",
  releasesPerTerm: 2,
  termMonths: 12,
  renewalRule: "TERM_DATE_HOLD_IF_LATE",
  priceCents: 4000,
  currency: "USD",
  autoRenew: true,
};
const perRelease: AnalysisPlan = {
  ...bundle,
  id: "plan-p",
  sellingPlanGid: "gid://shopify/SellingPlan/2",
  billingMode: "PER_RELEASE",
  releasesPerTerm: 1,
  termMonths: null,
  priceCents: 1300,
};
const settings: ImportSettings = {
  plans: [
    { planId: "plan-b", match: ["500", "annual"] },
    { planId: "plan-p", match: ["per-issue"] },
  ],
  issues: [],
  giftKeys: ["gift to"],
  statusKnown: true,
};

const US = { firstName: "T", lastName: "E", address1: "1 St", city: "Brooklyn", provinceCode: "NY", zip: "11201", countryCode: "US" } as any;

let orderId = 1000;
function order(
  processedAt: string,
  lines: Partial<OrderNode["lineItems"]["nodes"][number]>[] | "sub",
  extra: Partial<OrderNode> = {},
): OrderNode {
  const id = `gid://shopify/Order/${++orderId}`;
  const list = lines === "sub" ? [{ variant: { id: SUB_VARIANT } }] : lines;
  return {
    id,
    name: `#${orderId}`,
    processedAt,
    test: false,
    cancelledAt: null,
    displayFinancialStatus: "PAID",
    shippingAddress: US,
    lineItems: {
      nodes: list.map((line) => ({
        currentQuantity: 1,
        sku: null,
        product: null,
        variant: null,
        sellingPlan: null,
        customAttributes: [],
        discountedUnitPriceAfterAllDiscountsSet: {
          presentmentMoney: { amount: "40.00", currencyCode: "USD" },
        },
        ...line,
      })),
    },
    ...extra,
  };
}
const priced = (amount: string, currencyCode = "USD") => ({
  discountedUnitPriceAfterAllDiscountsSet: { presentmentMoney: { amount, currencyCode } },
});

const customer = (orders: OrderNode[], extra: Partial<CustomerRead> = {}): CustomerRead => ({
  id: "gid://shopify/Customer/9",
  defaultAddress: US,
  paymentMethods: { nodes: [{ id: "gid://shopify/CustomerPaymentMethod/c1" }] },
  subscriptionContracts: { nodes: [] },
  orders,
  historyComplete: true,
  ...extra,
});
const context = (extra: Partial<AnalysisContext> = {}): AnalysisContext => ({
  settings,
  plans: [bundle, perRelease],
  releases: [],
  orderTiming: "READY_TO_SHIP",
  allowedCountries: ["US"],
  cancelled: false,
  livePlanIds: new Set(),
  pendingPricePlanIds: new Set(),
  now: NOW,
  ...extra,
});
const one = (c: CustomerRead, x: Partial<AnalysisContext> = {}) => analyzeCustomer(c, context(x))[0];

describe("reading a contacts export", () => {
  it("handles quotes, commas, line breaks, CRLF and a byte-order mark", () => {
    expect(parseCsv('\uFEFFEmail,Name\r\na@x.co,"Smith, ""Al""\nJr"\r\n\r\nb@x.co,B')).toEqual([
      ["Email", "Name"],
      ["a@x.co", 'Smith, "Al"\nJr'],
      ["b@x.co", "B"],
    ]);
  });

  it("takes its column names and cancelled values as inputs, and keeps nothing else", () => {
    const parsed = contactsFrom("E-mail,Name,Street,State\nA@x.co,Al,1 St,Lapsed\nb@x.co,Bo,2 St,live\n", {
      email: "e-mail",
      status: "state",
      cancelled: "lapsed, gone",
    });
    expect(parsed).toEqual({
      ok: true,
      contacts: [
        { number: 1, email: "A@x.co", cancelled: true },
        { number: 2, email: "b@x.co", cancelled: false },
      ],
    });
  });

  it("refuses a column it can't find, rather than treating everyone as active", () => {
    const columns = { email: "Email", status: "Status", cancelled: "x" };
    expect(contactsFrom("Email\na@x.co\n", columns)).toMatchObject({ ok: false });
    expect(contactsFrom("Name\nAl\n", { ...columns, status: "" })).toMatchObject({ ok: false });
  });
});

describe("settings", () => {
  it("reads plans and the shipped list", () => {
    const parsed = parseSettings({
      plans: { a: "Annual, 500 ", b: "" },
      issues: "11 | Issue 11 | 2026-03-01 | 600\n12|Issue 12|2026-09-01\n",
      giftKeys: "Gift To",
      statusKnown: true,
    });
    expect(parsed).toEqual({
      ok: true,
      settings: {
        plans: [{ planId: "a", match: ["annual", "500"] }],
        issues: [
          { number: 11, title: "Issue 11", shippedAt: "2026-03-01T00:00:00.000Z", match: ["600"] },
          { number: 12, title: "Issue 12", shippedAt: "2026-09-01T00:00:00.000Z", match: [] },
        ],
        giftKeys: ["gift to"],
        statusKnown: true,
      },
    });
  });

  it("says what's wrong rather than guessing", () => {
    const parsed = parseSettings({ plans: {}, issues: "x | y\n1 | A | 2026-01-01\n1 | B | 2026-01-02", giftKeys: "", statusKnown: false });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors).toHaveLength(3);
  });
});

describe("rebuilding the numbers from order history", () => {
  const issues = [
    { number: 11, title: "11", shippedAt: ago(200), match: [] },
    { number: 12, title: "12", shippedAt: ago(30), match: [] },
  ];

  it("the term runs from the last real purchase, not the import or the first one", () => {
    const r = one(customer([order(ago(800), "sub"), order(ago(435), "sub"), order(ago(70), "sub")]));
    expect(r.category).toBe("READY");
    expect(r.facts.purchases).toBe(3);
    expect(r.facts.lastPurchaseAt).toBe(ago(70));
    // 70 days before NOW is 2027-03-23, so a year on.
    expect(r.facts.termEndsAt).toBe("2028-03-23T12:00:00.000Z");
  });

  it("a release shipped after the last purchase counts by date, and one before it doesn't", () => {
    const r = one(customer([order(ago(100), "sub")]), {
      settings: { ...settings, issues },
    });
    expect(r.facts).toMatchObject({ paid: 2, received: [12], remaining: 1, firstReleaseNumber: 13 });
    expect(r.flags).toContain("DATES_ONLY");
  });

  it("an order for a release beats its date: bought after it shipped but sent it anyway", () => {
    const withOrders = [{ number: 12, title: "12", shippedAt: ago(30), match: ["600"] }];
    const r = one(
      customer([order(ago(25), [{ variant: { id: ISSUE_VARIANT }, ...priced("0.00") }]), order(ago(26), "sub")]),
      { settings: { ...settings, issues: withOrders } },
    );
    expect(r.facts).toMatchObject({ received: [12], remaining: 1 });
    expect(r.flags).not.toContain("DATES_ONLY");
  });

  it("a release with order lines that this customer never got isn't counted, and says so", () => {
    const withOrders = [{ number: 12, title: "12", shippedAt: ago(30), match: ["600"] }];
    const r = one(customer([order(ago(100), "sub")]), { settings: { ...settings, issues: withOrders } });
    expect(r.facts).toMatchObject({ received: [], remaining: 2 });
    expect(r.flags).toContain("ISSUE_NOT_FOUND");
  });

  it("an order from before the last purchase doesn't use up this term", () => {
    const withOrders = [{ number: 11, title: "11", shippedAt: ago(400), match: ["600"] }];
    const r = one(
      customer([order(ago(390), [{ variant: { id: ISSUE_VARIANT } }]), order(ago(100), "sub"), order(ago(466), "sub")]),
      { settings: { ...settings, issues: withOrders } },
    );
    expect(r.facts).toMatchObject({ received: [], remaining: 2, purchases: 2 });
  });

  it("a release known only by its date, with nothing left to pay for it, wasn't theirs", () => {
    const three = [1, 2, 3].map((number) => ({ number, title: String(number), shippedAt: ago(50 - number), match: [] }));
    const r = one(customer([order(ago(60), "sub")]), { settings: { ...settings, issues: three } });
    expect(r.facts).toMatchObject({ paid: 2, remaining: 0, received: [1, 2] });
    expect(r.flags).not.toContain("OVER_SHIPPED");
  });

  it("recognizes a line by selling plan name or SKU, whatever the case", () => {
    expect(one(customer([order(ago(70), [{ sellingPlan: { name: "ANNUAL" } }])])).planId).toBe("plan-b");
    expect(one(customer([order(ago(70), [{ sku: "Per-Issue", ...priced("13.00") }])])).planId).toBe("plan-p");
  });

  it("a test, cancelled, refunded or unpaid order is no purchase", () => {
    expect(one(customer([order(ago(70), "sub", { test: true })])).category).toBe("NO_ORDERS");
    expect(one(customer([order(ago(70), "sub", { cancelledAt: ago(60) })])).category).toBe("NO_ORDERS");
    for (const status of ["REFUNDED", "VOIDED", "PENDING"]) {
      expect(
        one(customer([order(ago(70), "sub", { displayFinancialStatus: status })])).category,
      ).toBe("UNRECOGNIZED_PLAN");
    }
    expect(one(customer([order(ago(70), [{ variant: { id: SUB_VARIANT }, currentQuantity: 0 }])])).category).toBe(
      "UNRECOGNIZED_PLAN",
    );
    expect(one(customer([order(ago(70), "sub", { displayFinancialStatus: "PARTIALLY_REFUNDED" })])).flags).toContain(
      "PARTIAL_REFUND",
    );
  });

  it("the price is what they actually paid, and the quantity adds up", () => {
    const r = one(customer([order(ago(70), [
      { variant: { id: SUB_VARIANT }, currentQuantity: 2, ...priced("37.50") },
      { variant: { id: SUB_VARIANT }, ...priced("37.50") },
    ])]));
    expect(r.facts).toMatchObject({ quantity: 3, priceCents: 3750 });
    expect(r.flags).toEqual(expect.arrayContaining(["QUANTITY_ABOVE_ONE", "PRICE_DIFFERS_FROM_PLAN"]));
  });

  it("first release: past everything shipped and everything at its order step", () => {
    const reachedOpen = context({
      settings: { ...settings, issues },
      releases: [
        { number: 12, status: "SHIPPED" },
        { number: 13, status: "READY" },
        { number: 14, status: "PREORDER" },
        { number: 15, status: "UNANNOUNCED" },
        { number: 16, status: "CANCELLED" },
      ],
    });
    const r = analyzeCustomer(customer([order(ago(100), "sub")]), reachedOpen)[0];
    expect(r.facts.firstReleaseNumber).toBe(14);
    expect(r.flags).toEqual(expect.arrayContaining(["OPEN_RELEASE_SKIPPED", "PREORDER_EMAIL_MISSED"]));
    // Under PREORDER_OPENS a pre-order is at its order step too.
    const timing = analyzeCustomer(customer([order(ago(100), "sub")]), { ...reachedOpen, orderTiming: "PREORDER_OPENS" })[0];
    expect(timing.facts.firstReleaseNumber).toBe(15);
  });
});

describe("unused paid releases carry forward (N, 2026-11-05)", () => {
  const issue = (number: number, shippedAt: string, match: string[] = []) => ({ number, title: String(number), shippedAt, match });
  const on = (issues: ImportSettings["issues"], extra: Partial<AnalysisContext> = {}) => ({ settings: { ...settings, issues }, ...extra });
  const shipped = (number: number, at: string) => order(at, [{ sku: `issue-${number}`, ...priced("0.00") }]);
  const D = (date: string) => `${date}T15:00:00.000Z`;

  it("what an earlier purchase left is added to the last one's, and says how much", () => {
    const r = one(customer([order(D("2026-03-15"), "sub"), order(D("2025-03-15"), "sub")]), on([
      issue(1, D("2025-02-01")),
      issue(2, D("2025-09-01")),
      issue(3, D("2026-09-01")),
    ]));
    // +2, issue 2, +2, issue 3
    expect(r.facts).toMatchObject({ paid: 4, received: [2, 3], remaining: 2, carriedOver: 1, uncountedPurchases: 0 });
    expect(r.flags).toContain("CARRIED_OVER");
    expect(r.flags).not.toContain("HISTORY_BEFORE_LIST");
    // The term, copies and price are still the last purchase's.
    expect(r.facts.termEndsAt).toBe("2027-03-15T15:00:00.000Z");
  });

  it("a gap: what shipped while the balance was 0 doesn't count against a later purchase", () => {
    const r = one(customer([order(D("2026-05-01"), "sub"), order(D("2023-05-01"), "sub")]), on([
      issue(1, D("2023-01-01")),
      issue(2, D("2023-09-01")),
      issue(3, D("2024-03-01")),
      issue(4, D("2024-09-01")), // lapsed: not theirs
      issue(5, D("2025-03-01")), // lapsed: not theirs
      issue(6, D("2026-09-01")),
    ]));
    expect(r.facts).toMatchObject({ paid: 4, received: [2, 3, 6], remaining: 1, carriedOver: 0 });
    expect(r.flags).not.toContain("CARRIED_OVER");
    expect(r.flags).not.toContain("OVER_SHIPPED");
  });

  it("over-shipping: a free copy on an order at 0 uses up nothing, and is flagged", () => {
    const r = one(
      customer([
        order(D("2026-08-01"), "sub"),
        shipped(3, D("2026-03-05")),
        shipped(2, D("2025-09-03")),
        order(D("2024-09-01"), "sub"),
      ]),
      on([
        issue(1, D("2024-06-01")),
        issue(4, D("2025-03-01")),
        issue(2, D("2025-09-01"), ["issue-2"]),
        issue(3, D("2026-03-01"), ["issue-3"]),
        issue(5, D("2026-09-01")),
      ]),
    );
    // +2, issue 4, issue 2, issue 3 free at 0, +2, issue 5
    expect(r.facts).toMatchObject({ paid: 4, received: [2, 3, 4, 5], remaining: 1, carriedOver: 0 });
    expect(r.flags).toContain("OVER_SHIPPED");
  });

  it("a refunded or cancelled earlier purchase adds nothing", () => {
    const issues = [issue(1, D("2025-02-01")), issue(2, D("2025-09-01"))];
    for (const extra of [{ displayFinancialStatus: "REFUNDED" }, { cancelledAt: D("2025-04-01") }]) {
      const r = one(customer([order(D("2026-03-15"), "sub"), order(D("2025-03-15"), "sub", extra)]), on(issues));
      expect(r.facts).toMatchObject({ paid: 2, remaining: 2, carriedOver: 0, purchases: 1 });
    }
  });

  it("two subscriptions on one customer keep a balance each", () => {
    const results = analyzeCustomer(
      customer([order(D("2026-06-10"), "sub"), order(D("2026-03-15"), "sub"), order(D("2025-03-15"), "sub")]),
      context(on([issue(1, D("2025-02-01")), issue(2, D("2025-09-01")), issue(3, D("2026-05-01"))])),
    );
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.facts.remaining).sort()).toEqual([2, 2]);
    expect(results.find((r) => r.facts.purchases === 2)!.facts).toMatchObject({ carriedOver: 1, received: [2, 3] });
    expect(results.find((r) => r.facts.purchases === 1)!.facts).toMatchObject({ carriedOver: 0, paid: 2, received: [] });
  });

  it("pay per release carries too: each purchase pays for one", () => {
    const line = [{ sku: "per-issue", ...priced("13.00") }];
    const r = one(customer([order(D("2026-08-20"), line), order(D("2026-01-10"), line)]), on([
      issue(1, D("2025-12-01")),
      issue(2, D("2026-09-01")),
    ]));
    expect(r.facts).toMatchObject({ paid: 2, received: [2], remaining: 1, carriedOver: 1 });
    expect(r.flags).not.toContain("CHARGES_AT_NEXT_RELEASE");
  });

  describe("a shipped list that doesn't reach back", () => {
    const purchases = () => [order(D("2026-03-10"), "sub"), order(D("2025-03-10"), "sub"), order(D("2024-03-10"), "sub")];
    const short = [issue(13, D("2026-03-01"), ["issue-13"]), issue(14, D("2026-09-01"))];

    it("counts from the first purchase inside the list, gives nothing away, and flags it", () => {
      const r = one(customer(purchases()), on(short));
      expect(r.facts).toMatchObject({ paid: 2, received: [14], remaining: 1, carriedOver: 0, uncountedPurchases: 2, purchases: 3 });
      expect(r.flags).toContain("HISTORY_BEFORE_LIST");
    });

    it("every purchase before the list: starts from the last one", () => {
      const r = one(customer([order(D("2025-11-10"), "sub"), order(D("2024-11-10"), "sub")]), on(short));
      expect(r.facts).toMatchObject({ paid: 2, received: [14], remaining: 1, uncountedPurchases: 1 });
      expect(r.flags).toContain("HISTORY_BEFORE_LIST");
    });

    it("listing more gets the carried release back", () => {
      const longer = [issue(11, D("2024-02-01")), issue(12, D("2024-09-01")), ...short];
      const r = one(customer(purchases()), on(longer));
      // +2, 12, +2, +2, 14: nothing shows who got 13
      expect(r.facts).toMatchObject({ paid: 6, received: [12, 14], remaining: 4, carriedOver: 3, uncountedPurchases: 0 });
      expect(r.flags).not.toContain("HISTORY_BEFORE_LIST");
    });

    it("no list at all is flagged, and is the purchase alone", () => {
      const r = one(customer(purchases()), on([]));
      expect(r.facts).toMatchObject({ paid: 2, remaining: 2, uncountedPurchases: 2 });
      expect(r.flags).toContain("HISTORY_BEFORE_LIST");
    });
  });

  describe("a release known only by its date stops counting at the term's end (N, 2026-11-05)", () => {
    // Bought 2025-08-01 at 15:00, so the term ends 2026-08-01 at 15:00. NOW is 2027-06-01.
    const bought = () => [order(D("2025-08-01"), "sub")];
    const inTerm = issue(1, D("2025-09-01"));

    it("after the term, with a balance: not received, takes nothing off, and is flagged", () => {
      const r = one(customer(bought()), on([inTerm, issue(2, D("2026-09-01"))]));
      // +2, issue 1, issue 2 uncounted
      expect(r.facts).toMatchObject({ paid: 2, received: [1], remaining: 1 });
      expect(r.flags).toContain("SHIPPED_AFTER_TERM");
    });

    it("exactly at the term's end counts as after, as `termOver` does", () => {
      const r = one(customer(bought()), on([inTerm, issue(2, "2026-08-01T15:00:00.000Z")]));
      expect(r.facts).toMatchObject({ received: [1], remaining: 1 });
      expect(r.flags).toContain("SHIPPED_AFTER_TERM");
    });

    it("just before the term's end still counts", () => {
      const r = one(customer(bought()), on([inTerm, issue(2, "2026-08-01T14:59:59.999Z")]));
      expect(r.facts).toMatchObject({ received: [1, 2], remaining: 0 });
      expect(r.flags).not.toContain("SHIPPED_AFTER_TERM");
    });

    it("a release that wasn't counted raises no DATES_ONLY", () => {
      const r = one(customer(bought()), on([issue(0, D("2025-02-01")), issue(2, D("2026-09-01"))]));
      expect(r.facts).toMatchObject({ received: [], remaining: 2 });
      expect(r.flags).not.toContain("DATES_ONLY");
      expect(r.flags).toContain("SHIPPED_AFTER_TERM");
    });

    it("no flag when there was nothing left to count it against", () => {
      const r = one(customer(bought()), on([inTerm, issue(2, D("2026-01-01")), issue(3, D("2026-09-01"))]));
      expect(r.facts).toMatchObject({ received: [1, 2], remaining: 0 });
      expect(r.flags).not.toContain("SHIPPED_AFTER_TERM");
    });

    it("seen on an order after the term still counts: an order is proof", () => {
      const r = one(
        customer([shipped(2, D("2026-09-05")), ...bought()]),
        on([inTerm, issue(2, D("2026-09-01"), ["issue-2"])]),
      );
      expect(r.facts).toMatchObject({ received: [1, 2], remaining: 0 });
      expect(r.flags).not.toContain("SHIPPED_AFTER_TERM");
    });

    it("seen on an order after the term at 0 is still a free copy", () => {
      const r = one(
        customer([shipped(3, D("2026-09-05")), ...bought()]),
        on([inTerm, issue(2, D("2026-01-01")), issue(3, D("2026-09-01"), ["issue-3"])]),
      );
      expect(r.facts).toMatchObject({ received: [1, 2, 3], remaining: 0 });
      expect(r.flags).toContain("OVER_SHIPPED");
    });

    it("listed with order lines but no order, after the term, is still only ISSUE_NOT_FOUND", () => {
      const r = one(customer(bought()), on([inTerm, issue(2, D("2026-09-01"), ["issue-2"])]));
      expect(r.facts).toMatchObject({ received: [1], remaining: 1 });
      expect(r.flags).toContain("ISSUE_NOT_FOUND");
      expect(r.flags).not.toContain("SHIPPED_AFTER_TERM");
    });

    it("a later purchase starts a new term, so a release inside it counts", () => {
      const r = one(customer([order(D("2026-05-01"), "sub"), order(D("2024-08-01"), "sub")]), on([
        issue(0, D("2024-01-01")), // the list reaches back past every purchase
        issue(1, D("2025-03-01")), // in the first term
        issue(2, D("2025-09-01")), // after it, before the next purchase
        issue(3, D("2026-09-01")), // in the new term
      ]));
      // +2, issue 1, issue 2 uncounted, +2, issue 3
      expect(r.facts).toMatchObject({ paid: 4, received: [1, 3], remaining: 2, carriedOver: 1 });
      expect(r.flags).toContain("SHIPPED_AFTER_TERM");
    });

    it("the term is the latest purchase's: a renewal at the old term's end leaves that moment in the new term", () => {
      const r = one(customer([order(D("2026-08-01"), "sub"), ...bought()]), on([issue(0, D("2024-01-01")), inTerm, issue(2, D("2026-08-01"))]));
      // +2, issue 1, +2, issue 2, bought first at one moment
      expect(r.facts).toMatchObject({ received: [1, 2], remaining: 2 });
      expect(r.flags).not.toContain("SHIPPED_AFTER_TERM");
    });

    it("pay per release has no term, so it's as it was", () => {
      const line = [{ sku: "per-issue", ...priced("13.00") }];
      const r = one(customer([order(D("2023-01-10"), line)]), on([issue(0, D("2023-01-01")), issue(1, D("2026-09-01"))]));
      expect(r.facts).toMatchObject({ paid: 1, received: [1], remaining: 0 });
      expect(r.flags).not.toContain("SHIPPED_AFTER_TERM");
    });

    it("a bundle with no term length has no term end either", () => {
      const r = one(customer(bought()), on([inTerm, issue(2, D("2026-09-01"))], { plans: [{ ...bundle, termMonths: null }] }));
      expect(r.facts).toMatchObject({ received: [1, 2], remaining: 0 });
    });

    describe("what the kept release changes", () => {
      it("nothing left under the old count is now owed: a hold, not lapsed", () => {
        const r = one(customer(bought()), on([inTerm, issue(2, D("2026-09-01"))]));
        expect(r).toMatchObject({ category: "HOLD_TERM_PAST", facts: { remaining: 1, nextCharge: "HELD" } });
      });

      it("cancelled: nothing owed under the old count is now owed", () => {
        const r = one(customer(bought()), on([inTerm, issue(2, D("2026-09-01"))], { cancelled: true }));
        expect(r).toMatchObject({ category: "CANCELLED_OWED", facts: { remaining: 1 } });
      });

      it("it carries into a later purchase", () => {
        const r = one(customer([order(D("2026-10-01"), "sub"), ...bought()]), on([issue(0, D("2024-01-01")), inTerm, issue(2, D("2026-09-01"))]));
        // +2, issue 1, issue 2 uncounted, +2
        expect(r).toMatchObject({ category: "READY", facts: { paid: 4, received: [1], remaining: 3, carriedOver: 1 } });
      });

      it("the real run's fresh read gets the same number, as the balance and the opening slots", async () => {
        const t = await setup();
        t.settings.issues = [inTerm, issue(2, D("2026-09-01"))];
        t.add(1, bought());
        const runId = await t.dryRun([contact(1)]);
        expect((await t.rows(runId))[0]).toMatchObject({ category: "HOLD_TERM_PAST", facts: { remaining: 1 } });
        await t.realRun(runId);
        const [row] = await t.rows(runId);
        expect(row.state).toBe("DONE");
        expect(row.flags).toContain("SHIPPED_AFTER_TERM");
        expect(row.flags).not.toContain("CHANGED_SINCE_DRY_RUN");
        expect(await db().subscription.findFirst({ where: { shopId: t.shop.id } })).toMatchObject({
          status: "PAUSED",
          pausedReason: IMPORT_HOLD,
          releasesRemaining: 1,
          importedBalance: 1,
        });
      });

      it("a renewal since the import is still flagged, and an imported row keeps its facts", async () => {
        const t = await setup();
        t.settings.issues = [issue(0, D("2024-01-01")), inTerm, issue(2, D("2026-09-01"))];
        const gid = t.add(1, bought());
        await t.realRun(await t.dryRun([contact(1)]));
        t.customers.get(gid)!.orders.unshift(order(D("2026-10-01"), "sub"));
        const later = await t.dryRun([contact(1)]);
        const [row] = await t.rows(later);
        expect(row.flags).toEqual(["RENEWED_SINCE_IMPORT"]);
        expect(row.facts).toMatchObject({ remaining: 1 });
        expect(t.state.created).toHaveLength(1);
      });
    });
  });

  describe("what follows from it", () => {
    const history = () => [order(D("2025-10-05"), "sub"), order(D("2024-10-05"), "sub")];
    const list = [issue(1, D("2024-06-01")), issue(2, D("2025-03-01")), issue(3, D("2026-09-01"))];
    // NOW is 2027-06-01, so that term ended 2026-10-05: +2, issue 2, +2, issue 3.

    it("term over with carried releases left is a hold, not lapsed", () => {
      const r = one(customer(history()), on(list));
      expect(r).toMatchObject({ category: "HOLD_TERM_PAST", facts: { remaining: 2, carriedOver: 1, nextCharge: "HELD" } });
    });

    it("the old rule's 0 is no longer lapsed", () => {
      const used = [...list, issue(4, D("2026-09-20"))];
      const r = one(customer(history()), on(used));
      expect(r).toMatchObject({ category: "HOLD_TERM_PAST", facts: { remaining: 1, carriedOver: 1, received: [2, 3, 4] } });
    });

    it("cancelled: owed or not goes by the new number", () => {
      const used = [...list, issue(4, D("2026-09-20"))];
      expect(one(customer(history()), on(used, { cancelled: true }))).toMatchObject({ category: "CANCELLED_OWED", facts: { remaining: 1 } });
      const all = [...used, issue(5, D("2026-10-01"))];
      expect(one(customer(history()), on(all, { cancelled: true }))).toMatchObject({ category: "CANCELLED_NOTHING_OWED", facts: { remaining: 0 } });
    });
  });

  it("the real run imports the new number, as the balance and as what revenue leaves unpriced", async () => {
    const t = await setup();
    t.settings.issues = [issue(5, ago(500)), issue(6, ago(300))];
    t.add(1, [order(ago(40), "sub"), order(ago(400), "sub")]);
    await t.realRun(await t.dryRun([contact(1)]));
    const sub = await db().subscription.findFirstOrThrow({ where: { shopId: t.shop.id } });
    // +2, issue 6, +2
    expect(sub).toMatchObject({ releasesRemaining: 3, importedBalance: 3, firstReleaseNumber: 7 });

    const make = (number: number) => db().release.create({ data: { shopId: t.shop.id, number, title: `R${number}`, status: "SHIPPED" } });
    const releases = await Promise.all([make(11), make(12), make(13), make(14)]);
    for (const release of releases) {
      await db().delivery.create({
        data: { subscriptionId: sub.id, releaseId: release.id, status: "ORDERED", orderGid: `gid://shopify/Order/c${release.id}` },
      });
    }
    await db().billingAttempt.create({
      data: { subscriptionId: sub.id, chargeFor: "term-9", idempotencyKey: `c${sub.id}`, attempt: 1, result: "SUCCEEDED", amountCents: 4000, createdAt: new Date(NOW.getTime() + DAY) },
    });
    const report = await revenueReport(db(), env.DB, t.shop.id);
    const byRelease = totalsBy(report.rows, "releaseId");
    expect(releases.map((r) => byRelease.get(r.id)?.unpriced)).toEqual([1, 1, 1, 0]);
    expect(byRelease.get(releases[3].id)?.revenue).toBe(2000);
  });

  it("a dry run and the real run see a changed balance, and a renewal since the import is still flagged", async () => {
    const t = await setup();
    t.settings.issues = [issue(5, ago(900))];
    const gid = t.add(1, [order(ago(800), "sub")]);
    const runId = await t.dryRun([contact(1)]);
    const before = (await t.rows(runId))[0];
    expect(before.facts).toMatchObject({ remaining: 2 });
    // A renewal in the old app between the dry run and the real run.
    t.customers.get(gid)!.orders.unshift(order(ago(435), "sub"));
    await t.realRun(runId);
    const row = (await db().importRow.findUnique({ where: { id: before.id } }))!;
    expect(row.flags).toContain("CHANGED_SINCE_DRY_RUN");
    expect(row.flags).toContain("CARRIED_OVER");
    expect(row.facts).toMatchObject({ remaining: 4, carriedOver: 2 });
    expect(await db().subscription.findFirst({ where: { shopId: t.shop.id } })).toMatchObject({ releasesRemaining: 4 });

    t.customers.get(gid)!.orders.unshift(order(ago(70), "sub"));
    const later = await t.dryRun([contact(1)]);
    expect((await t.rows(later)).find((r) => r.state === "DONE")!.flags).toEqual(["RENEWED_SINCE_IMPORT"]);
    expect(t.state.created).toHaveLength(1);
  });
});

describe("nobody is charged because of the import", () => {
  it("term over with nothing left: lapsed, and no contract", () => {
    const issues = [1, 2].map((number) => ({ number, title: "x", shippedAt: ago(390 - number), match: [] }));
    const r = one(customer([order(ago(400), "sub")]), { settings: { ...settings, issues } });
    expect(r).toMatchObject({ category: "LAPSED", facts: { remaining: 0, nextCharge: "NEVER" } });
    expect(r.paymentMethodId).toBeUndefined();
  });

  it("term over with paid releases left: held", () => {
    expect(one(customer([order(ago(400), "sub")]))).toMatchObject({
      category: "HOLD_TERM_PAST",
      facts: { remaining: 2, nextCharge: "HELD" },
    });
    const termDate = { ...bundle, renewalRule: "TERM_DATE" };
    expect(one(customer([order(ago(400), "sub")]), { plans: [termDate] }).category).toBe("HOLD_TERM_PAST");
  });

  it("a renewal under 21 days away misses the notice: held", () => {
    const soon = one(customer([order(ago(365 - 20), "sub")]));
    expect(soon.category).toBe("HOLD_RENEWAL_SOON");
    expect(one(customer([order(ago(365 - 22), "sub")])).category).toBe("READY");
  });

  it("ON_DEPLETION at 0 would charge within the hour: held, with a date in the future or not", () => {
    const depletion = { ...bundle, renewalRule: "ON_DEPLETION" };
    const shipped = [1, 2].map((number) => ({ number, title: "x", shippedAt: ago(80 - number), match: [] }));
    expect(
      one(customer([order(ago(100), "sub")]), { plans: [depletion], settings: { ...settings, issues: shipped } }).category,
    ).toBe("HOLD_DEPLETED");
    // With paid releases left, the notice comes with the last one's pre-order.
    expect(one(customer([order(ago(100), "sub")]), { plans: [depletion] }).category).toBe("READY");
    // Unless that pre-order is already open, and the charge would follow its order with no notice.
    const lastOne = [{ number: 1, title: "x", shippedAt: ago(50), match: [] }];
    expect(
      one(customer([order(ago(100), "sub")]), {
        plans: [depletion],
        settings: { ...settings, issues: lastOne },
        releases: [{ number: 2, status: "PREORDER" }],
      }).category,
    ).toBe("HOLD_DEPLETED");
  });

  it("pay per release at 0: charged at the next release with its notice, and kept out of one already open", () => {
    const ordered = customer([order(ago(100), [{ sku: "per-issue", ...priced("13.00") }])]);
    const issues = [{ number: 1, title: "x", shippedAt: ago(50), match: [] }];
    const plain = one(ordered, { settings: { ...settings, issues } });
    expect(plain).toMatchObject({ category: "READY", facts: { remaining: 0, firstReleaseNumber: 2, nextCharge: "NEXT_RELEASE" } });
    expect(plain.flags).toContain("CHARGES_AT_NEXT_RELEASE");

    const open = one(ordered, { settings: { ...settings, issues }, releases: [{ number: 2, status: "PREORDER" }] });
    expect(open.facts.firstReleaseNumber).toBe(3);
    expect(open.flags).toContain("PREORDER_SKIPPED");

    const reached = one(ordered, { settings: { ...settings, issues }, releases: [{ number: 2, status: "READY" }] });
    expect(reached.facts.firstReleaseNumber).toBe(3);
  });

  it("pay per release with its paid release unshipped owes nothing yet", () => {
    const r = one(customer([order(ago(100), [{ sku: "per-issue", ...priced("13.00") }])]));
    expect(r.facts).toMatchObject({ paid: 1, remaining: 1, firstReleaseNumber: 1 });
    expect(r.flags).not.toContain("CHARGES_AT_NEXT_RELEASE");
  });

  it("a last purchase that cost nothing would renew for nothing: held", () => {
    expect(one(customer([order(ago(100), [{ variant: { id: SUB_VARIANT }, ...priced("0.00") }])])).category).toBe("HOLD_ZERO_PRICE");
  });

  it("a plan that doesn't renew has nothing to hold", () => {
    const noRenew = { ...bundle, autoRenew: false };
    expect(one(customer([order(ago(400), "sub")]), { plans: [noRenew] })).toMatchObject({
      category: "READY",
      facts: { nextCharge: "NEVER" },
    });
  });
});

describe("cases that don't fit get a named category", () => {
  it("cancelled in the old app, with and without releases owed", () => {
    const owed = one(customer([order(ago(100), "sub")]), { cancelled: true });
    expect(owed).toMatchObject({ category: "CANCELLED_OWED", paymentMethodId: null, facts: { remaining: 2, nextCharge: "NEVER" } });
    const shipped = [1, 2].map((number) => ({ number, title: "x", shippedAt: ago(90 - number), match: [] }));
    expect(one(customer([order(ago(100), "sub")]), { cancelled: true, settings: { ...settings, issues: shipped } }).category).toBe(
      "CANCELLED_NOTHING_OWED",
    );
  });

  it("no status column: everyone is flagged", () => {
    expect(one(customer([order(ago(100), "sub")]), { settings: { ...settings, statusKnown: false } }).flags).toContain("STATUS_UNKNOWN");
  });

  it("a gift can't be imported as anything", () => {
    expect(
      one(customer([order(ago(100), [{ variant: { id: SUB_VARIANT }, customAttributes: [{ key: "Gift To" }] }])])).category,
    ).toBe("GIFT");
  });

  it("no orders, or orders that match no plan", () => {
    expect(one(customer([])).category).toBe("NO_ORDERS");
    expect(one(customer([order(ago(100), [{ sku: "mug" }])])).category).toBe("UNRECOGNIZED_PLAN");
    expect(one(customer([order(ago(100), [{ sellingPlan: { name: "Other app" } }])])).category).toBe("UNRECOGNIZED_PLAN");
    const both = one(customer([order(ago(100), "sub"), order(ago(90), [{ sellingPlan: { name: "Other app" } }])]));
    expect(both).toMatchObject({ category: "READY" });
    expect(both.flags).toContain("UNRECOGNIZED_LINES");
  });

  it("addresses: not allowed, missing, or only on the last order", () => {
    const canada = { ...US, countryCode: "CA" };
    expect(one(customer([order(ago(100), "sub")], { defaultAddress: canada }))).toMatchObject({
      category: "ADDRESS_NOT_ALLOWED",
      facts: { addressCountry: "CA" },
    });
    expect(one(customer([order(ago(100), "sub")], { defaultAddress: canada }), { allowedCountries: ["US", "CA"] }).category).toBe("READY");
    expect(one(customer([order(ago(100), "sub", { shippingAddress: null })], { defaultAddress: null })).category).toBe("NO_ADDRESS");
    expect(one(customer([order(ago(100), "sub")], { defaultAddress: null })).flags).toContain("ADDRESS_FROM_ORDER");
  });

  it("the other categories", () => {
    expect(one(customer([order(ago(100), "sub")], { historyComplete: false })).category).toBe("HISTORY_TOO_LONG");
    expect(one(customer([order(ago(100), "sub")]), { livePlanIds: new Set(["plan-b"]) }).category).toBe("ALREADY_SUBSCRIBED");
    expect(one(customer([order(ago(100), [{ variant: { id: SUB_VARIANT }, ...priced("40.00", "CAD") }])])).category).toBe("CURRENCY_DIFFERS");
    expect(one(customer([order(ago(100), "sub")]), { plans: [{ ...bundle, sellingPlanGid: null }] }).category).toBe("PLAN_NOT_READY");
  });

  it("no card still comes in, flagged. An expired one too", () => {
    const none = one(customer([order(ago(100), "sub")], { paymentMethods: { nodes: [] } }));
    expect(none).toMatchObject({ category: "READY", paymentMethodId: null });
    expect(none.flags).toContain("NO_CARD");
    const expired = one(customer([order(ago(100), "sub")], {
      paymentMethods: { nodes: [{ id: "old", instrument: { expiryMonth: 1, expiryYear: 2020 } }] },
    }));
    expect(expired).toMatchObject({ paymentMethodId: "old" });
    expect(expired.flags).toContain("CARD_EXPIRED");
    const two = one(customer([order(ago(100), "sub")], {
      paymentMethods: { nodes: [{ id: "old", instrument: { expiryMonth: 1, expiryYear: 2020 } }, { id: "new", instrument: { expiryMonth: 1, expiryYear: 2030 } }] },
    }));
    expect(two).toMatchObject({ paymentMethodId: "new" });
    expect(two.flags).toContain("SEVERAL_CARDS");
  });
});

describe("two subscriptions", () => {
  it("orders inside each other's terms are two; a renewal continues the one that's ending", () => {
    const results = analyzeCustomer(
      customer([
        order("2025-01-10T00:00:00.000Z", "sub"),
        order("2025-03-01T00:00:00.000Z", "sub"),
        order("2026-01-10T00:00:00.000Z", "sub"),
        order("2026-03-01T00:00:00.000Z", "sub"),
        order("2027-01-10T00:00:00.000Z", "sub"),
        order("2027-03-01T00:00:00.000Z", "sub"),
      ]),
      context(),
    );
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.facts.lastPurchaseAt).sort()).toEqual([
      "2027-01-10T00:00:00.000Z",
      "2027-03-01T00:00:00.000Z",
    ]);
    expect(results.map((r) => r.facts.purchases)).toEqual([3, 3]);
    expect(new Set(results.map((r) => r.key)).size).toBe(2);
    expect(results[0].flags).toContain("TWO_SUBSCRIPTIONS");
  });

  it("two plans are two", () => {
    const results = analyzeCustomer(
      customer([order(ago(100), "sub"), order(ago(90), [{ sku: "per-issue", ...priced("13.00") }])]),
      context(),
    );
    expect(results.map((r) => r.planId).sort()).toEqual(["plan-b", "plan-p"]);
  });

  it("the key stays the same after a renewal, so a later run finds the same row", () => {
    const first = order(ago(500), "sub");
    const before = one(customer([first]));
    const after = one(customer([first, order(ago(135), "sub")]));
    expect(after.key).toBe(before.key);
    expect(after.facts.lastPurchaseAt).toBe(ago(135));
  });
});

// ---- with a database and a fake Shopify ---------------------------------------------------------

let k = 0;
let contractId = 9000;

/** Shopify as measured on `newstand-dev`: contract creates aren't deduped, and a marker reads back at once. */
function fakeShopify(customers: Map<string, CustomerRead>) {
  const state = {
    created: [] as any[],
    refuse: null as any,
    throttle: 0,
    throwOnce: false,
    failAfterCreate: false,
    mutations: 0,
    drafts: 0,
  };
  const graphql: Graphql = async (query, variables) => {
    if (query.includes("ImportCustomer")) {
      const c = customers.get(String(variables?.id));
      if (!c) return { customer: null };
      return {
        customer: {
          ...c,
          orders: { nodes: c.orders, pageInfo: { hasNextPage: false, endCursor: null } },
        },
      };
    }
    if (query.includes("ImportPlanVariant")) return { product: { variants: { nodes: [{ id: SUB_VARIANT }] } } };
    if (query.includes("ImportContractCreate")) {
      state.mutations++;
      if (state.throwOnce) {
        state.throwOnce = false;
        throw new Error("Admin API returned errors");
      }
      if (state.throttle > 0) {
        state.throttle--;
        return { subscriptionContractAtomicCreate: { contract: null, userErrors: [{ field: null, code: null, message: "Too many attempts" }] } };
      }
      if (state.refuse) return { subscriptionContractAtomicCreate: { contract: null, userErrors: [state.refuse] } };
      const id = `gid://shopify/SubscriptionContract/${++contractId}`;
      const c = customers.get((variables as any).input.customerId)!;
      const contract = { id, customAttributes: (variables as any).input.contract.customAttributes };
      c.subscriptionContracts.nodes.push(contract);
      state.created.push({ id, input: (variables as any).input });
      if (state.failAfterCreate) {
        state.failAfterCreate = false;
        throw new Error("crash after create");
      }
      return { subscriptionContractAtomicCreate: { contract: { id }, userErrors: [] } };
    }
    if (query.includes("ImportContacts")) {
      return Object.fromEntries(
        Object.entries(variables ?? {}).map(([name, email]) => {
          const hit = [...customers.values()].find((c) => (c as any).email === email);
          return [`c${name.slice(1)}`, hit ? { id: hit.id } : null];
        }),
      );
    }
    if (query.includes("ImportScopes")) {
      return { currentAppInstallation: { accessScopes: [{ handle: "read_all_orders" }] } };
    }
    throw new Error(`Unexpected query: ${query.slice(0, 60)}`);
  };
  return { graphql, state };
}

async function setup(extra: Partial<AnalysisPlan & { name: string }> = {}) {
  const domain = `import${++k}.myshopify.com`;
  const shop = await getOrCreateShop(db(), domain);
  const plan = await db().plan.create({
    data: {
      shopId: shop.id,
      name: "Annual",
      displayName: "Annual",
      billingMode: "PREPAID_BUNDLE",
      releasesPerTerm: 2,
      termMonths: 12,
      priceCents: 4000,
      sellingPlanGid: `gid://shopify/SellingPlan/${k}000`,
      productGid: "gid://shopify/Product/1",
      ...(extra as object),
    },
  });
  const settingsFor: ImportSettings = {
    plans: [{ planId: plan.id, match: ["500"] }],
    issues: [{ number: 5, title: "Old issue", shippedAt: ago(50), match: [] }],
    giftKeys: [],
    statusKnown: true,
  };
  const customers = new Map<string, CustomerRead>();
  const shopify = fakeShopify(customers);
  const add = (id: number, orders: OrderNode[], fields: Partial<CustomerRead> = {}) => {
    const gid = `gid://shopify/Customer/${k}0${id}`;
    const c = { ...customer(orders, { subscriptionContracts: { nodes: [] }, ...fields }), id: gid, email: `c${id}@x.co` } as CustomerRead;
    customers.set(gid, c);
    return gid;
  };
  /** A finished dry run over these contacts. */
  const dryRun = async (contacts: { number: number; email: string; cancelled: boolean }[]) => {
    const started = await startRun(db(), shopify.graphql, shop.id, settingsFor);
    if (!("runId" in started)) throw new Error(started.error);
    await addContacts(env.DB, shopify.graphql, shop.id, started.runId, contacts);
    const [job] = await beginRead(db(), { id: shop.id, shopDomain: domain }, started.runId, NOW);
    let next: Job | null = job;
    while (next) {
      next = (await runReadSlice(db(), env.DB, async () => shopify.graphql, next, () => NOW))?.job ?? null;
    }
    return started.runId;
  };
  const realRun = async (runId: string, clock = () => NOW) => {
    const [job] = await beginImport(db(), env.DB, { id: shop.id, shopDomain: domain }, runId, NOW);
    let next: Job | null = job ?? null;
    const delays: number[] = [];
    for (let i = 0; next && i < 20; i++) {
      const step = await runCreateSlice(db(), env.DB, async () => shopify.graphql, next, clock);
      if (step) delays.push(step.delaySeconds);
      next = step?.job ?? null;
    }
    return delays;
  };
  const rows = (runId: string) => db().importRow.findMany({ where: { runId }, orderBy: { contactNumber: "asc" } });
  return { shop, domain, plan, customers, ...shopify, add, dryRun, realRun, rows, settings: settingsFor };
}
const contact = (number: number, cancelled = false) => ({ number, email: `c${number}@x.co`, cancelled });

const syncShop = (t: { shop: { id: string }; domain: string }) => ({
  id: t.shop.id,
  shopDomain: t.domain,
  orderTiming: "READY_TO_SHIP" as const,
});

describe("the dry run", () => {
  it("writes only the report", async () => {
    const t = await setup();
    t.add(1, [order(ago(100), "sub")]);
    const before = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "Subscription"`).first<{ n: number }>();
    const releases = await db().release.count({ where: { shopId: t.shop.id } });
    const runId = await t.dryRun([contact(1)]);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM "Subscription"`).first<{ n: number }>())!.n).toBe(before!.n);
    expect(await db().release.count({ where: { shopId: t.shop.id } })).toBe(releases);
    expect(t.state.mutations).toBe(0);
    const [row] = await t.rows(runId);
    expect(row).toMatchObject({ state: "READ", category: "READY" });
    expect(await db().importRun.findUnique({ where: { id: runId } })).toMatchObject({ status: "READ" });
  });

  it("names a contact with no customer, and a repeated one, and stores no email", async () => {
    const t = await setup();
    t.add(1, [order(ago(100), "sub")]);
    const runId = await t.dryRun([contact(1), { number: 2, email: "nobody@x.co", cancelled: false }, { number: 3, email: "c1@x.co", cancelled: false }, { number: 4, email: "", cancelled: false }]);
    const rows = await t.rows(runId);
    expect(rows.map((r) => [r.contactNumber, r.category])).toEqual([
      [1, "READY"],
      [2, "NO_CUSTOMER"],
      [3, "DUPLICATE_CONTACT"],
      [4, "NO_CUSTOMER"],
    ]);
    const text = JSON.stringify(rows);
    expect(text).not.toContain("x.co");
    expect(JSON.stringify(await db().importRun.findUnique({ where: { id: runId } }))).not.toContain("x.co");
  });

  it("two lines for one person that disagree: cancelled wins, so neither charges", async () => {
    const t = await setup();
    t.add(1, [order(ago(100), "sub")]);
    const runId = await t.dryRun([contact(1), { ...contact(1), number: 2, cancelled: true }]);
    expect((await t.rows(runId)).find((r) => r.state === "READ" && r.planId)).toMatchObject({ category: "CANCELLED_OWED" });
  });

  it("no personal data lands in the report", async () => {
    const t = await setup();
    t.add(1, [order(ago(100), "sub")], { firstName: "Secret", lastName: "Name", defaultAddress: { ...US, firstName: "Secret", address1: "99 Hidden Rd" } });
    const runId = await t.dryRun([contact(1)]);
    const text = JSON.stringify(await t.rows(runId));
    expect(text).not.toContain("Secret");
    expect(text).not.toContain("Hidden");
  });

  it("refuses to run without read_all_orders, which would silently hide old orders", async () => {
    const t = await setup();
    const noScope: Graphql = async () => ({ currentAppInstallation: { accessScopes: [{ handle: "read_orders" }] } });
    expect(await startRun(db(), noScope, t.shop.id, t.settings)).toMatchObject({ error: expect.stringContaining("read_all_orders") });
  });

  it("refuses a shipped list that names an unshipped release", async () => {
    const t = await setup();
    await db().release.create({ data: { shopId: t.shop.id, number: 5, title: "Live", status: "READY" } });
    expect(await startRun(db(), t.graphql, t.shop.id, t.settings)).toMatchObject({ error: expect.stringContaining("5") });
  });

  it("refuses a new run while a real one is going", async () => {
    const t = await setup();
    await db().importRun.create({ data: { id: crypto.randomUUID(), shopId: t.shop.id, status: "IMPORTING", settings: {} } });
    expect(await startRun(db(), t.graphql, t.shop.id, t.settings)).toMatchObject({ error: expect.any(String) });
  });
});

describe("the real run", () => {
  it("creates the contract and Subscription, with nothing on the side", async () => {
    const t = await setup();
    const gid = t.add(1, [order(ago(100), [{ variant: { id: SUB_VARIANT }, currentQuantity: 2, ...priced("37.50") }])]);
    const runId = await t.dryRun([contact(1)]);
    await t.realRun(runId);

    expect(t.state.created).toHaveLength(1);
    const { input } = t.state.created[0];
    expect(input.customerId).toBe(gid);
    expect(input.contract).toMatchObject({
      status: "ACTIVE",
      paymentMethodId: "gid://shopify/CustomerPaymentMethod/c1",
      deliveryPrice: "0.00",
      billingPolicy: { interval: "YEAR", intervalCount: 1 },
    });
    expect(input.contract.customAttributes[0].key).toBe(IMPORT_MARKER);
    expect(input.contract.deliveryMethod.shipping.address).toMatchObject({ address1: "1 St", countryCode: "US" });
    expect(input.lines[0].line).toMatchObject({
      sellingPlanId: t.plan.sellingPlanGid,
      quantity: 2,
      currentPrice: "37.50",
    });
    expect(new Date(input.nextBillingDate).getTime()).toBeGreaterThan(NOW.getTime());

    const sub = await db().subscription.findFirstOrThrow({ where: { shopId: t.shop.id }, include: { deliveries: true, billingAttempts: true, events: true, emailSends: true } });
    expect(sub).toMatchObject({
      source: "IMPORTED",
      status: "ACTIVE",
      customerGid: gid,
      quantity: 2,
      lockedPriceCents: 3750,
      firstReleaseNumber: 6,
      releasesRemaining: 1, // paid 2, Old issue shipped after the purchase
      importedBalance: 1,
      noCardSince: null,
      signupCents: null,
    });
    expect(sub.deliveries).toEqual([]);
    expect(sub.billingAttempts).toEqual([]);
    expect(sub.events).toEqual([]);
    expect(sub.emailSends).toEqual([]);
    expect(await db().importRun.findUnique({ where: { id: runId } })).toMatchObject({ status: "DONE" });
    // The shipped list is filled in, so the next release's number follows it.
    expect(await db().release.findMany({ where: { shopId: t.shop.id } })).toMatchObject([{ number: 5, status: "SHIPPED", title: "Old issue" }]);
  });

  it("reads again, and uses what it finds: a renewal in the old app since the dry run moves the term", async () => {
    const t = await setup();
    const first = order(ago(350), "sub");
    const gid = t.add(1, [first]);
    const runId = await t.dryRun([contact(1)]);
    expect((await t.rows(runId))[0]).toMatchObject({ category: "HOLD_RENEWAL_SOON" });
    t.customers.get(gid)!.orders.unshift(order(ago(1), "sub"));
    await t.realRun(runId);
    const sub = await db().subscription.findFirstOrThrow({ where: { shopId: t.shop.id } });
    expect(sub.status).toBe("ACTIVE");
    expect(sub.termEndsAt!.getTime()).toBeGreaterThan(NOW.getTime() + 300 * DAY);
    const [row] = await t.rows(runId);
    expect(row.flags).toContain("CHANGED_SINCE_DRY_RUN");
  });

  it("leaves out someone who stopped fitting since the dry run", async () => {
    const t = await setup();
    const gid = t.add(1, [order(ago(100), "sub")]);
    const runId = await t.dryRun([contact(1)]);
    t.customers.get(gid)!.defaultAddress = { ...US, countryCode: "CA" };
    await t.realRun(runId);
    expect(t.state.created).toEqual([]);
    expect((await t.rows(runId))[0]).toMatchObject({ state: "SKIPPED", category: "ADDRESS_NOT_ALLOWED" });
  });

  it("a customer gone since the dry run is left out as redacted", async () => {
    const t = await setup();
    const gid = t.add(1, [order(ago(100), "sub")]);
    const runId = await t.dryRun([contact(1)]);
    t.customers.delete(gid);
    await t.realRun(runId);
    expect(t.state.created).toEqual([]);
    expect((await t.rows(runId))[0]).toMatchObject({ state: "SKIPPED", category: "REDACTED" });
  });

  it("each kind comes in as it should", async () => {
    const t = await setup();
    t.add(1, [order(ago(100), "sub")], { paymentMethods: { nodes: [] } }); // no card
    t.add(2, [order(ago(400), "sub")]); // term past, paid left
    t.add(3, [order(ago(100), "sub")]); // cancelled, owed
    t.add(4, [order(ago(365 - 10), "sub")]); // renewal soon
    t.add(5, [order(ago(100), "sub")], { defaultAddress: { ...US, countryCode: "CA" } }); // left out
    const runId = await t.dryRun([contact(1), contact(2), contact(3, true), contact(4), contact(5)]);
    await t.realRun(runId);
    const subs = await db().subscription.findMany({ where: { shopId: t.shop.id }, orderBy: { customerGid: "asc" } });
    expect(subs.map((s) => [s.status, s.pausedReason, s.noCardSince !== null])).toEqual([
      ["ACTIVE", null, true],
      ["PAUSED", IMPORT_HOLD, false],
      ["CANCELLED", null, false],
      ["PAUSED", IMPORT_HOLD, false],
    ]);
    const cancelled = t.state.created.find((c) => c.input.contract.status === "CANCELLED");
    expect(cancelled.input.contract.paymentMethodId).toBeUndefined();
    const noCard = t.state.created[0];
    expect(noCard.input.contract.paymentMethodId).toBeUndefined();
    expect((await subscriberCounts(env.DB, t.shop.id, NOW))).toMatchObject({ noCard: 1, onHold: 2, paused: 2 });
  });

  it("one customer with two subscriptions gets two contracts", async () => {
    const t = await setup();
    t.add(1, [order(ago(200), "sub"), order(ago(100), "sub")]);
    const runId = await t.dryRun([contact(1)]);
    await t.realRun(runId);
    expect(t.state.created).toHaveLength(2);
    expect(await db().subscription.count({ where: { shopId: t.shop.id } })).toBe(2);
  });

  it("a second run makes nothing new, and says so", async () => {
    const t = await setup();
    t.add(1, [order(ago(100), "sub")]);
    const first = await t.dryRun([contact(1)]);
    await t.realRun(first);
    const second = await t.dryRun([contact(1)]);
    expect((await t.rows(second))[0]).toMatchObject({ state: "DONE", category: "READY" });
    await t.realRun(second);
    expect(t.state.created).toHaveLength(1);
    expect(await db().subscription.count({ where: { shopId: t.shop.id } })).toBe(1);
  });

  it("a later dry run flags someone who bought again in the old app since their import", async () => {
    const t = await setup();
    const gid = t.add(1, [order(ago(100), "sub")]);
    const first = await t.dryRun([contact(1)]);
    await t.realRun(first);
    t.customers.get(gid)!.orders.unshift(order(ago(1), [{ variant: { id: SUB_VARIANT } }]));
    // A renewal: late enough to continue this subscription, not start a second.
    t.customers.get(gid)!.orders[1].processedAt = ago(370);
    const second = await t.dryRun([contact(1)]);
    const rows = await t.rows(second);
    expect(rows.find((r) => r.state === "DONE")!.flags).toEqual(["RENEWED_SINCE_IMPORT"]);
    await t.realRun(second);
    expect(t.state.created).toHaveLength(1);
  });

  it("a crash after Shopify made the contract finds it, not a second one", async () => {
    const t = await setup();
    t.add(1, [order(ago(100), "sub")]);
    const runId = await t.dryRun([contact(1)]);
    t.state.failAfterCreate = true;
    const delays = await t.realRun(runId);
    expect(delays[0]).toBe(60);
    expect(t.state.created).toHaveLength(1);
    expect(await db().subscription.count({ where: { shopId: t.shop.id } })).toBe(1);
    expect((await t.rows(runId))[0]).toMatchObject({ state: "DONE", contractGid: t.state.created[0].id });
  });

  it("a crash that left the row leased: the lease lapses and the retry finds the contract", async () => {
    const t = await setup();
    const gid = t.add(1, [order(ago(100), "sub")]);
    const runId = await t.dryRun([contact(1)]);
    const key = (await t.rows(runId))[0].key;
    await beginImport(db(), env.DB, { id: t.shop.id, shopDomain: t.domain }, runId, NOW);
    // What a killed Worker leaves: a lease, and a contract in Shopify whose ID never reached D1.
    await db().importRow.updateMany({ where: { runId }, data: { state: "CREATING", leaseUntil: new Date(NOW.getTime() + 300000) } });
    t.customers.get(gid)!.subscriptionContracts.nodes.push({
      id: "gid://shopify/SubscriptionContract/1",
      customAttributes: [{ key: IMPORT_MARKER, value: key }],
    });
    const job = { type: "import.create", id: "x", shop: t.domain, data: { runId } };
    // Still leased: nothing is done.
    const during = await runCreateSlice(db(), env.DB, async () => t.graphql, job, () => NOW);
    expect(during?.delaySeconds).toBe(60);
    expect(await db().subscription.count({ where: { shopId: t.shop.id } })).toBe(0);
    // Lapsed.
    const later = new Date(NOW.getTime() + 301000);
    expect(await runCreateSlice(db(), env.DB, async () => t.graphql, job, () => later)).toBeNull();
    expect(t.state.mutations).toBe(0);
    expect(await db().subscription.findFirst({ where: { shopId: t.shop.id } })).toMatchObject({ contractGid: "gid://shopify/SubscriptionContract/1" });
  });

  it("two slices at once make one contract", async () => {
    const t = await setup();
    t.add(1, [order(ago(100), "sub")]);
    const runId = await t.dryRun([contact(1)]);
    await beginImport(db(), env.DB, { id: t.shop.id, shopDomain: t.domain }, runId, NOW);
    const job = { type: "import.create", id: "x", shop: t.domain, data: { runId } };
    await Promise.all([
      runCreateSlice(db(), env.DB, async () => t.graphql, job, () => NOW),
      runCreateSlice(db(), env.DB, async () => t.graphql, job, () => NOW),
    ]);
    expect(t.state.created).toHaveLength(1);
  });

  it("being limited isn't failing: it waits and carries on, using no attempts", async () => {
    const t = await setup();
    t.add(1, [order(ago(100), "sub")]);
    const runId = await t.dryRun([contact(1)]);
    t.state.throttle = 7;
    const delays = await t.realRun(runId);
    expect(delays.slice(0, 7)).toEqual(Array(7).fill(60));
    expect((await t.rows(runId))[0]).toMatchObject({ state: "DONE", attempts: 0 });
  });

  it("a refusal fails visibly, and the message that could quote the customer stays out", async () => {
    const t = await setup();
    t.add(1, [order(ago(100), "sub")]);
    t.add(2, [order(ago(100), "sub")]);
    const runId = await t.dryRun([contact(1), contact(2)]);
    t.state.refuse = { field: ["input", "contract"], code: "INVALID", message: "Bad address 99 Hidden Rd" };
    await t.realRun(runId);
    const rows = await t.rows(runId);
    expect(rows.map((r) => r.state)).toEqual(["FAILED", "FAILED"]);
    expect(rows[0].error).toBe("INVALID input contract");
    expect(JSON.stringify(rows)).not.toContain("Hidden");
    expect(await db().importRun.findUnique({ where: { id: runId } })).toMatchObject({ status: "DONE" });
  });

  it("an error on every try ends in a visible failure, not a loop", async () => {
    const t = await setup();
    t.add(1, [order(ago(100), "sub")]);
    const runId = await t.dryRun([contact(1)]);
    await beginImport(db(), env.DB, { id: t.shop.id, shopDomain: t.domain }, runId, NOW);
    const job = { type: "import.create", id: "x", shop: t.domain, data: { runId } };
    const broken: Graphql = async (query, variables) => {
      if (query.includes("ImportContractCreate")) throw new Error("boom");
      return t.graphql(query, variables);
    };
    for (let i = 0; i < 5; i++) await runCreateSlice(db(), env.DB, async () => broken, job, () => NOW);
    expect((await t.rows(runId))[0]).toMatchObject({ state: "FAILED", error: "unexpected", attempts: 5 });
  });

  it("the tick takes up a run with work left, and only those", async () => {
    const t = await setup();
    t.add(1, [order(ago(100), "sub")]);
    const runId = await t.dryRun([contact(1)]);
    await env.DB.prepare(`INSERT INTO "OfflineSession" ("id", "data") VALUES (?1, '{}')`).bind(`offline_${t.domain}`).run();
    await beginImport(db(), env.DB, { id: t.shop.id, shopDomain: t.domain }, runId, NOW);
    const context_ = { env, db: db(), now: NOW };
    expect((await findImportWork(context_)).filter((j) => j.shop === t.domain)).toEqual([
      expect.objectContaining({ type: "import.create", data: { runId } }),
    ]);
    await t.realRun(runId);
    await db().importRun.updateMany({ where: { id: runId }, data: { status: "DONE" } });
    expect((await findImportWork(context_)).filter((j) => j.shop === t.domain)).toEqual([]);
  });
});

describe("a contract already made under another key", () => {
  /** A customer imported once, with the second plan ready to map to. */
  async function imported(orders: () => OrderNode[]) {
    const t = await setup();
    const other = await db().plan.create({
      data: {
        shopId: t.shop.id,
        name: "Annual, corrected",
        displayName: "Annual, corrected",
        billingMode: "PREPAID_BUNDLE",
        releasesPerTerm: 2,
        termMonths: 12,
        priceCents: 4000,
        sellingPlanGid: `gid://shopify/SellingPlan/${k}001`,
        productGid: "gid://shopify/Product/1",
      },
    });
    const gid = t.add(1, orders());
    await t.realRun(await t.dryRun([contact(1)]));
    expect(t.state.created).toHaveLength(1);
    return { t, other, gid };
  }

  it("a corrected plan mapping makes no second contract, and says why", async () => {
    const { t, other } = await imported(() => [order(ago(100), "sub")]);
    t.settings.plans[0].planId = other.id;
    const second = await t.dryRun([contact(1)]);
    const [row] = await t.rows(second);
    expect(row).toMatchObject({ category: "IMPORTED_UNDER_ANOTHER_KEY", planId: other.id, state: "READ" });
    await t.realRun(second);
    expect(t.state.created).toHaveLength(1);
    expect(await db().subscription.count({ where: { shopId: t.shop.id } })).toBe(1);
  });

  it("a first order refunded or cancelled later makes no second contract", async () => {
    for (const change of [
      { displayFinancialStatus: "REFUNDED" },
      { cancelledAt: ago(1) },
    ]) {
      const first = order(ago(500), "sub");
      const { t } = await imported(() => [order(ago(135), "sub"), first]);
      Object.assign(first, change);
      const second = await t.dryRun([contact(1)]);
      expect((await t.rows(second)).map((r) => r.category)).toEqual(["IMPORTED_UNDER_ANOTHER_KEY"]);
      await t.realRun(second);
      expect(t.state.created).toHaveLength(1);
      expect(await db().subscription.count({ where: { shopId: t.shop.id } })).toBe(1);
    }
  });

  it("the real run's fresh read refuses it too, when the marker appears after the dry run", async () => {
    const t = await setup();
    const gid = t.add(1, [order(ago(100), "sub")]);
    const runId = await t.dryRun([contact(1)]);
    expect((await t.rows(runId))[0]).toMatchObject({ category: "READY" });
    t.customers.get(gid)!.subscriptionContracts.nodes.push({
      id: "gid://shopify/SubscriptionContract/2",
      customAttributes: [{ key: IMPORT_MARKER, value: "some:other:key" }],
    });
    await t.realRun(runId);
    expect(t.state.created).toEqual([]);
    expect(await db().subscription.count({ where: { shopId: t.shop.id } })).toBe(0);
    expect((await t.rows(runId))[0]).toMatchObject({ state: "SKIPPED", category: "IMPORTED_UNDER_ANOTHER_KEY" });
  });

  it("an early renewal that starts a new chain is still a second subscription: the old key is among those found", async () => {
    const { t } = await imported(() => [order(ago(200), "sub")]);
    const gid = [...t.customers.keys()][0];
    t.customers.get(gid)!.orders.unshift(order(ago(100), "sub"));
    const second = await t.dryRun([contact(1)]);
    const rows = await t.rows(second);
    expect(rows.map((r) => [r.state, r.category]).sort()).toEqual([["DONE", "READY"], ["READ", "READY"]]);
    await t.realRun(second);
    expect(t.state.created).toHaveLength(2);
    expect(await db().subscription.count({ where: { shopId: t.shop.id } })).toBe(2);
  });

  it("a second plan added to the mapping comes in beside the first", async () => {
    const { t, other } = await imported(() => [
      order(ago(100), "sub"),
      order(ago(90), [{ sku: "second", ...priced("40.00") }]),
    ]);
    t.settings.plans.push({ planId: other.id, match: ["second"] });
    const second = await t.dryRun([contact(1)]);
    expect((await t.rows(second)).map((r) => r.category).sort()).toEqual(["READY", "READY"]);
    await t.realRun(second);
    expect(t.state.created).toHaveLength(2);
  });

  it("only an import's marker counts: another attribute on a contract doesn't refuse anyone", () => {
    const r = one(customer([order(ago(100), "sub")], {
      subscriptionContracts: { nodes: [{ id: "c", customAttributes: [{ key: "something_else", value: "x" }] }] },
    }));
    expect(r.category).toBe("READY");
  });

  it("each chain is judged by itself: one still matching stays as it is", () => {
    const a = order("2027-01-10T00:00:00.000Z", "sub");
    const b = order("2027-03-01T00:00:00.000Z", "sub");
    const keys = analyzeCustomer(customer([a, b]), context()).map((r) => r.key!);
    const results = analyzeCustomer(
      customer([a, b], {
        subscriptionContracts: {
          nodes: [
            { id: "x", customAttributes: [{ key: IMPORT_MARKER, value: keys[0] }] },
            { id: "y", customAttributes: [{ key: IMPORT_MARKER, value: "old:key:gone" }] },
          ],
        },
      }),
      context(),
    );
    expect(results.map((r) => r.category)).toEqual(["READY", "IMPORTED_UNDER_ANOTHER_KEY"]);
    expect(results[0].flags).toContain("CONTRACT_EXISTS");
  });
});

describe("a dry run always finishes", () => {
  const job = (t: { domain: string }, runId: string) => ({ type: "import.read", id: "x", shop: t.domain, data: { runId } });
  async function reading(t: Awaited<ReturnType<typeof setup>>, contacts: ReturnType<typeof contact>[]) {
    const started = await startRun(db(), t.graphql, t.shop.id, t.settings);
    if (!("runId" in started)) throw new Error(started.error);
    await addContacts(env.DB, t.graphql, t.shop.id, started.runId, contacts);
    await beginRead(db(), { id: t.shop.id, shopDomain: t.domain }, started.runId, NOW);
    return started.runId;
  }

  it("a row that always throws ends as READ_FAILED, and the rows behind it are still read", async () => {
    const t = await setup();
    const bad = t.add(1, [order(ago(100), "sub")]);
    t.add(2, [order(ago(100), "sub")]);
    const runId = await reading(t, [contact(1), contact(2)]);
    const broken: Graphql = async (query, variables) => {
      if (query.includes("ImportCustomer") && variables?.id === bad) throw new Error("Admin API returned errors");
      return t.graphql(query, variables);
    };
    const delays: number[] = [];
    let next: Job | null = job(t, runId);
    for (let i = 0; next && i < 20; i++) {
      const step = await runReadSlice(db(), env.DB, async () => broken, next, () => NOW);
      if (step) delays.push(step.delaySeconds);
      next = step?.job ?? null;
    }
    expect(next).toBeNull();
    expect(delays).toEqual([60, 60, 60, 60]);
    const rows = await t.rows(runId);
    expect(rows.map((r) => [r.state, r.category])).toEqual([["READ", "READ_FAILED"], ["READ", "READY"]]);
    expect(rows[0].attempts).toBe(5);
    expect(await db().importRun.findUnique({ where: { id: runId } })).toMatchObject({ status: "READ" });
    // It can't be imported.
    await t.realRun(runId);
    expect(t.state.created).toHaveLength(1);
  });

  it("being limited uses no attempts, however long it lasts", async () => {
    const t = await setup();
    t.add(1, [order(ago(100), "sub")]);
    const runId = await reading(t, [contact(1)]);
    let limited = 12;
    const admin = {
      graphql: async (query: string, options?: { variables?: Record<string, unknown> }) => {
        if (query.includes("ImportCustomer") && limited-- > 0) {
          return new Response(JSON.stringify({ errors: { graphQLErrors: [{ extensions: { code: "THROTTLED" } }] } }));
        }
        return new Response(JSON.stringify({ data: await t.graphql(query, options?.variables) }));
      },
    };
    let next: Job | null = job(t, runId);
    for (let i = 0; next && i < 20; i++) {
      next = (await runReadSlice(db(), env.DB, async () => graphqlOf(admin), next, () => NOW))?.job ?? null;
    }
    expect((await t.rows(runId))[0]).toMatchObject({ state: "READ", category: "READY", attempts: 0 });
  });

  it("a customer erased between order pages is left out as redacted, at once", async () => {
    const paged: Graphql = async (query) =>
      query.includes("ImportOrders")
        ? { customer: null }
        : {
            customer: {
              ...customer([]),
              subscriptionContracts: { pageInfo: { hasNextPage: false }, nodes: [] },
              orders: { nodes: [order(ago(100), "sub")], pageInfo: { hasNextPage: true, endCursor: "x" } },
            },
          };
    expect(await readCustomer(paged, "gid://shopify/Customer/9")).toBeNull();
  });
});

describe("reading a customer", () => {
  it("a contract list cut short can't rule out a contract already made, so nothing is imported", async () => {
    const page = (hasNextPage: boolean): Graphql => async () => ({
      customer: {
        ...customer([]),
        subscriptionContracts: { pageInfo: { hasNextPage }, nodes: [] },
        orders: { nodes: [order(ago(100), "sub")], pageInfo: { hasNextPage: false, endCursor: null } },
      },
    });
    const read = async (next: boolean) => one((await readCustomer(page(next), "gid://shopify/Customer/9"))!).category;
    expect(await read(false)).toBe("READY");
    expect(await read(true)).toBe("HISTORY_TOO_LONG");
  });

  it("an order list too long to finish isn't guessed at", async () => {
    const endless: Graphql = async () => ({
      customer: {
        ...customer([]),
        subscriptionContracts: { pageInfo: { hasNextPage: false }, nodes: [] },
        orders: { nodes: [order(ago(100), "sub")], pageInfo: { hasNextPage: true, endCursor: "x" } },
      },
    });
    expect((await readCustomer(endless, "gid://shopify/Customer/9"))!.historyComplete).toBe(false);
  });
});

describe("recognizing an imported contract", () => {
  const contractFor = (t: any, attributes: { key: string; value: string }[]) => ({
    id: "gid://shopify/SubscriptionContract/77",
    status: "ACTIVE",
    createdAt: NOW.toISOString(),
    customer: { id: "gid://shopify/Customer/1" },
    originOrder: null,
    customAttributes: attributes,
    lines: { nodes: [{ quantity: 1, sellingPlanId: t.plan.sellingPlanGid, currentPrice: { amount: "40.00" }, customAttributes: [] }] },
  });

  it("the webhook arriving first, or after a crash, or from the hourly check, starts nothing", async () => {
    const t = await setup();
    await db().release.create({ data: { shopId: t.shop.id, number: 1, title: "R", status: "READY" } });
    const graphql: Graphql = async () => ({
      subscriptionContract: contractFor(t, [{ key: IMPORT_MARKER, value: "1:2:3" }]),
    });
    const jobs = await syncContract(db(), env.DB, graphql, syncShop(t), "gid://shopify/SubscriptionContract/77", NOW);
    expect(jobs).toEqual([]);
    expect(await db().subscription.count({ where: { shopId: t.shop.id } })).toBe(0);
    expect(await db().event.count({ where: { shopId: t.shop.id } })).toBe(0);

    // The hourly check finds it, and its job does the same.
    const page: Graphql = async () => ({
      subscriptionContracts: {
        nodes: [{ id: "gid://shopify/SubscriptionContract/77", revisionId: "1" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    const missed = await findMissedContracts(db(), page, t.domain);
    expect(missed).toHaveLength(1);
    expect(await syncContract(db(), env.DB, graphql, syncShop(t), String(missed[0].data?.contractGid), NOW)).toEqual([]);
    expect(await db().subscription.count({ where: { shopId: t.shop.id } })).toBe(0);
  });

  it("the same contract without the marker is still a sign-up", async () => {
    const t = await setup();
    const graphql: Graphql = async () => ({ subscriptionContract: contractFor(t, []) });
    await syncContract(db(), env.DB, graphql, syncShop(t), "gid://shopify/SubscriptionContract/77", NOW);
    expect(await db().subscription.findFirst({ where: { shopId: t.shop.id } })).toMatchObject({ source: "NEW" });
  });

  it("the webhook after the row: no sign-up jobs, no welcome, and a cancellation still lands", async () => {
    const t = await setup();
    t.add(1, [order(ago(100), "sub")]);
    const runId = await t.dryRun([contact(1)]);
    await t.realRun(runId);
    const sub = await db().subscription.findFirstOrThrow({ where: { shopId: t.shop.id } });
    const live: Graphql = async () => ({
      subscriptionContract: { ...contractFor(t, [{ key: IMPORT_MARKER, value: "x" }]), id: sub.contractGid },
    });
    expect(await syncContract(db(), env.DB, live, syncShop(t), sub.contractGid!, NOW)).toEqual([]);
    expect(await db().subscription.findUnique({ where: { id: sub.id } })).toMatchObject({ status: "ACTIVE", source: "IMPORTED" });

    const cancelled: Graphql = async () => ({
      subscriptionContract: { ...contractFor(t, [{ key: IMPORT_MARKER, value: "x" }]), id: sub.contractGid, status: "CANCELLED" },
    });
    await syncContract(db(), env.DB, cancelled, syncShop(t), sub.contractGid!, NOW);
    expect(await db().subscription.findUnique({ where: { id: sub.id } })).toMatchObject({ status: "CANCELLED" });
  });
});

describe("a hold charges nothing until a merchant lets it go", () => {
  async function held(extra: { renewalRule?: string } = {}) {
    const t = await setup(extra as any);
    t.add(1, [order(ago(400), "sub")]);
    const runId = await t.dryRun([contact(1)]);
    await t.realRun(runId);
    const sub = await db().subscription.findFirstOrThrow({ where: { shopId: t.shop.id }, include: { plan: true } });
    await env.DB.prepare(`INSERT OR IGNORE INTO "OfflineSession" ("id", "data") VALUES (?1, '{}')`).bind(`offline_${t.domain}`).run();
    return { t, sub };
  }
  const contract = (sub: any) => ({ subscriptionContract: { status: "ACTIVE", lines: { nodes: [] }, id: sub.contractGid } });

  it("under every renewal rule, by every way in", async () => {
    for (const renewalRule of ["TERM_DATE_HOLD_IF_LATE", "TERM_DATE", "ON_DEPLETION"]) {
      const { t, sub } = await held({ renewalRule });
      expect(sub).toMatchObject({ status: "PAUSED", pausedReason: IMPORT_HOLD });
      expect(renewalDue({ ...sub, releasesRemaining: 0 }, sub.plan, NOW)).toBe(false);
      expect((await findRenewals({ env, db: db(), now: NOW })).filter((j) => j.shop === t.domain)).toEqual([]);
      let calls = 0;
      const graphql: Graphql = async () => {
        calls++;
        return contract(sub);
      };
      expect(await renewIfDue(db(), env.DB, graphql, sub.id, NOW)).toBeNull();
      expect(calls).toBe(0);
    }
  });

  it("releasing moves a past term out, so the notice goes first and nothing charges at once", async () => {
    const { t, sub } = await held();
    expect(await releaseImportHold(env.DB, t.shop.id, sub.id, NOW)).toBe(true);
    const after = await db().subscription.findUniqueOrThrow({ where: { id: sub.id }, include: { plan: true } });
    expect(after).toMatchObject({ status: "ACTIVE", pausedReason: null });
    expect(after.termEndsAt!.getTime()).toBe(NOW.getTime() + 22 * DAY);
    expect(renewalDue({ ...after, releasesRemaining: 0 }, after.plan, NOW)).toBe(false);
    expect((await findRenewals({ env, db: db(), now: NOW })).filter((j) => j.shop === t.domain)).toEqual([]);
    // Only a hold can be released, and only this shop's.
    expect(await releaseImportHold(env.DB, t.shop.id, sub.id, NOW)).toBe(false);
  });

  it("releasing leaves a term date further off alone", async () => {
    const { t, sub } = await held();
    const far = new Date(NOW.getTime() + 100 * DAY);
    await db().subscription.update({ where: { id: sub.id }, data: { termEndsAt: far } });
    await releaseImportHold(env.DB, t.shop.id, sub.id, NOW);
    expect((await db().subscription.findUniqueOrThrow({ where: { id: sub.id } })).termEndsAt).toEqual(far);
  });

  it("another shop can't release it", async () => {
    const { sub } = await held();
    const other = await setup();
    expect(await releaseImportHold(env.DB, other.shop.id, sub.id, NOW)).toBe(false);
  });
});

describe("charging an imported subscriber", () => {
  /** A live subscriber whose term has just ended with nothing left, so a renewal is due now. */
  async function due(fields: { noCardSince?: Date; createdAt?: Date } = {}) {
    const t = await setup();
    const subscription = await db().subscription.create({
      data: {
        shopId: t.shop.id,
        planId: t.plan.id,
        contractGid: `gid://shopify/SubscriptionContract/${++contractId}`,
        customerGid: "gid://shopify/Customer/5",
        source: "IMPORTED",
        releasesRemaining: 0,
        termEndsAt: new Date(NOW.getTime() - DAY),
        lockedPriceCents: 3000,
        ...fields,
      },
    });
    const state = { card: null as string | null, saved: null as string | null, charges: 0, draftCard: null as string | null, priced: null as string | null };
    const graphql: Graphql = async (query, variables) => {
      if (query.includes("ImportedContractCard")) {
        return {
          subscriptionContract: { customerPaymentMethod: state.card ? { id: state.card } : null },
          customer: { paymentMethods: { nodes: state.saved ? [{ id: state.saved }] : [] } },
        };
      }
      if (query.includes("ContractForCharge")) {
        return {
          subscriptionContract: {
            status: "ACTIVE",
            deliveryPrice: { amount: "0.0" },
            lines: { nodes: [{ id: "line", sellingPlanId: t.plan.sellingPlanGid, currentPrice: { amount: "30.00" } }] },
          },
        };
      }
      if (query.includes("PriceDraftOpen")) return { subscriptionContractUpdate: { draft: { id: "d" }, userErrors: [] } };
      if (query.includes("ImportedDraftCard")) {
        state.draftCard = (variables as any).input.paymentMethodId;
        return { subscriptionDraftUpdate: { userErrors: [] } };
      }
      if (query.includes("PriceDraftLine")) {
        state.priced = (variables as any).input.currentPrice;
        return { subscriptionDraftLineUpdate: { userErrors: [] } };
      }
      if (query.includes("PriceDraftCommit")) {
        if (state.draftCard) state.card = state.draftCard;
        return { subscriptionDraftCommit: { contract: { id: "c" }, userErrors: [] } };
      }
      if (query.includes("BillingAttemptCreate")) {
        state.charges++;
        return { subscriptionBillingAttemptCreate: { subscriptionBillingAttempt: { id: `gid://shopify/SubscriptionBillingAttempt/${state.charges}${contractId}`, state: { __typename: "x" } }, userErrors: [] } };
      }
      throw new Error(`Unexpected query: ${query.slice(0, 60)}`);
    };
    return { t, subscription, state, graphql };
  }
  const reread = (id: string) => db().subscription.findUniqueOrThrow({ where: { id } });

  it("no card and none saved: the charge still goes out, to fail and pause by the usual rule", async () => {
    const { subscription, state, graphql } = await due({ noCardSince: NOW });
    await renewIfDue(db(), env.DB, graphql, subscription.id, NOW);
    expect(state.charges).toBe(1);
    expect(state.draftCard).toBeNull();
    expect((await reread(subscription.id)).noCardSince).not.toBeNull();
  });

  it("a card saved since the import is put on the contract just before the charge", async () => {
    const { subscription, state, graphql } = await due({ noCardSince: NOW });
    state.saved = "gid://shopify/CustomerPaymentMethod/new";
    await renewIfDue(db(), env.DB, graphql, subscription.id, NOW);
    expect(state.card).toBe("gid://shopify/CustomerPaymentMethod/new");
    expect(state.charges).toBe(1);
    expect((await reread(subscription.id)).noCardSince).toBeNull();
  });

  it("a contract that has got a card some other way just clears the flag", async () => {
    const { subscription, state, graphql } = await due({ noCardSince: NOW });
    state.card = "gid://shopify/CustomerPaymentMethod/already";
    await renewIfDue(db(), env.DB, graphql, subscription.id, NOW);
    expect(state.draftCard).toBeNull();
    expect((await reread(subscription.id)).noCardSince).toBeNull();
  });

  it("the hold rule keeps waiting while a carried balance is left", async () => {
    const { subscription, state, graphql } = await due();
    await db().subscription.update({ where: { id: subscription.id }, data: { releasesRemaining: 3, importedBalance: 3 } });
    const reread2 = await db().subscription.findUniqueOrThrow({ where: { id: subscription.id }, include: { plan: true } });
    expect(renewalDue(reread2, reread2.plan, NOW)).toBe(false);
    expect(await renewIfDue(db(), env.DB, graphql, subscription.id, NOW)).toBeNull();
    expect(state.charges).toBe(0);
  });

  it("TERM_DATE charges at the date whatever the balance, and a success adds to it, so nothing carried is lost", async () => {
    const { t, subscription, state, graphql } = await due();
    await db().plan.update({ where: { id: t.plan.id }, data: { renewalRule: "TERM_DATE" } });
    await db().subscription.update({ where: { id: subscription.id }, data: { releasesRemaining: 3 } });
    expect(await renewIfDue(db(), env.DB, graphql, subscription.id, NOW)).toBe("sent");
    expect(state.charges).toBe(1);
    const row = await db().billingAttempt.findFirstOrThrow({ where: { subscriptionId: subscription.id } });
    const settled: Graphql = async () => ({
      subscriptionBillingAttempt: {
        id: row.shopifyAttemptGid,
        idempotencyKey: row.idempotencyKey,
        completedAt: NOW.toISOString(),
        state: { __typename: "SubscriptionBillingAttemptSuccessState", order: { id: "gid://shopify/Order/1" } },
      },
    });
    await settleAttempt(db(), env.DB, settled, row.shopifyAttemptGid!, NOW);
    expect(await reread(subscription.id)).toMatchObject({ releasesRemaining: 5 });
  });

  const priceChange = (planId: string, createdAt: Date, effectiveAt: Date) =>
    db().priceChange.create({ data: { planId, newPriceCents: 5000, policy: "APPLY_AT_RENEWAL", createdAt, effectiveAt } });

  it("a rise saved before they came in never reached them, so they keep what they pay", async () => {
    const { t, subscription, state, graphql } = await due({ createdAt: new Date(NOW.getTime() - 10 * DAY) });
    await priceChange(t.plan.id, new Date(NOW.getTime() - 20 * DAY), new Date(NOW.getTime() - 2 * DAY));
    await renewIfDue(db(), env.DB, graphql, subscription.id, NOW);
    expect(state.priced).toBeNull();
    expect((await reread(subscription.id)).lockedPriceCents).toBe(3000);
  });

  it("a rise saved after they came in applies, with its notice, like anyone's", async () => {
    const { t, subscription, state, graphql } = await due({ createdAt: new Date(NOW.getTime() - 60 * DAY) });
    await priceChange(t.plan.id, new Date(NOW.getTime() - 40 * DAY), new Date(NOW.getTime() - 10 * DAY));
    await renewIfDue(db(), env.DB, graphql, subscription.id, NOW);
    expect(state.priced).toBe("50.00");
    expect((await reread(subscription.id)).lockedPriceCents).toBe(5000);
  });
});

describe("imported subscribers elsewhere in the app", () => {
  it("revenue: what they arrived with is unpriced, and a renewal pays for the releases after it", async () => {
    const t = await setup();
    t.add(1, [order(ago(100), "sub")]);
    await t.realRun(await t.dryRun([contact(1)]));
    const sub = await db().subscription.findFirstOrThrow({ where: { shopId: t.shop.id } });
    expect(sub.importedBalance).toBe(1);
    const make = (number: number) => db().release.create({ data: { shopId: t.shop.id, number, title: `R${number}`, status: "SHIPPED" } });
    const [a, b, c] = await Promise.all([make(11), make(12), make(13)]);
    for (const release of [a, b, c]) {
      await db().delivery.create({
        data: { subscriptionId: sub.id, releaseId: release.id, status: "ORDERED", orderGid: `gid://shopify/Order/r${release.id}` },
      });
    }
    await db().billingAttempt.create({
      data: { subscriptionId: sub.id, chargeFor: "term-1", idempotencyKey: `k${sub.id}`, attempt: 1, result: "SUCCEEDED", amountCents: 4000, createdAt: new Date(NOW.getTime() + DAY) },
    });
    const report = await revenueReport(db(), env.DB, t.shop.id);
    const byRelease = totalsBy(report.rows, "releaseId");
    expect(byRelease.get(a.id)).toMatchObject({ revenue: 0, unpriced: 1 });
    expect(byRelease.get(b.id)?.revenue).toBe(2000);
    expect(byRelease.get(c.id)?.revenue).toBe(2000);
    // An opening balance isn't a payment waiting to be read.
    expect(report.paid).toMatchObject({ total: 4000, unread: 0 });
  });

  it("GDPR: a data request lists the rows, a redaction clears them, and a shop redaction deletes them", async () => {
    const t = await setup();
    const gid = t.add(1, [order(ago(100), "sub")]);
    t.add(2, [order(ago(100), "sub")]);
    const runId = await t.dryRun([contact(1), contact(2)]);

    await recordDataRequest(db(), env.DB, t.domain, gid, "req1");
    const event = await db().event.findFirstOrThrow({ where: { shopId: t.shop.id, type: "gdpr.data_request" } });
    expect((event.payload as any).importRows).toHaveLength(1);

    await redactCustomer(db(), env.DB, t.domain, gid);
    const rows = await t.rows(runId);
    expect(rows[0]).toMatchObject({ customerGid: "redacted", category: "REDACTED", state: "SKIPPED", facts: {}, flags: [] });
    expect(rows[0].key).not.toContain(gid.split("/").pop());
    expect(rows[1]).toMatchObject({ category: "READY" });

    // The real run can't bring them back.
    t.customers.delete(gid);
    await t.realRun(runId);
    expect(t.state.created).toHaveLength(1);
    expect(t.state.created[0].input.customerId).not.toBe(gid);

    await redactShop(db(), env.DB, t.domain);
    expect(await db().importRow.count({ where: { shopId: t.shop.id } })).toBe(0);
    expect(await db().importRun.count({ where: { shopId: t.shop.id } })).toBe(0);
  });

  it("a redaction after the contract call leaves no subscription for someone erased", async () => {
    const t = await setup();
    const gid = t.add(1, [order(ago(100), "sub")]);
    const runId = await t.dryRun([contact(1)]);
    await beginImport(db(), env.DB, { id: t.shop.id, shopDomain: t.domain }, runId, NOW);
    const racing: Graphql = async (query, variables) => {
      const result = await t.graphql(query, variables);
      if (query.includes("ImportContractCreate")) await redactCustomer(db(), env.DB, t.domain, gid);
      return result;
    };
    await runCreateSlice(db(), env.DB, async () => racing, { type: "import.create", id: "x", shop: t.domain, data: { runId } }, () => NOW);
    expect(await db().subscription.count({ where: { shopId: t.shop.id } })).toBe(0);
  });
});

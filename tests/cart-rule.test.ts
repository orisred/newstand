import { describe, expect, it } from "vitest";
import { ensureCartRule } from "../app/cart-rule.server";
import type { Graphql } from "../app/plan-sync.server";
import { cartValidationsGenerateRun as run } from "../extensions/one-plan-per-cart/src/cart_validations_generate_run.js";

const line = (plan: string | null) => ({
  sellingPlanAllocation: plan ? { sellingPlan: { id: plan } } : null,
});
const errorsFor = (...plans: (string | null)[]) =>
  run({ cart: { lines: plans.map(line) } }).operations[0].validationAdd.errors;

/** A line carrying a gift's recipient, the way the plan picker sends it. */
const gift = (plan: string | null, email: string | null, extra: Record<string, string> = {}) => ({
  ...line(plan),
  giftEmail: email === null ? null : { value: email },
  giftName: extra.name ? { value: extra.name } : null,
  giftMessage: extra.message ? { value: extra.message } : null,
});
const giftErrors = (...lines: ReturnType<typeof gift>[]) =>
  run({ cart: { lines } }).operations[0].validationAdd.errors.map((e: { message: string }) => e.message);

describe("the cart rule for gifts", () => {
  it("allows a gift on its own, alongside other products, and an ordinary subscription", () => {
    expect(giftErrors(gift("a", "ada@example.com", { name: "Ada", message: "Hi" }))).toEqual([]);
    expect(giftErrors(gift("a", "ada@example.com"), gift(null, null))).toEqual([]);
    expect(giftErrors(gift("a", null), gift("a", null))).toEqual([]);
  });

  it("blocks a gift next to another subscription line: they'd share one contract and one recipient", () => {
    const together = /checked out on its own/;
    expect(giftErrors(gift("a", "ada@example.com"), gift("a", "grace@example.com"))[0]).toMatch(together);
    expect(giftErrors(gift("a", "ada@example.com"), gift("a", null))[0]).toMatch(together);
  });

  it("blocks a recipient with no usable email while the buyer can still fix it", () => {
    for (const email of ["", "   ", "ada", "a@b", "a@b.com, c@d.com", "Ada <a@b.com>"]) {
      expect(giftErrors(gift("a", email, { name: "Ada" })), email).toEqual([
        "Please enter a valid email address for the gift recipient.",
      ]);
    }
    expect(giftErrors(gift("a", null, { message: "Hi" }))).toHaveLength(1);
    // A gift property on a line that isn't a subscription means nothing.
    expect(giftErrors(gift(null, "nope"))).toEqual([]);
  });
});

describe("the cart rule", () => {
  it("stops two different plans", () => {
    expect(errorsFor("a", "b")).toEqual([
      {
        message: "Please check out one subscription plan at a time.",
        target: "$.cart",
      },
    ]);
  });
  it("allows one plan, several lines of it, and other products alongside", () => {
    expect(errorsFor("a")).toEqual([]);
    expect(errorsFor("a", "a")).toEqual([]);
    expect(errorsFor("a", null, null)).toEqual([]);
    expect(errorsFor(null)).toEqual([]);
  });
});

function shopify(handles: string[], fail = false) {
  const created: unknown[] = [];
  const graphql: Graphql = async (query, variables) => {
    if (fail) throw new Error("down");
    if (query.includes("CartRuleCreate")) {
      created.push(variables);
      return { validationCreate: { validation: { id: "v" }, userErrors: [] } };
    }
    return {
      validations: {
        nodes: handles.map((handle) => ({ shopifyFunction: { handle } })),
      },
    };
  };
  return { graphql, created };
}

describe("ensureCartRule", () => {
  it("turns the rule on, without blocking checkouts if it fails at runtime", async () => {
    const { graphql, created } = shopify(["someone-elses"]);
    await ensureCartRule(graphql);
    expect(created).toEqual([
      {
        validation: expect.objectContaining({
          functionHandle: "one-plan-per-cart",
          enable: true,
          blockOnFailure: false,
        }),
      },
    ]);
  });
  it("leaves it alone once it exists, even if the merchant turned it off", async () => {
    const { graphql, created } = shopify(["one-plan-per-cart"]);
    await ensureCartRule(graphql);
    expect(created).toEqual([]);
  });
  it("never fails the plan sync", async () => {
    await expect(ensureCartRule(shopify([], true).graphql)).resolves.toBeUndefined();
  });
});

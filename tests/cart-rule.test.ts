import { describe, expect, it } from "vitest";
import { ensureCartRule } from "../app/cart-rule.server";
import type { Graphql } from "../app/plan-sync.server";
import { cartValidationsGenerateRun as run } from "../extensions/one-plan-per-cart/src/cart_validations_generate_run.js";

const line = (plan: string | null) => ({
  sellingPlanAllocation: plan ? { sellingPlan: { id: plan } } : null,
});
const errorsFor = (...plans: (string | null)[]) =>
  run({ cart: { lines: plans.map(line) } }).operations[0].validationAdd.errors;

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

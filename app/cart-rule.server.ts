import { logEvent } from "./logger.server";
import type { Graphql } from "./plan-sync.server";

const FUNCTION_HANDLE = "one-plan-per-cart";

const VALIDATIONS = `#graphql
  query CartRules {
    validations(first: 25) { nodes { shopifyFunction { handle } } }
  }`;

const CREATE = `#graphql
  mutation CartRuleCreate($validation: ValidationCreateInput!) {
    validationCreate(validation: $validation) {
      validation { id }
      userErrors { message }
    }
  }`;

/**
 * Turns on the checkout rule stopping two different plans in one cart. Runs with each plan
 * sync. Once it exists it's left alone, so a merchant who turned it off in Shopify's checkout
 * rules keeps it off. A failure never blocks the sync, because the contract job holds mixed
 * contracts anyway. If the rule fails at runtime it lets the checkout through (`blockOnFailure`).
 */
export async function ensureCartRule(graphql: Graphql) {
  try {
    const { validations } = await graphql(VALIDATIONS);
    const exists = validations.nodes.some(
      (node: { shopifyFunction: { handle: string } }) =>
        node.shopifyFunction.handle === FUNCTION_HANDLE,
    );
    if (exists) return;
    const { validationCreate: result } = await graphql(CREATE, {
      validation: {
        functionHandle: FUNCTION_HANDLE,
        enable: true,
        blockOnFailure: false,
        title: "One subscription plan per checkout",
      },
    });
    if (result.userErrors.length > 0) {
      logEvent("error", "cart_rule.refused", {});
    }
  } catch {
    logEvent("error", "cart_rule.failed", {});
  }
}

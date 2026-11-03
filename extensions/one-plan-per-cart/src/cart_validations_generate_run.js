/**
 * Stops a checkout holding two different selling plans. Shopify can merge plans with the same
 * billing cycle into one contract, and a billing attempt charges a whole contract, so their
 * releases couldn't be charged separately. Several copies of one plan are fine. It counts every
 * selling plan, because a function's input doesn't say which app a plan belongs to.
 */
export function cartValidationsGenerateRun(input) {
  const plans = new Set(
    input.cart.lines
      .map((line) => line.sellingPlanAllocation?.sellingPlan.id)
      .filter(Boolean),
  );
  const errors =
    plans.size > 1
      ? [
          {
            message: "Please check out one subscription plan at a time.",
            target: "$.cart",
          },
        ]
      : [];
  return { operations: [{ validationAdd: { errors } }] };
}

// The same shape the app accepts for a gift's recipient (app/gifts.server.ts): one address, no quotes or separators.
const EMAIL = /^[^\s@<>"'`,;:()[\]\\]+@[^\s@<>"'`,;:()[\]\\]+\.[^\s@<>"'`,;:()[\]\\]{2,}$/;

const cart = (message) => ({ message, target: "$.cart" });

/**
 * Stops a checkout the app couldn't honour.
 *
 * Two different selling plans: Shopify can merge plans with the same billing cycle into one
 * contract, and a billing attempt charges a whole contract, so their releases couldn't be
 * charged separately. Several copies of one plan are fine. It counts every selling plan,
 * because a function's input doesn't say which app a plan belongs to.
 *
 * Gifts: a gift's recipient is read from its line, and lines of one plan end up on one contract,
 * so a gift has to be the only subscription line. A recipient without a usable email would be
 * caught after the buyer paid, so it's caught here, while they can still fix it.
 */
export function cartValidationsGenerateRun(input) {
  const subscriptionLines = input.cart.lines.filter(
    (line) => line.sellingPlanAllocation,
  );
  const plans = new Set(
    subscriptionLines.map((line) => line.sellingPlanAllocation.sellingPlan.id),
  );
  const isGift = (line) =>
    [line.giftEmail, line.giftName, line.giftMessage].some((a) => a?.value?.trim());
  const gifts = subscriptionLines.filter(isGift);

  const errors = [];
  if (plans.size > 1) {
    errors.push(cart("Please check out one subscription plan at a time."));
  } else if (gifts.length > 0 && subscriptionLines.length > 1) {
    errors.push(
      cart("A gift has to be checked out on its own. Please buy each gift, and your own subscription, separately."),
    );
  }
  if (gifts.some((line) => !EMAIL.test(line.giftEmail?.value?.trim() ?? ""))) {
    errors.push(cart("Please enter a valid email address for the gift recipient."));
  }
  return { operations: [{ validationAdd: { errors } }] };
}

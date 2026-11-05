-- Merchant dashboard (Step 13). Written by hand: added columns need no table rebuild.
-- What a payment brought in, in cents, before tax and shipping. NULL until the hourly job has read the order.
ALTER TABLE "Subscription" ADD COLUMN "signupCents" INTEGER;
ALTER TABLE "BillingAttempt" ADD COLUMN "amountCents" INTEGER;
-- Costs per release: product per copy, shipping and handling per order. NULL means not recorded.
ALTER TABLE "Release" ADD COLUMN "productCostCents" INTEGER;
ALTER TABLE "Release" ADD COLUMN "shippingCostCents" INTEGER;
ALTER TABLE "Release" ADD COLUMN "handlingCostCents" INTEGER;
-- The lowest stock among the plan's product variants that stop selling at 0, as of the last hourly check.
ALTER TABLE "Plan" ADD COLUMN "stockLevel" INTEGER;
ALTER TABLE "Plan" ADD COLUMN "stockCheckedAt" DATETIME;

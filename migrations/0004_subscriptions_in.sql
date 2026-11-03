-- Subscriptions in (Step 7). Written by hand: added columns need no table rebuild.
ALTER TABLE "Release" ADD COLUMN "productTitle" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "quantity" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Subscription" ADD COLUMN "firstReleaseNumber" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Delivery" ADD COLUMN "orderLeaseUntil" DATETIME;
ALTER TABLE "Delivery" ADD COLUMN "orderError" TEXT;

CREATE INDEX "Delivery_releaseId_status_idx" ON "Delivery"("releaseId", "status");

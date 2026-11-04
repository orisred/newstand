-- Release runs (Step 8). Written by hand: added columns need no table rebuild.
ALTER TABLE "Release" ADD COLUMN "runLeaseUntil" DATETIME;
ALTER TABLE "Delivery" ADD COLUMN "orderName" TEXT;
ALTER TABLE "Shop" ADD COLUMN "timezone" TEXT;

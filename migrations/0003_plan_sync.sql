-- Plan sync state. Written by hand: `prisma migrate diff` wants to rebuild the Plan table
-- (drop and copy), which isn't needed for added columns and is risky with foreign keys on D1.
ALTER TABLE "Plan" ADD COLUMN "sellingPlanGroupGid" TEXT;
ALTER TABLE "Plan" ADD COLUMN "productGid" TEXT;
ALTER TABLE "Plan" ADD COLUMN "productTitle" TEXT;
ALTER TABLE "Plan" ADD COLUMN "syncStatus" TEXT NOT NULL DEFAULT 'NOT_SYNCED';
ALTER TABLE "Plan" ADD COLUMN "syncMessage" TEXT;
ALTER TABLE "Plan" ADD COLUMN "syncedAt" DATETIME;
ALTER TABLE "Plan" ADD COLUMN "syncRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Plan" ADD COLUMN "syncLeaseUntil" DATETIME;

CREATE UNIQUE INDEX "Plan_sellingPlanGroupGid_key" ON "Plan"("sellingPlanGroupGid");
CREATE INDEX "Plan_shopId_createdAt_idx" ON "Plan"("shopId", "createdAt");

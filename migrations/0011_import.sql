-- Migration import (Step 14). No names, addresses or emails in either table.
CREATE TABLE "ImportRun" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shopId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'COLLECTING',
  "settings" JSONB NOT NULL,
  "readAt" DATETIME,
  "importedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ImportRun_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ImportRun_shopId_createdAt_idx" ON "ImportRun"("shopId", "createdAt");

CREATE TABLE "ImportRow" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shopId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "contactNumber" INTEGER,
  "customerGid" TEXT,
  "contactCancelled" BOOLEAN NOT NULL DEFAULT false,
  "planId" TEXT,
  "state" TEXT NOT NULL DEFAULT 'TO_READ',
  "category" TEXT,
  "flags" JSONB NOT NULL DEFAULT '[]',
  "facts" JSONB NOT NULL DEFAULT '{}',
  "leaseUntil" DATETIME,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "contractGid" TEXT,
  "subscriptionId" TEXT,
  "error" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ImportRow_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ImportRow_shopId_key_key" ON "ImportRow"("shopId", "key");
CREATE INDEX "ImportRow_runId_state_idx" ON "ImportRow"("runId", "state");
CREATE INDEX "ImportRow_runId_category_idx" ON "ImportRow"("runId", "category");
CREATE INDEX "ImportRow_shopId_customerGid_idx" ON "ImportRow"("shopId", "customerGid");

ALTER TABLE "Subscription" ADD COLUMN "importedBalance" INTEGER;
ALTER TABLE "Subscription" ADD COLUMN "noCardSince" DATETIME;

-- Generated with `prisma migrate diff --from-empty`. The JSON defaults on "Shop" are
-- quoted by hand, because Prisma writes them unquoted, which is invalid SQL.

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "releaseWordSingular" TEXT NOT NULL DEFAULT 'issue',
    "releaseWordPlural" TEXT NOT NULL DEFAULT 'issues',
    "allowedCountries" JSONB NOT NULL DEFAULT '["US"]',
    "memberDiscountTag" TEXT DEFAULT 'active-subscriber',
    "orderTiming" TEXT NOT NULL DEFAULT 'READY_TO_SHIP',
    "emailsEnabled" JSONB NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Release" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "productGid" TEXT,
    "preorderOpensAt" DATETIME,
    "cutoffAt" DATETIME,
    "shipAt" DATETIME,
    "triggerMode" TEXT NOT NULL DEFAULT 'MANUAL',
    "quantity" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'UNANNOUNCED',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Release_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "sellingPlanGid" TEXT,
    "billingMode" TEXT NOT NULL DEFAULT 'PREPAID_BUNDLE',
    "releasesPerTerm" INTEGER NOT NULL DEFAULT 1,
    "termMonths" INTEGER,
    "renewalRule" TEXT NOT NULL DEFAULT 'TERM_DATE_HOLD_IF_LATE',
    "priceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "autoRenew" BOOLEAN NOT NULL DEFAULT true,
    "startRule" TEXT NOT NULL DEFAULT 'PREORDER_SWITCHOVER',
    "giftable" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Plan_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "contractGid" TEXT,
    "customerGid" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "source" TEXT NOT NULL DEFAULT 'NEW',
    "releasesRemaining" INTEGER NOT NULL,
    "termEndsAt" DATETIME,
    "nextReleaseId" TEXT,
    "lockedPriceCents" INTEGER,
    "giftBuyerGid" TEXT,
    "giftMessage" TEXT,
    "pausedReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Subscription_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Delivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subscriptionId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "orderGid" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "addressConfirmedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Delivery_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Delivery_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "Release" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BillingAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subscriptionId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "shopifyAttemptGid" TEXT,
    "result" TEXT NOT NULL DEFAULT 'PENDING',
    "errorCode" TEXT,
    "nextRetryAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BillingAttempt_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PriceChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "planId" TEXT NOT NULL,
    "newPriceCents" INTEGER NOT NULL,
    "policy" TEXT NOT NULL,
    "effectiveAt" DATETIME NOT NULL,
    "noticeSentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PriceChange_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "sentToFlowAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Event_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Event_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");

-- CreateIndex
CREATE INDEX "Release_shopId_cutoffAt_idx" ON "Release"("shopId", "cutoffAt");

-- CreateIndex
CREATE UNIQUE INDEX "Release_shopId_number_key" ON "Release"("shopId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_sellingPlanGid_key" ON "Plan"("sellingPlanGid");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_contractGid_key" ON "Subscription"("contractGid");

-- CreateIndex
CREATE INDEX "Subscription_shopId_status_idx" ON "Subscription"("shopId", "status");

-- CreateIndex
CREATE INDEX "Subscription_customerGid_idx" ON "Subscription"("customerGid");

-- CreateIndex
CREATE UNIQUE INDEX "Delivery_orderGid_key" ON "Delivery"("orderGid");

-- CreateIndex
CREATE UNIQUE INDEX "Delivery_subscriptionId_releaseId_key" ON "Delivery"("subscriptionId", "releaseId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingAttempt_idempotencyKey_key" ON "BillingAttempt"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "BillingAttempt_shopifyAttemptGid_key" ON "BillingAttempt"("shopifyAttemptGid");

-- CreateIndex
CREATE INDEX "Event_shopId_type_createdAt_idx" ON "Event"("shopId", "type", "createdAt");


-- Renewals and per-release charges (Step 9). Written by hand. BillingAttempt had no writer before
-- this step, so it's empty everywhere and is rebuilt for its required column.
DROP TABLE "BillingAttempt";
CREATE TABLE "BillingAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subscriptionId" TEXT NOT NULL,
    "chargeFor" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "shopifyAttemptGid" TEXT,
    "orderGid" TEXT,
    "result" TEXT NOT NULL DEFAULT 'PENDING',
    "errorCode" TEXT,
    "nextRetryAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BillingAttempt_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BillingAttempt_idempotencyKey_key" ON "BillingAttempt"("idempotencyKey");
CREATE UNIQUE INDEX "BillingAttempt_shopifyAttemptGid_key" ON "BillingAttempt"("shopifyAttemptGid");
CREATE INDEX "BillingAttempt_subscriptionId_chargeFor_idx" ON "BillingAttempt"("subscriptionId", "chargeFor");
CREATE INDEX "BillingAttempt_chargeFor_result_idx" ON "BillingAttempt"("chargeFor", "result");
CREATE INDEX "BillingAttempt_result_createdAt_idx" ON "BillingAttempt"("result", "createdAt");
CREATE INDEX "BillingAttempt_nextRetryAt_idx" ON "BillingAttempt"("nextRetryAt");

ALTER TABLE "Subscription" ADD COLUMN "paymentProblemSince" DATETIME;
CREATE INDEX "Subscription_shopId_paymentProblemSince_idx" ON "Subscription"("shopId", "paymentProblemSince");

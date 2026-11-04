-- Emails and member tags (Step 10). Written by hand: both tables are new.
CREATE TABLE "EmailSend" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" DATETIME,
    "reason" TEXT,
    "messageId" TEXT,
    "sentAt" DATETIME,
    "addressConfirmedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EmailSend_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "EmailSend_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "EmailSend_shopId_status_idx" ON "EmailSend"("shopId", "status");
CREATE INDEX "EmailSend_subscriptionId_idx" ON "EmailSend"("subscriptionId");

CREATE TABLE "MemberTag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "customerGid" TEXT NOT NULL,
    "tag" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MemberTag_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "MemberTag_shopId_idx" ON "MemberTag"("shopId");

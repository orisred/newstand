-- CreateTable
CREATE TABLE "JobRun" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "shop" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CLAIMED',
    "owner" TEXT,
    "leaseExpiresAt" DATETIME,
    "runs" INTEGER NOT NULL DEFAULT 1,
    "lastError" TEXT,
    "body" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "OfflineSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "data" TEXT NOT NULL
);


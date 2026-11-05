-- Step 15. A second success on one charge is recorded as DUPLICATE (BillingAttempt.result is plain TEXT).
-- RateLimit holds one hashed key per limiter and window, so no customer ID or IP is stored.
CREATE TABLE "RateLimit" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "count" INTEGER NOT NULL DEFAULT 1,
  "windowEndsAt" DATETIME NOT NULL
);
CREATE INDEX "RateLimit_windowEndsAt_idx" ON "RateLimit"("windowEndsAt");
-- What pruning walks, instead of the whole table.
CREATE INDEX "JobRun_status_updatedAt_idx" ON "JobRun"("status", "updatedAt");

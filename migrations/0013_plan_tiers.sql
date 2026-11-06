-- Cutover C3. A plan's perk text (sent as its selling plan's description) and its own member tag, and
-- the shop's vocabulary for customer-facing text. Existing shops keep "subscription".
ALTER TABLE "Plan" ADD COLUMN "description" TEXT;
ALTER TABLE "Plan" ADD COLUMN "memberTag" TEXT;
ALTER TABLE "Shop" ADD COLUMN "vocabulary" TEXT NOT NULL DEFAULT 'SUBSCRIPTIONS';

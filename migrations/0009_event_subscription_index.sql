-- Step 13: the dashboard looks a subscriber's events up by subscription.
CREATE INDEX "Event_subscriptionId_idx" ON "Event"("subscriptionId");

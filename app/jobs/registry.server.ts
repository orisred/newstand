import { graphqlOf, syncPlan } from "../plan-sync.server";
import { SYNC_JOB } from "../plans.server";
import { unauthenticated } from "../shopify.server";
import type { DueWorkFinder, JobHandler } from "./runner.server";

// Steps 7 to 10 add their job types and finders here.
export const jobHandlers: Record<string, JobHandler> = {
  // Brings one plan's selling plan group in line with the plan. Queued by the plan screens.
  [SYNC_JOB]: async (job, { db }) => {
    const { planId, shopId } = job.data ?? {};
    if (!job.shop || typeof planId !== "string" || typeof shopId !== "string") {
      throw new Error("plan.sync job without a shop or plan");
    }
    const { admin } = await unauthenticated.admin(job.shop);
    await syncPlan(db, graphqlOf(admin), shopId, planId);
  },
};
export const dueWorkFinders: DueWorkFinder[] = [];

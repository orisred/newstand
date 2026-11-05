import {
  attachSavedCards,
  BILLING_RECOVER_JOB,
  BILLING_RENEW_JOB,
  BILLING_RESUME_JOB,
  BILLING_RETRY_JOB,
  BILLING_SETTLE_JOB,
  CARD_UPDATED_JOB,
  DISPUTE_JOB,
  findLostResults,
  findRenewals,
  findRetries,
  recordChargeback,
  recoverAttempt,
  resumeAfterCardUpdate,
  runResumeJob,
  renewIfDue,
  retryDue,
  settleAttempt,
} from "../billing.server";
import { ensureCartRule } from "../cart-rule.server";
import { DASHBOARD_JOB, dashboardJob, refreshDashboard } from "../dashboard.server";
import { publishGiftPlans } from "../gifts.server";
import {
  findImportWork,
  IMPORT_CREATE_JOB,
  IMPORT_READ_JOB,
  runCreateSlice,
  runReadSlice,
} from "../import.server";
import { runEmailSlice } from "../emails.server";
import { runFlowSlice } from "../flow.server";
import { runMemberTagSlice } from "../member-tag.server";
import {
  EMAIL_JOB,
  emailRunJob,
  FLOW_JOB,
  flowJob,
  MEMBER_TAG_JOB,
  memberTagJob,
} from "../notification-jobs";
import {
  GDPR_JOB,
  recordDataRequest,
  redactCustomer,
  redactShop,
} from "../gdpr.server";
import { markPaymentOrderFulfilled } from "../payment-orders.server";
import { findPruneWork, PRUNE_JOB, pruneOldRows } from "../prune.server";
import { graphqlOf, syncPlan } from "../plan-sync.server";
import { SYNC_JOB } from "../plans.server";
import { createDeliveryOrder } from "../release-orders.server";
import {
  findReleaseRuns,
  findScheduledSteps,
  renewAfterOrder,
  runReleaseSlice,
} from "../release-runs.server";
import { fireScheduledRelease } from "../releases.server";
import { getOrCreateShop } from "../shop.server";
import { unauthenticated } from "../shopify.server";
import {
  CONTRACT_JOB,
  DELIVERY_ORDER_JOB,
  findMissedContracts,
  PAYMENT_ORDER_JOB,
  RECONCILE_JOB,
  RELEASE_FIRE_JOB,
  RELEASE_RUN_JOB,
  syncContract,
} from "../subscriptions.server";
import { logEvent } from "../logger.server";
import { enqueueJobs, type DueWorkFinder, type JobHandler } from "./runner.server";

async function shopGraphql(shop: string | undefined) {
  if (!shop) throw new Error("Job without a shop");
  const { admin } = await unauthenticated.admin(shop);
  return graphqlOf(admin);
}

export const jobHandlers: Record<string, JobHandler> = {
  // Brings one plan's selling plan group in line with the plan. Queued by the plan screens.
  [SYNC_JOB]: async (job, { db }) => {
    const { planId, shopId } = job.data ?? {};
    if (!job.shop || typeof planId !== "string" || typeof shopId !== "string") {
      throw new Error("plan.sync job without a shop or plan");
    }
    const graphql = await shopGraphql(job.shop);
    await syncPlan(db, graphql, shopId, planId);
    await ensureCartRule(graphql);
    await publishGiftPlans(db, graphql, shopId);
  },

  // One contract's subscription and first release. Queued by its webhooks and the tick.
  [CONTRACT_JOB]: async (job, { db, env }) => {
    const graphql = await shopGraphql(job.shop);
    const shop = await getOrCreateShop(db, job.shop!);
    const next = await syncContract(
      db,
      env.DB,
      graphql,
      { ...shop, shopDomain: job.shop! },
      String(job.data?.contractGid),
    );
    await enqueueJobs(env, next);
  },

  [RECONCILE_JOB]: async (job, { db, env }) => {
    const graphql = await shopGraphql(job.shop);
    await enqueueJobs(env, await findMissedContracts(db, graphql, job.shop!));
  },

  // Refused orders and a missing product show on the releases screen instead of retrying.
  [DELIVERY_ORDER_JOB]: async (job, { db, env }) => {
    const graphql = await shopGraphql(job.shop);
    const deliveryId = String(job.data?.deliveryId);
    const result = await createDeliveryOrder(db, env.DB, graphql, deliveryId);
    logEvent("info", "delivery.order_job", { jobId: job.id, result });
    if (result === "created" || result === "recovered") {
      await renewAfterOrder(db, env.DB, graphql, deliveryId, new Date());
    }
  },

  // One slice of a release's run. It ends by enqueueing the next, and never by failing on a limit.
  [RELEASE_RUN_JOB]: async (job, { db, env }) => {
    const next = await runReleaseSlice(db, env.DB, () => shopGraphql(job.shop), job);
    if (next) await enqueueJobs(env, [next.job], next.delaySeconds);
  },

  [RELEASE_FIRE_JOB]: async (job, { db, env }) => {
    const shop = await getOrCreateShop(db, job.shop!);
    await fireScheduledRelease(
      db,
      env,
      { ...shop, shopDomain: job.shop! },
      String(job.data?.releaseId),
    );
  },

  [PAYMENT_ORDER_JOB]: async (job) => {
    const graphql = await shopGraphql(job.shop);
    await markPaymentOrderFulfilled(graphql, String(job.data?.orderGid));
  },

  // A billing attempt's result, queued by its webhooks. The job reads it fresh from Shopify.
  [BILLING_SETTLE_JOB]: async (job, { db, env }) => {
    const graphql = await shopGraphql(job.shop);
    await enqueueJobs(
      env,
      await settleAttempt(db, env.DB, graphql, String(job.data?.attemptGid)),
    );
  },

  [BILLING_RECOVER_JOB]: async (job, { db, env }) => {
    const graphql = await shopGraphql(job.shop);
    await enqueueJobs(
      env,
      await recoverAttempt(db, env.DB, graphql, String(job.data?.attemptId)),
    );
  },

  [BILLING_RENEW_JOB]: async (job, { db, env }) => {
    const graphql = await shopGraphql(job.shop);
    await renewIfDue(db, env.DB, graphql, String(job.data?.subscriptionId));
  },

  [BILLING_RETRY_JOB]: async (job, { db, env }) => {
    const graphql = await shopGraphql(job.shop);
    await enqueueJobs(env, await retryDue(db, env.DB, graphql, String(job.data?.attemptId)));
  },

  // A merchant's press, and in Step 11 a customer's new card.
  [BILLING_RESUME_JOB]: async (job, { db, env }) => {
    const graphql = await shopGraphql(job.shop);
    await enqueueJobs(
      env,
      await runResumeJob(db, env.DB, graphql, job),
    );
  },

  [CARD_UPDATED_JOB]: async (job, { db, env }) => {
    const customerGid = String(job.data?.customerGid);
    await attachSavedCards(db, () => shopGraphql(job.shop), job.shop!, customerGid);
    await enqueueJobs(env, await resumeAfterCardUpdate(db, job.shop!, customerGid));
  },

  [DISPUTE_JOB]: async (job, { db, env }) => {
    const graphql = await shopGraphql(job.shop);
    await recordChargeback(db, env.DB, graphql, String(job.data?.orderGid));
  },

  // One slice of a shop's emails: queues what's due, then sends a page. Queued by the tick, by a
  // merchant's announce and by a new sign-up.
  [EMAIL_JOB]: async (job, { db, env }) => {
    const next = await runEmailSlice(env, db, env.DB, () => shopGraphql(job.shop), job);
    if (next) await enqueueJobs(env, [next.job], next.delaySeconds);
  },

  [FLOW_JOB]: async (job, { env }) => {
    const next = await runFlowSlice(env.DB, () => shopGraphql(job.shop), job);
    if (next) await enqueueJobs(env, [next.job], next.delaySeconds);
  },

  [MEMBER_TAG_JOB]: async (job, { db, env }) => {
    const next = await runMemberTagSlice(db, env.DB, () => shopGraphql(job.shop), job);
    if (next) await enqueueJobs(env, [next]);
  },

  // Reads what payments brought in and the plans' stock from Shopify, for the dashboard. Read-only.
  [DASHBOARD_JOB]: async (job, { db, env }) => {
    await refreshDashboard(db, env.DB, await shopGraphql(job.shop), job.shop!);
  },

  // One slice of a dry run, then of a real run. Each ends by enqueueing the next, never by failing on a limit.
  [IMPORT_READ_JOB]: async (job, { db, env }) => {
    const next = await runReadSlice(db, env.DB, () => shopGraphql(job.shop), job);
    if (next) await enqueueJobs(env, [next.job], next.delaySeconds);
  },

  [IMPORT_CREATE_JOB]: async (job, { db, env }) => {
    const next = await runCreateSlice(db, env.DB, () => shopGraphql(job.shop), job);
    if (next) await enqueueJobs(env, [next.job], next.delaySeconds);
  },

  [PRUNE_JOB]: async (_job, { env }) => {
    await pruneOldRows(env.DB);
  },

  [GDPR_JOB]: async (job, { db, env }) => {
    const { topic, shopDomain, customerGid, requestId } = job.data ?? {};
    if (typeof shopDomain !== "string") throw new Error("gdpr job without a shop");
    if (topic === "shop_redact") return redactShop(db, env.DB, shopDomain);
    if (typeof customerGid !== "string") throw new Error("gdpr job without a customer");
    if (topic === "customers_redact") {
      return redactCustomer(db, env.DB, shopDomain, customerGid);
    }
    if (topic === "customers_data_request") {
      return recordDataRequest(db, env.DB, shopDomain, customerGid, String(requestId));
    }
    throw new Error("gdpr job with an unknown topic");
  },
};

/** One job per installed shop per hour, for contracts whose webhooks never came. */
const findMissedContractWork: DueWorkFinder = async ({ env, now }) => {
  const { results } = await env.DB.prepare(
    `SELECT s."shopDomain" FROM "Shop" s
     JOIN "OfflineSession" o ON o."id" = 'offline_' || s."shopDomain"`,
  ).all<{ shopDomain: string }>();
  const hour = now.toISOString().slice(0, 13);
  return results.map(({ shopDomain }) => ({
    type: RECONCILE_JOB,
    id: `${RECONCILE_JOB}:${shopDomain}:${hour}`,
    shop: shopDomain,
  }));
};

/** Each hour, for every installed shop: its emails, its Flow triggers, its customers' tags and its dashboard figures. */
const findNotificationWork: DueWorkFinder = async ({ env, now }) => {
  const { results } = await env.DB.prepare(
    `SELECT s."shopDomain" FROM "Shop" s
     JOIN "OfflineSession" o ON o."id" = 'offline_' || s."shopDomain"`,
  ).all<{ shopDomain: string }>();
  const hour = now.toISOString().slice(0, 13);
  return results.flatMap(({ shopDomain }) => [
    emailRunJob(shopDomain, hour),
    flowJob(shopDomain, hour),
    memberTagJob(shopDomain, hour),
    dashboardJob(shopDomain, hour),
  ]);
};

export const dueWorkFinders: DueWorkFinder[] = [
  findMissedContractWork,
  findNotificationWork,
  findScheduledSteps,
  findReleaseRuns,
  findRenewals,
  findRetries,
  findLostResults,
  findImportWork,
  findPruneWork,
];

import { ensureCartRule } from "../cart-rule.server";
import {
  GDPR_JOB,
  recordDataRequest,
  redactCustomer,
  redactShop,
} from "../gdpr.server";
import { markPaymentOrderFulfilled } from "../payment-orders.server";
import { graphqlOf, syncPlan } from "../plan-sync.server";
import { SYNC_JOB } from "../plans.server";
import { createDeliveryOrder } from "../release-orders.server";
import { getOrCreateShop } from "../shop.server";
import { unauthenticated } from "../shopify.server";
import {
  CONTRACT_JOB,
  DELIVERY_ORDER_JOB,
  findMissedContracts,
  PAYMENT_ORDER_JOB,
  RECONCILE_JOB,
  syncContract,
} from "../subscriptions.server";
import { logEvent } from "../logger.server";
import { enqueueJobs, type DueWorkFinder, type JobHandler } from "./runner.server";

async function shopGraphql(shop: string | undefined) {
  if (!shop) throw new Error("Job without a shop");
  const { admin } = await unauthenticated.admin(shop);
  return graphqlOf(admin);
}

// Steps 8 to 10 add their job types and finders here.
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
    const result = await createDeliveryOrder(
      db,
      env.DB,
      graphql,
      String(job.data?.deliveryId),
    );
    logEvent("info", "delivery.order_job", { jobId: job.id, result });
  },

  [PAYMENT_ORDER_JOB]: async (job) => {
    const graphql = await shopGraphql(job.shop);
    await markPaymentOrderFulfilled(graphql, String(job.data?.orderGid));
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

export const dueWorkFinders: DueWorkFinder[] = [findMissedContractWork];

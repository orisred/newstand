import type { Job } from "./jobs/runner.server";
import { describeError, logEvent } from "./logger.server";
import type { Graphql } from "./plan-sync.server";
import { LAST_RELEASE } from "./emails.server";
import {
  CANCELLED_EVENT,
  flowJob,
  LAST_RELEASE_EVENT,
  PAUSED_EVENT,
  STARTED_EVENT,
} from "./notification-jobs";


// An event is worth sending to Flow for this long after it happened, so a first deploy or a
// long outage doesn't replay history into a merchant's workflows.
const FLOW_WITHIN_DAYS = 3;
const EVENTS_PER_SLICE = 25;

type FlowEvent = {
  id: string;
  type: string;
  payload: string;
  customerGid: string;
  displayName: string;
};

/**
 * Which Flow trigger an Event is, and what it carries. The handles and field keys are those in
 * `extensions/flow-triggers/shopify.extension.toml`. Fields are IDs and plan names, never personal data;
 * Flow reads the customer itself from `customer_id`.
 */
export function triggerFor(event: FlowEvent) {
  const payload = JSON.parse(event.payload || "{}") as Record<string, unknown>;
  const customer_id = Number(event.customerGid.split("/").pop());
  const plan = event.displayName;
  switch (event.type) {
    case STARTED_EVENT:
      return { handle: "subscription-started", properties: { customer_id, Plan: plan } };
    case "billing.failed":
      return {
        handle: "subscription-payment-failed",
        properties: { customer_id, Plan: plan, "Will retry": payload.nextRetryAt != null },
      };
    case PAUSED_EVENT:
      return {
        handle: "subscription-paused-or-cancelled",
        properties: { customer_id, Plan: plan, Status: "paused", Reason: "failed payment" },
      };
    case "billing.chargeback":
      return {
        handle: "subscription-paused-or-cancelled",
        properties: { customer_id, Plan: plan, Status: "paused", Reason: "chargeback" },
      };
    case CANCELLED_EVENT:
      return {
        handle: "subscription-paused-or-cancelled",
        properties: { customer_id, Plan: plan, Status: "cancelled", Reason: "cancelled" },
      };
    case LAST_RELEASE_EVENT:
      return { handle: "last-release-shipped", properties: { customer_id, Plan: plan } };
    default:
      return null;
  }
}

const FLOW_TYPES = [
  STARTED_EVENT,
  "billing.failed",
  PAUSED_EVENT,
  "billing.chargeback",
  CANCELLED_EVENT,
  LAST_RELEASE_EVENT,
];

const RECEIVE = `#graphql
  mutation FlowTrigger($handle: String, $payload: JSON) {
    flowTriggerReceive(handle: $handle, payload: $payload) { userErrors { field message } }
  }`;

/** Writes the one event Flow needs that no code path writes: a last release shipping. Safe to repeat. */
async function recordLastReleaseEvents(rawDb: D1Database, shopId: string, now: Date) {
  await rawDb
    .prepare(
      `INSERT INTO "Event" ("id", "shopId", "subscriptionId", "type", "payload", "createdAt")
       SELECT '${LAST_RELEASE_EVENT}:' || d."id", s."shopId", s."id", '${LAST_RELEASE_EVENT}',
         json_object('deliveryId', d."id"), ?2
       ${LAST_RELEASE}
       ON CONFLICT DO NOTHING`,
    )
    .bind(shopId, now.toISOString())
    .run();
}

/**
 * Sends a shop's new events to Flow, each once. An event is claimed (`sentToFlowAt`) before it's
 * sent, so a repeat of the job never sends it twice. If Flow can't be reached, the claim is given
 * back and the next tick tries again. If the Worker dies between the claim and the answer, that one
 * trigger is lost: Flow has no way to ask whether it arrived, and running a workflow twice (a second
 * email from Klaviyo, say) was judged worse than missing one.
 * Returns the next slice if the page was full.
 */
export async function runFlowSlice(
  rawDb: D1Database,
  graphqlFor: () => Promise<Graphql>,
  job: Job,
  clock: () => Date = () => new Date(),
): Promise<{ job: Job; delaySeconds: number } | null> {
  const shop = await rawDb
    .prepare(`SELECT "id" FROM "Shop" WHERE "shopDomain" = ?1`)
    .bind(job.shop)
    .first<{ id: string }>();
  if (!shop) return null;
  const started = clock();
  await recordLastReleaseEvents(rawDb, shop.id, started);

  const { results } = await rawDb
    .prepare(
      `SELECT e."id", e."type", e."payload", s."customerGid", p."displayName"
       FROM "Event" e
       JOIN "Subscription" s ON s."id" = e."subscriptionId"
       JOIN "Plan" p ON p."id" = s."planId"
       WHERE e."shopId" = ?1 AND e."sentToFlowAt" IS NULL
         AND e."type" IN (${FLOW_TYPES.map((type) => `'${type}'`).join(", ")})
         AND julianday(e."createdAt") > julianday(?2) - ${FLOW_WITHIN_DAYS}
       ORDER BY e."createdAt", e."id" LIMIT ?3`,
    )
    .bind(shop.id, started.toISOString(), EVENTS_PER_SLICE)
    .all<FlowEvent>();

  let sent = 0;
  const graphql = results.length ? await graphqlFor() : null;
  for (const event of results) {
    const claimed = await rawDb
      .prepare(`UPDATE "Event" SET "sentToFlowAt" = ?2 WHERE "id" = ?1 AND "sentToFlowAt" IS NULL`)
      .bind(event.id, clock().toISOString())
      .run();
    if (claimed.meta.changes === 0) continue;
    const trigger = event.customerGid === "redacted" ? null : triggerFor(event);
    if (!trigger) continue;
    try {
      const { flowTriggerReceive } = await graphql!(RECEIVE, {
        handle: trigger.handle,
        payload: trigger.properties,
      });
      if (flowTriggerReceive.userErrors.length > 0) {
        // Refused for what's in it, so sending it again won't help. It stays claimed.
        logEvent("error", "flow.refused", { eventId: event.id, handle: trigger.handle });
      } else sent++;
    } catch (error) {
      await rawDb
        .prepare(`UPDATE "Event" SET "sentToFlowAt" = NULL WHERE "id" = ?1`)
        .bind(event.id)
        .run();
      logEvent("error", "flow.send_failed", { eventId: event.id, ...describeError(error) });
    }
  }
  logEvent("info", "flow.slice", { shopId: shop.id, sent, found: results.length });
  return results.length === EVENTS_PER_SLICE
    ? { delaySeconds: 0, job: flowJob(String(job.shop), crypto.randomUUID()) }
    : null;
}

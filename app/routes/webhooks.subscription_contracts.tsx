import type { ActionFunctionArgs } from "react-router";
import { enqueueJobs } from "../jobs/runner.server";
import { authenticate } from "../shopify.server";
import { contractJob } from "../subscriptions.server";

/**
 * Only enqueues. The job reads the contract fresh, so `create` and `update` do the same work.
 * Keyed on the webhook, which Shopify's retries keep, and not on `revision_id`: cancelling a
 * contract leaves that unchanged (checked live), so the job would be skipped as a repeat.
 */
export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shop, payload, webhookId } = await authenticate.webhook(request);
  const { admin_graphql_api_id: contractGid } = payload as {
    admin_graphql_api_id: string;
  };
  await enqueueJobs(context.cloudflare.env, [
    contractJob(shop, contractGid, webhookId),
  ]);
  return new Response();
};

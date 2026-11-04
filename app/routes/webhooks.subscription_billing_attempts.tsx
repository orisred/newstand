import type { ActionFunctionArgs } from "react-router";
import { settleJob } from "../billing.server";
import { enqueueJobs } from "../jobs/runner.server";
import { authenticate } from "../shopify.server";

/**
 * Success, failure and challenged all do the same thing: only enqueue. The job reads the attempt
 * fresh, so a webhook arriving twice or out of order ends the same way.
 */
export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shop, payload, webhookId } = await authenticate.webhook(request);
  const { admin_graphql_api_id: attemptGid } = payload as {
    admin_graphql_api_id: string;
  };
  await enqueueJobs(context.cloudflare.env, [settleJob(shop, attemptGid, webhookId)]);
  return new Response();
};

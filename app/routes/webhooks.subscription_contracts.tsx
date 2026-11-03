import type { ActionFunctionArgs } from "react-router";
import { enqueueJobs } from "../jobs/runner.server";
import { authenticate } from "../shopify.server";
import { contractJob } from "../subscriptions.server";

/** Only enqueues. The job reads the contract fresh, so `create` and `update` do the same work. */
export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shop, payload, webhookId } = await authenticate.webhook(request);
  const { admin_graphql_api_id: contractGid, revision_id: revision } =
    payload as { admin_graphql_api_id: string; revision_id?: string | number };
  await enqueueJobs(context.cloudflare.env, [
    contractJob(shop, contractGid, String(revision ?? webhookId)),
  ]);
  return new Response();
};

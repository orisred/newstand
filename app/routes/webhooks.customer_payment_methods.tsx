import type { ActionFunctionArgs } from "react-router";
import { cardUpdatedJob } from "../billing.server";
import { enqueueJobs } from "../jobs/runner.server";
import { authenticate } from "../shopify.server";

/** A saved card changed. If it's the card a failed payment is waiting on, the job recovers it. */
export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shop, payload, webhookId } = await authenticate.webhook(request);
  const { customer_id: customerId } = payload as { customer_id?: number | string };
  if (customerId) {
    await enqueueJobs(context.cloudflare.env, [
      cardUpdatedJob(shop, `gid://shopify/Customer/${customerId}`, webhookId),
    ]);
  }
  return new Response();
};

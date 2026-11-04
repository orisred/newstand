import type { ActionFunctionArgs } from "react-router";
import { disputeJob } from "../billing.server";
import { enqueueJobs } from "../jobs/runner.server";
import { authenticate } from "../shopify.server";

/** Only a chargeback pauses: an inquiry isn't a dispute of the charge yet. */
export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shop, payload, webhookId } = await authenticate.webhook(request);
  const { order_id: orderId, type } = payload as {
    order_id: number | null;
    type: string;
  };
  if (type === "chargeback" && orderId) {
    await enqueueJobs(context.cloudflare.env, [
      disputeJob(shop, `gid://shopify/Order/${orderId}`, webhookId),
    ]);
  }
  return new Response();
};

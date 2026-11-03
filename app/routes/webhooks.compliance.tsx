import type { ActionFunctionArgs } from "react-router";
import { GDPR_JOB } from "../gdpr.server";
import { enqueueJobs } from "../jobs/runner.server";
import { authenticate } from "../shopify.server";

/**
 * The mandatory GDPR webhooks. `authenticate.webhook` answers 401 to a bad signature, and it
 * works after uninstall, when there's no session. Only enqueues. The job's ID is Shopify's
 * webhook ID, so a retry runs once and JobRun keeps neither the shop nor the customer.
 */
export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shop, topic, payload, webhookId } =
    await authenticate.webhook(request);
  const { customer, data_request: dataRequest } = payload as {
    customer?: { id: number };
    data_request?: { id: number };
  };
  await enqueueJobs(context.cloudflare.env, [
    {
      type: GDPR_JOB,
      id: `${GDPR_JOB}:${webhookId}`,
      data: {
        topic: String(topic).toLowerCase().replace("/", "_"),
        shopDomain: shop,
        ...(customer ? { customerGid: `gid://shopify/Customer/${customer.id}` } : {}),
        ...(dataRequest ? { requestId: String(dataRequest.id) } : {}),
      },
    },
  ]);
  return new Response();
};

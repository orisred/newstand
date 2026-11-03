import type { ActionFunctionArgs } from "react-router";
import { authenticate, sessionStorage } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Delete by shop, not through the webhook's session: there's no session once the
  // shop's refresh token stops working, and the row would keep the old tokens.
  await sessionStorage.deleteSession(`offline_${shop}`);

  return new Response();
};

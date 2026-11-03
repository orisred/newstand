import type { ActionFunctionArgs } from "react-router";
import { authenticate, sessionStorage } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    const sessions = await sessionStorage.findSessionsByShop(shop);
    // The KV adapter's per-shop list can repeat an ID and can name a session
    // that has already been deleted.
    const ids = new Set(sessions.filter(Boolean).map(({ id }) => id));
    await sessionStorage.deleteSessions([...ids]);
  }

  return new Response();
};

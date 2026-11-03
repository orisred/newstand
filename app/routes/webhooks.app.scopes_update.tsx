import type { ActionFunctionArgs } from "react-router";
import { authenticate, sessionStorage } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, topic, shop } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  // Only the scope is written, never the session the webhook loaded: see updateScope.
  await sessionStorage.updateScope(
    shop,
    (payload.current as string[]).toString(),
  );
  return new Response();
};

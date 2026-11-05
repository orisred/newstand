import type { LoaderFunctionArgs } from "react-router";
import { createDb } from "../db.server";
import { dataRequestFile } from "../gdpr.server";
import { getOrCreateShop } from "../shop.server";
import { authenticate } from "../shopify.server";

// The releases screen fetches this, and App Bridge adds the session token to the fetch.
export const loader = async ({ request, params, context }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = createDb(context.cloudflare.env.DB);
  const shop = await getOrCreateShop(db, session.shop);
  const file = await dataRequestFile(db, shop.id, String(params.id));
  if (file === null) throw new Response("Not found", { status: 404 });
  return new Response(file, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="customer-data-request.json"',
      "Cache-Control": "no-store",
    },
  });
};

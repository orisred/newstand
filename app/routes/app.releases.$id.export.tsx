import type { LoaderFunctionArgs } from "react-router";
import { createDb } from "../db.server";
import { buildRunCsv } from "../release-csv.server";
import { getOrCreateShop } from "../shop.server";
import { authenticate } from "../shopify.server";

// The releases screen fetches this, and App Bridge adds the session token to the fetch.
export const loader = async ({
  request,
  params,
  context,
}: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { env } = context.cloudflare;
  const shop = await getOrCreateShop(createDb(env.DB), session.shop);
  const csv = await buildRunCsv(
    env.DB,
    { id: shop.id, shopDomain: session.shop, word: shop.releaseWordSingular },
    String(params.id),
  );
  if (csv === null) throw new Response("Not found", { status: 404 });
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="run.csv"',
      "Cache-Control": "no-store",
    },
  });
};

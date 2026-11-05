import type { ActionFunctionArgs } from "react-router";
import type { BrowserContact } from "../import-csv";
import { addContacts } from "../import.server";
import { createDb } from "../db.server";
import { graphqlOf } from "../plan-sync.server";
import { getOrCreateShop } from "../shop.server";
import { authenticate } from "../shopify.server";

/**
 * A batch of contacts from the import page. A short request, one Shopify call, so the emails never
 * have to be stored or queued for a job to look them up. Nothing here is logged.
 */
export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const { env } = context.cloudflare;
  const db = createDb(env.DB);
  const shop = await getOrCreateShop(db, session.shop);
  const { runId, contacts } = (await request.json()) as { runId: string; contacts: BrowserContact[] };
  const run = await db.importRun.findFirst({
    where: { id: runId, shopId: shop.id, status: "COLLECTING" },
    select: { id: true },
  });
  if (!run) throw new Response("Not found", { status: 404 });
  await addContacts(env.DB, graphqlOf(admin), shop.id, run.id, contacts);
  return Response.json({ ok: true });
};

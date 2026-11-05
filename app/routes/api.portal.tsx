import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { createDb } from "../db.server";
import { resumeJob } from "../billing.server";
import { enqueueJobs } from "../jobs/runner.server";
import { graphqlOf } from "../plan-sync.server";
import {
  cancelSubscription,
  changeAddress,
  confirmAddress,
  loadPortal,
  ownSubscription,
  PortalError,
  portalCopy,
  refuseGift,
  sendCardUpdateEmail,
} from "../portal.server";
import { authenticate, unauthenticated } from "../shopify.server";

/**
 * The customer account extension's API. The customer is whoever Shopify's session token says is
 * signed in (`sub`), and the shop is the token's `dest`; nothing in the request body names either.
 * A subscription ID in the body is only looked up together with that customer.
 *
 * The page calls this from another origin with an Authorization header, so the browser asks first
 * (OPTIONS) and must be able to read every answer, errors included. The library's `authenticate`
 * answers a "bot" User-Agent such as curl with a bare 410 before it gets to OPTIONS and adds no CORS
 * headers to its 401s, so this answers preflights itself and puts the headers on everything.
 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "7200",
};

const withCors = (response: Response) => {
  for (const [name, value] of Object.entries(CORS))
    response.headers.set(name, value);
  return response;
};

async function guarded(request: Request, run: () => Promise<Response>) {
  if (request.method === "OPTIONS")
    return withCors(new Response(null, { status: 204 }));
  try {
    return withCors(await run());
  } catch (error) {
    // The library throws its refusals (401 and the like) as responses.
    if (error instanceof Response) return withCors(error);
    throw error;
  }
}

async function caller(
  request: Request,
  context: LoaderFunctionArgs["context"],
) {
  const { sessionToken } = await authenticate.public.customerAccount(request);
  const env = context.cloudflare.env;
  // Checked on a real token: `dest` is the shop's bare domain and `sub` the customer's GID.
  const shopDomain = String(sessionToken.dest);
  return {
    env,
    db: createDb(env.DB),
    shopDomain,
    customerGid: String(sessionToken.sub ?? ""),
    graphql: async () =>
      graphqlOf((await unauthenticated.admin(shopDomain)).admin),
  };
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export const loader = ({ request, context }: LoaderFunctionArgs) =>
  guarded(request, async () => {
    const { env, db, shopDomain, customerGid, graphql } = await caller(
      request,
      context,
    );
    return json(
      (await loadPortal(db, env.DB, graphql, shopDomain, customerGid)) ?? {
        subscriptions: [],
      },
    );
  });

// OPTIONS, like every non-GET request, comes to the action.
export const action = ({ request, context }: ActionFunctionArgs) =>
  guarded(request, async () => {
    const { env, db, shopDomain, customerGid, graphql } = await caller(
      request,
      context,
    );
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const subscription = await ownSubscription(
      db,
      shopDomain,
      customerGid,
      String(body?.subscriptionId),
    );
    if (!subscription) return json({ error: "not_found" }, 404);
    const copy = portalCopy({
      singular: subscription.shop.releaseWordSingular,
      plural: subscription.shop.releaseWordPlural,
    });
    try {
      // A gift's card and contract are the buyer's: refused before Shopify is asked anything.
      if (body?.intent === "card" || body?.intent === "resume") {
        refuseGift(subscription, "giftNoCard");
      }
      if (body?.intent === "cancel") refuseGift(subscription, "giftNoCancel");
      switch (body?.intent) {
        case "confirm": {
          const done = await confirmAddress(
            db,
            env.DB,
            subscription,
            String(body.releaseId),
          );
          return json({ ok: done, message: done ? copy.confirmed : undefined });
        }
        case "address":
          await changeAddress(
            db,
            env.DB,
            await graphql(),
            subscription,
            body.address,
          );
          return json({ ok: true });
        case "card":
          await sendCardUpdateEmail(await graphql(), subscription);
          return json({ ok: true, message: copy.cardSent });
        case "resume":
          // Same job the merchant's Retry charge runs. Only the merchant can end a chargeback.
          await enqueueJobs(env, [
            resumeJob(shopDomain, subscription.id, crypto.randomUUID(), false),
          ]);
          return json({ ok: true, message: copy.resumeAsked });
        case "cancel":
          await cancelSubscription(db, env.DB, await graphql(), subscription);
          return json({
            ok: true,
            message: copy.cancelled(
              subscription.releasesRemaining,
              subscription.pausedReason === "CHARGEBACK",
            ),
          });
        default:
          return json({ error: "unknown_intent" }, 400);
      }
    } catch (error) {
      if (error instanceof PortalError)
        return json({ error: error.code, message: error.message }, 422);
      throw error;
    }
  });

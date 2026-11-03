import { useEffect, useRef } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { createDb } from "../db.server";
import {
  listPlans,
  retrySync,
  requestSync,
  setPlanActive,
} from "../plans.server";
import { getOrCreateShop } from "../shop.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = createDb(context.cloudflare.env.DB);
  const shop = await getOrCreateShop(db, session.shop);
  return {
    word: shop.releaseWordSingular,
    plural: shop.releaseWordPlural,
    plans: await listPlans(db, shop.id),
  };
};

type ActionData = { ok: boolean; message: string };

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const env = context.cloudflare.env;
  const db = createDb(env.DB);
  const shop = await getOrCreateShop(db, session.shop);
  const shopRef = { id: shop.id, shopDomain: session.shop };
  const intent = form.get("intent");
  const planId = form.get("planId");
  if (typeof planId !== "string") {
    return { ok: false, message: "Unknown plan." } satisfies ActionData;
  }

  if (intent === "activate" || intent === "deactivate") {
    const found = await setPlanActive(
      db,
      shop.id,
      planId,
      intent === "activate",
    );
    if (!found)
      return {
        ok: false,
        message: "That plan no longer exists.",
      } satisfies ActionData;
    await requestSync(env, db, shopRef, planId);
    return {
      ok: true,
      message:
        intent === "activate"
          ? "Plan turned on. It will appear on its product shortly."
          : "Plan turned off. It will leave its product shortly; current subscribers aren't affected.",
    } satisfies ActionData;
  }
  if (intent === "sync") {
    const found = await retrySync(env, db, shopRef, planId);
    return found
      ? ({ ok: true, message: "Sync started." } satisfies ActionData)
      : ({
          ok: false,
          message: "That plan no longer exists.",
        } satisfies ActionData);
  }
  return { ok: false, message: "Unknown action." } satisfies ActionData;
};

const STATUS = {
  NOT_SYNCED: { tone: "neutral", text: "Waiting to sync" },
  SYNCING: { tone: "info", text: "Syncing" },
  SYNCED: { tone: "success", text: "In sync with Shopify" },
  MISMATCH: { tone: "critical", text: "Differs from Shopify" },
  ERROR: { tone: "critical", text: "Sync failed" },
} as const;

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    cents / 100,
  );

const POLL_MS = 3000;
const MAX_POLLS = 20;

export default function Plans() {
  const { word, plural, plans } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  const waiting = plans.some(
    (plan) => plan.syncStatus === "NOT_SYNCED" || plan.syncStatus === "SYNCING",
  );

  useEffect(() => {
    if (fetcher.data) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    }
  }, [fetcher.data, shopify]);

  // Syncs run on the queue, so look again until they're done, for a little while.
  const polls = useRef(0);
  useEffect(() => {
    if (!waiting) {
      polls.current = 0;
      return;
    }
    const timer = setInterval(() => {
      if (++polls.current > MAX_POLLS) return clearInterval(timer);
      revalidator.revalidate();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, revalidator]);

  const submit = (intent: string, planId: string) =>
    fetcher.submit({ intent, planId }, { method: "POST" });

  return (
    <s-page heading="Plans">
      <s-button slot="primary-action" variant="primary" href="/app/plans/new">
        Create plan
      </s-button>
      <s-section padding="none">
        {plans.length === 0 ? (
          <s-box padding="base">
            <s-paragraph>
              No plans yet. A plan is what customers buy: {plural} paid one at a
              time, or a prepaid bundle.
            </s-paragraph>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Plan</s-table-header>
              <s-table-header>Customers see</s-table-header>
              <s-table-header>Price</s-table-header>
              <s-table-header>Product</s-table-header>
              <s-table-header>Shopify</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {plans.map((plan) => (
                <s-table-row key={plan.id}>
                  <s-table-cell>
                    <s-stack gap="small-300">
                      <s-text>{plan.name}</s-text>
                      <s-text color="subdued">
                        {plan.billingMode === "PER_RELEASE"
                          ? `Paid per ${word}`
                          : `${plan.releasesPerTerm} ${plural} prepaid, ${plan.termMonths} months`}
                      </s-text>
                      {!plan.active && <s-badge tone="neutral">Off</s-badge>}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{plan.displayName}</s-table-cell>
                  <s-table-cell>
                    {money(plan.priceCents, plan.currency)}
                  </s-table-cell>
                  <s-table-cell>{plan.productTitle ?? "None"}</s-table-cell>
                  <s-table-cell>
                    <s-stack gap="small-300">
                      <s-badge tone={STATUS[plan.syncStatus].tone}>
                        {STATUS[plan.syncStatus].text}
                      </s-badge>
                      {plan.syncMessage && (
                        <s-text color="subdued">{plan.syncMessage}</s-text>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small">
                      <s-button
                        href={`/app/plans/${encodeURIComponent(plan.id)}`}
                      >
                        Edit
                      </s-button>
                      {plan.syncStatus !== "SYNCED" &&
                        plan.syncStatus !== "SYNCING" && (
                          <s-button
                            {...(busy ? { disabled: true } : {})}
                            onClick={() => submit("sync", plan.id)}
                          >
                            Sync now
                          </s-button>
                        )}
                      {plan.syncStatus === "SYNCED" && (
                        <s-button
                          {...(busy ? { disabled: true } : {})}
                          onClick={() => submit("sync", plan.id)}
                        >
                          Check Shopify
                        </s-button>
                      )}
                      <s-button
                        tone={plan.active ? "critical" : "neutral"}
                        {...(busy ? { disabled: true } : {})}
                        onClick={() =>
                          submit(
                            plan.active ? "deactivate" : "activate",
                            plan.id,
                          )
                        }
                      >
                        {plan.active ? "Turn off" : "Turn on"}
                      </s-button>
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
      <s-section heading="About turning a plan off">
        <s-paragraph>
          A plan that is off disappears from its product, so no one new can buy
          it. Nothing is deleted: customers already on it keep their {plural},
          and turning it on puts it back. A new price applies to new sign-ups.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

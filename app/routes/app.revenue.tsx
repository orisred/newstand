import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { dashboardJob, parseCostCents, revenueReport, setReleaseCosts, totalsBy } from "../dashboard.server";
import { formatMoney } from "../dashboard-format";
import { createDb } from "../db.server";
import { enqueueJobs } from "../jobs/runner.server";
import { capitalize } from "../release-actions";
import { getOrCreateShop } from "../shop.server";
import { authenticate } from "../shopify.server";
import { useTerms } from "../vocabulary";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { env } = context.cloudflare;
  const db = createDb(env.DB);
  const shop = await getOrCreateShop(db, session.shop);
  const report = await revenueReport(db, env.DB, shop.id);
  // Payments not read yet are read now rather than at the next tick. The ten minutes in the ID keep repeat loads to one job.
  if (report.paid.unread > 0) {
    await enqueueJobs(env, [dashboardJob(session.shop, `view:${new Date().toISOString().slice(0, 15)}`)]);
  }
  const byRelease = totalsBy(report.rows, "releaseId");
  const byPlan = totalsBy(report.rows, "planId");
  const empty = { orders: 0, revenue: 0, costs: 0, unpriced: 0, uncosted: 0 };
  const shown = Math.round(report.rows.reduce((sum, row) => sum + row.revenue, 0));
  return {
    vocabulary: shop.vocabulary,
    word: shop.releaseWordSingular,
    plural: shop.releaseWordPlural,
    currency: report.plans[0]?.currency ?? "USD",
    releases: report.releases.map((release) => ({
      ...release,
      ...(byRelease.get(release.id) ?? empty),
    })),
    plans: report.plans.map((plan) => ({ ...plan, ...(byPlan.get(plan.id) ?? empty) })),
    paidIn: Math.round(report.paid.total),
    unread: report.paid.unread,
    waiting: Math.max(0, Math.round(report.paid.total) - shown),
  };
};

type ActionData = { ok: boolean; message: string };

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const db = createDb(context.cloudflare.env.DB);
  const shop = await getOrCreateShop(db, session.shop);
  const product = parseCostCents(form.get("product"));
  const shipping = parseCostCents(form.get("shipping"));
  const handling = parseCostCents(form.get("handling"));
  if ("error" in product || "error" in shipping || "error" in handling) {
    return { ok: false, message: "Enter costs as amounts such as 4 or 4.50, or leave empty." } satisfies ActionData;
  }
  const saved = await setReleaseCosts(db, shop.id, String(form.get("releaseId")), {
    productCostCents: product.cents,
    shippingCostCents: shipping.cents,
    handlingCostCents: handling.cents,
  });
  return {
    ok: saved,
    message: saved ? "Costs saved." : `That ${shop.releaseWordSingular} no longer exists.`,
  } satisfies ActionData;
};

const dollars = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2));

export default function Revenue() {
  const { word, plural, currency, releases, plans, paidIn, unread, waiting } =
    useLoaderData<typeof loader>();
  const t = useTerms();
  const fetcher = useFetcher<ActionData>();
  const shopify = useAppBridge();
  const [editing, setEditing] = useState<(typeof releases)[number] | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const money = (cents: number) => formatMoney(cents, currency);

  useEffect(() => {
    if (fetcher.data) shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.data, shopify]);

  return (
    <s-page heading="Revenue and profit">
      <s-section>
        <s-stack gap="small">
          <s-paragraph>
            Each {word} ships on a $0 order, so revenue comes from the payments. Every payment buys
            release slots (a bundle buys all of its {plural}, a pay-per-{word} {t.plan} one), and a{" "}
            {t.member}&apos;s shipped {plural} use their slots in the order they were paid for. A{" "}
            {word}&apos;s revenue is the share of those payments for the {plural} that have shipped.
            A gift&apos;s payment is the buyer&apos;s order and counts the same way. Amounts are
            before tax and shipping.
          </s-paragraph>
          <s-text>
            Paid in so far: {money(paidIn)}. Waiting on {plural} still to ship:{" "}
            {money(waiting)}.
          </s-text>
          {unread > 0 && (
            <s-banner tone="info">
              {unread} {unread === 1 ? "payment hasn't" : "payments haven't"} been read from Shopify
              yet. It happens hourly, and revenue below grows once they are.
            </s-banner>
          )}
        </s-stack>
      </s-section>

      <s-section heading={`Profit per ${t.plan}`} padding="none">
        {plans.length === 0 ? (
          <s-box padding="base">
            <s-paragraph>No {t.plans} yet.</s-paragraph>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>{t.Plan}</s-table-header>
              <s-table-header>Orders shipped</s-table-header>
              <s-table-header>Revenue</s-table-header>
              <s-table-header>Costs</s-table-header>
              <s-table-header>Profit</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {plans.map((plan) => (
                <s-table-row key={plan.id}>
                  <s-table-cell>{plan.name}</s-table-cell>
                  <s-table-cell>{plan.orders}</s-table-cell>
                  <s-table-cell>
                    {money(plan.revenue)}
                    {plan.unpriced > 0 && (
                      <s-text color="subdued"> ({plan.unpriced} unpriced)</s-text>
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    {money(plan.costs)}
                    {plan.uncosted > 0 && (
                      <s-text color="subdued"> ({plan.uncosted} without costs)</s-text>
                    )}
                  </s-table-cell>
                  <s-table-cell>{money(plan.revenue - plan.costs)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading={`Revenue per ${word}`} padding="none">
        {releases.length === 0 ? (
          <s-box padding="base">
            <s-paragraph>No {plural} yet.</s-paragraph>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>{capitalize(word)}</s-table-header>
              <s-table-header>Orders shipped</s-table-header>
              <s-table-header>Revenue</s-table-header>
              <s-table-header>Costs</s-table-header>
              <s-table-header>Profit</s-table-header>
              <s-table-header>Costs per order</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {releases.map((release) => {
                const recorded =
                  release.productCostCents !== null ||
                  release.shippingCostCents !== null ||
                  release.handlingCostCents !== null;
                return (
                  <s-table-row key={release.id}>
                    <s-table-cell>
                      {release.number}. {release.title}
                    </s-table-cell>
                    <s-table-cell>{release.orders}</s-table-cell>
                    <s-table-cell>
                      {money(release.revenue)}
                      {release.unpriced > 0 && (
                        <s-text color="subdued"> ({release.unpriced} unpriced)</s-text>
                      )}
                    </s-table-cell>
                    <s-table-cell>{money(release.costs)}</s-table-cell>
                    <s-table-cell>{money(release.revenue - release.costs)}</s-table-cell>
                    <s-table-cell>
                      <s-stack gap="small-300">
                        <s-text color="subdued">
                          {recorded
                            ? `Product ${money(release.productCostCents ?? 0)} per copy, shipping ${money(release.shippingCostCents ?? 0)}, handling ${money(release.handlingCostCents ?? 0)}`
                            : "Not recorded"}
                        </s-text>
                        <s-stack direction="inline">
                          <s-button
                            variant="tertiary"
                            commandFor="costs-modal"
                            command="--show"
                            onClick={() => setEditing(release)}
                          >
                            {recorded ? "Change costs" : "Record costs"}
                          </s-button>
                        </s-stack>
                      </s-stack>
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-modal id="costs-modal" heading={`Costs for this ${word}`}>
        {/* Keyed on the release, so the fields start from its costs each time. */}
        <form ref={form} key={editing?.id}>
          <s-stack gap="base">
            <s-paragraph>
              Recorded separately, in {currency}. Shipping is included in the {t.plan} price through a free
              rate, so the cost is yours. A {word} with no costs recorded counts as costing nothing, and
              the profit tables say how many orders that is.
            </s-paragraph>
            <s-text-field
              label="Product cost, per copy"
              name="product"
              defaultValue={dollars(editing?.productCostCents ?? null)}
            />
            <s-text-field
              label="Shipping cost, per order"
              name="shipping"
              defaultValue={dollars(editing?.shippingCostCents ?? null)}
            />
            <s-text-field
              label="Handling cost, per order"
              name="handling"
              defaultValue={dollars(editing?.handlingCostCents ?? null)}
            />
          </s-stack>
        </form>
        <s-button
          slot="primary-action"
          variant="primary"
          commandFor="costs-modal"
          command="--hide"
          onClick={() => {
            if (!editing || !form.current) return;
            const data = new FormData(form.current);
            data.set("releaseId", editing.id);
            fetcher.submit(data, { method: "POST" });
          }}
        >
          Save
        </s-button>
        <s-button slot="secondary-actions" commandFor="costs-modal" command="--hide">
          Close
        </s-button>
      </s-modal>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

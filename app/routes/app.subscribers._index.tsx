import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { capitalize } from "../release-actions";
import {
  customerLabel,
  customerNames,
  loadSubscribersPage,
} from "../dashboard.server";
import { idOf, parseView, stateOf, VIEWS, whenText, type View } from "../dashboard-format";
import { createDb } from "../db.server";
import { graphqlOf } from "../plan-sync.server";
import { getOrCreateShop } from "../shop.server";
import { authenticate } from "../shopify.server";
import { useTerms } from "../vocabulary";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const { env } = context.cloudflare;
  const db = createDb(env.DB);
  const shop = await getOrCreateShop(db, session.shop);
  const url = new URL(request.url);
  const view = parseView(url.searchParams.get("view"));
  const { counts, list } = await loadSubscribersPage(
    env.DB,
    shop.id,
    view,
    url.searchParams.get("before"),
    new Date(),
  );
  const names = await customerNames(graphqlOf(admin), list.rows.map((row) => row.customerGid));
  return {
    vocabulary: shop.vocabulary,
    word: shop.releaseWordSingular,
    plural: shop.releaseWordPlural,
    view,
    counts,
    next: list.next,
    rows: list.rows.map((row) => ({
      id: row.id,
      name: customerLabel(names, row.customerGid),
      customerId: idOf(row.customerGid),
      state: stateOf(row),
      gift: row.source === "GIFT",
      imported: row.source === "IMPORTED",
      plan: row.plan,
      remaining: row.releasesRemaining,
      term:
        row.billingMode === "PER_RELEASE"
          ? "Per release"
          : whenText(row.termEndsAt, shop.timezone),
      since: whenText(row.createdAt, shop.timezone),
      portalCancelled: Boolean(row.portalCancelled),
      portalAddress: Boolean(row.portalAddress),
    })),
  };
};

const VIEW_TEXT: Record<View, string> = {
  all: "All",
  live: "Active",
  paused: "Paused",
  onHold: "On hold from import",
  noCard: "Imported, no card",
  ending: "Cancelled, still shipping",
  finished: "Finished",
  gifts: "Gifts",
};

export default function Subscribers() {
  const { word, plural, view, counts, rows, next } = useLoaderData<typeof loader>();
  const t = useTerms();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const count = (key: View) => (key === "all" ? counts.total : counts[key]);

  return (
    <s-page heading={t.Members}>
      {counts.noCard > 0 && (
        <s-banner tone="critical" heading={`${counts.noCard} imported with no card`}>
          <s-paragraph>
            Their contracts have no card, so their next charge will fail, retry and then pause. Ask
            them to save a card: it goes on the contract as soon as they do.
          </s-paragraph>
        </s-banner>
      )}
      {counts.onHold > 0 && (
        <s-banner tone="warning" heading={`${counts.onHold} on hold from the import`}>
          <s-paragraph>
            Nothing is charged until you release each one on its page. Paid {plural} still ship.
          </s-paragraph>
        </s-banner>
      )}
      <s-section heading="At a glance">
        <s-stack direction="inline" gap="large">
          <s-stack gap="small-300">
            <s-text color="subdued">Active</s-text>
            <s-heading>{counts.live}</s-heading>
          </s-stack>
          <s-stack gap="small-300">
            <s-text color="subdued">Paused</s-text>
            <s-heading>{counts.paused}</s-heading>
          </s-stack>
          <s-stack gap="small-300">
            <s-text color="subdued">Cancelled, still shipping</s-text>
            <s-heading>{counts.ending}</s-heading>
          </s-stack>
          <s-stack gap="small-300">
            <s-text color="subdued">Finished</s-text>
            <s-heading>{counts.finished}</s-heading>
          </s-stack>
          <s-stack gap="small-300">
            <s-text color="subdued">Left in the last {counts.churnDays} days</s-text>
            <s-heading>
              {counts.cancelled}
              {counts.churnRate !== null && ` (${(counts.churnRate * 100).toFixed(1)}%)`}
            </s-heading>
            {counts.cancelledViaPortal > 0 && (
              <s-text color="subdued">{counts.cancelledViaPortal} through the portal</s-text>
            )}
          </s-stack>
        </s-stack>
        <s-paragraph>
          A gift, or a {t.plan} that doesn&apos;t renew, is finished once its last {word} has
          shipped, even though Shopify still lists it as active. Churn counts {t.members} who
          cancelled; a gift&apos;s recipient can&apos;t cancel, so gifts are left out.
        </s-paragraph>
      </s-section>

      <s-section padding="none">
        <s-stack direction="inline" gap="small" padding="base">
          {VIEWS.map((key) => (
            <s-button
              key={key}
              variant={key === view ? "primary" : "secondary"}
              onClick={() => navigate(key === "all" ? "?" : `?view=${key}`)}
            >
              {VIEW_TEXT[key]} ({count(key)})
            </s-button>
          ))}
        </s-stack>
        {rows.length === 0 ? (
          <s-box padding="base">
            <s-paragraph>No {t.members} here yet.</s-paragraph>
          </s-box>
        ) : (
          <s-table
            paginate={next !== null || params.has("before")}
            hasNextPage={next !== null}
            hasPreviousPage={params.has("before")}
            onNextPage={() => navigate(`?view=${view}&before=${encodeURIComponent(next ?? "")}`)}
            onPreviousPage={() => navigate(-1)}
          >
            <s-table-header-row>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>{t.Plan}</s-table-header>
              <s-table-header>{capitalize(plural)} left</s-table-header>
              <s-table-header>Term ends</s-table-header>
              <s-table-header>Portal</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((row) => (
                <s-table-row key={row.id}>
                  <s-table-cell>
                    <s-link href={`/app/subscribers/${row.id}`}>{row.name}</s-link>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-300">
                      <s-badge tone={row.state.tone}>{row.state.text}</s-badge>
                      {row.gift && <s-badge>Gift</s-badge>}
                      {row.imported && <s-badge>Imported</s-badge>}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{row.plan}</s-table-cell>
                  <s-table-cell>{row.remaining}</s-table-cell>
                  <s-table-cell>{row.term ?? "None"}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-300">
                      {row.portalCancelled && <s-badge tone="warning">Cancelled</s-badge>}
                      {row.portalAddress && <s-badge>Changed address</s-badge>}
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

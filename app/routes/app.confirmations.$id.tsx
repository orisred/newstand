import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  CONFIRMATIONS_PER_PAGE,
  customerLabel,
  customerNames,
  listConfirmations,
} from "../dashboard.server";
import { whenText } from "../dashboard-format";
import { createDb } from "../db.server";
import { graphqlOf } from "../plan-sync.server";
import { getOrCreateShop } from "../shop.server";
import { authenticate } from "../shopify.server";
import { useTerms } from "../vocabulary";

export const loader = async ({ request, context, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const { env } = context.cloudflare;
  const db = createDb(env.DB);
  const shop = await getOrCreateShop(db, session.shop);
  const release = await db.release.findFirst({
    where: { id: String(params.id), shopId: shop.id },
    select: { id: true, number: true, title: true },
  });
  if (!release) throw new Response("Not found", { status: 404 });
  const result = await listConfirmations(env.DB, shop.id, release.id);
  const names = await customerNames(graphqlOf(admin), result.rows.map((row) => row.customerGid));
  return {
    vocabulary: shop.vocabulary,
    word: shop.releaseWordSingular,
    release,
    total: result.total,
    confirmed: result.confirmed,
    changed: result.changed,
    more: result.more,
    limit: CONFIRMATIONS_PER_PAGE,
    rows: result.rows.map((row) => ({
      id: row.id,
      name: customerLabel(names, row.customerGid),
      confirmed: whenText(row.confirmedAt, shop.timezone),
      changed: Boolean(row.changed),
    })),
  };
};

export default function Confirmations() {
  const c = useLoaderData<typeof loader>();
  const t = useTerms();
  return (
    <s-page heading={`Address confirmations: ${c.release.number}. ${c.release.title}`}>
      <s-link slot="breadcrumb-actions" href="/app">
        Back
      </s-link>
      <s-section>
        <s-paragraph>
          {c.confirmed} of {c.total} confirmed their address for this {c.word}, and {c.changed}{" "}
          changed it in their account since it was announced. {t.Members} who haven&apos;t
          confirmed are listed first. The address used is the one on the {t.noun} when the order is
          created.
        </s-paragraph>
      </s-section>
      <s-section padding="none">
        {c.rows.length === 0 ? (
          <s-box padding="base">
            <s-paragraph>Nobody has been told about this {c.word} yet.</s-paragraph>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Address confirmed</s-table-header>
              <s-table-header>Changed in account</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {c.rows.map((row) => (
                <s-table-row key={row.id}>
                  <s-table-cell>
                    <s-link href={`/app/subscribers/${row.id}`}>{row.name}</s-link>
                  </s-table-cell>
                  <s-table-cell>
                    {row.confirmed ?? <s-badge tone="warning">Not confirmed</s-badge>}
                  </s-table-cell>
                  <s-table-cell>{row.changed ? "Yes" : ""}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        {c.more && (
          <s-box padding="base">
            <s-text color="subdued">Showing the first {c.limit}, unconfirmed first.</s-text>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

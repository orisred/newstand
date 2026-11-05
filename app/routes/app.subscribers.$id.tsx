import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  customerLabel,
  customerNames,
  EMAIL_KIND_LABELS,
  getSubscriber,
  PORTAL_ADDRESS_EVENT,
} from "../dashboard.server";
import { formatMoney, idOf, stateOf, whenText } from "../dashboard-format";
import { createDb } from "../db.server";
import { releaseImportHold } from "../import.server";
import { graphqlOf } from "../plan-sync.server";
import { capitalize } from "../release-actions";
import { getOrCreateShop } from "../shop.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request, context, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const db = createDb(context.cloudflare.env.DB);
  const shop = await getOrCreateShop(db, session.shop);
  const found = await getSubscriber(db, shop.id, String(params.id));
  if (!found) throw new Response("Not found", { status: 404 });
  const { subscription, deliveries, attempts, events, emails } = found;
  const names = await customerNames(
    graphqlOf(admin),
    [subscription.customerGid, subscription.giftBuyerGid ?? ""],
  );
  const when = (value: Date | string | null) => whenText(value, shop.timezone);
  const gift = subscription.source === "GIFT";
  const finished =
    subscription.status === "ACTIVE" &&
    subscription.releasesRemaining <= 0 &&
    (gift || !subscription.plan.autoRenew);
  const currency = subscription.plan.currency;
  return {
    word: shop.releaseWordSingular,
    plural: shop.releaseWordPlural,
    state: stateOf({ ...subscription, finished }),
    source: subscription.source,
    customer: {
      name: customerLabel(names, subscription.customerGid),
      id: idOf(subscription.customerGid),
    },
    buyer: subscription.giftBuyerGid
      ? { name: customerLabel(names, subscription.giftBuyerGid), id: idOf(subscription.giftBuyerGid) }
      : null,
    giftMessage: subscription.giftMessage,
    plan: subscription.plan.displayName,
    perRelease: subscription.plan.billingMode === "PER_RELEASE",
    quantity: subscription.quantity,
    remaining: subscription.releasesRemaining,
    termEnds: when(subscription.termEndsAt),
    since: when(subscription.createdAt),
    paidAtSignup:
      subscription.signupCents === null ? null : formatMoney(subscription.signupCents, currency),
    pausedReason: subscription.pausedReason,
    problemSince: when(subscription.paymentProblemSince),
    imported: subscription.source === "IMPORTED",
    noCardSince: when(subscription.noCardSince),
    depleting: subscription.plan.renewalRule === "ON_DEPLETION",
    zeroPrice: subscription.lockedPriceCents === 0,
    deliveries: deliveries.map((d) => ({
      ...d,
      confirmed: when(d.addressConfirmedAt),
      orderId: d.orderGid ? idOf(d.orderGid) : null,
    })),
    attempts: attempts.map((a) => ({
      ...a,
      at: when(a.createdAt),
      amount: a.amountCents === null ? null : formatMoney(a.amountCents, currency),
    })),
    portal: events.map((e) => ({
      text: e.type === PORTAL_ADDRESS_EVENT ? "Changed their address" : "Cancelled",
      at: when(e.createdAt),
    })),
    emails: emails.map((e) => ({
      id: e.id,
      label: EMAIL_KIND_LABELS[e.kind] ?? e.kind,
      status: e.status,
      reason: e.reason,
      at: when(e.sentAt ?? e.createdAt),
    })),
  };
};

/** A merchant lets a subscriber held by the import go live. */
export const action = async ({ request, context, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { env } = context.cloudflare;
  const shop = await getOrCreateShop(createDb(env.DB), session.shop);
  return { released: await releaseImportHold(env.DB, shop.id, String(params.id)) };
};

const DELIVERY_TEXT = {
  PENDING: "Waiting for its order",
  ORDERED: "Order created",
  HELD: "Held, waiting for payment",
  FULFILLED: "Fulfilled",
  CANCELLED: "Cancelled",
} as const;

const EMAIL_TONE = {
  SENT: "success",
  PENDING: "info",
  SENDING: "info",
  SKIPPED: "neutral",
  FAILED: "critical",
  UNSURE: "warning",
} as const;

export default function Subscriber() {
  const s = useLoaderData<typeof loader>();
  const release = useFetcher<typeof action>();
  return (
    <s-page heading={s.customer.name}>
      <s-link slot="breadcrumb-actions" href="/app/subscribers">
        Subscribers
      </s-link>
      {s.noCardSince && (
        <s-banner tone="critical" heading="No card on this contract">
          <s-paragraph>
            Imported with no saved card, so the next charge will fail, retry and then pause. A card
            the customer saves goes on the contract when they save it, and this goes away.
          </s-paragraph>
        </s-banner>
      )}
      {s.pausedReason === "IMPORT_HOLD" && (
        <s-banner tone="warning" heading="On hold from the import">
          <s-stack gap="small">
            <s-paragraph>
              Nothing is charged while it&apos;s on hold, and paid {s.plural} still ship. Check the
              old app has stopped charging this subscriber first.{" "}
              {s.depleting
                ? "This plan renews when paid releases run out, so with none left, releasing it charges within the hour, with no notice sent."
                : "Releasing it moves a term date less than 22 days away out to 22 days from now, so the upcoming-charge notice goes first."}
              {s.zeroPrice &&
                " Their last purchase cost nothing, so this contract's price is $0 and it renews for nothing. Releasing the hold doesn't change that."}
            </s-paragraph>
            <s-button
              variant="primary"
              {...(release.state !== "idle" ? { loading: true } : {})}
              onClick={() => release.submit({}, { method: "post" })}
            >
              Release hold
            </s-button>
          </s-stack>
        </s-banner>
      )}
      <s-section heading="Subscription">
        <s-stack gap="small">
          <s-stack direction="inline" gap="small">
            <s-badge tone={s.state.tone}>{s.state.text}</s-badge>
            {s.source === "GIFT" && <s-badge>Gift</s-badge>}
            {s.source === "IMPORTED" && <s-badge>Imported</s-badge>}
            {s.pausedReason === "CHARGEBACK" && <s-badge tone="critical">Chargeback</s-badge>}
            {s.pausedReason === "FAILED_PAYMENT" && <s-badge tone="critical">Failed payment</s-badge>}
          </s-stack>
          <s-text>Customer: <s-link href={`shopify://admin/customers/${s.customer.id}`}>{s.customer.name}</s-link></s-text>
          <s-text>Plan: {s.plan}</s-text>
          <s-text>Copies of each {s.word}: {s.quantity}</s-text>
          <s-text>Paid {s.word} still to ship: {s.remaining}</s-text>
          <s-text>Term ends: {s.perRelease ? "Per release, no term" : (s.termEnds ?? "None")}</s-text>
          <s-text>{s.imported ? "Imported" : "Signed up"}: {s.since}</s-text>
          <s-text>
            Paid at sign-up: {s.imported ? "Before the import, in the old app" : (s.paidAtSignup ?? "Not read from Shopify yet")}
          </s-text>
          {s.problemSince && <s-text>Payment problem since: {s.problemSince}</s-text>}
        </s-stack>
      </s-section>

      {s.source === "GIFT" && (
        <s-section heading="Gift">
          <s-stack gap="small">
            <s-text>Source: bought as a gift. The buyer paid and is never charged again.</s-text>
            <s-text>
              Buyer:{" "}
              {s.buyer ? (
                <s-link href={`shopify://admin/customers/${s.buyer.id}`}>{s.buyer.name}</s-link>
              ) : (
                "Removed at the buyer's request"
              )}
            </s-text>
            <s-text>
              Recipient: <s-link href={`shopify://admin/customers/${s.customer.id}`}>{s.customer.name}</s-link>
            </s-text>
            {s.giftMessage && <s-text>Message from the buyer: {s.giftMessage}</s-text>}
          </s-stack>
        </s-section>
      )}

      <s-section heading={`${capitalize(s.plural)} and address confirmation`} padding="none">
        {s.deliveries.length === 0 ? (
          <s-box padding="base">
            <s-paragraph>No {s.plural} yet.</s-paragraph>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>{capitalize(s.word)}</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Order</s-table-header>
              <s-table-header>Address confirmed</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {s.deliveries.map((d) => (
                <s-table-row key={d.release.number}>
                  <s-table-cell>
                    {d.release.number}. {d.release.title}
                  </s-table-cell>
                  <s-table-cell>{DELIVERY_TEXT[d.status]}</s-table-cell>
                  <s-table-cell>
                    {d.orderId ? (
                      <s-link href={`shopify://admin/orders/${d.orderId}`}>{d.orderName ?? d.orderId}</s-link>
                    ) : (
                      "None yet"
                    )}
                  </s-table-cell>
                  <s-table-cell>{d.confirmed ?? "Not confirmed"}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Portal activity">
        {s.portal.length === 0 ? (
          <s-paragraph>Nothing yet. Address changes and cancellations the customer makes in their account show here.</s-paragraph>
        ) : (
          <s-stack gap="small-300">
            {s.portal.map((e) => (
              <s-text key={`${e.at}${e.text}`}>{e.at}: {e.text}</s-text>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Payments" padding="none">
        {s.attempts.length === 0 ? (
          <s-box padding="base">
            <s-paragraph>No charges yet apart from the sign-up payment.</s-paragraph>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>When</s-table-header>
              <s-table-header>Result</s-table-header>
              <s-table-header>Amount</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {s.attempts.map((a) => (
                <s-table-row key={`${a.at}${a.attempt}`}>
                  <s-table-cell>{a.at}</s-table-cell>
                  <s-table-cell>
                    {a.result === "FAILED"
                      ? `Failed (try ${a.attempt}${a.errorCode ? `, ${a.errorCode.replaceAll("_", " ").toLowerCase()}` : ""})`
                      : a.result === "DUPLICATE"
                        ? "Charged twice: refund this one"
                        : capitalize(a.result.toLowerCase())}
                  </s-table-cell>
                  <s-table-cell>{a.amount ?? ""}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Emails" padding="none">
        {s.emails.length === 0 ? (
          <s-box padding="base">
            <s-paragraph>No emails yet.</s-paragraph>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Email</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>When</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {s.emails.map((e) => (
                <s-table-row key={e.id}>
                  <s-table-cell>{e.label}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={EMAIL_TONE[e.status]}>{capitalize(e.status.toLowerCase())}</s-badge>
                  </s-table-cell>
                  <s-table-cell>{e.at}</s-table-cell>
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

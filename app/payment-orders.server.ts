import { logEvent } from "./logger.server";
import type { Graphql } from "./plan-sync.server";
import { DELIVERY_MARKER } from "./release-orders.server";

const ORDER = `#graphql
  query PaymentOrder($id: ID!) {
    order(id: $id) {
      createdAt
      sourceIdentifier
      lineItems(first: 50) { nodes { id unfulfilledQuantity contract { id } } }
      fulfillmentOrders(first: 20) {
        nodes {
          id
          status
          supportedActions { action }
          lineItems(first: 50) { nodes { id remainingQuantity lineItem { id } } }
        }
      }
    }
  }`;

const FULFILL = `#graphql
  mutation PaymentOrderFulfill($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id }
      userErrors { message }
    }
  }`;

/** It can be fulfilled later (it's on hold, say), or Shopify refused. The job retries. */
export class PaymentOrderNotFulfilled extends Error {}

export type PaymentOrderResult =
  | { status: "fulfilled"; lines: number; latencyMs: number }
  | { status: "nothing_to_do" | "not_found" | "release_order" | "not_visible" };

/**
 * Marks the subscription lines of a payment order fulfilled, without telling the customer: the
 * order records payment, and the release ships on its own $0 order. Billing orders come here too.
 *
 * Only lines belonging to a subscription contract are touched, so another product bought in
 * the same checkout still ships. A $0 release order has none and also carries a marker, and is
 * refused outright. Repeats are safe, because it works from what remains to fulfill.
 */
export async function markPaymentOrderFulfilled(
  graphql: Graphql,
  orderGid: string,
  now = new Date(),
): Promise<PaymentOrderResult> {
  const { order } = await graphql(ORDER, { id: orderGid });
  if (!order) return { status: "not_found" };
  if (order.sourceIdentifier?.startsWith(DELIVERY_MARKER)) {
    logEvent("error", "payment_order.refused_release_order", { orderGid });
    return { status: "release_order" };
  }

  type LineItem = {
    id: string;
    unfulfilledQuantity: number;
    contract: { id: string } | null;
  };
  type FulfillmentOrder = {
    id: string;
    status: string;
    supportedActions: { action: string }[];
    lineItems: {
      nodes: {
        id: string;
        remainingQuantity: number;
        lineItem: { id: string };
      }[];
    };
  };
  const subscriptionLines = (order.lineItems.nodes as LineItem[]).filter(
    (line) => line.contract,
  );
  const lineIds = new Set(subscriptionLines.map((line) => line.id));

  let lines = 0;
  let blocked = 0;
  let found = 0;
  for (const fulfillmentOrder of order.fulfillmentOrders
    .nodes as FulfillmentOrder[]) {
    const items = fulfillmentOrder.lineItems.nodes.filter(
      (item) => item.remainingQuantity > 0 && lineIds.has(item.lineItem.id),
    );
    if (items.length === 0) continue;
    found += items.length;
    const fulfillable = fulfillmentOrder.supportedActions.some(
      ({ action }) => action === "CREATE_FULFILLMENT",
    );
    if (!fulfillable) {
      blocked++;
      continue;
    }
    const { fulfillmentCreate: result } = await graphql(FULFILL, {
      fulfillment: {
        notifyCustomer: false,
        lineItemsByFulfillmentOrder: [
          {
            fulfillmentOrderId: fulfillmentOrder.id,
            fulfillmentOrderLineItems: items.map((item) => ({
              id: item.id,
              quantity: item.remainingQuantity,
            })),
          },
        ],
      },
    });
    if (result.userErrors.length > 0) {
      throw new PaymentOrderNotFulfilled("Shopify refused the fulfillment");
    }
    lines += items.length;
  }

  if (blocked > 0) {
    throw new PaymentOrderNotFulfilled("A fulfillment order can't be fulfilled yet");
  }
  if (lines === 0) {
    // Unfulfilled, but in no fulfillment order this app can see: one assigned to a fulfillment
    // service. Only that service can fulfill it. The product must stock at a merchant's location.
    const hidden = subscriptionLines.some(
      (line) => line.unfulfilledQuantity > 0,
    );
    if (hidden && found === 0) {
      logEvent("error", "payment_order.not_visible", { orderGid });
      return { status: "not_visible" };
    }
    return { status: "nothing_to_do" };
  }
  const latencyMs = now.getTime() - Date.parse(order.createdAt);
  logEvent("info", "payment_order.fulfilled", { orderGid, lines, latencyMs });
  return { status: "fulfilled", lines, latencyMs };
}

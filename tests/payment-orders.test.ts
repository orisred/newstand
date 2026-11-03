/* eslint-disable @typescript-eslint/no-explicit-any -- a fake of Shopify's loosely typed responses */
import { describe, expect, it } from "vitest";
import {
  markPaymentOrderFulfilled,
  PaymentOrderNotFulfilled,
} from "../app/payment-orders.server";
import type { Graphql } from "../app/plan-sync.server";
import { DELIVERY_MARKER } from "../app/release-orders.server";

const CREATE = { action: "CREATE_FULFILLMENT" };

function shopify(order: any, userErrors: { message: string }[] = []) {
  const fulfillments: any[] = [];
  const graphql: Graphql = async (query, variables: any) => {
    if (query.includes("PaymentOrderFulfill")) {
      fulfillments.push(variables.fulfillment);
      return { fulfillmentCreate: { fulfillment: { id: "f" }, userErrors } };
    }
    return { order };
  };
  return { graphql, fulfillments };
}

const line = (id: string, contract: boolean, unfulfilledQuantity = 1) => ({
  id,
  unfulfilledQuantity,
  contract: contract ? { id: "contract" } : null,
});

const foLine = (id: string, lineId: string, remainingQuantity = 1) => ({
  id,
  remainingQuantity,
  lineItem: { id: lineId },
});

const paymentOrder = (overrides: Record<string, unknown> = {}) => ({
  createdAt: "2026-06-01T00:00:00Z",
  sourceIdentifier: null,
  lineItems: { nodes: [line("L1", true)] },
  fulfillmentOrders: {
    nodes: [
      {
        id: "FO1",
        status: "OPEN",
        supportedActions: [CREATE],
        lineItems: { nodes: [foLine("FL1", "L1")] },
      },
    ],
  },
  ...overrides,
});

describe("markPaymentOrderFulfilled", () => {
  it("fulfills the subscription line and never notifies the customer", async () => {
    const { graphql, fulfillments } = shopify(paymentOrder());
    const result = await markPaymentOrderFulfilled(
      graphql,
      "order",
      new Date("2026-06-01T00:00:03Z"),
    );
    expect(result).toEqual({ status: "fulfilled", lines: 1, latencyMs: 3000 });
    expect(fulfillments).toEqual([
      {
        notifyCustomer: false,
        lineItemsByFulfillmentOrder: [
          {
            fulfillmentOrderId: "FO1",
            fulfillmentOrderLineItems: [{ id: "FL1", quantity: 1 }],
          },
        ],
      },
    ]);
  });

  it("fulfills every copy of a quantity above 1", async () => {
    const { graphql, fulfillments } = shopify(
      paymentOrder({
        fulfillmentOrders: {
          nodes: [
            {
              id: "FO1",
              status: "OPEN",
              supportedActions: [CREATE],
              lineItems: { nodes: [foLine("FL1", "L1", 2)] },
            },
          ],
        },
      }),
    );
    await markPaymentOrderFulfilled(graphql, "order");
    expect(
      fulfillments[0].lineItemsByFulfillmentOrder[0].fulfillmentOrderLineItems,
    ).toEqual([{ id: "FL1", quantity: 2 }]);
  });

  it("leaves another product from the same checkout to ship", async () => {
    const { graphql, fulfillments } = shopify(
      paymentOrder({
        lineItems: { nodes: [line("L1", true), line("MUG", false)] },
        fulfillmentOrders: {
          nodes: [
            {
              id: "FO1",
              status: "OPEN",
              supportedActions: [CREATE],
              lineItems: {
                nodes: [foLine("FL1", "L1"), foLine("FL2", "MUG")],
              },
            },
          ],
        },
      }),
    );
    await markPaymentOrderFulfilled(graphql, "order");
    expect(
      fulfillments[0].lineItemsByFulfillmentOrder[0].fulfillmentOrderLineItems,
    ).toEqual([{ id: "FL1", quantity: 1 }]);
  });

  it("refuses a $0 release order, even one with a contract line", async () => {
    const { graphql, fulfillments } = shopify(
      paymentOrder({ sourceIdentifier: `${DELIVERY_MARKER}abc` }),
    );
    expect(await markPaymentOrderFulfilled(graphql, "order")).toEqual({
      status: "release_order",
    });
    expect(fulfillments).toHaveLength(0);
  });

  it("an order with no subscription lines is left alone", async () => {
    const { graphql, fulfillments } = shopify(
      paymentOrder({ lineItems: { nodes: [line("L1", false)] } }),
    );
    expect(await markPaymentOrderFulfilled(graphql, "order")).toEqual({
      status: "nothing_to_do",
    });
    expect(fulfillments).toHaveLength(0);
  });

  it("a repeat finds nothing remaining and does nothing", async () => {
    const { graphql, fulfillments } = shopify(
      paymentOrder({
        lineItems: { nodes: [line("L1", true, 0)] },
        fulfillmentOrders: {
          nodes: [
            {
              id: "FO1",
              status: "CLOSED",
              supportedActions: [],
              lineItems: { nodes: [foLine("FL1", "L1", 0)] },
            },
          ],
        },
      }),
    );
    expect(await markPaymentOrderFulfilled(graphql, "order")).toEqual({
      status: "nothing_to_do",
    });
    expect(fulfillments).toHaveLength(0);
  });

  it("an order on hold is retried, not forgotten", async () => {
    const { graphql } = shopify(
      paymentOrder({
        fulfillmentOrders: {
          nodes: [
            {
              id: "FO1",
              status: "ON_HOLD",
              supportedActions: [],
              lineItems: { nodes: [foLine("FL1", "L1")] },
            },
          ],
        },
      }),
    );
    await expect(markPaymentOrderFulfilled(graphql, "order")).rejects.toBeInstanceOf(
      PaymentOrderNotFulfilled,
    );
  });

  it("Shopify refusing is retried", async () => {
    const { graphql } = shopify(paymentOrder(), [{ message: "no" }]);
    await expect(markPaymentOrderFulfilled(graphql, "order")).rejects.toBeInstanceOf(
      PaymentOrderNotFulfilled,
    );
  });

  it("says so when a fulfillment service holds the order, out of this app's sight", async () => {
    const { graphql } = shopify(paymentOrder({ fulfillmentOrders: { nodes: [] } }));
    expect(await markPaymentOrderFulfilled(graphql, "order")).toEqual({
      status: "not_visible",
    });
  });

  it("an order that's gone is nothing to do", async () => {
    expect(await markPaymentOrderFulfilled(shopify(null).graphql, "order")).toEqual({
      status: "not_found",
    });
  });
});

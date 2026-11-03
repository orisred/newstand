import type { createDb } from "./db.server";
import { logEvent } from "./logger.server";
import type { Graphql } from "./plan-sync.server";
import { orderStepReached } from "./subscriptions.server";

type Db = ReturnType<typeof createDb>;

/** Starts `sourceIdentifier` on every $0 release order. Also how the payment helper refuses them. */
export const DELIVERY_MARKER = "release-subscriptions:delivery:";

// Far longer than Shopify takes to index a new order for search (about 5 seconds when measured).
const LEASE_MS = 5 * 60 * 1000;

/** Another run is creating this order, or one crashed doing so. The job retries when the lease ends. */
export class OrderBusy extends Error {}
/** Shopify is limiting order creation. Nothing was created, so the job just retries. */
export class OrderThrottled extends Error {}

const ADDRESS_FIELDS = `firstName lastName company address1 address2 city provinceCode zip countryCode phone`;

const CONTRACT = `#graphql
  query ContractForOrder($id: ID!, $variant: ID!) {
    shop { currencyCode }
    productVariant(id: $variant) { inventoryItem { requiresShipping } }
    subscriptionContract(id: $id) {
      deliveryMethod {
        ... on SubscriptionDeliveryMethodShipping { address { ${ADDRESS_FIELDS} } }
        ... on SubscriptionDeliveryMethodLocalDelivery { address { ${ADDRESS_FIELDS} } }
      }
    }
  }`;

const FIND_ORDER = `#graphql
  query OrderByMarker($query: String!) {
    orders(first: 5, query: $query) { nodes { id sourceIdentifier } }
  }`;

const CREATE_ORDER = `#graphql
  mutation ReleaseOrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      order { id }
      userErrors { message }
    }
  }`;

export type OrderResult =
  | "created"
  | "recovered" // an earlier try made it, and crashed before storing its ID
  | "already"
  | "not_due"
  | "no_product"
  | "refused"
  | "skipped";

/**
 * Creates the $0 order behind one Delivery. Step 8's run calls this too.
 *
 * Shopify can't dedupe this for us: `orderCreate` accepts `@idempotent` and a unique metafield
 * and makes a second order anyway (checked live, see DECISIONS.md). So, in this order:
 * 1. take a lease on the Delivery, so two runs never create at once;
 * 2. search for an order carrying this Delivery's marker, which finds one whose ID never
 *    reached D1, and the lease outlasts the search index's delay;
 * 3. create the order with the marker, using the contract's address at this moment;
 * 4. store its ID and count the release in one batch.
 * A crash leaves the lease to lapse, and the retry finds the order at step 2.
 *
 * `releasesRemaining` goes down here, and only here: see DECISIONS.md.
 */
export async function createDeliveryOrder(
  db: Db,
  rawDb: D1Database,
  graphql: Graphql,
  deliveryId: string,
  now = new Date(),
): Promise<OrderResult> {
  const delivery = await db.delivery.findUnique({
    where: { id: deliveryId },
    select: {
      status: true,
      orderGid: true,
      subscriptionId: true,
      subscription: {
        select: {
          status: true,
          contractGid: true,
          customerGid: true,
          quantity: true,
          shop: { select: { orderTiming: true } },
        },
      },
      release: { select: { status: true, productGid: true } },
    },
  });
  if (!delivery) return "skipped";
  if (delivery.orderGid) return "already";
  const { subscription, release } = delivery;
  if (
    delivery.status !== "PENDING" ||
    subscription.status === "ENDED" ||
    !subscription.contractGid
  ) {
    return "skipped";
  }
  if (!orderStepReached(release.status, subscription.shop.orderTiming)) {
    return "not_due";
  }
  // Shown to the merchant on the releases screen. Choosing a product runs this again.
  if (!release.productGid) return "no_product";

  const leased = await db.delivery.updateMany({
    where: {
      id: deliveryId,
      orderGid: null,
      OR: [{ orderLeaseUntil: null }, { orderLeaseUntil: { lt: now } }],
    },
    data: { orderLeaseUntil: new Date(now.getTime() + LEASE_MS) },
  });
  if (leased.count === 0) throw new OrderBusy("Order is being created");

  const marker = `${DELIVERY_MARKER}${deliveryId}`;
  const found = await graphql(FIND_ORDER, {
    query: `source_identifier:'${marker}'`,
  });
  // The search is loose, so match exactly.
  const matches = (
    found.orders.nodes as { id: string; sourceIdentifier: string | null }[]
  ).filter((order) => order.sourceIdentifier === marker);
  if (matches.length > 1) {
    logEvent("error", "delivery.duplicate_orders", {
      deliveryId,
      orders: matches.length,
    });
  }
  let orderGid = matches[0]?.id as string | undefined;
  const recovered = Boolean(orderGid);

  if (!orderGid) {
    const data = await graphql(CONTRACT, {
      id: subscription.contractGid,
      variant: release.productGid,
    });
    if (!data.productVariant) {
      return refuse(
        db,
        deliveryId,
        "The product chosen for this release no longer exists. Choose another.",
      );
    }
    const address = data.subscriptionContract?.deliveryMethod?.address;
    if (!address) {
      // For example a contract set to pickup. Refused, not skipped: the merchant has to act.
      return refuse(
        db,
        deliveryId,
        "This subscription's contract has no delivery address.",
      );
    }
    const created = await graphql(CREATE_ORDER, {
      order: {
        customer: { toAssociate: { id: subscription.customerGid } },
        shippingAddress: address,
        financialStatus: "PAID",
        sourceIdentifier: marker,
        tags: ["release-subscriptions"],
        lineItems: [
          {
            variantId: release.productGid,
            quantity: subscription.quantity,
            // Shopify doesn't take this from the variant: left out, the line reads as not shipping.
            requiresShipping: data.productVariant.inventoryItem.requiresShipping,
            priceSet: {
              shopMoney: {
                amount: "0.00",
                currencyCode: data.shop.currencyCode,
              },
            },
          },
        ],
      },
      options: {
        // A release is paid for, so it can't be refused for being out of stock.
        inventoryBehaviour: "DECREMENT_IGNORING_POLICY",
        // The app's own emails (Step 10) tell the customer, each switchable off per merchant.
        sendReceipt: false,
        sendFulfillmentReceipt: false,
      },
    });
    const errors: { message: string }[] = created.orderCreate.userErrors;
    // A limit, not a refusal, though it arrives the same way and with no error code.
    if (errors.some(({ message }) => /too many attempts/i.test(message))) {
      await db.delivery.updateMany({
        where: { id: deliveryId, orderGid: null },
        data: { orderLeaseUntil: null },
      });
      throw new OrderThrottled("Shopify is limiting order creation");
    }
    if (errors.length > 0) {
      return refuse(
        db,
        deliveryId,
        errors.map((error) => error.message).join("; "),
      );
    }
    orderGid = created.orderCreate.order.id as string;
  }

  const stamp = new Date().toISOString();
  // Together, and counted only if this batch is the one storing the order.
  await rawDb.batch([
    rawDb
      .prepare(
        `UPDATE "Subscription" SET "releasesRemaining" = "releasesRemaining" - 1, "updatedAt" = ?3
         WHERE "id" = ?1
           AND EXISTS (SELECT 1 FROM "Delivery" WHERE "id" = ?2 AND "orderGid" IS NULL)`,
      )
      .bind(delivery.subscriptionId, deliveryId, stamp),
    rawDb
      .prepare(
        `UPDATE "Delivery" SET "orderGid" = ?2, "status" = 'ORDERED', "orderLeaseUntil" = NULL,
           "orderError" = NULL, "updatedAt" = ?3
         WHERE "id" = ?1 AND "orderGid" IS NULL`,
      )
      .bind(deliveryId, orderGid, stamp),
  ]);
  logEvent("info", "delivery.ordered", { deliveryId, orderGid, recovered });
  return recovered ? "recovered" : "created";
}

async function refuse(db: Db, deliveryId: string, message: string) {
  await db.delivery.updateMany({
    where: { id: deliveryId, orderGid: null },
    data: { orderError: message.slice(0, 500), orderLeaseUntil: null },
  });
  logEvent("warn", "delivery.order_refused", { deliveryId });
  return "refused" as const;
}

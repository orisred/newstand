/* eslint-disable @typescript-eslint/no-explicit-any -- a fake of Shopify's loosely typed responses */
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../app/db.server";
import type { Graphql } from "../app/plan-sync.server";
import {
  createDeliveryOrder,
  DELIVERY_MARKER,
  OrderBusy,
  OrderThrottled,
} from "../app/release-orders.server";
import { listWaitingOrders, setReleaseProduct } from "../app/releases.server";
import { getOrCreateShop } from "../app/shop.server";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const db = () => createDb(env.DB);
let n = 0;

const ADDRESS = {
  firstName: "A",
  lastName: "B",
  address1: "1 Test St",
  city: "NY",
  provinceCode: "NY",
  zip: "10001",
  countryCode: "US",
};

/** A Shopify holding orders. Search sees an order only once `indexed` is set. */
function fakeShopify(options: { address?: any; errors?: string[] } = {}) {
  const orders: any[] = [];
  const state = {
    indexed: true,
    address: options.address ?? ADDRESS,
    variantGone: false,
  };
  const graphql: Graphql = async (query, variables: any) => {
    if (query.includes("OrderByMarker")) {
      const marker = /source_identifier:'(.+)'/.exec(variables.query)![1];
      return {
        orders: {
          nodes: state.indexed
            ? orders.filter((order) => order.sourceIdentifier === marker)
            : [],
        },
      };
    }
    if (query.includes("ContractForOrder")) {
      return {
        shop: { currencyCode: "USD" },
        productVariant: state.variantGone
          ? null
          : { inventoryItem: { requiresShipping: true } },
        subscriptionContract: {
          deliveryMethod: state.address ? { address: state.address } : {},
        },
      };
    }
    if (query.includes("ReleaseOrderCreate")) {
      if (options.errors?.length) {
        return {
          orderCreate: {
            order: null,
            userErrors: options.errors.map((message) => ({ message })),
          },
        };
      }
      const order = {
        id: `gid://shopify/Order/${++n}`,
        sourceIdentifier: variables.order.sourceIdentifier,
        input: variables,
      };
      orders.push(order);
      return { orderCreate: { order: { id: order.id }, userErrors: [] } };
    }
    throw new Error(`Unexpected query: ${query}`);
  };
  return { graphql, orders, state };
}

/** A D1 whose next `batch` fails: the Worker dying right after Shopify made the order. */
function crashingOnBatch() {
  return new Proxy(env.DB, {
    get(target, key) {
      if (key === "batch") return () => Promise.reject(new Error("crash"));
      const value = (target as any)[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function setup(
  fields: {
    status?: "UNANNOUNCED" | "PREORDER" | "READY" | "SHIPPED" | "CANCELLED";
    productGid?: string | null;
    orderTiming?: "READY_TO_SHIP" | "PREORDER_OPENS";
    quantity?: number;
    subscriptionStatus?: "ACTIVE" | "CANCELLED" | "ENDED";
  } = {},
) {
  const domain = `orders${++n}.myshopify.com`;
  const shop = await getOrCreateShop(db(), domain);
  await db().shop.update({
    where: { id: shop.id },
    data: { orderTiming: fields.orderTiming ?? "READY_TO_SHIP" },
  });
  const plan = await db().plan.create({
    data: { shopId: shop.id, name: "P", displayName: "P", priceCents: 4000 },
  });
  const release = await db().release.create({
    data: {
      shopId: shop.id,
      number: 1,
      title: "R",
      status: fields.status ?? "SHIPPED",
      productGid:
        fields.productGid === undefined
          ? "gid://shopify/ProductVariant/1"
          : fields.productGid,
    },
  });
  const subscription = await db().subscription.create({
    data: {
      shopId: shop.id,
      planId: plan.id,
      contractGid: `gid://shopify/SubscriptionContract/${++n}`,
      customerGid: "gid://shopify/Customer/1",
      releasesRemaining: 2,
      quantity: fields.quantity ?? 1,
      status: fields.subscriptionStatus ?? "ACTIVE",
    },
  });
  const delivery = await db().delivery.create({
    data: { subscriptionId: subscription.id, releaseId: release.id },
  });
  return { shop: { ...shop, shopDomain: domain }, release, subscription, delivery };
}

const remaining = async (id: string) =>
  (await db().subscription.findUniqueOrThrow({ where: { id } })).releasesRemaining;
const deliveryRow = (id: string) =>
  db().delivery.findUniqueOrThrow({ where: { id } });

describe("createDeliveryOrder", () => {
  it("makes a $0 order for the customer at the contract's address, telling no one", async () => {
    const { delivery } = await setup({ quantity: 2 });
    const shopify = fakeShopify();
    expect(
      await createDeliveryOrder(db(), env.DB, shopify.graphql, delivery.id),
    ).toBe("created");
    const { order, options } = shopify.orders[0].input;
    expect(order).toMatchObject({
      customer: { toAssociate: { id: "gid://shopify/Customer/1" } },
      shippingAddress: ADDRESS,
      financialStatus: "PAID",
      sourceIdentifier: `${DELIVERY_MARKER}${delivery.id}`,
    });
    expect(order.lineItems).toEqual([
      {
        variantId: "gid://shopify/ProductVariant/1",
        quantity: 2,
        requiresShipping: true,
        priceSet: { shopMoney: { amount: "0.00", currencyCode: "USD" } },
      },
    ]);
    expect(order.shippingLines).toBeUndefined();
    expect(order.taxLines).toBeUndefined();
    expect(options).toEqual({
      inventoryBehaviour: "DECREMENT_IGNORING_POLICY",
      sendReceipt: false,
      sendFulfillmentReceipt: false,
    });
  });

  it("uses the address on the contract at this moment", async () => {
    const { delivery } = await setup();
    const shopify = fakeShopify();
    shopify.state.address = { ...ADDRESS, address1: "2 New St" };
    await createDeliveryOrder(db(), env.DB, shopify.graphql, delivery.id);
    expect(shopify.orders[0].input.order.shippingAddress.address1).toBe("2 New St");
  });

  it("links the order and takes one off releasesRemaining, once", async () => {
    const { delivery, subscription } = await setup();
    const shopify = fakeShopify();
    await createDeliveryOrder(db(), env.DB, shopify.graphql, delivery.id);
    expect(await deliveryRow(delivery.id)).toMatchObject({
      status: "ORDERED",
      orderGid: shopify.orders[0].id,
      orderLeaseUntil: null,
    });
    expect(await remaining(subscription.id)).toBe(1);

    expect(
      await createDeliveryOrder(db(), env.DB, shopify.graphql, delivery.id),
    ).toBe("already");
    expect(shopify.orders).toHaveLength(1);
    expect(await remaining(subscription.id)).toBe(1);
  });

  it("doesn't count a release before its order exists", async () => {
    const { delivery, subscription } = await setup({ status: "PREORDER" });
    await createDeliveryOrder(db(), env.DB, fakeShopify().graphql, delivery.id);
    expect(await remaining(subscription.id)).toBe(2);
  });

  describe("a crash between creating the order and storing its ID", () => {
    it("the retry finds the order and makes no second one", async () => {
      const { delivery, subscription } = await setup();
      const shopify = fakeShopify();
      const start = new Date("2026-06-01T00:00:00Z");

      await expect(
        createDeliveryOrder(db(), crashingOnBatch(), shopify.graphql, delivery.id, start),
      ).rejects.toThrow("crash");
      expect(shopify.orders).toHaveLength(1);
      expect((await deliveryRow(delivery.id)).orderGid).toBeNull();
      expect(await remaining(subscription.id)).toBe(2);

      const later = new Date(start.getTime() + 6 * 60 * 1000);
      expect(
        await createDeliveryOrder(db(), env.DB, shopify.graphql, delivery.id, later),
      ).toBe("recovered");
      expect(shopify.orders).toHaveLength(1);
      expect((await deliveryRow(delivery.id)).orderGid).toBe(shopify.orders[0].id);
      expect(await remaining(subscription.id)).toBe(1);
    });

    it("a retry while search may still miss the order waits out the lease", async () => {
      const { delivery } = await setup();
      const shopify = fakeShopify();
      shopify.state.indexed = false;
      const start = new Date("2026-06-01T00:00:00Z");
      await expect(
        createDeliveryOrder(db(), crashingOnBatch(), shopify.graphql, delivery.id, start),
      ).rejects.toThrow("crash");
      const soon = new Date(start.getTime() + 60 * 1000);
      await expect(
        createDeliveryOrder(db(), env.DB, shopify.graphql, delivery.id, soon),
      ).rejects.toBeInstanceOf(OrderBusy);
      expect(shopify.orders).toHaveLength(1);
    });
  });

  it("a sign-up racing a run for one Delivery makes one order", async () => {
    const { delivery, subscription } = await setup();
    const shopify = fakeShopify();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        createDeliveryOrder(db(), env.DB, shopify.graphql, delivery.id),
      ),
    );
    expect(shopify.orders).toHaveLength(1);
    expect(await remaining(subscription.id)).toBe(1);
    const created = results.filter(
      (result) => result.status === "fulfilled" && result.value === "created",
    );
    expect(created).toHaveLength(1);
  });

  it("a run reaching a subscriber's Delivery finds the unique key already taken", async () => {
    const { delivery, subscription, release } = await setup();
    await expect(
      db().delivery.create({
        data: { subscriptionId: subscription.id, releaseId: release.id },
      }),
    ).rejects.toThrow();
    expect(
      await db().delivery.count({ where: { subscriptionId: subscription.id } }),
    ).toBe(1);
    expect(delivery.id).toBeTruthy();
  });

  describe("orderTiming", () => {
    it("pre-order under ready to ship timing: not due", async () => {
      const { delivery } = await setup({ status: "PREORDER" });
      const shopify = fakeShopify();
      expect(
        await createDeliveryOrder(db(), env.DB, shopify.graphql, delivery.id),
      ).toBe("not_due");
      expect(shopify.orders).toHaveLength(0);
    });

    it("pre-order under pre-order timing: created, for a sign-up after the run", async () => {
      const { delivery } = await setup({
        status: "PREORDER",
        orderTiming: "PREORDER_OPENS",
      });
      const shopify = fakeShopify();
      expect(
        await createDeliveryOrder(db(), env.DB, shopify.graphql, delivery.id),
      ).toBe("created");
    });

    it("a cancelled release gets no order", async () => {
      const { delivery } = await setup({ status: "CANCELLED" });
      expect(
        await createDeliveryOrder(db(), env.DB, fakeShopify().graphql, delivery.id),
      ).toBe("not_due");
    });
  });

  it("a cancelled subscription still gets its paid release", async () => {
    const { delivery } = await setup({ subscriptionStatus: "CANCELLED" });
    expect(
      await createDeliveryOrder(db(), env.DB, fakeShopify().graphql, delivery.id),
    ).toBe("created");
  });

  it("an ended or redacted subscription gets none", async () => {
    const { delivery } = await setup({ subscriptionStatus: "ENDED" });
    expect(
      await createDeliveryOrder(db(), env.DB, fakeShopify().graphql, delivery.id),
    ).toBe("skipped");
  });

  describe("orders that can't be created stay visible", () => {
    it("no product: left pending, nothing skipped or counted", async () => {
      const { delivery, subscription, shop, release } = await setup({
        productGid: null,
      });
      const shopify = fakeShopify();
      expect(
        await createDeliveryOrder(db(), env.DB, shopify.graphql, delivery.id),
      ).toBe("no_product");
      expect((await deliveryRow(delivery.id)).status).toBe("PENDING");
      expect(await remaining(subscription.id)).toBe(2);
      expect(
        await listWaitingOrders(db(), shop.orderTiming, [
          { id: release.id, status: "SHIPPED" },
        ]),
      ).toEqual({ [release.id]: { count: 1, error: null } });
    });

    it("choosing a product queues the waiting order under a new job ID", async () => {
      const { delivery, shop, release } = await setup({ productGid: null });
      const sent: any[] = [];
      const jobsEnv = {
        JOBS: { sendBatch: async (messages: any[]) => sent.push(...messages) },
      } as any;
      for (let i = 0; i < 2; i++) {
        expect(
          await setReleaseProduct(
            db(),
            jobsEnv,
            shop,
            release.id,
            "gid://shopify/ProductVariant/9",
            "Zine",
          ),
        ).toBe(true);
      }
      expect(sent).toHaveLength(2);
      expect(sent[0].body.data).toEqual({ deliveryId: delivery.id });
      expect(sent[0].body.id).not.toBe(sent[1].body.id);
    });

    it("refuses a product that isn't a variant, or another shop's release", async () => {
      const { shop, release } = await setup({ productGid: null });
      const other = await setup({ productGid: null });
      const jobsEnv = { JOBS: { sendBatch: async () => {} } } as any;
      expect(
        await setReleaseProduct(db(), jobsEnv, shop, release.id, "gid://shopify/Product/1", "Z"),
      ).toBe(false);
      expect(
        await setReleaseProduct(
          db(),
          jobsEnv,
          other.shop,
          release.id,
          "gid://shopify/ProductVariant/1",
          "Z",
        ),
      ).toBe(false);
    });

    it("the chosen variant was deleted: the reason is kept for the merchant", async () => {
      const { delivery } = await setup();
      const shopify = fakeShopify();
      shopify.state.variantGone = true;
      expect(
        await createDeliveryOrder(db(), env.DB, shopify.graphql, delivery.id),
      ).toBe("refused");
      expect((await deliveryRow(delivery.id)).orderError).toMatch(/no longer exists/);
      expect(shopify.orders).toHaveLength(0);
    });

    it("no address on the contract: the reason is kept for the merchant", async () => {
      const { delivery } = await setup();
      const shopify = fakeShopify();
      shopify.state.address = null;
      expect(
        await createDeliveryOrder(db(), env.DB, shopify.graphql, delivery.id),
      ).toBe("refused");
      const row = await deliveryRow(delivery.id);
      expect(row.orderError).toMatch(/no delivery address/);
      expect(row.orderLeaseUntil).toBeNull();
    });

    it("Shopify limiting orders is retried at once, and isn't shown as a refusal", async () => {
      const { delivery, subscription } = await setup();
      await expect(
        createDeliveryOrder(
          db(),
          env.DB,
          fakeShopify({ errors: ["Too many attempts. Please try again later."] }).graphql,
          delivery.id,
        ),
      ).rejects.toBeInstanceOf(OrderThrottled);
      const row = await deliveryRow(delivery.id);
      expect(row.orderError).toBeNull();
      expect(row.orderLeaseUntil).toBeNull();
      expect(await remaining(subscription.id)).toBe(2);

      const shopify = fakeShopify();
      expect(
        await createDeliveryOrder(db(), env.DB, shopify.graphql, delivery.id),
      ).toBe("created");
    });

    it("Shopify refuses: the reason is kept, and a later success clears it", async () => {
      const { delivery, subscription } = await setup();
      expect(
        await createDeliveryOrder(
          db(),
          env.DB,
          fakeShopify({ errors: ["Variant is gone"] }).graphql,
          delivery.id,
        ),
      ).toBe("refused");
      expect((await deliveryRow(delivery.id)).orderError).toBe("Variant is gone");
      expect(await remaining(subscription.id)).toBe(2);

      await createDeliveryOrder(db(), env.DB, fakeShopify().graphql, delivery.id);
      expect((await deliveryRow(delivery.id)).orderError).toBeNull();
    });
  });
});

import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../app/db.server";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("first D1 migration through Prisma", () => {
  it("applies the JSON and enum defaults the schema promises", async () => {
    const db = createDb(env.DB);
    const shop = await db.shop.create({
      data: { shopDomain: "defaults.myshopify.com" },
    });

    expect(shop.allowedCountries).toEqual(["US"]);
    expect(shop.emailsEnabled).toEqual({});
    expect(shop.orderTiming).toBe("READY_TO_SHIP");
    expect(shop.releaseWordSingular).toBe("issue");
  });

  it("round-trips JSON, enums and dates", async () => {
    const db = createDb(env.DB);
    const shop = await db.shop.create({
      data: {
        shopDomain: "roundtrip.myshopify.com",
        emailsEnabled: { welcome: false },
        orderTiming: "PREORDER_OPENS",
      },
    });
    const cutoffAt = new Date("2027-03-01T12:00:00.000Z");
    await db.release.create({
      data: { shopId: shop.id, number: 1, title: "One", cutoffAt },
    });

    const read = await db.shop.findUniqueOrThrow({
      where: { id: shop.id },
      include: { releases: true },
    });
    expect(read.emailsEnabled).toEqual({ welcome: false });
    expect(read.orderTiming).toBe("PREORDER_OPENS");
    expect(read.releases[0].status).toBe("UNANNOUNCED");
    expect(read.releases[0].cutoffAt).toEqual(cutoffAt);
  });

  it("rejects a repeated billing attempt idempotency key", async () => {
    const db = createDb(env.DB);
    const shop = await db.shop.create({
      data: { shopDomain: "idempotent.myshopify.com" },
    });
    const plan = await db.plan.create({
      data: {
        shopId: shop.id,
        name: "Yearly",
        displayName: "Yearly subscription",
        priceCents: 4000,
      },
    });
    const subscription = await db.subscription.create({
      data: {
        shopId: shop.id,
        planId: plan.id,
        customerGid: "gid://shopify/Customer/1",
        releasesRemaining: 2,
      },
    });
    const attempt = {
      subscriptionId: subscription.id,
      idempotencyKey: `${subscription.id}:release:1`,
      attempt: 1,
    };

    await db.billingAttempt.create({ data: attempt });
    await expect(db.billingAttempt.create({ data: attempt })).rejects.toThrow();
    expect(
      await db.billingAttempt.count({
        where: { subscriptionId: subscription.id },
      }),
    ).toBe(1);
  });
});

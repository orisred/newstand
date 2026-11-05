/* eslint-disable @typescript-eslint/no-explicit-any -- a fake of Shopify's loosely typed responses */
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../app/db.server";
import {
  findOrCreateRecipient,
  GIFT_EMAIL_KEY,
  GIFT_INVALID_EVENT,
  GIFT_MESSAGE_KEY,
  GIFT_NAME_KEY,
  MAX_MESSAGE,
  parseGift,
  publishGiftPlans,
} from "../app/gifts.server";
import { parsePlan } from "../app/plans.server";
import { getOrCreateShop } from "../app/shop.server";
import { syncContract } from "../app/subscriptions.server";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const db = () => createDb(env.DB);
let n = 0;

const attrs = (email?: string, name?: string, message?: string) =>
  [
    [GIFT_EMAIL_KEY, email],
    [GIFT_NAME_KEY, name],
    [GIFT_MESSAGE_KEY, message],
  ].flatMap(([key, value]) => (value === undefined ? [] : [{ key: key!, value: value! }]));

describe("parseGift", () => {
  it("no recipient fields is an ordinary purchase", () => {
    expect(parseGift([])).toEqual({ kind: "none" });
    expect(parseGift([{ key: "Engraving", value: "Hi" }])).toEqual({ kind: "none" });
    expect(parseGift(attrs("  ", "", " "))).toEqual({ kind: "none" });
  });

  it("reads, trims and normalizes a recipient", () => {
    expect(parseGift(attrs(" Ada@Example.COM ", "  Ada   King Lovelace ", "Happy\r\nbirthday\n\n\n\nx"))).toEqual({
      kind: "gift",
      gift: {
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "King Lovelace",
        message: "Happy\nbirthday\n\nx",
      },
    });
    expect(parseGift(attrs("a@b.co"))).toMatchObject({
      kind: "gift",
      gift: { firstName: "", lastName: null, message: null },
    });
  });

  it("a name or message without an email is invalid, because the buyer meant a gift", () => {
    expect(parseGift(attrs(undefined, "Ada"))).toEqual({ kind: "invalid", reason: "no_email" });
    expect(parseGift(attrs("", undefined, "Hi"))).toEqual({ kind: "invalid", reason: "no_email" });
  });

  it("refuses anything that isn't one plain address", () => {
    for (const email of [
      "nope",
      "a@b",
      "a@b.c",
      "two@a.com,three@a.com",
      "two@a.com three@a.com",
      "Ada <ada@a.com>",
      '"ada"@a.com',
      "ada@a.com\nBcc: x@y.com",
      "ada@a.com\u0000",
      "a@@b.com",
      `${"a".repeat(250)}@b.com`,
    ]) {
      expect(parseGift(attrs(email)), email).toEqual({ kind: "invalid", reason: "bad_email" });
    }
  });

  it("cleans a name and bounds a message instead of trusting them", () => {
    const parsed = parseGift(attrs("a@b.co", "<b>Ada</b>‮\n", `${"x".repeat(MAX_MESSAGE + 50)}\u0007`));
    expect(parsed).toMatchObject({ kind: "gift", gift: { firstName: "bAda/b" } });
    if (parsed.kind !== "gift") throw new Error();
    expect(parsed.gift.message).toHaveLength(MAX_MESSAGE);
    expect(parsed.gift.message).not.toContain("\u0007");
    // Markup in a message is kept as text: it's escaped wherever it's shown.
    expect(parseGift(attrs("a@b.co", "", "<script>alert(1)</script>"))).toMatchObject({
      gift: { message: "<script>alert(1)</script>" },
    });
  });
});

// ---- Shopify, as far as a gift needs it ---------------------------------------------------------

/** Customers by email. `raceOn` makes the first search miss and the create lose to a customer that appears meanwhile. */
function fakeShopify(contract: any) {
  const customers = new Map<string, string>();
  const state = { creates: 0, searches: 0, refuse: false, raceOn: false, lastInput: null as any };
  const graphql = async (query: string, variables: any) => {
    if (query.includes("ContractForSync")) return { subscriptionContract: contract };
    if (query.includes("GiftRecipientCreate")) {
      state.creates++;
      state.lastInput = variables.input;
      if (state.refuse) {
        return { customerCreate: { customer: null, userErrors: [{ message: "Email is invalid" }] } };
      }
      if (customers.has(variables.input.email)) {
        return { customerCreate: { customer: null, userErrors: [{ message: "Email has already been taken" }] } };
      }
      const id = `gid://shopify/Customer/g${++n}`;
      customers.set(variables.input.email, id);
      return { customerCreate: { customer: { id }, userErrors: [] } };
    }
    if (query.includes("GiftRecipient")) {
      state.searches++;
      if (state.raceOn && state.searches === 1) {
        customers.set(variables.email, `gid://shopify/Customer/raced${++n}`);
        return { customerByIdentifier: null };
      }
      const id = customers.get(variables.email);
      return { customerByIdentifier: id ? { id } : null };
    }
    throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
  };
  return { graphql, customers, state };
}

const BUYER = "gid://shopify/Customer/1";

async function setup(plan: Record<string, unknown> = {}) {
  const domain = `gift${++n}.myshopify.com`;
  const shop = await getOrCreateShop(db(), domain);
  const sellingPlanGid = `gid://shopify/SellingPlan/${++n}`;
  const row = await db().plan.create({
    data: {
      shopId: shop.id,
      name: "P",
      displayName: "Yearly",
      priceCents: 4000,
      billingMode: "PREPAID_BUNDLE",
      releasesPerTerm: 2,
      termMonths: 12,
      giftable: true,
      sellingPlanGid,
      ...plan,
    },
  });
  return { shop: { ...shop, shopDomain: domain }, plan: row, sellingPlanGid };
}

function contractFor(sellingPlanGid: string, lines: any[] | null, overrides: any = {}) {
  return {
    id: `gid://shopify/SubscriptionContract/${++n}`,
    status: "ACTIVE",
    createdAt: "2026-03-01T10:00:00Z",
    customer: { id: BUYER },
    originOrder: { id: `gid://shopify/Order/${++n}`, name: "#1001" },
    lines: {
      nodes: (lines ?? [attrs("ada@example.com", "Ada Lovelace", "Enjoy!")]).map((customAttributes) => ({
        quantity: 1,
        sellingPlanId: sellingPlanGid,
        currentPrice: { amount: "40.0" },
        customAttributes,
      })),
    },
    ...overrides,
  };
}

const subscriptionOf = (contractGid: string) =>
  db().subscription.findUnique({ where: { contractGid }, include: { deliveries: true } });

const flags = (shopId: string) =>
  db().event.findMany({ where: { shopId, type: GIFT_INVALID_EVENT } });

describe("a gift becomes the recipient's subscription", () => {
  it("belongs to the recipient, not to the contract's customer, the buyer", async () => {
    const { shop, sellingPlanGid } = await setup();
    const read = contractFor(sellingPlanGid, null);
    const shopify = fakeShopify(read);
    const jobs = await syncContract(db(), env.DB, shopify.graphql, shop, read.id);
    const row = (await subscriptionOf(read.id))!;
    const recipient = shopify.customers.get("ada@example.com")!;
    expect(row).toMatchObject({
      source: "GIFT",
      customerGid: recipient,
      giftBuyerGid: BUYER,
      giftMessage: "Enjoy!",
      releasesRemaining: 2,
      status: "ACTIVE",
    });
    expect(row.customerGid).not.toBe(BUYER);
    expect(shopify.state.lastInput).toEqual({ email: "ada@example.com", firstName: "Ada", lastName: "Lovelace" });
    // The email and member tag jobs read state, so they reach the recipient. No charge job exists at all.
    expect(jobs.map((job) => job.type)).toContain("member.tag");
    expect(jobs.map((job) => job.type)).toContain("email.run");
    expect(await flags(shop.id)).toHaveLength(0);
  });

  it("a job that runs twice, or at the same time as another, makes one customer and one subscription", async () => {
    const { shop, sellingPlanGid } = await setup();
    const read = contractFor(sellingPlanGid, null);
    const shopify = fakeShopify(read);
    await syncContract(db(), env.DB, shopify.graphql, shop, read.id);
    await syncContract(db(), env.DB, shopify.graphql, shop, read.id);
    expect(shopify.state.creates).toBe(1);
    expect(await db().subscription.count({ where: { contractGid: read.id } })).toBe(1);

    // Two at once: both search and miss, one create wins, the other's is refused and it searches again.
    const other = contractFor(sellingPlanGid, [attrs("grace@example.com")]);
    const racing = fakeShopify(other);
    racing.state.raceOn = true;
    await syncContract(db(), env.DB, racing.graphql, shop, other.id);
    expect(racing.state.creates).toBe(1);
    expect((await subscriptionOf(other.id))!.customerGid).toMatch(/raced/);
  });

  it("a gift to an existing subscriber is a second subscription for them, and changes nothing about them", async () => {
    const { shop, sellingPlanGid } = await setup();
    const first = contractFor(sellingPlanGid, [attrs("ada@example.com", "Ada")]);
    const shopify = fakeShopify(first);
    // Ada already subscribes for herself, and is a customer Shopify knows.
    const ada = "gid://shopify/Customer/777";
    shopify.customers.set("ada@example.com", ada);
    const own = await db().subscription.create({
      data: {
        shopId: shop.id,
        planId: (await db().plan.findFirstOrThrow({ where: { shopId: shop.id } })).id,
        contractGid: `gid://shopify/SubscriptionContract/${++n}`,
        customerGid: ada,
        releasesRemaining: 2,
      },
    });
    await syncContract(db(), env.DB, shopify.graphql, shop, first.id);
    const gift = (await subscriptionOf(first.id))!;
    expect(gift).toMatchObject({ customerGid: ada, source: "GIFT" });
    expect(gift.id).not.toBe(own.id);
    expect(await db().subscription.count({ where: { shopId: shop.id, customerGid: ada } })).toBe(2);
    // Found, never created or rewritten with a name a stranger typed.
    expect(shopify.state.creates).toBe(0);
  });

  it("is a gift only on a giftable prepaid bundle; elsewhere the details are ignored and it's the buyer's own", async () => {
    for (const plan of [{ giftable: false }, { billingMode: "PER_RELEASE", releasesPerTerm: 1, termMonths: null }]) {
      const { shop, sellingPlanGid } = await setup(plan);
      const read = contractFor(sellingPlanGid, null);
      const shopify = fakeShopify(read);
      await syncContract(db(), env.DB, shopify.graphql, shop, read.id);
      expect(await subscriptionOf(read.id)).toMatchObject({ source: "NEW", customerGid: BUYER, giftBuyerGid: null });
      expect(shopify.state.creates + shopify.state.searches).toBe(0);
    }
  });

  it("an ordinary purchase of a giftable plan stays the buyer's", async () => {
    const { shop, sellingPlanGid } = await setup();
    const read = contractFor(sellingPlanGid, [[]]);
    const shopify = fakeShopify(read);
    await syncContract(db(), env.DB, shopify.graphql, shop, read.id);
    expect(await subscriptionOf(read.id)).toMatchObject({ source: "NEW", customerGid: BUYER });
  });

  it("a later update of the contract doesn't touch the recipient or look them up again", async () => {
    const { shop, sellingPlanGid } = await setup();
    const read = contractFor(sellingPlanGid, null);
    const shopify = fakeShopify(read);
    await syncContract(db(), env.DB, shopify.graphql, shop, read.id);
    const searches = shopify.state.searches;
    read.status = "CANCELLED";
    await syncContract(db(), env.DB, shopify.graphql, shop, read.id);
    expect(shopify.state.searches).toBe(searches);
    expect(await subscriptionOf(read.id)).toMatchObject({ source: "GIFT", status: "CANCELLED" });
  });
});

describe("a gift that can't be delivered fails visibly", () => {
  const cases: [string, any[], string][] = [
    ["a message but no email", [attrs(undefined, "Ada", "Hi")], "no_email"],
    ["an email that isn't one", [attrs("ada at example")], "bad_email"],
    ["two recipients on one contract", [attrs("a@example.com"), attrs("b@example.com")], "several_lines"],
    ["a gift next to a line for the buyer", [attrs("a@example.com"), []], "several_lines"],
  ];
  for (const [name, lines, reason] of cases) {
    it(`${name}: no subscription, nothing queued, the order flagged for the merchant`, async () => {
      const { shop, sellingPlanGid } = await setup();
      const read = contractFor(sellingPlanGid, lines);
      const shopify = fakeShopify(read);
      expect(await syncContract(db(), env.DB, shopify.graphql, shop, read.id)).toEqual([]);
      expect(await subscriptionOf(read.id)).toBeNull();
      expect(shopify.state.creates).toBe(0);
      const [flag] = await flags(shop.id);
      expect(flag.payload).toEqual({
        contractGid: read.id,
        orderGid: read.originOrder.id,
        orderName: "#1001",
        reason,
      });
      // The flag names the order, never the recipient.
      expect(JSON.stringify(flag.payload)).not.toMatch(/example|Ada/);
      // A repeat adds nothing.
      await syncContract(db(), env.DB, shopify.graphql, shop, read.id);
      expect(await flags(shop.id)).toHaveLength(1);
    });
  }

  it("an address Shopify won't take: flagged, and no subscription for the buyer", async () => {
    const { shop, sellingPlanGid } = await setup();
    const read = contractFor(sellingPlanGid, null);
    const shopify = fakeShopify(read);
    shopify.state.refuse = true;
    expect(await syncContract(db(), env.DB, shopify.graphql, shop, read.id)).toEqual([]);
    expect(await subscriptionOf(read.id)).toBeNull();
    expect((await flags(shop.id))[0].payload).toMatchObject({ reason: "recipient_refused" });
  });
});

describe("findOrCreateRecipient", () => {
  it("finds before it creates, and lets a lost race find the winner", async () => {
    const shopify = fakeShopify({});
    const gift = { email: "x@example.com", firstName: "X", lastName: null, message: null };
    const a = await findOrCreateRecipient(shopify.graphql, gift);
    const b = await findOrCreateRecipient(shopify.graphql, gift);
    expect(a).toBe(b);
    expect(shopify.state.creates).toBe(1);
    expect(shopify.state.lastInput).toEqual({ email: "x@example.com", firstName: "X" });
  });
});

describe("telling the plan picker which plans take a gift", () => {
  it("lists only active, synced, giftable bundles, and nothing as an empty list", async () => {
    const { shop, plan } = await setup({ sellingPlanGid: "gid://shopify/SellingPlan/111" });
    const mk = (fields: Record<string, unknown>) =>
      db().plan.create({
        data: { shopId: shop.id, name: "Q", displayName: "Q", priceCents: 1, ...fields },
      });
    await mk({ giftable: true, sellingPlanGid: "gid://shopify/SellingPlan/222" });
    await mk({ giftable: false, sellingPlanGid: "gid://shopify/SellingPlan/333" });
    await mk({ giftable: true, active: false, sellingPlanGid: "gid://shopify/SellingPlan/444" });
    await mk({ giftable: true, billingMode: "PER_RELEASE", sellingPlanGid: "gid://shopify/SellingPlan/555" });
    await mk({ giftable: true });
    const calls: any[] = [];
    const graphql = async (query: string, variables: any) => {
      calls.push(variables);
      return query.includes("GiftAppInstallation")
        ? { currentAppInstallation: { id: "gid://shopify/AppInstallation/1" } }
        : { metafieldsSet: { userErrors: [] } };
    };
    await publishGiftPlans(db(), graphql as any, shop.id);
    const [field] = calls[1].metafields;
    expect(field).toMatchObject({
      ownerId: "gid://shopify/AppInstallation/1",
      namespace: "release_subscriptions",
      key: "giftable_plans",
    });
    expect(field.value.split(",").filter(Boolean).sort()).toEqual(["111", "222"]);
    expect(field.value).toMatch(/^,.*,$/);

    await db().plan.updateMany({ where: { shopId: shop.id }, data: { giftable: false } });
    await publishGiftPlans(db(), graphql as any, shop.id);
    expect(calls[3].metafields[0].value).toBe(",,");
    expect(plan.id).toBeTruthy();
  });

  it("a failure never throws into the sync", async () => {
    const { shop } = await setup();
    await expect(
      publishGiftPlans(db(), (async () => { throw new Error("down"); }) as any, shop.id),
    ).resolves.toBeUndefined();
  });
});

describe("the plan form", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries({
      name: "P",
      displayName: "P",
      billingMode: "PREPAID_BUNDLE",
      releasesPerTerm: "2",
      termMonths: "12",
      renewalRule: "TERM_DATE_HOLD_IF_LATE",
      startRule: "PREORDER_SWITCHOVER",
      price: "40",
      productGid: "gid://shopify/Product/1",
      productTitle: "Z",
      giftable: "on",
      ...fields,
    })) {
      data.set(key, value);
    }
    return data;
  };

  it("allows a gift on a prepaid bundle and refuses it on a per-release plan, saying why", () => {
    expect(parsePlan(form({}))).toMatchObject({ ok: true, values: { giftable: true } });
    const refused = parsePlan(form({ billingMode: "PER_RELEASE" }));
    expect(refused).toMatchObject({ ok: false });
    expect((refused as any).errors.giftable).toMatch(/prepaid bundle/);
    const off = form({ billingMode: "PER_RELEASE" });
    off.delete("giftable");
    expect(parsePlan(off).ok).toBe(true);
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any -- fakes of Shopify's loosely typed responses */
import { applyD1Migrations, env } from "cloudflare:test";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { beforeAll, describe, expect, it } from "vitest";
import {
  cardUpdatedJob,
  resumeAfterCardUpdate,
  retryCharge,
} from "../app/billing.server";
import { createDb } from "../app/db.server";
import { signLinkToken } from "../app/email-link.server";
import type { Job } from "../app/jobs/runner.server";
import {
  cancelSubscription,
  changeAddress,
  cleanAddress,
  confirmAddress,
  loadPortal,
  ownSubscription,
  PortalError,
  portalCopy,
  sendCardUpdateEmail,
  upcomingFor,
} from "../app/portal.server";
import { createDueDeliveries } from "../app/release-runs.server";
import {
  action as portalAction,
  loader as portalLoader,
} from "../app/routes/api.portal";
import {
  action as linkAction,
  loader as linkLoader,
} from "../app/routes/l.$token";
import { action as cardWebhook } from "../app/routes/webhooks.customer_payment_methods";
import { getOrCreateShop } from "../app/shop.server";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const db = () => createDb(env.DB);
let n = 0;
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

async function setup(shopData: Record<string, unknown> = {}) {
  const domain = `portal${++n}.myshopify.com`;
  const shop = await getOrCreateShop(db(), domain);
  await db().shop.update({ where: { id: shop.id }, data: shopData });
  const plan = await db().plan.create({
    data: {
      shopId: shop.id,
      name: "Yearly",
      displayName: "Yearly subscription",
      priceCents: 4000,
      billingMode: "PREPAID_BUNDLE",
      releasesPerTerm: 2,
      termMonths: 12,
    },
  });
  return { shop, domain, plan };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const customer = () => `gid://shopify/Customer/${++n}`;

async function subscribe(s: Setup, data: Record<string, unknown> = {}) {
  return db().subscription.create({
    data: {
      shopId: s.shop.id,
      planId: s.plan.id,
      contractGid: `gid://shopify/SubscriptionContract/${++n}`,
      customerGid: customer(),
      releasesRemaining: 1,
      lockedPriceCents: 4000,
      createdAt: ago(100),
      ...data,
    },
  });
}

const release = (s: Setup, status: any, data: Record<string, unknown> = {}) => {
  const number = ++n;
  return db().release.create({
    data: {
      shopId: s.shop.id,
      number,
      title: `Zine ${number}`,
      status,
      ...data,
    },
  });
};

/** Records every Shopify call, answering mutations with success. */
function shopify(overrides: Record<string, any> = {}) {
  const calls: { query: string; variables: any }[] = [];
  const graphql = async (query: string, variables: any) => {
    calls.push({ query, variables });
    for (const [name, value] of Object.entries(overrides)) {
      if (query.includes(name)) return value;
    }
    if (query.includes("subscriptionContractUpdate")) {
      return {
        subscriptionContractUpdate: {
          draft: { id: "draft-1" },
          userErrors: [],
        },
      };
    }
    if (query.includes("subscriptionDraftUpdate")) {
      return { subscriptionDraftUpdate: { userErrors: [] } };
    }
    if (query.includes("subscriptionDraftCommit")) {
      return {
        subscriptionDraftCommit: { contract: { id: "c" }, userErrors: [] },
      };
    }
    if (query.includes("subscriptionContractCancel")) {
      return {
        subscriptionContractCancel: {
          contract: { id: "c", status: "CANCELLED" },
          userErrors: [],
        },
      };
    }
    if (query.includes("PortalPaymentMethod")) {
      return {
        subscriptionContract: {
          customerPaymentMethod: {
            id: "gid://shopify/CustomerPaymentMethod/1",
          },
        },
      };
    }
    if (query.includes("customerPaymentMethodSendUpdateEmail")) {
      return { customerPaymentMethodSendUpdateEmail: { userErrors: [] } };
    }
    throw new Error(`unexpected query ${query.slice(0, 60)}`);
  };
  return { graphql, calls };
}

const own = async (
  s: Setup,
  subscription: { id: string; customerGid: string },
) =>
  (await ownSubscription(
    db(),
    s.domain,
    subscription.customerGid,
    subscription.id,
  ))!;

// ---- whose subscription it is --------------------------------------------------------------

describe("ownership", () => {
  it("a subscription is found only for its own customer in its own shop", async () => {
    const s = await setup();
    const other = await setup();
    const sub = await subscribe(s);
    expect(
      await ownSubscription(db(), s.domain, sub.customerGid, sub.id),
    ).not.toBeNull();
    // Another customer, another shop, and junk in place of a customer.
    expect(
      await ownSubscription(db(), s.domain, customer(), sub.id),
    ).toBeNull();
    expect(
      await ownSubscription(db(), other.domain, sub.customerGid, sub.id),
    ).toBeNull();
    expect(await ownSubscription(db(), s.domain, "", sub.id)).toBeNull();
    expect(
      await ownSubscription(db(), s.domain, "redacted", sub.id),
    ).toBeNull();
  });

  it("an ended subscription is not reachable", async () => {
    const s = await setup();
    const sub = await subscribe(s, { status: "ENDED" });
    expect(
      await ownSubscription(db(), s.domain, sub.customerGid, sub.id),
    ).toBeNull();
  });
});

// ---- the extension's API ---------------------------------------------------------------------

async function token(sub: string, dest: string) {
  const b64 = (o: object) =>
    btoa(JSON.stringify(o))
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({
    iss: `https://${dest}/admin`,
    dest,
    aud: "x",
    sub,
    exp: now + 60,
    nbf: now - 5,
    iat: now,
    jti: `j${++n}`,
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SHOPIFY_API_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${head}.${body}`),
    ),
  );
  return `${head}.${body}.${btoa(String.fromCharCode(...sig))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")}`;
}

async function callPortal(
  shopDomain: string,
  customerGid: string,
  body: object,
) {
  const sent: Job[] = [];
  const response = await portalAction({
    request: new Request("https://app.example.com/api/portal", {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "User-Agent": "Mozilla/5.0 Chrome/130",
        "Content-Type": "application/json",
        Authorization: `Bearer ${await token(customerGid, shopDomain)}`,
      },
    }),
    context: {
      cloudflare: {
        env: {
          ...env,
          JOBS: {
            sendBatch: async (m: { body: Job }[]) =>
              void sent.push(...m.map((x) => x.body)),
          },
        },
      },
    },
  } as unknown as ActionFunctionArgs);
  return {
    status: response.status,
    headers: response.headers,
    json: (await response.json()) as any,
    sent,
  };
}

describe("the extension's API", () => {
  it("refuses a request with no token, or one that isn't signed by Shopify", async () => {
    const s = await setup();
    const sub = await subscribe(s);
    for (const headers of [{}, { Authorization: "Bearer junk" }] as Record<
      string,
      string
    >[]) {
      const result = await portalAction({
        request: new Request("https://app.example.com/api/portal", {
          method: "POST",
          body: JSON.stringify({ intent: "cancel", subscriptionId: sub.id }),
          headers: { "User-Agent": "Mozilla/5.0 Chrome/130", ...headers },
        }),
        context: { cloudflare: { env } },
      } as unknown as ActionFunctionArgs).then(
        (r) => r.status,
        (r) => (r as Response).status,
      );
      expect(result).toBe(401);
    }
    expect(
      (await db().subscription.findUniqueOrThrow({ where: { id: sub.id } }))
        .status,
    ).toBe("ACTIVE");
  });

  it("another customer, or the same customer in another shop, gets a 404 and changes nothing", async () => {
    const s = await setup();
    const other = await setup();
    const sub = await subscribe(s);
    for (const intent of ["cancel", "address", "card", "resume", "confirm"]) {
      const stranger = await callPortal(s.domain, customer(), {
        intent,
        subscriptionId: sub.id,
      });
      expect(stranger.status, intent).toBe(404);
      const wrongShop = await callPortal(other.domain, sub.customerGid, {
        intent,
        subscriptionId: sub.id,
      });
      expect(wrongShop.status, intent).toBe(404);
      expect(stranger.sent).toEqual([]);
    }
    expect(
      (await db().subscription.findUniqueOrThrow({ where: { id: sub.id } }))
        .status,
    ).toBe("ACTIVE");
  });

  it("takes the customer from the token, never the body", async () => {
    const s = await setup();
    const sub = await subscribe(s);
    const result = await callPortal(s.domain, customer(), {
      intent: "resume",
      subscriptionId: sub.id,
      customerGid: sub.customerGid,
      customer: sub.customerGid,
    });
    expect(result.status).toBe(404);
  });

  it("a customer's card update retries a failed payment, as the customer and not the merchant", async () => {
    const s = await setup();
    const sub = await subscribe(s);
    const result = await callPortal(s.domain, sub.customerGid, {
      intent: "resume",
      subscriptionId: sub.id,
    });
    expect(result.status).toBe(200);
    expect(result.sent).toHaveLength(1);
    // The page says only what's true whether or not a try follows.
    expect(result.json.message).toBe(
      portalCopy({ singular: "issue", plural: "issues" }).resumeAsked,
    );
    expect(result.json.message).not.toMatch(/trying your payment/i);
    expect(result.sent[0]).toMatchObject({
      type: "billing.resume",
      shop: s.domain,
      data: { subscriptionId: sub.id, byMerchant: false },
    });
  });

  it("a read with the wrong customer lists nothing", async () => {
    const s = await setup();
    await subscribe(s);
    const response = await portalLoader({
      request: new Request("https://app.example.com/api/portal", {
        headers: {
          "User-Agent": "Mozilla/5.0 Chrome/130",
          Authorization: `Bearer ${await token(customer(), s.domain)}`,
        },
      }),
      context: { cloudflare: { env } },
    } as unknown as LoaderFunctionArgs);
    // Nothing is theirs, so Shopify (which the test has no session for) isn't even asked.
    expect(((await response.json()) as any).subscriptions).toEqual([]);
  });
});

// ---- address confirmation ------------------------------------------------------------------

describe("confirming an address", () => {
  it("before the Delivery exists it's kept on the email's row and carried into the Delivery, with the first time kept", async () => {
    const s = await setup();
    const sub = await subscribe(s);
    const rel = await release(s, "PREORDER");
    await db().emailSend.create({
      data: {
        id: `preorderAnnounced:${sub.id}:${rel.id}`,
        shopId: s.shop.id,
        subscriptionId: sub.id,
        kind: "preorderAnnounced",
        subject: rel.id,
        status: "SENT",
      },
    });
    const owned = await own(s, sub);
    expect(await confirmAddress(db(), env.DB, owned, rel.id, ago(0.02))).toBe(
      true,
    );
    expect(
      await db().delivery.count({ where: { subscriptionId: sub.id } }),
    ).toBe(0);

    await db().release.update({
      where: { id: rel.id },
      data: { status: "READY" },
    });
    await createDueDeliveries(env.DB, s.shop.id, rel.id, NOW);
    const delivery = await db().delivery.findFirstOrThrow({
      where: { subscriptionId: sub.id },
    });
    expect(delivery.addressConfirmedAt?.getTime()).toBe(ago(0.02).getTime());

    // Confirming again, now with a Delivery in hand, keeps the first time.
    expect(await confirmAddress(db(), env.DB, owned, rel.id, NOW)).toBe(true);
    expect(
      (
        await db().delivery.findUniqueOrThrow({ where: { id: delivery.id } })
      ).addressConfirmedAt?.getTime(),
    ).toBe(ago(0.02).getTime());
  });

  it("after the Delivery exists it's recorded on the Delivery", async () => {
    const s = await setup();
    const sub = await subscribe(s);
    const rel = await release(s, "PREORDER");
    const delivery = await db().delivery.create({
      data: { subscriptionId: sub.id, releaseId: rel.id },
    });
    expect(
      await confirmAddress(db(), env.DB, await own(s, sub), rel.id, ago(0.01)),
    ).toBe(true);
    expect(
      (
        await db().delivery.findUniqueOrThrow({ where: { id: delivery.id } })
      ).addressConfirmedAt?.getTime(),
    ).toBe(ago(0.01).getTime());
  });

  it("means nothing once the order exists, for a release the subscriber has no part in, or one that isn't theirs", async () => {
    const s = await setup();
    const sub = await subscribe(s);
    const ordered = await release(s, "READY");
    await db().delivery.create({
      data: {
        subscriptionId: sub.id,
        releaseId: ordered.id,
        status: "ORDERED",
        orderGid: `gid://shopify/Order/${++n}`,
      },
    });
    const noPart = await release(s, "PREORDER");
    const unannounced = await release(s, "UNANNOUNCED");
    const owned = await own(s, sub);
    for (const id of [ordered.id, noPart.id, unannounced.id, "unknown"]) {
      expect(await confirmAddress(db(), env.DB, owned, id)).toBe(false);
    }
    // Another shop's release can't be confirmed through this subscription.
    const other = await setup();
    const foreign = await release(other, "PREORDER");
    await db().delivery.create({
      data: { subscriptionId: sub.id, releaseId: foreign.id },
    });
    expect(await confirmAddress(db(), env.DB, owned, foreign.id)).toBe(false);
    expect(
      (
        await db().delivery.findMany({
          where: { subscriptionId: sub.id, addressConfirmedAt: { not: null } },
        })
      ).length,
    ).toBe(0);
  });

  it("lists the releases a subscriber will get, as many as they've paid for, with their state", async () => {
    const s = await setup();
    const sub = await subscribe(s, { firstReleaseNumber: 1 });
    const mine = await release(s, "READY");
    const next = await release(s, "PREORDER");
    await release(s, "UNANNOUNCED"); // beyond the one release they have paid for
    await db().delivery.create({
      data: { subscriptionId: sub.id, releaseId: mine.id, status: "HELD" },
    });
    const upcoming = await upcomingFor(db(), env.DB, await own(s, sub));
    expect(upcoming.map((r) => [r.id, r.state])).toEqual([
      [mine.id, "On hold until your payment goes through"],
      [next.id, "In pre-order"],
    ]);
  });

  it("shows a subscriber who signed up during a pre-order that release, with a button that works", async () => {
    // Sign-up gives them the pre-order release's Delivery at once, and no pre-order email.
    const s = await setup();
    const sub = await subscribe(s, {
      createdAt: ago(0.01),
      firstReleaseNumber: 1,
    });
    const rel = await release(s, "PREORDER");
    const delivery = await db().delivery.create({
      data: { subscriptionId: sub.id, releaseId: rel.id },
    });
    const owned = await own(s, sub);
    const [shown] = await upcomingFor(db(), env.DB, owned);
    expect(shown).toMatchObject({
      id: rel.id,
      state: "In pre-order",
      confirmable: true,
      confirmed: false,
      ordered: false,
    });
    expect(await confirmAddress(db(), env.DB, owned, rel.id, NOW)).toBe(true);
    expect(
      (await db().delivery.findUniqueOrThrow({ where: { id: delivery.id } }))
        .addressConfirmedAt,
    ).not.toBeNull();

    // Their link page doesn't say the order exists, because it doesn't.
    const link = await signLinkToken(env, {
      k: "address",
      s: sub.id,
      r: rel.id,
    });
    const page: any = await linkLoader({
      params: { token: link },
      context: { cloudflare: { env } },
    } as unknown as LoaderFunctionArgs);
    expect(page).toMatchObject({ confirmable: true, confirmed: true });
  });

  it("a due subscriber with no email row and no Delivery yet sees the release but can't confirm what there's nowhere to keep", async () => {
    const s = await setup();
    const sub = await subscribe(s, { firstReleaseNumber: 1 });
    const rel = await release(s, "PREORDER");
    const [shown] = await upcomingFor(db(), env.DB, await own(s, sub));
    expect(shown).toMatchObject({
      id: rel.id,
      confirmable: false,
      ordered: false,
    });
    expect(await confirmAddress(db(), env.DB, await own(s, sub), rel.id)).toBe(
      false,
    );
  });

  it("a cancelled subscriber sees only what they paid for, and can confirm only that", async () => {
    const s = await setup();
    const sub = await subscribe(s, {
      firstReleaseNumber: 1,
      status: "CANCELLED",
      releasesRemaining: 1,
    });
    const paid = await release(s, "PREORDER");
    const extra = await release(s, "PREORDER");
    await release(s, "UNANNOUNCED");
    for (const rel of [paid, extra]) {
      await db().emailSend.create({
        data: {
          id: `preorderAnnounced:${sub.id}:${rel.id}`,
          shopId: s.shop.id,
          subscriptionId: sub.id,
          kind: "preorderAnnounced",
          subject: rel.id,
          status: "SENT",
        },
      });
    }
    const owned = await own(s, sub);
    const shown = await upcomingFor(db(), env.DB, owned);
    expect(shown.map((r) => r.id)).toEqual([paid.id]);
    expect(await confirmAddress(db(), env.DB, owned, extra.id)).toBe(false);
    expect(await confirmAddress(db(), env.DB, owned, paid.id)).toBe(true);

    // With nothing paid for, nothing is listed at all.
    const none = await subscribe(s, {
      firstReleaseNumber: 1,
      status: "CANCELLED",
      releasesRemaining: 0,
    });
    expect(await upcomingFor(db(), env.DB, await own(s, none))).toEqual([]);
  });

  it("a cancelled subscriber with their paid release already waiting sees no spare one", async () => {
    // A hold makes every release due, so only the spare count keeps the list to what was paid for.
    const s = await setup();
    const sub = await subscribe(s, {
      firstReleaseNumber: 1,
      status: "CANCELLED",
      pausedReason: "CHARGEBACK",
      releasesRemaining: 1,
    });
    const paid = await release(s, "PREORDER");
    await release(s, "PREORDER"); // beyond what they paid for
    await db().delivery.create({
      data: { subscriptionId: sub.id, releaseId: paid.id, status: "PENDING" },
    });
    const shown = await upcomingFor(db(), env.DB, await own(s, sub));
    expect(shown.map((r) => r.id)).toEqual([paid.id]);
  });

  it("a cancelled subscriber's link page says it can't be confirmed, not that the order exists", async () => {
    const s = await setup();
    const sub = await subscribe(s, {
      firstReleaseNumber: 1,
      status: "CANCELLED",
      releasesRemaining: 0,
    });
    const rel = await release(s, "PREORDER");
    const link = await signLinkToken(env, {
      k: "address",
      s: sub.id,
      r: rel.id,
    });
    const page: any = await linkLoader({
      params: { token: link },
      context: { cloudflare: { env } },
    } as unknown as LoaderFunctionArgs);
    expect(page.confirmable).toBe(false);
    expect(page.notice).toBe(
      portalCopy({ singular: "issue", plural: "issues" }).closed,
    );
  });
});

describe("the email link page", () => {
  const callLoader = async (token: string) =>
    linkLoader({
      params: { token },
      context: { cloudflare: { env } },
    } as unknown as LoaderFunctionArgs);
  const callAction = async (token: string) =>
    linkAction({
      params: { token },
      context: { cloudflare: { env } },
      request: new Request("https://app.example.com/l/x", { method: "POST" }),
    } as unknown as ActionFunctionArgs);

  async function preorder(s: Setup) {
    const sub = await subscribe(s);
    const rel = await release(s, "PREORDER");
    await db().emailSend.create({
      data: {
        id: `preorderAnnounced:${sub.id}:${rel.id}`,
        shopId: s.shop.id,
        subscriptionId: sub.id,
        kind: "preorderAnnounced",
        subject: rel.id,
        status: "SENT",
      },
    });
    return { sub, rel, rowId: `preorderAnnounced:${sub.id}:${rel.id}` };
  }

  it("opening the link, as a mail scanner does, records nothing and shows nothing personal", async () => {
    const s = await setup();
    const { sub, rel, rowId } = await preorder(s);
    const link = await signLinkToken(env, {
      k: "address",
      s: sub.id,
      r: rel.id,
    });
    const page: any = await callLoader(link);
    expect(page).toMatchObject({
      kind: "address",
      title: rel.title,
      confirmable: true,
      confirmed: false,
    });
    expect(JSON.stringify(page)).not.toContain(sub.customerGid);
    expect(
      (await db().emailSend.findUniqueOrThrow({ where: { id: rowId } }))
        .addressConfirmedAt,
    ).toBeNull();
  });

  it("an explicit confirm records the address for an address link, and only that", async () => {
    const s = await setup();
    const { sub, rel, rowId } = await preorder(s);
    const link = await signLinkToken(env, {
      k: "address",
      s: sub.id,
      r: rel.id,
    });
    expect(await callAction(link)).toEqual({ done: true });
    expect(
      (await db().emailSend.findUniqueOrThrow({ where: { id: rowId } }))
        .addressConfirmedAt,
    ).not.toBeNull();
    // Nothing else moved: the subscription is as it was.
    expect(
      (await db().subscription.findUniqueOrThrow({ where: { id: sub.id } }))
        .status,
    ).toBe("ACTIVE");
  });

  it("a card link, a forged link and an expired link confirm nothing", async () => {
    const s = await setup();
    const { sub, rel, rowId } = await preorder(s);
    const card = await signLinkToken(env, { k: "card", s: sub.id, r: rel.id });
    const old = await signLinkToken(
      env,
      { k: "address", s: sub.id, r: rel.id },
      ago(40),
    );
    for (const link of [card, old, `${card.split(".")[0]}.AAAA`, "junk"]) {
      expect(await callAction(link)).toEqual({ done: false });
    }
    expect(
      (await db().emailSend.findUniqueOrThrow({ where: { id: rowId } }))
        .addressConfirmedAt,
    ).toBeNull();
    expect(((await callLoader(old)) as any).kind).toBeNull();
  });

  it("a link for an ended or redacted subscription is dead, and a card link offers sign-in only", async () => {
    const s = await setup();
    const { sub, rel } = await preorder(s);
    const card: any = await callLoader(
      await signLinkToken(env, { k: "card", s: sub.id }),
    );
    expect(card).toMatchObject({ kind: "card" });
    expect(card.portal).toMatch(
      /^https:\/\/(shopify\.com\/\d+\/account|portal\d+\.myshopify\.com\/account)/,
    );
    await db().subscription.update({
      where: { id: sub.id },
      data: { status: "ENDED" },
    });
    expect(
      (
        (await callLoader(
          await signLinkToken(env, { k: "address", s: sub.id, r: rel.id }),
        )) as any
      ).kind,
    ).toBeNull();
    expect(
      await callAction(
        await signLinkToken(env, { k: "address", s: sub.id, r: rel.id }),
      ),
    ).toEqual({ done: false });
  });
});

// ---- address -----------------------------------------------------------------------------

describe("changing the address", () => {
  const good = {
    firstName: " Ada ",
    lastName: "L",
    address1: "1 Main St",
    city: "New York",
    provinceCode: "NY",
    zip: "10001",
    countryCode: "us",
  };

  it("cleans what was typed and checks the country against the shop's list", () => {
    expect(cleanAddress(good, ["US"])).toMatchObject({
      firstName: "Ada",
      countryCode: "US",
    });
    expect(() => cleanAddress({ ...good, countryCode: "FR" }, ["US"])).toThrow(
      PortalError,
    );
    expect(() => cleanAddress({ ...good, city: "  " }, ["US"])).toThrow(
      "fill in every required field",
    );
    expect(() => cleanAddress(null, ["US"])).toThrow(PortalError);
    expect(
      cleanAddress({ ...good, address1: "x".repeat(900), hack: "yes" }, ["US"])
        .address1,
    ).toHaveLength(255);
    expect(cleanAddress({ ...good, hack: "yes" }, ["US"])).not.toHaveProperty(
      "hack",
    );
  });

  it("writes the address through a contract draft, and counts as confirming what's waiting", async () => {
    const s = await setup();
    const sub = await subscribe(s);
    const rel = await release(s, "PREORDER");
    const delivery = await db().delivery.create({
      data: { subscriptionId: sub.id, releaseId: rel.id },
    });
    const fake = shopify();
    await changeAddress(
      db(),
      env.DB,
      fake.graphql,
      await own(s, sub),
      good,
      NOW,
    );
    expect(fake.calls.map((c) => c.query.match(/mutation (\w+)/)![1])).toEqual([
      "PortalDraftOpen",
      "PortalDraftAddress",
      "PortalDraftCommit",
    ]);
    expect(
      fake.calls[1].variables.input.deliveryMethod.shipping.address,
    ).toMatchObject({ address1: "1 Main St", countryCode: "US" });
    expect(
      (await db().delivery.findUniqueOrThrow({ where: { id: delivery.id } }))
        .addressConfirmedAt,
    ).not.toBeNull();
    // The merchant's dashboard shows who changed an address.
    expect(
      await db().event.count({
        where: { subscriptionId: sub.id, type: "portal.address_changed" },
      }),
    ).toBe(1);
  });

  it("changes nothing for a country the shop doesn't ship to, or a cancelled subscription", async () => {
    const s = await setup();
    const sub = await subscribe(s);
    const fake = shopify();
    await expect(
      changeAddress(db(), env.DB, fake.graphql, await own(s, sub), {
        ...good,
        countryCode: "CA",
      }),
    ).rejects.toThrow(PortalError);
    expect(
      await db().event.count({
        where: { subscriptionId: sub.id, type: "portal.address_changed" },
      }),
    ).toBe(0);
    const cancelled = await subscribe(s, { status: "CANCELLED" });
    await expect(
      changeAddress(db(), env.DB, fake.graphql, await own(s, cancelled), good),
    ).rejects.toThrow("cancelled");
    expect(fake.calls).toEqual([]);
  });

  it("does not confirm when Shopify refuses the address", async () => {
    const s = await setup();
    const sub = await subscribe(s);
    const rel = await release(s, "PREORDER");
    await db().delivery.create({
      data: { subscriptionId: sub.id, releaseId: rel.id },
    });
    const fake = shopify({
      subscriptionDraftUpdate: {
        subscriptionDraftUpdate: { userErrors: [{ message: "Invalid zip" }] },
      },
    });
    await expect(
      changeAddress(db(), env.DB, fake.graphql, await own(s, sub), good),
    ).rejects.toThrow("Invalid zip");
    expect(
      (
        await db().delivery.findFirstOrThrow({
          where: { subscriptionId: sub.id },
        })
      ).addressConfirmedAt,
    ).toBeNull();
  });
});

// ---- card ----------------------------------------------------------------------------------

describe("the card", () => {
  it("has Shopify email the customer a secure link, and sends no card data through the app", async () => {
    const s = await setup();
    const sub = await subscribe(s);
    const fake = shopify();
    await sendCardUpdateEmail(fake.graphql, await own(s, sub));
    expect(fake.calls.map((c) => c.variables)).toEqual([
      { id: sub.contractGid },
      { id: "gid://shopify/CustomerPaymentMethod/1" },
    ]);
  });

  it("a contract with no card says so", async () => {
    const s = await setup();
    const sub = await subscribe(s);
    const fake = shopify({
      PortalPaymentMethod: {
        subscriptionContract: { customerPaymentMethod: null },
      },
    });
    await expect(
      sendCardUpdateEmail(fake.graphql, await own(s, sub)),
    ).rejects.toThrow("no card");
  });

  it("a saved card recovers a customer's failed payment but never ends a chargeback", async () => {
    const s = await setup();
    const failing = await subscribe(s, {
      status: "PAUSED",
      pausedReason: "FAILED_PAYMENT",
      paymentProblemSince: ago(1),
    });
    const retrying = await subscribe(s, {
      customerGid: failing.customerGid,
      paymentProblemSince: ago(1),
    });
    const dispute = await subscribe(s, {
      customerGid: failing.customerGid,
      status: "PAUSED",
      pausedReason: "CHARGEBACK",
      paymentProblemSince: ago(1),
    });
    const fine = await subscribe(s, { customerGid: failing.customerGid });
    const elsewhere = await setup();
    const other = await subscribe(elsewhere, {
      customerGid: failing.customerGid,
      paymentProblemSince: ago(1),
    });
    const jobs = await resumeAfterCardUpdate(
      db(),
      s.domain,
      failing.customerGid,
      "hook-1",
    );
    expect(jobs.map((j) => j.data?.subscriptionId).sort()).toEqual(
      [failing.id, retrying.id].sort(),
    );
    expect(jobs.every((j) => j.data?.byMerchant === false)).toBe(true);
    expect(jobs.map((j) => j.data?.subscriptionId)).not.toContain(dispute.id);
    expect(jobs.map((j) => j.data?.subscriptionId)).not.toContain(fine.id);
    expect(jobs.map((j) => j.data?.subscriptionId)).not.toContain(other.id);

    // Even asked directly, as the customer, a chargeback stays.
    const fake = shopify();
    expect(
      await retryCharge(db(), env.DB, fake.graphql, dispute.id, false, NOW),
    ).toEqual([]);
    const held = await db().subscription.findUniqueOrThrow({
      where: { id: dispute.id },
    });
    expect([held.status, held.pausedReason]).toEqual(["PAUSED", "CHARGEBACK"]);
    expect(fake.calls).toEqual([]);
  });

  it("the card webhook becomes one job for the customer, keyed on the webhook", async () => {
    const sent: Job[] = [];
    const body = JSON.stringify({ customer_id: 77 });
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.SHOPIFY_API_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
    );
    const response = await cardWebhook({
      request: new Request(
        "https://app.example.com/webhooks/customer_payment_methods",
        {
          method: "POST",
          body,
          headers: {
            "X-Shopify-Hmac-Sha256": btoa(String.fromCharCode(...sig)),
            "X-Shopify-Topic": "customer_payment_methods/update",
            "X-Shopify-Shop-Domain": "card-hook.myshopify.com",
            "X-Shopify-API-Version": "2026-10",
            "X-Shopify-Webhook-Id": "hook-9",
          },
        },
      ),
      context: {
        cloudflare: {
          env: {
            JOBS: {
              sendBatch: async (m: { body: Job }[]) =>
                void sent.push(...m.map((x) => x.body)),
            },
          },
        },
      },
    } as unknown as ActionFunctionArgs);
    expect(response.status).toBe(200);
    expect(sent).toEqual([
      cardUpdatedJob(
        "card-hook.myshopify.com",
        "gid://shopify/Customer/77",
        "hook-9",
      ),
    ]);
  });
});

// ---- cancel ----------------------------------------------------------------------------------

describe("cancelling", () => {
  it("cancels the contract, ends renewals and keeps the paid releases shipping", async () => {
    const s = await setup();
    const sub = await subscribe(s, { releasesRemaining: 2 });
    const paid = await release(s, "READY");
    const delivery = await db().delivery.create({
      data: { subscriptionId: sub.id, releaseId: paid.id },
    });
    const fake = shopify();
    await cancelSubscription(
      db(),
      env.DB,
      fake.graphql,
      await own(s, sub),
      NOW,
    );
    expect(fake.calls[0].variables).toEqual({ id: sub.contractGid });
    expect(
      (await db().subscription.findUniqueOrThrow({ where: { id: sub.id } }))
        .status,
    ).toBe("CANCELLED");
    // The merchant's dashboard counts it as a cancellation made in the portal.
    expect(
      await db().event.count({
        where: { subscriptionId: sub.id, type: "portal.cancelled" },
      }),
    ).toBe(1);
    // Two paid releases are still owed, so the waiting Delivery stays.
    expect(
      (await db().delivery.findUniqueOrThrow({ where: { id: delivery.id } }))
        .status,
    ).toBe("PENDING");
    expect(
      (await db().subscription.findUniqueOrThrow({ where: { id: sub.id } }))
        .releasesRemaining,
    ).toBe(2);
  });

  it("closes what was held back for a failed payment, since it was never paid", async () => {
    const s = await setup();
    const sub = await subscribe(s, {
      releasesRemaining: 0,
      status: "PAUSED",
      pausedReason: "FAILED_PAYMENT",
      paymentProblemSince: ago(1),
    });
    const missed = await release(s, "READY");
    const held = await db().delivery.create({
      data: { subscriptionId: sub.id, releaseId: missed.id, status: "HELD" },
    });
    await db().billingAttempt.create({
      data: {
        subscriptionId: sub.id,
        chargeFor: missed.id,
        idempotencyKey: `${sub.id}:${missed.id}:1`,
        attempt: 1,
        result: "FAILED",
        nextRetryAt: ago(-1),
      },
    });
    await cancelSubscription(
      db(),
      env.DB,
      shopify().graphql,
      await own(s, sub),
      NOW,
    );
    expect(
      (await db().delivery.findUniqueOrThrow({ where: { id: held.id } }))
        .status,
    ).toBe("CANCELLED");
    expect(
      (
        await db().billingAttempt.findFirstOrThrow({
          where: { subscriptionId: sub.id },
        })
      ).nextRetryAt,
    ).toBeNull();
  });

  it("is refused while a charge is in flight, and changes nothing", async () => {
    const s = await setup();
    const sub = await subscribe(s);
    await db().billingAttempt.create({
      data: {
        subscriptionId: sub.id,
        chargeFor: "term-1",
        idempotencyKey: `${sub.id}:term-1:1`,
        attempt: 1,
        result: "PENDING",
      },
    });
    const fake = shopify();
    await expect(
      cancelSubscription(db(), env.DB, fake.graphql, await own(s, sub), NOW),
    ).rejects.toThrow("being processed");
    expect(fake.calls).toEqual([]);
    expect(
      (await db().subscription.findUniqueOrThrow({ where: { id: sub.id } }))
        .status,
    ).toBe("ACTIVE");
  });

  it("a chargeback hold stays flagged through a cancellation", async () => {
    const s = await setup();
    const sub = await subscribe(s, {
      status: "PAUSED",
      pausedReason: "CHARGEBACK",
      paymentProblemSince: ago(1),
    });
    await cancelSubscription(
      db(),
      env.DB,
      shopify().graphql,
      await own(s, sub),
      NOW,
    );
    const after = await db().subscription.findUniqueOrThrow({
      where: { id: sub.id },
    });
    expect([after.status, after.pausedReason]).toEqual([
      "CANCELLED",
      "CHARGEBACK",
    ]);
  });

  it("does not mark the subscription cancelled when Shopify refuses, and repeating a cancel does nothing more", async () => {
    const s = await setup();
    const sub = await subscribe(s);
    const refuse = shopify({
      subscriptionContractCancel: {
        subscriptionContractCancel: {
          contract: null,
          userErrors: [{ message: "no" }],
        },
      },
    });
    await expect(
      cancelSubscription(db(), env.DB, refuse.graphql, await own(s, sub), NOW),
    ).rejects.toThrow(PortalError);
    expect(
      (await db().subscription.findUniqueOrThrow({ where: { id: sub.id } }))
        .status,
    ).toBe("ACTIVE");

    const fake = shopify();
    await cancelSubscription(
      db(),
      env.DB,
      fake.graphql,
      await own(s, sub),
      NOW,
    );
    await cancelSubscription(
      db(),
      env.DB,
      fake.graphql,
      await own(s, { ...sub, id: sub.id }),
      NOW,
    );
    expect(fake.calls).toHaveLength(1);
    expect(
      await db().event.count({
        where: { subscriptionId: sub.id, type: "portal.cancelled" },
      }),
    ).toBe(1);
    expect(
      await db().event.count({
        where: { subscriptionId: sub.id, type: "subscription.cancelled" },
      }),
    ).toBe(1);
  });
});

// ---- words -------------------------------------------------------------------------------

describe("what the customer reads", () => {
  const drop = { singular: "drop", plural: "drops" };
  it("says what cancelling does in the shop's own word, with the number still owed", () => {
    const copy = portalCopy(drop);
    expect(copy.cancel(2, false, 0)).toBe(
      "You'll still receive the 2 drops you've already paid for. You won't be charged again, and what you've paid isn't refunded.",
    );
    expect(copy.cancel(1, false, 0)).toContain("the 1 drop you've");
    expect(copy.cancel(0, false, 0)).toBe(
      "You won't be charged again. You've already received every drop you paid for.",
    );
    expect(copy.cancel(0, false, 1)).toContain(
      "Any drop we couldn't charge you for won't ship if you cancel.",
    );
    expect(copy.cancel(2, true, 0)).toContain(
      "on hold after a payment dispute",
    );
    expect(copy.cancelled(2, true)).not.toContain("still receive");
    expect(copy.cancelled(2, true)).toContain(
      "stay on hold until the shop reviews it",
    );
    expect(copy.cancelled(2, false)).toBe(
      "Your subscription is cancelled. You'll still receive the 2 drops you've paid for.",
    );
  });

  it("never hard-codes a release word", () => {
    const copy = portalCopy(drop);
    const text = JSON.stringify([
      copy,
      copy.cancel(2, false, 1),
      copy.cancel(0, true, 0),
      copy.cancelled(1, false),
      copy.cancelled(0, false),
    ]);
    expect(text).not.toMatch(/issue/i);
  });
});

// ---- the browser's view of the API ---------------------------------------------------------

describe("CORS", () => {
  const BROWSER =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";
  const ORIGIN = "https://extensions.shopifycdn.com";
  const ctx = { cloudflare: { env } };
  const expectCors = (response: Response) => {
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain(
      "Authorization",
    );
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain(
      "Content-Type",
    );
  };

  it("answers a preflight with the headers the browser needs, for any origin and any User-Agent", async () => {
    // curl counts as a bot to the library, which answers those with a bare 410 before it reaches OPTIONS.
    for (const agent of [BROWSER, "curl/8.7.1"]) {
      for (const origin of [ORIGIN, "null"]) {
        const response = await portalAction({
          request: new Request("https://app.example.com/api/portal", {
            method: "OPTIONS",
            headers: {
              "User-Agent": agent,
              Origin: origin,
              "Access-Control-Request-Method": "POST",
              "Access-Control-Request-Headers": "authorization,content-type",
            },
          }),
          context: ctx,
        } as unknown as ActionFunctionArgs);
        expect(response.status, `${agent} ${origin}`).toBe(204);
        expectCors(response);
        expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
          "POST",
        );
      }
    }
  });

  it("lets the page read a refusal: no token and a bad token are 401s with CORS headers, on a read and on a write", async () => {
    for (const handler of [portalLoader, portalAction]) {
      for (const headers of [{}, { Authorization: "Bearer junk" }] as Record<
        string,
        string
      >[]) {
        const response = await (handler as any)({
          request: new Request("https://app.example.com/api/portal", {
            method: handler === portalLoader ? "GET" : "POST",
            body: handler === portalLoader ? undefined : "{}",
            headers: { "User-Agent": BROWSER, Origin: ORIGIN, ...headers },
          }),
          context: ctx,
        });
        expect(response.status).toBe(401);
        expectCors(response);
      }
    }
  });

  it("puts the headers on answers too, including a 404 and a success", async () => {
    const s = await setup();
    const sub = await subscribe(s);
    const ok = await (async () => {
      const response = await portalLoader({
        request: new Request("https://app.example.com/api/portal", {
          headers: {
            "User-Agent": BROWSER,
            Origin: ORIGIN,
            Authorization: `Bearer ${await token(customer(), s.domain)}`,
          },
        }),
        context: ctx,
      } as unknown as LoaderFunctionArgs);
      return response;
    })();
    expect(ok.status).toBe(200);
    expectCors(ok);
    const missing = await callPortal(s.domain, customer(), {
      intent: "cancel",
      subscriptionId: sub.id,
    });
    expect(missing.status).toBe(404);
    expectCors(new Response(null, { headers: missing.headers }));
  });
});

// ---- gifts ---------------------------------------------------------------------------------------

describe("a gift in the portal", () => {
  const BUYER = "gid://shopify/Customer/9001";

  async function gift(s: Setup, data: Record<string, unknown> = {}) {
    return subscribe(s, {
      source: "GIFT",
      giftBuyerGid: BUYER,
      giftMessage: "<b>Enjoy</b> it!",
      ...data,
    });
  }

  /** The contract as Shopify has it: the buyer's card, and the address the buyer typed for the recipient. */
  const contractNodes = (id: string) => ({
    nodes: [
      {
        id,
        deliveryMethod: { address: { firstName: "Ada", address1: "1 Test St", countryCode: "US" } },
        customerPaymentMethod: { instrument: { brand: "Visa", lastDigits: "1234" } },
      },
    ],
  });

  it("shows the recipient their gift, the message and the address, and never the buyer's card", async () => {
    const s = await setup();
    const ordinary = await subscribe(s);
    const sub = await gift(s, { paymentProblemSince: ago(1) });
    const read = async (who: string, id: string) =>
      (await loadPortal(db(), env.DB, async () => async () => contractNodes(id), s.domain, who))!;

    const mine = await read(sub.customerGid, sub.contractGid!);
    expect(mine.subscriptions).toHaveLength(1);
    expect(mine.subscriptions[0]).toMatchObject({
      gift: true,
      giftMessage: "<b>Enjoy</b> it!",
      card: null,
      cardProblem: false,
      address: { address1: "1 Test St" },
    });
    expect(mine.copy.giftNote).toMatch(/never be charged/);
    expect(JSON.stringify(mine)).not.toMatch(/1234|Visa|ending/);
    expect(mine.subscriptions[0].cancelNote).toMatch(/nothing for you to cancel/);

    // An ordinary subscription still shows its own card.
    const control = await read(ordinary.customerGid, ordinary.contractGid!);
    expect(control.subscriptions[0]).toMatchObject({ gift: false, giftMessage: null, card: "Visa ending 1234" });
  });

  it("the buyer sees nothing of it in their own account, and can't act on it", async () => {
    const s = await setup();
    const sub = await gift(s);
    const asked: string[] = [];
    const portal = await loadPortal(
      db(),
      env.DB,
      async () => async (query: string) => void asked.push(query) as any,
      s.domain,
      BUYER,
    );
    expect(portal!.subscriptions).toEqual([]);
    expect(asked).toEqual([]); // no subscription of theirs, so Shopify isn't even asked
    expect(await ownSubscription(db(), s.domain, BUYER, sub.id)).toBeNull();
    for (const intent of ["cancel", "address", "card", "resume", "confirm"]) {
      const result = await callPortal(s.domain, BUYER, { intent, subscriptionId: sub.id });
      expect(result.status, intent).toBe(404);
      expect(result.sent).toEqual([]);
    }
    expect((await db().subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe("ACTIVE");
  });

  it("refuses the recipient any card action or cancel, before Shopify is asked anything", async () => {
    const s = await setup();
    const sub = await gift(s, { paymentProblemSince: ago(1) });
    for (const [intent, message] of [
      ["card", /no card or payment/],
      ["resume", /no card or payment/],
      ["cancel", /nothing for you to cancel/],
    ] as const) {
      // The test Worker has no Shopify session: asking Shopify would be a 500, not this answer.
      const result = await callPortal(s.domain, sub.customerGid, { intent, subscriptionId: sub.id });
      expect(result.status, intent).toBe(422);
      expect(result.json.error).toBe("gift");
      expect(result.json.message).toMatch(message);
      expect(result.sent).toEqual([]);
    }
    expect((await db().subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe("ACTIVE");

    // And the functions behind them refuse on their own.
    const fake = shopify();
    const owned = await own(s, sub);
    await expect(sendCardUpdateEmail(fake.graphql, owned)).rejects.toMatchObject({ code: "gift" });
    await expect(cancelSubscription(db(), env.DB, fake.graphql, owned)).rejects.toMatchObject({ code: "gift" });
    expect(fake.calls).toEqual([]);
  });

  it("lets the recipient change the address, which is the contract's, and confirm it", async () => {
    const s = await setup();
    const sub = await gift(s);
    const preorder = await release(s, "PREORDER", { preorderOpensAt: ago(1) });
    await db().delivery.create({ data: { subscriptionId: sub.id, releaseId: preorder.id } });
    const fake = shopify();
    await changeAddress(db(), env.DB, fake.graphql, await own(s, sub), {
      firstName: "Ada",
      lastName: "L",
      address1: "2 New St",
      city: "Town",
      zip: "10001",
      countryCode: "US",
    });
    const commit = fake.calls.find((call) => call.query.includes("subscriptionDraftUpdate"))!;
    expect(commit.variables.input.deliveryMethod.shipping.address.address1).toBe("2 New St");
    expect(fake.calls.every((call) => !call.query.includes("customerPaymentMethod"))).toBe(true);
    expect(await confirmAddress(db(), env.DB, await own(s, sub), preorder.id)).toBe(true);
  });
});

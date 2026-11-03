import "@shopify/shopify-api/adapters/cf-worker";
import { applyD1Migrations, env } from "cloudflare:test";
import { Session } from "@shopify/shopify-api";
import type { ActionFunctionArgs } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { action as uninstalled } from "../app/routes/webhooks.app.uninstalled";
import { D1SessionStorage } from "../app/session-storage.server";
import { unauthenticated } from "../app/shopify.server";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const HOUR = 60 * 60 * 1000;
let nextShop = 0;

function newShop() {
  return `sessions-${++nextShop}.myshopify.com`;
}

function storage() {
  return new D1SessionStorage(env.DB, {
    apiKey: "api-key",
    apiSecretKey: "api-secret",
  });
}

function offlineSession(shop: string, expiresInMs = HOUR, token = "old") {
  return new Session({
    id: `offline_${shop}`,
    shop,
    state: "",
    isOnline: false,
    scope: "write_products",
    accessToken: `${token}-access`,
    expires: new Date(Date.now() + expiresInMs),
    refreshToken: `${token}-refresh`,
    refreshTokenExpires: new Date(Date.now() + 90 * 24 * HOUR),
  });
}

function refreshResponse() {
  return Response.json({
    access_token: "new-access",
    refresh_token: "new-refresh",
    scope: "write_products",
    expires_in: 3600,
    refresh_token_expires_in: 7776000,
  });
}

/** Stubs Shopify's token endpoint and returns the stub. */
function stubFetch(respond: () => Response = refreshResponse) {
  const stub = vi.fn<typeof fetch>(async () => respond());
  vi.stubGlobal("fetch", stub);
  return stub;
}

describe("D1 session storage", () => {
  it("keeps the expiring offline token fields", async () => {
    const shop = newShop();
    const session = offlineSession(shop);
    await storage().storeSession(session);
    const fetchStub = stubFetch();

    const loaded = await storage().loadSession(session.id);

    expect(fetchStub).not.toHaveBeenCalled();
    expect(loaded?.accessToken).toBe("old-access");
    expect(loaded?.refreshToken).toBe("old-refresh");
    expect(loaded?.expires).toEqual(session.expires);
    expect(loaded?.refreshTokenExpires).toEqual(session.refreshTokenExpires);
  });

  it("finds and deletes a shop's session", async () => {
    const shop = newShop();
    const session = offlineSession(shop);
    await storage().storeSession(session);

    expect(await storage().findSessionsByShop(shop)).toHaveLength(1);

    await storage().deleteSessions([session.id]);

    expect(await storage().findSessionsByShop(shop)).toEqual([]);
    const row = await env.DB.prepare(
      `SELECT "id" FROM "OfflineSession" WHERE "id" = ?1`,
    )
      .bind(session.id)
      .first();
    expect(row).toBeNull();
  });
});

describe("refreshing on load", () => {
  it("refreshes an expired token and stores the new one", async () => {
    const shop = newShop();
    await storage().storeSession(offlineSession(shop, -HOUR));
    const fetchStub = stubFetch();

    const loaded = await storage().loadSession(`offline_${shop}`);

    expect(loaded?.accessToken).toBe("new-access");
    expect(loaded?.isActive(undefined)).toBe(true);
    const [url, init] = fetchStub.mock.calls[0];
    expect(url).toBe(`https://${shop}/admin/oauth/access_token`);
    expect(JSON.parse(init?.body as string)).toEqual({
      client_id: "api-key",
      client_secret: "api-secret",
      refresh_token: "old-refresh",
      grant_type: "refresh_token",
    });

    // Right after the refresh, the next reader gets the new token without another one.
    const next = await storage().loadSession(`offline_${shop}`);
    expect(next?.refreshToken).toBe("new-refresh");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("refreshes a token within 5 minutes of expiry, so the library won't exchange it", async () => {
    const shop = newShop();
    await storage().storeSession(offlineSession(shop, 4 * 60 * 1000));
    stubFetch();

    const loaded = await storage().loadSession(`offline_${shop}`);

    expect(loaded?.accessToken).toBe("new-access");
  });

  it("refreshes a token the library has invalidated after a 401", async () => {
    const shop = newShop();
    const session = offlineSession(shop);
    session.accessToken = undefined;
    await storage().storeSession(session);
    stubFetch();

    const loaded = await storage().loadSession(`offline_${shop}`);

    expect(loaded?.accessToken).toBe("new-access");
  });

  it("gives two jobs refreshing at once a working token each", async () => {
    const shop = newShop();
    await storage().storeSession(offlineSession(shop, -HOUR));
    stubFetch();

    const [a, b] = await Promise.all([
      storage().loadSession(`offline_${shop}`),
      storage().loadSession(`offline_${shop}`),
    ]);

    expect(a?.accessToken).toBe("new-access");
    expect(b?.accessToken).toBe("new-access");
  });

  it("throws and keeps the session when Shopify fails, so the job retries", async () => {
    const shop = newShop();
    await storage().storeSession(offlineSession(shop, -HOUR));
    stubFetch(() => new Response(null, { status: 503 }));

    await expect(storage().loadSession(`offline_${shop}`)).rejects.toThrow("503");

    const [kept] = await storage().findSessionsByShop(shop);
    expect(kept.refreshToken).toBe("old-refresh");
  });

  it("returns nothing when there's no session", async () => {
    expect(await storage().loadSession(`offline_${newShop()}`)).toBeUndefined();
  });

  it("returns nothing but keeps the session when Shopify rejects the refresh token", async () => {
    const shop = newShop();
    await storage().storeSession(offlineSession(shop, -HOUR));
    stubFetch(() => Response.json({ error: "invalid_request" }, { status: 401 }));

    // Undefined makes an admin request run a token exchange, which replaces the session.
    expect(await storage().loadSession(`offline_${shop}`)).toBeUndefined();

    // Rejection may be our own misconfiguration, so nothing is thrown away.
    const [kept] = await storage().findSessionsByShop(shop);
    expect(kept.refreshToken).toBe("old-refresh");
  });
});

describe("a background job through the Shopify library", () => {
  it("gets a new token after expiry, without the library refreshing again", async () => {
    const shop = newShop();
    await storage().storeSession(offlineSession(shop, -HOUR));
    const fetchStub = stubFetch();

    const { session } = await unauthenticated.admin(shop);

    expect(session.accessToken).toBe("new-access");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("fails when the shop has no session, so the job can retry", async () => {
    await expect(unauthenticated.admin(newShop())).rejects.toThrow(
      "Could not find a session",
    );
  });
});

describe("the app/uninstalled webhook", () => {
  it("deletes the session even when its refresh token no longer works", async () => {
    const shop = newShop();
    await storage().storeSession(offlineSession(shop, -HOUR));
    stubFetch(() => Response.json({ error: "invalid_request" }, { status: 401 }));
    const body = JSON.stringify({ id: 1 });
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.SHOPIFY_API_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(body),
    );

    const response = await uninstalled({
      request: new Request("https://app.example.com/webhooks/app/uninstalled", {
        method: "POST",
        body,
        headers: {
          "X-Shopify-Hmac-Sha256": btoa(
            String.fromCharCode(...new Uint8Array(signature)),
          ),
          "X-Shopify-Topic": "app/uninstalled",
          "X-Shopify-Shop-Domain": shop,
          "X-Shopify-API-Version": "2026-10",
          "X-Shopify-Webhook-Id": "webhook-1",
        },
      }),
    } as ActionFunctionArgs);

    expect(response.status).toBe(200);
    expect(await storage().findSessionsByShop(shop)).toEqual([]);
  });
});

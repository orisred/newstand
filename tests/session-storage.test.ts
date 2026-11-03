import "@shopify/shopify-api/adapters/cf-worker";
import { env } from "cloudflare:test";
import { Session } from "@shopify/shopify-api";
import { KVSessionStorage } from "@shopify/shopify-app-session-storage-kv";
import { describe, expect, it } from "vitest";

const shop = "sessions.myshopify.com";

function offlineSession() {
  return new Session({
    id: `offline_${shop}`,
    shop,
    state: "",
    isOnline: false,
    scope: "write_products",
    accessToken: "access-token",
    expires: new Date("2027-01-01T01:00:00.000Z"),
    refreshToken: "refresh-token",
    refreshTokenExpires: new Date("2027-04-01T00:00:00.000Z"),
  });
}

describe("KV session storage", () => {
  it("keeps the expiring offline token fields", async () => {
    const storage = new KVSessionStorage(env.SESSIONS);
    await storage.storeSession(offlineSession());

    const loaded = await storage.loadSession(`offline_${shop}`);
    expect(loaded?.accessToken).toBe("access-token");
    expect(loaded?.refreshToken).toBe("refresh-token");
    expect(loaded?.expires).toEqual(new Date("2027-01-01T01:00:00.000Z"));
    expect(loaded?.refreshTokenExpires).toEqual(
      new Date("2027-04-01T00:00:00.000Z"),
    );
  });

  it("removes every copy of an ID from the shop's list when deleted", async () => {
    const storage = new KVSessionStorage(env.SESSIONS);
    const session = offlineSession();
    // A token refresh stores the same ID again, and the adapter appends it.
    await storage.storeSession(session);
    await storage.storeSession(session);
    expect((await storage.findSessionsByShop(shop)).length).toBeGreaterThan(1);

    await storage.deleteSession(session.id);

    expect(await storage.loadSession(session.id)).toBeUndefined();
    expect(await storage.findSessionsByShop(shop)).toEqual([]);
  });
});

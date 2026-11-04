import { Session } from "@shopify/shopify-api";
import { logEvent } from "./logger.server";

// The library runs a token exchange on a token within 5 minutes of expiry, so refreshing
// inside that window means it only ever exchanges when no refresh token works.
const REFRESH_WITHIN_MS = 5 * 60 * 1000;

interface ApiCredentials {
  apiKey: string;
  apiSecretKey: string;
}

/**
 * Offline sessions in D1, refreshed on load. A refresh racing a token exchange can leave
 * a dead refresh token stored, which would stop background jobs until the merchant next
 * opens the app. Refreshing here means no exchange happens while a refresh token works.
 * See the 2026-11-03 note in docs/DECISIONS.md.
 */
export class D1SessionStorage {
  constructor(
    private db: D1Database,
    private credentials: ApiCredentials,
  ) {}

  async storeSession(session: Session) {
    await this.db
      .prepare(
        `INSERT INTO "OfflineSession" ("id", "data") VALUES (?1, ?2)
         ON CONFLICT ("id") DO UPDATE SET "data" = excluded."data"`,
      )
      .bind(session.id, JSON.stringify(session.toPropertyArray(true)))
      .run();
    return true;
  }

  /**
   * Returns a session with a working token, refreshing it if it's about to expire.
   * Returns undefined when the caller has to get a new token: the library then runs a
   * token exchange if it's an admin request, and throws if it's a background job.
   */
  async loadSession(id: string) {
    const data = await this.readData(id);
    if (!data) return undefined;
    const session = Session.fromPropertyArray(JSON.parse(data), true);
    if (session.isActive(undefined, REFRESH_WITHIN_MS)) return session;
    if (!session.refreshToken) return undefined;

    const refreshed = await this.refresh(session);
    if (refreshed) await this.storeSession(refreshed);
    return refreshed ?? undefined;
  }

  /**
   * Changes only the scope of a shop's stored session. A webhook must not write back a whole
   * session it read earlier: a refresh may have stored a newer token since, and the old
   * refresh token might not survive that. So the write only lands on the row as it was read
   * (compare and set), and otherwise reads again.
   */
  async updateScope(shop: string, scope: string) {
    const id = `offline_${shop}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const data = await this.readData(id);
      if (!data) return false;
      const properties = JSON.parse(data) as [string, unknown][];
      const next = properties.map(([key, value]) =>
        key === "scope" ? [key, scope] : [key, value],
      );
      const { meta } = await this.db
        .prepare(
          `UPDATE "OfflineSession" SET "data" = ?1 WHERE "id" = ?2 AND "data" = ?3`,
        )
        .bind(JSON.stringify(next), id, data)
        .run();
      if (meta.changes === 1) return true;
    }
    throw new Error("Session kept changing while its scope was updated");
  }

  async deleteSession(id: string) {
    await this.db
      .prepare(`DELETE FROM "OfflineSession" WHERE "id" = ?1`)
      .bind(id)
      .run();
    return true;
  }

  async deleteSessions(ids: string[]) {
    await Promise.all(ids.map((id) => this.deleteSession(id)));
    return true;
  }

  async findSessionsByShop(shop: string) {
    const data = await this.readData(`offline_${shop}`);
    return data ? [Session.fromPropertyArray(JSON.parse(data), true)] : [];
  }

  private async readData(id: string) {
    return this.db
      .prepare(`SELECT "data" FROM "OfflineSession" WHERE "id" = ?1`)
      .bind(id)
      .first<string>("data");
  }

  /** Returns null when Shopify rejects the token, and throws if it may work later. */
  private async refresh({ id, shop, refreshToken }: Session) {
    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: this.credentials.apiKey,
        client_secret: this.credentials.apiSecretKey,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (response.status === 400 || response.status === 401) {
      // Every job for this shop now fails, until the merchant next opens the app.
      logEvent("error", "session.refresh_rejected", {
        shop,
        errorStatus: response.status,
      });
      return null;
    }
    if (!response.ok) {
      throw new Error(`Token refresh failed with status ${response.status}`);
    }
    const body = (await response.json()) as {
      access_token: string;
      scope: string;
      expires_in: number;
      refresh_token: string;
      refresh_token_expires_in: number;
    };
    logEvent("info", "session.refreshed", { shop });
    const now = Date.now();
    return new Session({
      id,
      shop,
      state: "",
      isOnline: false,
      scope: body.scope,
      accessToken: body.access_token,
      expires: new Date(now + body.expires_in * 1000),
      refreshToken: body.refresh_token,
      refreshTokenExpires: new Date(now + body.refresh_token_expires_in * 1000),
    });
  }
}

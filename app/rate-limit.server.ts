/**
 * Limits that hold across a Worker's isolates, which share no memory. The key is a hash, so neither a
 * customer ID nor an IP address is kept, and a row ends with its window (`pruneOldRows`).
 */
const HOUR_MS = 60 * 60 * 1000;

/** Each action a customer can repeat, per customer per hour. What they're owed has no limit: never a cancel. */
export const PORTAL_LIMITS = {
  read: 120,
  confirm: 30,
  address: 30,
  resume: 10,
  card: 5,
} as const;

/** Per IP per subscription, so whoever holds a forwarded link uses up only their own. */
export const LINK_PRESSES_PER_HOUR = 20;

async function count(rawDb: D1Database, name: string, now: Date) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name));
  const key = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const row = await rawDb
    .prepare(
      `INSERT INTO "RateLimit" ("key", "count", "windowEndsAt") VALUES (?1, 1, ?2)
       ON CONFLICT ("key") DO UPDATE SET
         "count" = CASE WHEN "windowEndsAt" <= ?3 THEN 1 ELSE "count" + 1 END,
         "windowEndsAt" = CASE WHEN "windowEndsAt" <= ?3 THEN excluded."windowEndsAt" ELSE "windowEndsAt" END
       RETURNING "count"`,
    )
    .bind(key, new Date(now.getTime() + HOUR_MS).toISOString(), now.toISOString())
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/** Counts this action, and says whether it's over the limit. An action with no limit isn't counted. */
export async function limited(rawDb: D1Database, customerGid: string, action: string, now = new Date()) {
  const limit = (PORTAL_LIMITS as Record<string, number>)[action];
  return limit !== undefined && (await count(rawDb, `portal:${action}:${customerGid}`, now)) > limit;
}

/** The same for a press on the email link page. */
export async function linkLimited(rawDb: D1Database, subscriptionId: string, ip: string, now = new Date()) {
  return (await count(rawDb, `link:${subscriptionId}:${ip}`, now)) > LINK_PRESSES_PER_HOUR;
}

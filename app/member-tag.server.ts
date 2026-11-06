import type { createDb } from "./db.server";
import { CHARGEBACK_HOLD } from "./release-runs.server";
import type { Job } from "./jobs/runner.server";
import { describeError, logEvent } from "./logger.server";
import { memberTagJob } from "./notification-jobs";
import type { Graphql } from "./plan-sync.server";
import { IMPORT_HOLD } from "./subscriptions.server";

type Db = ReturnType<typeof createDb>;

const CUSTOMERS_PER_SLICE = 25;

/**
 * Whether a subscription earns the member discount tag. Active ones do. A cancelled or paused (failed
 * payment) one keeps it while it still has paid releases whose orders haven't been created, and loses it
 * when the last of them is. A chargeback or an ended subscription never does.
 * A gift never renews, so it stays active in name only: it loses the tag with its last paid release too.
 * A plan without auto-renew has nothing to renew into either, so it keeps the tag until its term is up, and
 * past that only while a paid release is still owed (N, 2026-11-05). With no term, its last release ends it.
 * An import hold is the merchant's doing and they've paid for the term, so it keeps the tag while that runs,
 * even with nothing left to ship (N, 2026-11-05).
 */
const QUALIFIES = `s."status" <> 'ENDED' AND NOT ${CHARGEBACK_HOLD}
  AND (s."releasesRemaining" > 0 OR (s."status" = 'ACTIVE' AND s."source" <> 'GIFT'
    AND (p."autoRenew" = 1 OR julianday(s."termEndsAt") > julianday(?5)))
  OR (s."pausedReason" = '${IMPORT_HOLD}' AND julianday(s."termEndsAt") > julianday(?5)))`;

const TAGS_ADD = `#graphql
  mutation MemberTagAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { userErrors { message } }
  }`;
const TAGS_REMOVE = `#graphql
  mutation MemberTagRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) { userErrors { message } }
  }`;

/**
 * Brings customers' tags in line with their subscriptions, for one shop, a page at a time. State-driven:
 * it compares what each customer should have with `MemberTag`, what the app last put on them, and fixes
 * the difference. What they should have is the shop's member tag if any of their subscriptions qualifies,
 * plus the plan's own tag (`Plan.memberTag`) of each one that does, so a tier's tag comes off when that
 * tier stops qualifying while the shop's stays for another. Both are held as one sorted, comma-separated
 * set: Shopify tags hold no commas. Every step is repeatable, so a
 * crash, a retry or a second job changes nothing. `tagsAdd` and `tagsRemove` work for guest customers
 * too. A redacted customer has no `customerGid` to tag.
 * Tags the merchant removes by hand in Shopify aren't noticed: Shopify isn't read, only the app's record.
 */
export async function runMemberTagSlice(
  db: Db,
  rawDb: D1Database,
  graphqlFor: () => Promise<Graphql>,
  job: Job,
  clock: () => Date = () => new Date(),
): Promise<Job | null> {
  const shop = await db.shop.findUnique({
    where: { shopDomain: String(job.shop) },
    select: { id: true, shopDomain: true, memberDiscountTag: true },
  });
  if (!shop) return null;
  const after = String(job.data?.after ?? "");

  const { results } = await rawDb
    .prepare(
      `WITH subs AS (
         SELECT s."customerGid", p."memberTag" AS "planTag", CASE WHEN ${QUALIFIES} THEN 1 ELSE 0 END AS "ok"
         FROM "Subscription" s
         JOIN "Plan" p ON p."id" = s."planId"
         WHERE s."shopId" = ?1 AND s."customerGid" <> 'redacted' AND s."customerGid" > ?3
       ), wanted AS (
         SELECT "customerGid", ?2 AS "tag" FROM subs WHERE "ok" = 1 AND ?2 IS NOT NULL
         UNION SELECT "customerGid", "planTag" FROM subs WHERE "ok" = 1 AND "planTag" IS NOT NULL
       )
       SELECT * FROM (
         SELECT c."customerGid", m."tag" AS "current",
           (SELECT group_concat(w."tag", ',' ORDER BY w."tag") FROM wanted w WHERE w."customerGid" = c."customerGid") AS "wanted"
         FROM (SELECT DISTINCT "customerGid" FROM subs) c
         LEFT JOIN "MemberTag" m ON m."id" = ?1 || ':' || c."customerGid"
       )
       WHERE "wanted" IS NOT "current"
       ORDER BY "customerGid" LIMIT ?4`,
    )
    .bind(shop.id, shop.memberDiscountTag, after, CUSTOMERS_PER_SLICE, clock().toISOString())
    .all<{ customerGid: string; current: string | null; wanted: string | null }>();

  const graphql = results.length ? await graphqlFor() : null;
  let changed = 0;
  for (const { customerGid, current, wanted } of results) {
    try {
      // A renamed tag is moved: the old one comes off. Only the difference is sent.
      const had = tagSet(current);
      const want = tagSet(wanted);
      const off = had.filter((tag) => !want.includes(tag));
      const on = want.filter((tag) => !had.includes(tag));
      if (off.length) await tagMutation(graphql!, TAGS_REMOVE, customerGid, off);
      if (on.length) await tagMutation(graphql!, TAGS_ADD, customerGid, on);
      await rawDb
        .prepare(
          `INSERT INTO "MemberTag" ("id", "shopId", "customerGid", "tag", "updatedAt")
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT ("id") DO UPDATE SET "tag" = excluded."tag", "updatedAt" = excluded."updatedAt"`,
        )
        .bind(`${shop.id}:${customerGid}`, shop.id, customerGid, wanted, clock().toISOString())
        .run();
      changed++;
    } catch (error) {
      // Left as it was, so the next tick tries again. One customer doesn't hold up the rest.
      logEvent("error", "member_tag.failed", { shopId: shop.id, ...describeError(error) });
    }
  }
  logEvent("info", "member_tag.slice", { shopId: shop.id, found: results.length, changed });
  return results.length === CUSTOMERS_PER_SLICE
    ? memberTagJob(shop.shopDomain, crypto.randomUUID(), {
        after: results[results.length - 1].customerGid,
      })
    : null;
}

const tagSet = (tags: string | null) => (tags ? tags.split(",") : []);

async function tagMutation(graphql: Graphql, query: string, id: string, tags: string[]) {
  const data = await graphql(query, { id, tags });
  const result = data.tagsAdd ?? data.tagsRemove;
  // A customer who's gone has nothing to tag. Anything else is worth another try.
  if (result.userErrors.length > 0 && !/not exist|not found/i.test(result.userErrors[0].message)) {
    throw new Error("Shopify refused a customer tag");
  }
}

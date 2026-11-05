import type { createDb } from "./db.server";
import { CHARGEBACK_HOLD } from "./release-runs.server";
import type { Job } from "./jobs/runner.server";
import { describeError, logEvent } from "./logger.server";
import { memberTagJob } from "./notification-jobs";
import type { Graphql } from "./plan-sync.server";

type Db = ReturnType<typeof createDb>;

const CUSTOMERS_PER_SLICE = 25;

/**
 * Whether a subscription earns the member discount tag. Active ones do. A cancelled or paused (failed
 * payment) one keeps it while it still has paid releases whose orders haven't been created, and loses it
 * when the last of them is. A chargeback or an ended subscription never does.
 * A gift never renews, so it stays active in name only: it loses the tag with its last paid release too.
 */
const QUALIFIES = `s."status" <> 'ENDED' AND NOT ${CHARGEBACK_HOLD}
  AND (s."releasesRemaining" > 0 OR (s."status" = 'ACTIVE' AND s."source" <> 'GIFT'))`;

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
 * it compares what each customer should have (any qualifying subscription among all theirs) with
 * `MemberTag`, what the app last put on them, and fixes the difference. Every step is repeatable, so a
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
      `SELECT s."customerGid", m."tag" AS "current",
         CASE WHEN MAX(CASE WHEN ${QUALIFIES} THEN 1 ELSE 0 END) = 1 THEN ?2 END AS "wanted"
       FROM "Subscription" s
       LEFT JOIN "MemberTag" m ON m."id" = s."shopId" || ':' || s."customerGid"
       WHERE s."shopId" = ?1 AND s."customerGid" <> 'redacted' AND s."customerGid" > ?3
       GROUP BY s."customerGid"
       HAVING "wanted" IS NOT m."tag"
       ORDER BY s."customerGid" LIMIT ?4`,
    )
    .bind(shop.id, shop.memberDiscountTag, after, CUSTOMERS_PER_SLICE)
    .all<{ customerGid: string; current: string | null; wanted: string | null }>();

  const graphql = results.length ? await graphqlFor() : null;
  let changed = 0;
  for (const { customerGid, current, wanted } of results) {
    try {
      // A renamed tag is moved: the old one comes off.
      if (current && current !== wanted) await tagMutation(graphql!, TAGS_REMOVE, customerGid, current);
      if (wanted) await tagMutation(graphql!, TAGS_ADD, customerGid, wanted);
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

async function tagMutation(graphql: Graphql, query: string, id: string, tag: string) {
  const data = await graphql(query, { id, tags: [tag] });
  const result = data.tagsAdd ?? data.tagsRemove;
  // A customer who's gone has nothing to tag. Anything else is worth another try.
  if (result.userErrors.length > 0 && !/not exist|not found/i.test(result.userErrors[0].message)) {
    throw new Error("Shopify refused a customer tag");
  }
}

const STATUS_TEXT: Record<string, string> = {
  PENDING: "Waiting for an order",
  ORDERED: "Order created",
  HELD: "Held",
  FULFILLED: "Fulfilled",
  CANCELLED: "Cancelled",
};

/**
 * One CSV cell. Text a spreadsheet would run as a formula gets a leading apostrophe, which
 * makes it plain text: a title, plan name or Shopify message can start with anything. The
 * full-width forms count because some spreadsheets normalize them.
 */
export function csvCell(value: string | number | null) {
  const text = String(value ?? "");
  const safe = /^\s*[=+\-@＝＋－＠]|^[\t\r\n]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

const lastPart = (gid: string | null) => gid?.split("/").pop() ?? "";

/**
 * A release's run as CSV: one query, whose rows hold only what the app already stores, so it
 * stays short at any size and needs no Shopify call in a request. No names or addresses, which
 * this app doesn't keep (see DECISIONS.md): each row links to the order, and the order's
 * `release-<number>` tag finds the whole run in Shopify for labels or an address export.
 * Rows still waiting sort first, so problems are at the top.
 */
export async function buildRunCsv(
  rawDb: D1Database,
  shop: { id: string; shopDomain: string; word: string },
  releaseId: string,
) {
  const release = await rawDb
    .prepare(
      `SELECT "number", "title" FROM "Release" WHERE "id" = ?1 AND "shopId" = ?2`,
    )
    .bind(releaseId, shop.id)
    .first<{ number: number; title: string }>();
  if (!release) return null;
  const { results } = await rawDb
    .prepare(
      `SELECT d."status", d."orderGid", d."orderName", d."orderError",
         s."quantity", s."customerGid", s."contractGid", p."name" AS "plan"
       FROM "Delivery" d
       JOIN "Subscription" s ON s."id" = d."subscriptionId"
       JOIN "Plan" p ON p."id" = s."planId"
       WHERE d."releaseId" = ?1
       ORDER BY length(d."orderName"), d."orderName", d."id"`,
    )
    .bind(releaseId)
    .all<{
      status: string;
      orderGid: string | null;
      orderName: string | null;
      orderError: string | null;
      quantity: number;
      customerGid: string;
      contractGid: string | null;
      plan: string;
    }>();
  const admin = `https://${shop.shopDomain}/admin`;
  const word = shop.word[0].toUpperCase() + shop.word.slice(1);
  const rows = results.map((row) => [
    `${release.number}. ${release.title}`,
    row.orderName ?? lastPart(row.orderGid),
    row.orderGid ? `${admin}/orders/${lastPart(row.orderGid)}` : "",
    STATUS_TEXT[row.status] ?? row.status,
    row.orderError,
    row.quantity,
    row.plan,
    // A redacted customer keeps their order, and has no one to link to.
    row.customerGid.startsWith("gid:")
      ? `${admin}/customers/${lastPart(row.customerGid)}`
      : "",
    lastPart(row.contractGid),
  ]);
  const header = [
    word,
    "Order",
    "Order link",
    "Status",
    "Problem",
    "Quantity",
    "Plan",
    "Customer link",
    "Contract ID",
  ];
  // The byte-order mark makes Excel read this as UTF-8.
  return `\uFEFF${[header, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n")}\r\n`;
}

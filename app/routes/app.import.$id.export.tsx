import type { LoaderFunctionArgs } from "react-router";
import { reportRows } from "../import.server";
import { createDb } from "../db.server";
import { csvCell } from "../release-csv.server";
import { getOrCreateShop } from "../shop.server";
import { authenticate } from "../shopify.server";
import { termsOf } from "../vocabulary";

// No names: a contact's line number and customer link say who it is, so the file holds no personal data.
export const loader = async ({ request, params, context }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { env } = context.cloudflare;
  const db = createDb(env.DB);
  const shop = await getOrCreateShop(db, session.shop);
  const rows = await reportRows(db, env.DB, shop.id, String(params.id));
  if (!rows) throw new Response("Not found", { status: 404 });
  const header = [
    "Contact line", "Customer link", "Category", "State", "Flags", termsOf(shop.vocabulary).Plan, "Last purchase", "Last purchase date",
    "Purchases", "Quantity", "Price", "Paid", "Carried over", "Purchases not counted", "Received", "Left", "First release", "Term ends", "Next charge", "Country",
    "Contract ID", "Error",
  ];
  const lines = rows.map((row) => {
    const facts = JSON.parse(row.facts) as Record<string, string | number | number[] | null | undefined>;
    const customer = row.customerGid?.startsWith("gid://")
      ? `https://${session.shop}/admin/customers/${row.customerGid.split("/").pop()}`
      : (row.customerGid ?? "");
    return [
      row.contactNumber, customer, row.category, row.state,
      (JSON.parse(row.flags) as string[]).join(" "), row.planId,
      (facts.lastOrderName as string) ?? "", (facts.lastPurchaseAt as string) ?? "",
      (facts.purchases as number) ?? "", (facts.quantity as number) ?? "", (facts.priceCents as number) ?? "",
      (facts.paid as number) ?? "", (facts.carriedOver as number) ?? "", (facts.uncountedPurchases as number) ?? "",
      ((facts.received as number[]) ?? []).join(" "), (facts.remaining as number) ?? "",
      (facts.firstReleaseNumber as number) ?? "", (facts.termEndsAt as string) ?? "", (facts.nextCharge as string) ?? "",
      (facts.addressCountry as string) ?? "", row.contractGid?.split("/").pop() ?? "", row.error,
    ];
  });
  return new Response(
    `\uFEFF${[header, ...lines].map((line) => line.map(csvCell).join(",")).join("\r\n")}\r\n`,
    {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="import-report.csv"',
        "Cache-Control": "no-store",
      },
    },
  );
};

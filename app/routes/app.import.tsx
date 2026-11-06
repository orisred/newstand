import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate, useRevalidator, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { customerLabel, customerNames } from "../dashboard.server";
import { idOf, whenText } from "../dashboard-format";
import { createDb } from "../db.server";
import { contactsFrom } from "../import-csv";
import {
  beginImport,
  beginRead,
  hasAllOrders,
  importPage,
  type ImportSettings,
  parseSettings,
  startRun,
} from "../import.server";
import { enqueueJobs } from "../jobs/runner.server";
import { graphqlOf } from "../plan-sync.server";
import { getOrCreateShop } from "../shop.server";
import { authenticate } from "../shopify.server";

const IMPORTS_WHEN_RUN: Record<string, string> = {
  READY: "Comes in active",
  HOLD_TERM_PAST: "On hold: term date has passed with paid releases left",
  HOLD_RENEWAL_SOON: "On hold: renewal too soon for the upcoming-charge notice",
  HOLD_DEPLETED: "On hold: renews when paid releases run out, and they have",
  HOLD_ZERO_PRICE: "On hold: last purchase cost nothing",
  CANCELLED_OWED: "Comes in cancelled: paid releases ship, never charged",
};
const LEFT_OUT: Record<string, string> = {
  NO_CUSTOMER: "No customer with that email (or erased)",
  DUPLICATE_CONTACT: "Same customer as an earlier line",
  NO_ORDERS: "Customer has no real orders",
  UNRECOGNIZED_PLAN: "Orders, but none match a plan",
  HISTORY_TOO_LONG: "Too many orders to read",
  LAPSED: "Term over and nothing left",
  CANCELLED_NOTHING_OWED: "Cancelled, nothing owed",
  GIFT: "Bought as a gift",
  ADDRESS_NOT_ALLOWED: "Address outside your allowed countries",
  NO_ADDRESS: "No address",
  REDACTED: "Customer erased",
  ALREADY_SUBSCRIBED: "Already subscribed in this app",
  CURRENCY_DIFFERS: "Paid in another currency",
  PLAN_NOT_READY: "Plan isn't synced or has no product",
  IMPORTED_UNDER_ANOTHER_KEY: "Already imported, under a mapping or first order that has since changed: no second contract",
  READ_FAILED: "Couldn't read their orders after 5 tries: start a new dry run to try again",
};
const CATEGORY_TEXT: Record<string, string> = { ...IMPORTS_WHEN_RUN, ...LEFT_OUT };

const FLAG_TEXT: Record<string, string> = {
  NO_CARD: "No saved card: first charge will fail, retry, then pause",
  CARD_EXPIRED: "Saved card has expired",
  SEVERAL_CARDS: "Several saved cards: check the right one is used",
  STATUS_UNKNOWN: "Export doesn't say whether they cancelled",
  TWO_SUBSCRIPTIONS: "Looks like two subscriptions",
  QUANTITY_ABOVE_ONE: "More than one copy",
  PRICE_DIFFERS_FROM_PLAN: "Pays a different price from the plan",
  CHARGES_AT_NEXT_RELEASE: "Charged when the next release ships, with notice at its pre-order",
  PREORDER_SKIPPED: "Kept out of the open pre-order, which would charge with no notice",
  PREORDER_EMAIL_MISSED: "Gets the open pre-order, but not its email",
  OPEN_RELEASE_SKIPPED: "Kept out of a release already shipping; balance goes to the next",
  DATES_ONLY: "Shipped count is from dates, not orders",
  ISSUE_NOT_FOUND: "A release shipped in the term with no order for them",
  OVER_SHIPPED: "Sent a copy while nothing was paid for: it uses up nothing",
  CARRIED_OVER: "Has paid releases left from earlier purchases",
  SHIPPED_AFTER_TERM: "A release shipped after their term with nothing to show they got it, so they keep that paid release",
  HISTORY_BEFORE_LIST: "Bought before your shipped list starts, so that purchase's balance can't be seen: list earlier releases if any shipped",
  UNRECOGNIZED_LINES: "Also has subscription orders matching no plan",
  PARTIAL_REFUND: "Last purchase was partly refunded",
  PAID_SHIPPING: "Paid shipping before; none is billed here",
  PRICE_CHANGE_PENDING: "Keeps their price: a price rise was saved before they came in",
  ADDRESS_FROM_ORDER: "Address taken from their last order",
  CONTRACT_EXISTS: "A contract from an earlier try exists",
  CHANGED_SINCE_DRY_RUN: "Changed since the dry run",
  RENEWED_SINCE_IMPORT: "Bought again since the import: possible double charge",
};
const NEXT_CHARGE: Record<string, string> = {
  ON_TERM_DATE: "Term date",
  NEXT_RELEASE: "When a release ships with none paid",
  WHEN_RELEASES_RUN_OUT: "When releases run out",
  HELD: "None until released",
  NEVER: "Never",
};

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const { env } = context.cloudflare;
  const db = createDb(env.DB);
  const shop = await getOrCreateShop(db, session.shop);
  const url = new URL(request.url);
  const page = Math.max(0, Number(url.searchParams.get("page")) || 0);
  const graphql = graphqlOf(admin);
  const [report, plans, allOrders] = await Promise.all([
    importPage(db, env.DB, shop.id, url.searchParams.get("category"), page),
    db.plan.findMany({
      where: { shopId: shop.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, displayName: true },
    }),
    hasAllOrders(graphql),
  ]);
  const names = await customerNames(graphql, report.rows.flatMap((row) => row.customerGid ?? []));
  const planName = new Map(plans.map((plan) => [plan.id, plan.name]));
  const settings = report.run?.settings as ImportSettings | undefined;
  return {
    plans,
    allOrders,
    word: shop.releaseWordSingular,
    plural: shop.releaseWordPlural,
    page,
    more: report.more,
    run: report.run && {
      id: report.run.id,
      status: report.run.status,
      read: whenText(report.run.readAt, shop.timezone),
      imported: whenText(report.run.importedAt, shop.timezone),
      statusKnown: settings?.statusKnown ?? false,
    },
    counts: report.counts,
    toCheck: report.toCheck,
    rows: report.rows.map((row) => {
      const facts = JSON.parse(row.facts) as {
        lastOrderGid?: string;
        lastOrderName?: string;
        lastPurchaseAt?: string;
        quantity?: number;
        priceCents?: number;
        paid?: number;
        received?: number[];
        remaining?: number;
        firstReleaseNumber?: number;
        termEndsAt?: string | null;
        nextCharge?: string;
        carriedOver?: number;
        uncountedPurchases?: number;
      };
      return {
        ...row,
        name: row.customerGid ? customerLabel(names, row.customerGid) : null,
        customerId: row.customerGid ? idOf(row.customerGid) : null,
        plan: row.planId ? (planName.get(row.planId) ?? "") : "",
        flags: JSON.parse(row.flags) as string[],
        facts: {
          ...facts,
          orderId: facts.lastOrderGid ? idOf(facts.lastOrderGid) : null,
          bought: whenText(facts.lastPurchaseAt ?? null, shop.timezone),
          term: whenText(facts.termEndsAt ?? null, shop.timezone),
        },
      };
    }),
  };
};

type ActionData = { error?: string; errors?: string[]; runId?: string };

export const action = async ({ request, context }: ActionFunctionArgs): Promise<ActionData> => {
  const { session, admin } = await authenticate.admin(request);
  const { env } = context.cloudflare;
  const db = createDb(env.DB);
  const shop = await getOrCreateShop(db, session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const shopRef = { id: shop.id, shopDomain: session.shop };

  if (intent === "start") {
    const plans = Object.fromEntries(
      [...form.entries()]
        .filter(([name]) => name.startsWith("plan:"))
        .map(([name, value]) => [name.slice(5), String(value)]),
    );
    const parsed = parseSettings({
      plans,
      issues: String(form.get("issues") ?? ""),
      giftKeys: String(form.get("giftKeys") ?? ""),
      statusKnown: form.get("statusKnown") === "true",
      orderTag: String(form.get("orderTag") ?? ""),
      listFrom: String(form.get("listFrom") ?? ""),
    });
    if (!parsed.ok) return { errors: parsed.errors };
    return startRun(db, graphqlOf(admin), shop.id, parsed.settings);
  }
  const runId = String(form.get("runId"));
  if (intent === "read") {
    await enqueueJobs(env, await beginRead(db, shopRef, runId));
    return {};
  }
  if (intent === "import") {
    const jobs = await beginImport(db, env.DB, shopRef, runId);
    await enqueueJobs(env, jobs);
    return jobs.length ? {} : { error: "That dry run can't be imported. Start a new one." };
  }
  return { error: "Unknown action." };
};

const CONTACTS_PER_REQUEST = 50;

export default function ImportPage() {
  const { plans, allOrders, word, plural, run, counts, toCheck, rows, page, more } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [progress, setProgress] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [understood, setUnderstood] = useState(false);
  const working = run?.status === "READING" || run?.status === "IMPORTING";
  const pending = useRef<((data: ActionData) => void) | null>(null);

  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => revalidator.revalidate(), 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [working]);

  /**
   * The file stays in this page. It's read here, the settings make a run, then the contacts go up in
   * small requests. App Bridge adds the session token to `fetch`.
   */
  const startDryRun = async (form: HTMLFormElement) => {
    setProblem(null);
    const data = new FormData(form);
    const file = (form.querySelector("#contacts-file") as unknown as { files?: File[] } | null)?.files?.[0];
    if (!file) return setProblem("Choose the contacts export first.");
    const parsed = contactsFrom(await file.text(), {
      email: String(data.get("emailColumn") ?? ""),
      status: String(data.get("statusColumn") ?? ""),
      cancelled: String(data.get("cancelledValues") ?? ""),
    });
    if (!parsed.ok) return setProblem(parsed.error);
    data.delete("emailColumn");
    data.delete("cancelledValues");
    data.set("statusKnown", String(data.get("statusColumn") ?? "").trim() ? "true" : "false");
    data.delete("statusColumn");
    data.set("intent", "start");
    const started = await post(data);
    if (started.error || started.errors) {
      return setProblem(started.error ?? started.errors!.join(" "));
    }
    const { contacts } = parsed;
    for (let i = 0; i < contacts.length; i += CONTACTS_PER_REQUEST) {
      setProgress(`Finding customers: ${i} of ${contacts.length}`);
      const response = await fetch("/app/import/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: started.runId, contacts: contacts.slice(i, i + CONTACTS_PER_REQUEST) }),
      });
      if (!response.ok) {
        setProgress(null);
        return setProblem("Finding customers stopped part way. Start the dry run again.");
      }
    }
    setProgress(null);
    const read = new FormData();
    read.set("intent", "read");
    read.set("runId", started.runId!);
    await post(read);
    revalidator.revalidate();
  };

  const post = async (body: FormData) =>
    new Promise<ActionData>((resolve) => {
      pending.current = resolve;
      fetcher.submit(body, { method: "post" });
    });
  useEffect(() => {
    if (fetcher.state === "idle" && pending.current) {
      const resolve = pending.current;
      pending.current = null;
      resolve(fetcher.data ?? {});
    }
  }, [fetcher.state, fetcher.data]);

  const counted = (names: Record<string, string>) =>
    counts.filter((row) => row.category && names[row.category]);
  const totalFor = (state: string) =>
    counts.filter((row) => row.state === state).reduce((total, row) => total + row.n, 0);
  const toImport = counts
    .filter((row) => row.state === "READ" && row.category && IMPORTS_WHEN_RUN[row.category])
    .reduce((total, row) => total + row.n, 0);
  const statusBlocked = run && !run.statusKnown && !understood;

  return (
    <s-page heading="Import subscribers">
      {!allOrders && (
        <s-banner tone="critical" heading="Can't read old orders yet">
          <s-paragraph>The app needs the read_all_orders permission before an import can run.</s-paragraph>
        </s-banner>
      )}
      {problem && (
        <s-banner tone="critical" heading="That didn't start">
          <s-paragraph>{problem}</s-paragraph>
        </s-banner>
      )}
      {fetcher.data?.error && (
        <s-banner tone="critical" heading="That didn't work">
          <s-paragraph>{fetcher.data.error}</s-paragraph>
        </s-banner>
      )}

      <s-section heading="Start a dry run">
        <s-paragraph>
          A dry run reads each contact&apos;s order history and writes nothing to Shopify or to your
          subscribers. Your export stays in this browser: only each contact&apos;s email and whether
          they cancelled are sent, to find the customer, and neither is stored.
        </s-paragraph>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void startDryRun(event.currentTarget);
          }}
        >
          <s-stack gap="base">
            <s-drop-zone id="contacts-file" label="Contacts export (CSV)" accept=".csv,text/csv" />
            <s-stack direction="inline" gap="base">
              <s-text-field name="emailColumn" label="Email column" value="Email" />
              <s-text-field
                name="statusColumn"
                label="Status column (if the export has one)"
                details="Without one, nobody can be recognized as cancelled."
              />
              <s-text-field
                name="cancelledValues"
                label="Status values that mean cancelled"
                value="cancelled, canceled, inactive, expired"
              />
            </s-stack>
            {plans.map((plan) => (
              <s-text-field
                key={plan.id}
                name={`plan:${plan.id}`}
                label={`Order lines that mean "${plan.name}"`}
                details="Comma separated. The old app's selling plan name, a SKU, or a product or variant ID."
              />
            ))}
            <s-text-area
              name="issues"
              label={`Each ${word} already shipped, one a line`}
              details={`number | title | YYYY-MM-DD | product or variant IDs or SKUs on its orders (optional). Without the last part, a subscriber counts as having received it if it shipped during their term while they had a paid ${word} left. Reach back as far as your subscribers' purchases go: a purchase from before the first line can't be counted. Numbers carry on into your new ${plural}.`}
              rows={5}
            />
            <s-text-field
              name="listFrom"
              label="The list covers everything from (optional)"
              details={`YYYY-MM-DD. If subscriptions began before the first ${word} above, the day they began: purchases from then count in full, as nothing shipped to subscribers before that ${word}. Leave empty to start at the first line.`}
            />
            <s-text-field
              name="giftKeys"
              label="Line properties that mark a gift (optional)"
              value="Gift recipient email"
            />
            <s-text-field
              name="orderTag"
              label={`Order tag on subscribers' ${plural} (optional)`}
              details={`With order lines listed above, an order counts for a listed ${word} only if it has this tag, so a copy someone bought in your shop isn't counted as theirs. Leave empty to count every order.`}
            />
            <s-stack direction="inline" gap="base">
              <s-button
                type="submit"
                variant="primary"
                disabled={!allOrders || working || progress !== null}
              >
                Start dry run
              </s-button>
              {progress && <s-text>{progress}</s-text>}
            </s-stack>
          </s-stack>
        </form>
      </s-section>

      {run && (
        <s-section heading="Report">
          <s-stack gap="base">
            {run.status === "COLLECTING" && <s-paragraph>Finding customers…</s-paragraph>}
            {run.status === "READING" && <s-paragraph>Reading order history…</s-paragraph>}
            {run.status === "IMPORTING" && <s-paragraph>Creating contracts, a few a minute at most…</s-paragraph>}
            {run.read && (
              <s-banner tone="warning" heading={`Term dates were read on ${run.read}`}>
                <s-paragraph>
                  The old app keeps charging until you switch it off, and this one never touches its
                  contracts. A subscriber who renews there after this moment renews with a new date.
                  The real run reads every subscriber again and uses what it finds. Anyone with a
                  renewal under 21 days away is held, which also gives you that long to switch it off.
                </s-paragraph>
              </s-banner>
            )}
            {!run.statusKnown && run.read && (
              <s-banner tone="critical" heading="The export didn't say who cancelled">
                <s-paragraph>
                  Someone who cancelled in the old app with a term still running looks active, and
                  would be charged at their term date unless they cancel after the upcoming-charge notice.
                </s-paragraph>
              </s-banner>
            )}
            {toCheck && toCheck.carried > 0 && (
              <s-paragraph>
                {toCheck.carried} carry paid {plural} over from earlier purchases: worth spot-checking.
                Unused paid {plural} carry forward, so these get every one they paid for.
              </s-paragraph>
            )}
            {toCheck && toCheck.beforeList > 0 && (
              <s-banner tone="warning" heading={`${toCheck.beforeList} bought before your shipped list starts`}>
                <s-paragraph>
                  What those purchases were used for can&apos;t be seen, so they aren&apos;t counted, and
                  unused {plural} from them are lost. If earlier {plural} shipped, add them to the list and
                  run this again.
                </s-paragraph>
              </s-banner>
            )}
            <s-table>
              <s-table-header-row>
                <s-table-header>What happens</s-table-header>
                <s-table-header>Result</s-table-header>
                <s-table-header>People</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {[...counted(IMPORTS_WHEN_RUN), ...counted(LEFT_OUT)].map((row) => (
                  <s-table-row key={`${row.category}${row.state}`}>
                    <s-table-cell>
                      <s-link onClick={() => navigate(`?category=${row.category}`)}>
                        {CATEGORY_TEXT[row.category!]}
                      </s-link>
                    </s-table-cell>
                    <s-table-cell>
                      {row.state === "DONE" ? "Imported" : row.state === "FAILED" ? "Shopify refused" : row.state === "SKIPPED" ? "Left out on the fresh read" : IMPORTS_WHEN_RUN[row.category!] ? "Will import" : "Left out"}
                    </s-table-cell>
                    <s-table-cell>{row.n}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
            <s-link href={`/app/import/${run.id}/export`} target="_blank">Download the report</s-link>
            {run.status === "READ" && toImport > 0 && (
              <s-stack gap="small">
                <s-paragraph>
                  The real run creates {toImport} {toImport === 1 ? "contract" : "contracts"}, each on the customer&apos;s saved card if they
                  have one. It charges nobody, makes no orders, and sends no welcome email. It reads
                  each subscriber again first.
                </s-paragraph>
                {!run.statusKnown && (
                  <s-checkbox
                    label="I understand nobody here can be recognized as cancelled"
                    checked={understood}
                    onChange={(event: Event) => setUnderstood((event.currentTarget as HTMLInputElement).checked)}
                  />
                )}
                <s-button
                  variant="primary"
                  tone="critical"
                  disabled={Boolean(statusBlocked) || fetcher.state !== "idle"}
                  onClick={() => fetcher.submit({ intent: "import", runId: run.id }, { method: "post" })}
                >
                  Start real run
                </s-button>
              </s-stack>
            )}
            {(run.status === "DONE" || totalFor("DONE") > 0) && (
              <s-paragraph>{totalFor("DONE")} imported. {totalFor("FAILED")} refused by Shopify.</s-paragraph>
            )}
          </s-stack>
        </s-section>
      )}

      {rows.length > 0 && (
        <s-section heading={params.get("category") ? CATEGORY_TEXT[params.get("category")!] : "Everyone"} padding="none">
          <s-table
            paginate={more || page > 0}
            hasNextPage={more}
            hasPreviousPage={page > 0}
            onNextPage={() => {
              const next = new URLSearchParams(params);
              next.set("page", String(page + 1));
              navigate(`?${next}`);
            }}
            onPreviousPage={() => navigate(-1)}
          >
            <s-table-header-row>
              <s-table-header>Line</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Outcome</s-table-header>
              <s-table-header>Plan</s-table-header>
              <s-table-header>Last purchase</s-table-header>
              <s-table-header>Copies, price</s-table-header>
              <s-table-header>Paid, got, left</s-table-header>
              <s-table-header>First {word}</s-table-header>
              <s-table-header>Term ends</s-table-header>
              <s-table-header>Next charge</s-table-header>
              <s-table-header>Check</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((row) => (
                <s-table-row key={row.id}>
                  <s-table-cell>{row.contactNumber}</s-table-cell>
                  <s-table-cell>
                    {row.subscriptionId ? (
                      <s-link href={`/app/subscribers/${row.subscriptionId}`}>{row.name}</s-link>
                    ) : row.customerId && row.customerGid !== "redacted" ? (
                      <s-link href={`shopify://admin/customers/${row.customerId}`}>{row.name}</s-link>
                    ) : (
                      (row.name ?? "See this line of your export")
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    {CATEGORY_TEXT[row.category ?? ""] ?? row.category ?? "Not read yet"}
                    {row.error ? ` (${row.error})` : ""}
                  </s-table-cell>
                  <s-table-cell>{row.plan}</s-table-cell>
                  <s-table-cell>
                    {row.facts.orderId && (
                      <s-link href={`shopify://admin/orders/${row.facts.orderId}`}>
                        {row.facts.lastOrderName}
                      </s-link>
                    )}{" "}
                    {row.facts.bought}
                  </s-table-cell>
                  <s-table-cell>
                    {row.facts.quantity !== undefined &&
                      `${row.facts.quantity} at $${((row.facts.priceCents ?? 0) / 100).toFixed(2)}`}
                  </s-table-cell>
                  <s-table-cell>
                    {row.facts.paid !== undefined &&
                      `${row.facts.paid}, ${(row.facts.received ?? []).length}${
                        (row.facts.received ?? []).length ? ` (${row.facts.received!.join(", ")})` : ""
                      }, ${row.facts.remaining}`}
                  </s-table-cell>
                  <s-table-cell>{row.facts.firstReleaseNumber}</s-table-cell>
                  <s-table-cell>{row.facts.term}</s-table-cell>
                  <s-table-cell>{row.facts.nextCharge ? NEXT_CHARGE[row.facts.nextCharge] : ""}</s-table-cell>
                  <s-table-cell>
                    <s-stack gap="small-300">
                      {row.flags.map((flag) => (
                        <s-text key={flag}>
                          {FLAG_TEXT[flag] ?? flag}
                          {flag === "CARRIED_OVER" ? ` (${row.facts.carriedOver})` : ""}
                          {flag === "HISTORY_BEFORE_LIST" && row.facts.uncountedPurchases
                            ? ` (${row.facts.uncountedPurchases} not counted)`
                            : ""}
                        </s-text>
                      ))}
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

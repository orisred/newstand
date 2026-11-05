import { useEffect, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useRevalidator,
  useSearchParams,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { resumeJob } from "../billing.server";
import { createDb } from "../db.server";
import { enqueueJobs } from "../jobs/runner.server";
import { graphqlOf } from "../plan-sync.server";
import {
  actionsFor,
  capitalize,
  isReleaseAction,
  type ReleaseAction,
} from "../release-actions";
import { formatZoned, zonedFields, zonedToUtc } from "../release-dates";
import {
  createRelease,
  listPaymentProblems,
  listReleases,
  listRunProgress,
  moveRelease,
  parseQuantity,
  parseTitle,
  scheduleRelease,
  setReleaseProduct,
  TITLE_MAX_LENGTH,
} from "../releases.server";
import { getOrCreateShop } from "../shop.server";
import { authenticate } from "../shopify.server";
import { GIFT_INVALID_EVENT } from "../gifts.server";
import { MIXED_HANDLED_EVENT, MIXED_PLANS_EVENT } from "../subscriptions.server";

const TIMEZONE = `#graphql
  query ShopTimezone { shop { ianaTimezone } }`;

/** Reads the store's timezone and keeps it, so a page load needs no Admin API call after this. */
async function refreshTimezone(
  db: ReturnType<typeof createDb>,
  admin: Parameters<typeof graphqlOf>[0],
  shopId: string,
) {
  const { shop } = await graphqlOf(admin)(TIMEZONE);
  const timezone = shop.ianaTimezone as string;
  await db.shop.update({ where: { id: shopId }, data: { timezone } });
  return timezone;
}

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const db = createDb(context.cloudflare.env.DB);
  const shop = await getOrCreateShop(db, session.shop);
  const timezone = shop.timezone ?? (await refreshTimezone(db, admin, shop.id));
  const before = Number(new URL(request.url).searchParams.get("before"));
  const { releases: rows, nextBefore } = await listReleases(
    db,
    shop.id,
    Number.isInteger(before) && before > 0 ? before : undefined,
  );
  // Dates are text by here, on the store's clock, so the browser never works them out.
  const releases = rows.map((release) => ({
    ...release,
    preorderText:
      release.preorderOpensAt &&
      formatZoned(release.preorderOpensAt, timezone),
    cutoffText: release.cutoffAt && formatZoned(release.cutoffAt, timezone),
    preorderFields:
      release.preorderOpensAt && zonedFields(release.preorderOpensAt, timezone),
    cutoffFields: release.cutoffAt && zonedFields(release.cutoffAt, timezone),
  }));
  const [runs, problems, mixed] = await Promise.all([
    listRunProgress(db, shop.orderTiming, rows),
    listPaymentProblems(db, shop.id),
    db.event.findMany({
      where: {
        shopId: shop.id,
        type: { in: [MIXED_PLANS_EVENT, GIFT_INVALID_EVENT] },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, type: true, payload: true },
    }),
  ]);
  return {
    word: shop.releaseWordSingular,
    plural: shop.releaseWordPlural,
    releases,
    nextBefore,
    runs,
    timezone,
    paymentProblems: problems.rows.map((row) => {
      const [last] = row.billingAttempts;
      return {
        id: row.id,
        plan: row.plan.name,
        customerId: row.customerGid.split("/").pop(),
        chargeback: row.pausedReason === "CHARGEBACK",
        paused: row.status === "PAUSED",
        // Shopify's code, in lower case: it's specific, and there are too many to word by hand.
        error: last?.errorCode?.replaceAll("_", " ").toLowerCase() ?? null,
        tries: last?.attempt ?? 0,
        nextTry: last?.nextRetryAt && formatZoned(last.nextRetryAt, timezone),
      };
    }),
    morePaymentProblems: problems.more,
    mixed: mixed.map(({ id, type, payload }) => {
      const { orderGid, orderName } = payload as {
        orderGid?: string;
        orderName?: string;
      };
      const orderId = String(orderGid).split("/").pop();
      return {
        id,
        gift: type === GIFT_INVALID_EVENT,
        orderId,
        orderName: orderName ?? `Order ${orderId}`,
      };
    }),
    // One-time token for the create form: a double submit carries the same one.
    createKey: crypto.randomUUID(),
  };
};

type ActionData = { ok: boolean; message: string };

const KEY_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const { env } = context.cloudflare;
  const db = createDb(env.DB);
  const shop = await getOrCreateShop(db, session.shop);
  const word = shop.releaseWordSingular;
  const intent = form.get("intent");

  if (intent === "create") {
    const key = form.get("key");
    const title = parseTitle(form.get("title"));
    const quantity = parseQuantity(form.get("quantity"));
    if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
      return {
        ok: false,
        message: "Reload the page and try again.",
      } satisfies ActionData;
    }
    if (!title) {
      return {
        ok: false,
        message: `Enter a title of up to ${TITLE_MAX_LENGTH} characters.`,
      } satisfies ActionData;
    }
    if ("error" in quantity) {
      return {
        ok: false,
        message: "Quantity must be a whole number, or empty for no cap.",
      } satisfies ActionData;
    }
    const { created } = await createRelease(db, shop.id, {
      key,
      title,
      quantity: quantity.quantity,
    });
    return {
      ok: true,
      message: created
        ? `${capitalize(word)} created.`
        : `That ${word} was already created.`,
    } satisfies ActionData;
  }

  if (intent === "mixedHandled") {
    const { count } = await db.event.updateMany({
      where: {
        id: String(form.get("eventId")),
        shopId: shop.id,
        type: { in: [MIXED_PLANS_EVENT, GIFT_INVALID_EVENT] },
      },
      data: { type: MIXED_HANDLED_EVENT },
    });
    return {
      ok: count === 1,
      message: count === 1 ? "Marked as handled." : "That sign-up was already handled.",
    } satisfies ActionData;
  }

  if (intent === "retryCharge") {
    const subscriptionId = String(form.get("subscriptionId"));
    const owned = await db.subscription.count({
      where: { id: subscriptionId, shopId: shop.id },
    });
    if (owned === 0) {
      return {
        ok: false,
        message: "That subscriber no longer exists.",
      } satisfies ActionData;
    }
    await enqueueJobs(env, [
      resumeJob(session.shop, subscriptionId, crypto.randomUUID(), true),
    ]);
    return {
      ok: true,
      message: "Done. It takes a moment to show here.",
    } satisfies ActionData;
  }

  const releaseId = form.get("releaseId");
  if (intent === "schedule" && typeof releaseId === "string") {
    // Read fresh here, so a store that changed timezone saves what the merchant meant.
    const timezone = await refreshTimezone(db, admin, shop.id);
    const when = (field: string) => {
      const date = String(form.get(`${field}Date`) ?? "");
      return date
        ? zonedToUtc(date, Number(form.get(`${field}Hour`)), timezone)
        : null;
    };
    return scheduleRelease(db, shop.id, releaseId, word, {
      mode: form.get("mode") === "SCHEDULED" ? "SCHEDULED" : "MANUAL",
      preorderOpensAt: when("preorder"),
      cutoffAt: when("cutoff"),
    });
  }
  if (intent === "setProduct" && typeof releaseId === "string") {
    const saved = await setReleaseProduct(
      db,
      env,
      { ...shop, shopDomain: session.shop },
      releaseId,
      String(form.get("productGid")),
      String(form.get("productTitle")),
    );
    return {
      ok: saved,
      message: saved
        ? `Product saved for this ${word}.`
        : `Nothing changed: that isn't a product variant of this ${word}.`,
    } satisfies ActionData;
  }
  if (!isReleaseAction(intent) || typeof releaseId !== "string") {
    return { ok: false, message: "Unknown action." } satisfies ActionData;
  }
  return moveRelease(
    db,
    env,
    { ...shop, shopDomain: session.shop },
    releaseId,
    intent,
  );
};

const BUTTON_LABEL: Record<ReleaseAction, string> = {
  announce: "Announce pre-order",
  ready: "Ready to ship",
  ship: "Mark as shipped",
  cancel: "Cancel",
};

const BADGE_TONE = {
  UNANNOUNCED: "neutral",
  PREORDER: "info",
  READY: "warning",
  SHIPPED: "success",
  CANCELLED: "critical",
} as const;

const STATUS_TEXT = {
  UNANNOUNCED: "Unannounced",
  PREORDER: "Pre-order",
  READY: "Ready to ship",
  SHIPPED: "Shipped",
  CANCELLED: "Cancelled",
} as const;

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

const hourLabel = (hour: number) =>
  `${hour % 12 || 12}:00 ${hour < 12 ? "AM" : "PM"}`;

function DateAndHour({
  label,
  name,
  value,
}: {
  label: string;
  name: string;
  value: { date: string; hour: number } | null;
}) {
  return (
    <s-stack direction="inline" gap="base">
      <s-date-field
        label={label}
        name={`${name}Date`}
        defaultValue={value?.date ?? ""}
      />
      <s-select
        label="Time"
        name={`${name}Hour`}
        value={String(value?.hour ?? 9)}
      >
        {HOURS.map((hour) => (
          <s-option key={hour} value={String(hour)}>
            {hourLabel(hour)}
          </s-option>
        ))}
      </s-select>
    </s-stack>
  );
}

export default function Releases() {
  const {
    word,
    plural,
    releases,
    nextBefore,
    createKey,
    runs,
    timezone,
    mixed,
    paymentProblems,
    morePaymentProblems,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const { revalidate } = useRevalidator();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [cancelling, setCancelling] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [scheduling, setScheduling] = useState<
    (typeof releases)[number] | null
  >(null);
  const scheduleForm = useRef<HTMLFormElement>(null);
  const busy = fetcher.state !== "idle";
  const heading = capitalize(plural);
  // A run can take a while, so its progress moves on the screen while there's something to see.
  const running = releases.some(
    (release) => release.productGid && runs[release.id]?.waiting > 0,
  );

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(revalidate, 30_000);
    return () => clearInterval(timer);
  }, [running, revalidate]);

  useEffect(() => {
    if (fetcher.data) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    }
  }, [fetcher.data, shopify]);

  // A run assigns its subscribers a moment after the press, and then there's progress to show.
  useEffect(() => {
    if (!fetcher.data?.ok) return;
    const timer = setTimeout(revalidate, 5000);
    return () => clearTimeout(timer);
  }, [fetcher.data, revalidate]);

  const act = (intent: ReleaseAction, releaseId: string) =>
    fetcher.submit({ intent, releaseId }, { method: "POST" });

  const exportRun = async ({ id, number }: { id: string; number: number }) => {
    const response = await fetch(`/app/releases/${encodeURIComponent(id)}/export`);
    if (!response.ok) {
      shopify.toast.show("The export didn't work. Try again.", { isError: true });
      return;
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(await response.blob());
    link.download = `${word}-${number}-orders.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const pickProduct = async (releaseId: string) => {
    // The product picker, because the variant picker shows a one-variant product with no name.
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: false,
      action: "select",
    });
    const product = selected?.[0] as
      | { title: string; variants: { id?: string; title?: string }[] }
      | undefined;
    if (!product) return;
    if (product.variants.length !== 1 || !product.variants[0].id) {
      shopify.toast.show(
        `Choose one variant to ship with this ${word}, not the whole product.`,
        { isError: true },
      );
      return;
    }
    const [variant] = product.variants;
    fetcher.submit(
      {
        intent: "setProduct",
        releaseId,
        productGid: variant.id!,
        productTitle:
          variant.title && variant.title !== "Default Title"
            ? `${product.title} - ${variant.title}`
            : product.title,
      },
      { method: "POST" },
    );
  };

  return (
    <s-page heading={heading}>
      {[
        {
          gift: false,
          heading: "A sign-up needs you: one contract holds more than one plan",
          text: "Shopify put two plans on one subscription contract, and a contract is charged as a whole, so the app can't charge them separately. No subscription was created and the order stays unfulfilled. Refund it and ask the customer to buy each plan separately.",
        },
        {
          gift: true,
          heading: "A gift needs you: its recipient couldn't be used",
          text: "The buyer paid for a gift, but the recipient's email was missing, invalid, refused by Shopify, or the gift sat in a cart with other subscriptions. No subscription was created, so nothing will ship or be charged, and the order stays unfulfilled. Contact the buyer, then refund the order or cancel its subscription contract in Shopify.",
        },
      ].map(({ gift, heading: title, text }) => {
        const rows = mixed.filter((row) => row.gift === gift);
        return (
          rows.length > 0 && (
            <s-banner key={title} tone="critical" heading={title}>
              <s-stack gap="base">
                <s-paragraph>{text}</s-paragraph>
                {rows.map(({ id, orderId, orderName }) => (
                  <s-stack
                    key={id}
                    direction="inline"
                    gap="base"
                    alignItems="center"
                  >
                    <s-link href={`shopify://admin/orders/${orderId}`}>
                      {orderName}
                    </s-link>
                    <s-button
                      {...(busy ? { disabled: true } : {})}
                      onClick={() =>
                        fetcher.submit(
                          { intent: "mixedHandled", eventId: id },
                          { method: "POST" },
                        )
                      }
                    >
                      Mark as handled
                    </s-button>
                  </s-stack>
                ))}
              </s-stack>
            </s-banner>
          )
        );
      })}
      {paymentProblems.length > 0 && (
        <s-section heading="Payment problems">
          <s-stack gap="base">
            <s-paragraph>
              Once paid, the {word} that failed ships late. On a bundle, so does
              each {word} due meanwhile, as far as the renewal covers. On pay per{" "}
              {word}, those are skipped. Paid {plural} still ship, unless
              there&apos;s a chargeback.
            </s-paragraph>
            {paymentProblems.map((problem) => (
              <s-stack
                key={problem.id}
                direction="inline"
                gap="base"
                alignItems="center"
              >
                <s-link href={`shopify://admin/customers/${problem.customerId}`}>
                  Customer {problem.customerId}
                </s-link>
                <s-text>{problem.plan}</s-text>
                {problem.chargeback ? (
                  <s-badge tone="critical">Chargeback</s-badge>
                ) : problem.paused ? (
                  <s-badge tone="critical">Paused</s-badge>
                ) : (
                  <s-badge tone="warning">Retrying</s-badge>
                )}
                {problem.error && (
                  <s-text color="subdued">
                    {problem.error}, after {problem.tries}{" "}
                    {problem.tries === 1 ? "try" : "tries"}
                  </s-text>
                )}
                {problem.nextTry && (
                  <s-text color="subdued">Next try {problem.nextTry}</s-text>
                )}
                <s-button
                  {...(busy ? { disabled: true } : {})}
                  onClick={() =>
                    fetcher.submit(
                      { intent: "retryCharge", subscriptionId: problem.id },
                      { method: "POST" },
                    )
                  }
                >
                  {problem.chargeback ? "End the hold" : "Retry charge"}
                </s-button>
              </s-stack>
            ))}
            {morePaymentProblems && (
              <s-text color="subdued">
                More subscribers have payment problems. They appear here as these
                are resolved.
              </s-text>
            )}
          </s-stack>
        </s-section>
      )}
      <s-section heading={`New ${word}`}>
        {/* Keyed on the token, so the form clears when a new one arrives. */}
        <fetcher.Form method="post" key={createKey}>
          <input type="hidden" name="intent" value="create" />
          <input type="hidden" name="key" value={createKey} />
          <s-stack gap="base">
            <s-text-field label="Title" name="title" required />
            <s-number-field
              label="Quantity"
              name="quantity"
              min={1}
              details="Optional. Leave empty for no cap."
            />
            <s-stack direction="inline">
              <s-button type="submit" {...(busy ? { loading: true } : {})}>
                Create {word}
              </s-button>
            </s-stack>
          </s-stack>
        </fetcher.Form>
      </s-section>

      <s-section padding="none">
        {releases.length === 0 && nextBefore === null ? (
          <s-box padding="base">
            <s-paragraph>
              No {plural} yet. Create the first one above.
            </s-paragraph>
          </s-box>
        ) : (
          <s-table
            paginate={nextBefore !== null || searchParams.has("before")}
            hasNextPage={nextBefore !== null}
            hasPreviousPage={searchParams.has("before")}
            onNextPage={() => navigate(`?before=${nextBefore}`)}
            onPreviousPage={() => navigate(-1)}
          >
            <s-table-header-row>
              <s-table-header>No.</s-table-header>
              <s-table-header>Title</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Quantity</s-table-header>
              <s-table-header>Ships as</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {releases.map((release) => (
                <s-table-row key={release.id}>
                  <s-table-cell>{release.number}</s-table-cell>
                  <s-table-cell>{release.title}</s-table-cell>
                  <s-table-cell>
                    <s-stack gap="small-300">
                      <s-badge tone={BADGE_TONE[release.status]}>
                        {STATUS_TEXT[release.status]}
                      </s-badge>
                      {release.preorderText && (
                        <s-text color="subdued">
                          {release.status === "UNANNOUNCED"
                            ? "Pre-order opens"
                            : "Announced"}{" "}
                          {release.preorderText}
                        </s-text>
                      )}
                      {release.cutoffText && (
                        <s-text color="subdued">
                          {release.status === "UNANNOUNCED" ||
                          release.status === "PREORDER"
                            ? "Ready to ship on"
                            : "Ready"}{" "}
                          {release.cutoffText}
                        </s-text>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{release.quantity ?? "No cap"}</s-table-cell>
                  <s-table-cell>
                    <s-stack gap="small-300">
                      {release.productTitle ? (
                        <s-text>{release.productTitle}</s-text>
                      ) : (
                        <s-badge tone="warning">No product chosen</s-badge>
                      )}
                      {runs[release.id] && (
                        <s-text color="subdued">
                          {runs[release.id].ordered} of{" "}
                          {runs[release.id].ordered +
                            runs[release.id].waiting +
                            runs[release.id].refused +
                            runs[release.id].held}{" "}
                          orders created.
                        </s-text>
                      )}
                      {runs[release.id]?.held > 0 && (
                        <s-text color="subdued">
                          {runs[release.id].held} held: waiting for payment. They
                          ship late once paid.
                        </s-text>
                      )}
                      {runs[release.id]?.waiting > 0 && !release.productGid && (
                        <s-text tone="critical">
                          {runs[release.id].waiting} waiting for an order. Choose
                          a product to ship this {word}.
                        </s-text>
                      )}
                      {runs[release.id]?.waiting > 0 && release.productGid && (
                        <s-text color="subdued">
                          {runs[release.id].waiting} being created. Shopify limits
                          how fast this goes, and it carries on by itself.
                        </s-text>
                      )}
                      {runs[release.id]?.refused > 0 && (
                        <s-text tone="critical">
                          {runs[release.id].refused} refused:{" "}
                          {runs[release.id].error} Choose the product again to
                          retry.
                        </s-text>
                      )}
                      <s-stack direction="inline">
                        <s-button
                          variant="tertiary"
                          {...(busy ? { disabled: true } : {})}
                          onClick={() => pickProduct(release.id)}
                        >
                          {release.productGid ? "Change" : "Choose product"}
                        </s-button>
                        {runs[release.id] && (
                          <s-button
                            variant="tertiary"
                            onClick={() => exportRun(release)}
                          >
                            Export CSV
                          </s-button>
                        )}
                      </s-stack>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small">
                      {(release.status === "UNANNOUNCED" ||
                        release.status === "PREORDER") && (
                        <s-button
                          commandFor="schedule-modal"
                          command="--show"
                          onClick={() => setScheduling(release)}
                        >
                          {release.triggerMode === "SCHEDULED"
                            ? "Change dates"
                            : "Schedule"}
                        </s-button>
                      )}
                      {actionsFor(release.status)
                        // Orders use up paid releases, so the server refuses this too.
                        .filter(
                          (name) =>
                            name !== "cancel" || !runs[release.id]?.ordered,
                        )
                        .map((name) =>
                        name === "cancel" ? (
                          <s-button
                            key={name}
                            tone="critical"
                            commandFor="cancel-modal"
                            command="--show"
                            onClick={() =>
                              setCancelling({
                                id: release.id,
                                label: `${release.number}. ${release.title}`,
                              })
                            }
                          >
                            {BUTTON_LABEL[name]}
                          </s-button>
                        ) : (
                          <s-button
                            key={name}
                            variant={name === "ship" ? "secondary" : "primary"}
                            {...(busy ? { disabled: true } : {})}
                            onClick={() => act(name, release.id)}
                          >
                            {BUTTON_LABEL[name]}
                          </s-button>
                        ),
                      )}
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-modal id="schedule-modal" heading={`Schedule this ${word}`}>
        {/* Keyed on the release, so the fields start from its dates each time. */}
        <form ref={scheduleForm} key={scheduling?.id}>
          <s-stack gap="base">
            <s-paragraph>
              Times are in the store&apos;s timezone ({timezone}). The app checks
              once an hour, so each step happens within the hour after its date.
              You can still press a step&apos;s button early.
            </s-paragraph>
            <s-select
              label="How it moves on"
              name="mode"
              value={scheduling?.triggerMode ?? "MANUAL"}
            >
              <s-option value="MANUAL">When I press the buttons</s-option>
              <s-option value="SCHEDULED">On these dates</s-option>
            </s-select>
            {scheduling?.status === "UNANNOUNCED" && (
              <DateAndHour
                label="Pre-order opens"
                name="preorder"
                value={scheduling.preorderFields ?? null}
              />
            )}
            <DateAndHour
              label="Ready to ship"
              name="cutoff"
              value={scheduling?.cutoffFields ?? null}
            />
          </s-stack>
        </form>
        <s-button
          slot="primary-action"
          variant="primary"
          commandFor="schedule-modal"
          command="--hide"
          onClick={() => {
            if (!scheduling || !scheduleForm.current) return;
            const form = new FormData(scheduleForm.current);
            form.set("intent", "schedule");
            form.set("releaseId", scheduling.id);
            fetcher.submit(form, { method: "POST" });
          }}
        >
          Save
        </s-button>
        <s-button
          slot="secondary-actions"
          commandFor="schedule-modal"
          command="--hide"
        >
          Close
        </s-button>
      </s-modal>

      <s-modal id="cancel-modal" heading={`Cancel this ${word}?`}>
        <s-paragraph>
          {cancelling?.label} will be cancelled and can&apos;t be brought back.
          Subscribers assigned to it stay paid for the next {word}.
        </s-paragraph>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          commandFor="cancel-modal"
          command="--hide"
          onClick={() => cancelling && act("cancel", cancelling.id)}
        >
          Cancel {word}
        </s-button>
        <s-button
          slot="secondary-actions"
          commandFor="cancel-modal"
          command="--hide"
        >
          Keep it
        </s-button>
      </s-modal>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

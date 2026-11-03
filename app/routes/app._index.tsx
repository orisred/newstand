import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useSearchParams,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { createDb } from "../db.server";
import {
  actionsFor,
  capitalize,
  isReleaseAction,
  type ReleaseAction,
} from "../release-actions";
import {
  createRelease,
  listReleases,
  listWaitingOrders,
  parseQuantity,
  parseTitle,
  setReleaseProduct,
  transitionRelease,
  TITLE_MAX_LENGTH,
} from "../releases.server";
import { getOrCreateShop } from "../shop.server";
import { authenticate } from "../shopify.server";
import { MIXED_HANDLED_EVENT, MIXED_PLANS_EVENT } from "../subscriptions.server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = createDb(context.cloudflare.env.DB);
  const shop = await getOrCreateShop(db, session.shop);
  const before = Number(new URL(request.url).searchParams.get("before"));
  const { releases, nextBefore } = await listReleases(
    db,
    shop.id,
    Number.isInteger(before) && before > 0 ? before : undefined,
  );
  const [waiting, mixed] = await Promise.all([
    listWaitingOrders(db, shop.orderTiming, releases),
    db.event.findMany({
      where: { shopId: shop.id, type: MIXED_PLANS_EVENT },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, payload: true },
    }),
  ]);
  return {
    word: shop.releaseWordSingular,
    plural: shop.releaseWordPlural,
    releases,
    nextBefore,
    waiting,
    mixed: mixed.map(({ id, payload }) => {
      const { orderGid, orderName } = payload as {
        orderGid?: string;
        orderName?: string;
      };
      const orderId = String(orderGid).split("/").pop();
      return { id, orderId, orderName: orderName ?? `Order ${orderId}` };
    }),
    // One-time token for the create form: a double submit carries the same one.
    createKey: crypto.randomUUID(),
  };
};

type ActionData = { ok: boolean; message: string };

const KEY_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const db = createDb(context.cloudflare.env.DB);
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
        type: MIXED_PLANS_EVENT,
      },
      data: { type: MIXED_HANDLED_EVENT },
    });
    return {
      ok: count === 1,
      message: count === 1 ? "Marked as handled." : "That sign-up was already handled.",
    } satisfies ActionData;
  }

  const releaseId = form.get("releaseId");
  if (intent === "setProduct" && typeof releaseId === "string") {
    const saved = await setReleaseProduct(
      db,
      context.cloudflare.env,
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
  return transitionRelease(db, shop.id, releaseId, intent, word);
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

const day = (date: Date | null) =>
  date ? date.toISOString().slice(0, 10) : null;

export default function Releases() {
  const { word, plural, releases, nextBefore, createKey, waiting, mixed } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [cancelling, setCancelling] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const busy = fetcher.state !== "idle";
  const heading = capitalize(plural);

  useEffect(() => {
    if (fetcher.data) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    }
  }, [fetcher.data, shopify]);

  const act = (intent: ReleaseAction, releaseId: string) =>
    fetcher.submit({ intent, releaseId }, { method: "POST" });

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
      {mixed.length > 0 && (
        <s-banner
          tone="critical"
          heading="A sign-up needs you: one contract holds more than one plan"
        >
          <s-stack gap="base">
            <s-paragraph>
              Shopify put two plans on one subscription contract, and a contract
              is charged as a whole, so the app can&apos;t charge them separately.
              No subscription was created and the order stays unfulfilled. Refund
              it and ask the customer to buy each plan separately.
            </s-paragraph>
            {mixed.map(({ id, orderId, orderName }) => (
              <s-stack key={id} direction="inline" gap="base" alignItems="center">
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
                      {day(release.preorderOpensAt) && (
                        <s-text color="subdued">
                          Announced {day(release.preorderOpensAt)}
                        </s-text>
                      )}
                      {day(release.cutoffAt) && (
                        <s-text color="subdued">
                          Ready {day(release.cutoffAt)}
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
                      {waiting[release.id] && (
                        <s-text tone="critical">
                          {waiting[release.id].count} waiting for an order.{" "}
                          {waiting[release.id].error ??
                            (release.productGid
                              ? "Being created."
                              : `Choose a product to ship this ${word}.`)}
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
                      </s-stack>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small">
                      {actionsFor(release.status).map((name) =>
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

      <s-modal id="cancel-modal" heading={`Cancel this ${word}?`}>
        <s-paragraph>
          {cancelling?.label} will be cancelled and can&apos;t be brought back.
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

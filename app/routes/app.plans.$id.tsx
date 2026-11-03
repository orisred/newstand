import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { createDb } from "../db.server";
import {
  createPlan,
  getPlan,
  parsePlan,
  requestSync,
  updatePlan,
  type PlanErrors,
} from "../plans.server";
import { MAX_RELEASES_PER_TERM, MAX_TERM_MONTHS } from "../plan-options";
import { capitalize } from "../release-actions";
import { getOrCreateShop } from "../shop.server";
import { authenticate } from "../shopify.server";

const KEY_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export const loader = async ({
  request,
  params,
  context,
}: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = createDb(context.cloudflare.env.DB);
  const shop = await getOrCreateShop(db, session.shop);
  const words = {
    word: shop.releaseWordSingular,
    plural: shop.releaseWordPlural,
  };
  if (params.id === "new") {
    // One-time token for the form: a double submit carries the same one.
    return { ...words, plan: null, createKey: crypto.randomUUID() };
  }
  const plan = await getPlan(db, shop.id, params.id ?? "");
  if (!plan) throw new Response("Plan not found", { status: 404 });
  return { ...words, plan, createKey: "" };
};

type ActionData = {
  ok: boolean;
  message: string;
  errors?: PlanErrors;
};

export const action = async ({
  request,
  params,
  context,
}: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const env = context.cloudflare.env;
  const db = createDb(env.DB);
  const shop = await getOrCreateShop(db, session.shop);
  const shopRef = { id: shop.id, shopDomain: session.shop };

  const creating = params.id === "new";
  const existing = creating
    ? null
    : await getPlan(db, shop.id, params.id ?? "");
  if (!creating && !existing) {
    return {
      ok: false,
      message: "That plan no longer exists.",
    } satisfies ActionData;
  }
  const key = form.get("key");
  if (creating && (typeof key !== "string" || !KEY_PATTERN.test(key))) {
    return {
      ok: false,
      message: "Reload the page and try again.",
    } satisfies ActionData;
  }

  const parsed = parsePlan(form, existing ?? undefined);
  if (!parsed.ok) {
    return {
      ok: false,
      message: "The plan was not saved. Fix the highlighted fields.",
      errors: parsed.errors,
    } satisfies ActionData;
  }

  if (creating) {
    const { created, id } = await createPlan(
      db,
      shop.id,
      key as string,
      parsed.values,
    );
    if (created) await requestSync(env, db, shopRef, id);
    return {
      ok: true,
      message: created
        ? "Plan created. Syncing to Shopify."
        : "That plan was already created.",
    } satisfies ActionData;
  }
  await updatePlan(db, shop.id, existing!.id, parsed.values);
  await requestSync(env, db, shopRef, existing!.id);
  return {
    ok: true,
    message: "Plan saved. Syncing to Shopify.",
  } satisfies ActionData;
};

export default function PlanForm() {
  const { word, plural, plan, createKey } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const saving = fetcher.state !== "idle";
  const errors = fetcher.data?.errors ?? {};
  const [mode, setMode] = useState<string>(
    plan?.billingMode ?? "PREPAID_BUNDLE",
  );
  const [product, setProduct] = useState({
    gid: plan?.productGid ?? "",
    title: plan?.productTitle ?? "",
  });

  useEffect(() => {
    if (!fetcher.data) return;
    shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    if (fetcher.data.ok) navigate("/app/plans");
  }, [fetcher.data, shopify, navigate]);

  const pickProduct = async () => {
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: false,
      action: "select",
      filter: { variants: false },
      selectionIds: product.gid ? [{ id: product.gid }] : [],
    });
    const first = selected?.[0];
    if (first) setProduct({ gid: first.id, title: first.title });
  };

  return (
    <s-page heading={plan ? "Edit plan" : "Create plan"}>
      <s-link slot="breadcrumb-actions" href="/app/plans">
        Plans
      </s-link>
      <fetcher.Form method="post">
        <input type="hidden" name="key" value={createKey} />
        <input type="hidden" name="productGid" value={product.gid} />
        <input type="hidden" name="productTitle" value={product.title} />
        <s-stack gap="base">
          <s-section heading="What customers see">
            <s-stack gap="base">
              <s-text-field
                label="Name (only you see this)"
                name="name"
                value={plan?.name ?? ""}
                error={errors.name}
              />
              <s-text-field
                label="Name customers see"
                name="displayName"
                details={`For example "Yearly subscription" or "2 ${plural} paid upfront".`}
                value={plan?.displayName ?? ""}
                error={errors.displayName}
              />
              <s-text-field
                label="Price"
                name="price"
                details={
                  mode === "PER_RELEASE"
                    ? `Charged at sign-up, then with each ${word}. In your store's currency.`
                    : "The whole bundle, charged at sign-up. In your store's currency."
                }
                value={plan ? (plan.priceCents / 100).toFixed(2) : ""}
                error={errors.price}
              />
            </s-stack>
          </s-section>

          <s-section heading="How customers pay">
            {plan ? (
              <s-paragraph>
                {plan.billingMode === "PER_RELEASE"
                  ? `Paid per ${word}.`
                  : `A bundle of ${plan.releasesPerTerm} ${plural}, ${plan.termMonths} months.`}{" "}
                This can&apos;t change once a plan exists, because it is what
                subscribers bought. Create a new plan instead.
              </s-paragraph>
            ) : (
              <s-stack gap="base">
                <s-select
                  label="Billing"
                  name="billingMode"
                  value={mode}
                  error={errors.billingMode}
                  onChange={(event: Event) =>
                    setMode((event.currentTarget as HTMLSelectElement).value)
                  }
                >
                  <s-option value="PREPAID_BUNDLE">
                    Prepaid bundle: several {plural} paid upfront
                  </s-option>
                  <s-option value="PER_RELEASE">
                    Pay per {word}: charged as each {word} ships
                  </s-option>
                </s-select>
                {mode === "PREPAID_BUNDLE" && (
                  <>
                    <s-number-field
                      label={`${capitalize(plural)} in the bundle`}
                      name="releasesPerTerm"
                      min={1}
                      max={MAX_RELEASES_PER_TERM}
                      value="2"
                      error={errors.releasesPerTerm}
                    />
                    <s-number-field
                      label="Term in months"
                      name="termMonths"
                      min={1}
                      max={MAX_TERM_MONTHS}
                      value="12"
                      details="When the bundle comes up for renewal."
                      error={errors.termMonths}
                    />
                  </>
                )}
              </s-stack>
            )}
            {(plan ? plan.billingMode : mode) === "PREPAID_BUNDLE" && (
              <s-select
                label="Renewal"
                name="renewalRule"
                value={plan?.renewalRule ?? "TERM_DATE_HOLD_IF_LATE"}
                error={errors.renewalRule}
              >
                <s-option value="TERM_DATE_HOLD_IF_LATE">
                  On the term date, but wait if the last paid {word} hasn&apos;t
                  shipped
                </s-option>
                <s-option value="TERM_DATE">On the term date</s-option>
                <s-option value="ON_DEPLETION">
                  When the paid {plural} run out
                </s-option>
              </s-select>
            )}
            <s-checkbox
              label="Renew automatically"
              name="autoRenew"
              {...((plan?.autoRenew ?? true) ? { checked: true } : {})}
            />
          </s-section>

          <s-section heading="Who gets which release">
            <s-stack gap="base">
              <s-select
                label={`First ${word} for a new subscriber`}
                name="startRule"
                value={plan?.startRule ?? "PREORDER_SWITCHOVER"}
                error={errors.startRule}
              >
                <s-option value="PREORDER_SWITCHOVER">
                  The latest released {word}, until the next pre-order is
                  announced
                </s-option>
                <s-option value="CURRENT_IF_BEFORE_CUTOFF">
                  The current {word}, if it hasn&apos;t passed its cutoff
                </s-option>
                <s-option value="NEXT">Always the next {word}</s-option>
              </s-select>
              <s-checkbox
                label="Can be bought as a gift"
                name="giftable"
                {...(plan?.giftable ? { checked: true } : {})}
              />
            </s-stack>
          </s-section>

          <s-section heading="Product">
            <s-stack gap="base">
              <s-paragraph>
                The product customers subscribe on. The plan appears in its
                purchase options. While it has a plan, the product can only be
                bought with one, so it cannot be bought as a one-time purchase.
                It must be a physical product, so checkout asks for a shipping
                address. If you turn off its last plan, it goes back to selling
                normally.
              </s-paragraph>
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-button onClick={pickProduct}>
                  {product.gid ? "Change product" : "Choose product"}
                </s-button>
                <s-text>{product.title || "No product chosen"}</s-text>
              </s-stack>
              {errors.product && (
                <s-text tone="critical">{errors.product}</s-text>
              )}
            </s-stack>
          </s-section>

          <s-stack direction="inline" gap="base">
            <s-button
              type="submit"
              variant="primary"
              {...(saving ? { loading: true } : {})}
            >
              Save
            </s-button>
            <s-button href="/app/plans">Cancel</s-button>
          </s-stack>
        </s-stack>
      </fetcher.Form>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

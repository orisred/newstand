import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { createDb } from "../db.server";
import { listPlans, retrySync } from "../plans.server";
import {
  EMAIL_KEYS,
  getOrCreateShop,
  isEmailEnabled,
  parseSettings,
  saveSettings,
  type EmailKey,
  type SettingsErrors,
} from "../shop.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(
    createDb(context.cloudflare.env.DB),
    session.shop,
  );
  return {
    releaseWordSingular: shop.releaseWordSingular,
    releaseWordPlural: shop.releaseWordPlural,
    vocabulary: shop.vocabulary,
    allowedCountries: (shop.allowedCountries as string[]).join(", "),
    orderTiming: shop.orderTiming,
    emails: Object.fromEntries(
      EMAIL_KEYS.map((key) => [key, isEmailEnabled(shop.emailsEnabled, key)]),
    ) as Record<EmailKey, boolean>,
  };
};

type ActionData = { ok: boolean; message: string; errors?: SettingsErrors };

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const parsed = parseSettings(await request.formData());
  if (!parsed.ok) {
    return {
      ok: false,
      message: "Settings were not saved. Fix the highlighted fields.",
      errors: parsed.errors,
    } satisfies ActionData;
  }
  const { env } = context.cloudflare;
  const db = createDb(env.DB);
  const shop = await getOrCreateShop(db, session.shop);
  await saveSettings(db, shop.id, parsed.values);
  // The words are also the option name on each plan's group in Shopify, and the picker's: sync them.
  if (shop.vocabulary !== parsed.values.vocabulary) {
    const ref = { id: shop.id, shopDomain: session.shop };
    for (const plan of await listPlans(db, shop.id)) await retrySync(env, db, ref, plan.id);
  }
  return { ok: true, message: "Settings saved." } satisfies ActionData;
};

const EMAIL_LABELS: Record<EmailKey, string> = {
  welcome: "Welcome",
  giftReceived: "Gift received (to the recipient)",
  preorderAnnounced: "Pre-order announced",
  upcomingCharge: "Upcoming charge",
  failedPayment: "Failed payment",
  lastReleaseShipping: "Last paid release shipping (a gift's end-of-gift offer too)",
};

export default function Settings() {
  const settings = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const shopify = useAppBridge();
  const saving = fetcher.state !== "idle";
  const errors = fetcher.data?.errors ?? {};

  useEffect(() => {
    if (fetcher.data) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    }
  }, [fetcher.data, shopify]);

  return (
    <s-page heading="Settings">
      <fetcher.Form method="post">
        <s-stack gap="base">
          <s-section heading="Words">
            <s-stack gap="base">
              <s-paragraph>
                Customers see this word everywhere, such as &ldquo;issue&rdquo;,
                &ldquo;drop&rdquo; or &ldquo;box&rdquo;.
              </s-paragraph>
              <s-text-field
                label="Singular"
                name="releaseWordSingular"
                value={settings.releaseWordSingular}
                error={errors.releaseWordSingular}
              />
              <s-text-field
                label="Plural"
                name="releaseWordPlural"
                value={settings.releaseWordPlural}
                error={errors.releaseWordPlural}
              />
              <s-select
                label="What customers buy"
                name="vocabulary"
                value={settings.vocabulary}
                details="The words in the customer account, emails, the plan picker and checkout's option name."
                error={errors.vocabulary}
              >
                <s-option value="SUBSCRIPTIONS">
                  Subscriptions: subscription, subscriber, subscribe
                </s-option>
                <s-option value="MEMBERSHIPS">
                  Memberships: membership, member, join
                </s-option>
              </s-select>
            </s-stack>
          </s-section>

          <s-section heading="Shipping">
            <s-stack gap="base">
              <s-text-field
                label="Countries you ship to"
                name="allowedCountries"
                details="Two-letter country codes, separated by commas."
                value={settings.allowedCountries}
                error={errors.allowedCountries}
              />
              <s-select
                label="Create subscribers' orders"
                name="orderTiming"
                value={settings.orderTiming}
                error={errors.orderTiming}
              >
                <s-option value="READY_TO_SHIP">
                  When the {settings.releaseWordSingular} is ready to ship
                </s-option>
                <s-option value="PREORDER_OPENS">
                  When the pre-order is announced
                </s-option>
              </s-select>
            </s-stack>
          </s-section>

          <s-section heading="Emails">
            <s-stack gap="small">
              <s-paragraph>
                Choose which emails the app sends to subscribers. Turning one off stops it from then on, and turning it back on doesn&apos;t send the ones missed in between. The notice of a price rise has no switch: it is what gives subscribers their 30 days&apos; notice.
              </s-paragraph>
              {(Object.keys(EMAIL_LABELS) as EmailKey[]).map((key) => (
                <s-checkbox
                  key={key}
                  label={EMAIL_LABELS[key]}
                  name={`email_${key}`}
                  {...(settings.emails[key] ? { checked: true } : {})}
                />
              ))}
            </s-stack>
          </s-section>

          <s-stack direction="inline">
            <s-button
              type="submit"
              variant="primary"
              {...(saving ? { loading: true } : {})}
            >
              Save
            </s-button>
          </s-stack>
        </s-stack>
      </fetcher.Form>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

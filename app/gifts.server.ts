import type { createDb } from "./db.server";
import { logEvent } from "./logger.server";
import type { Graphql } from "./plan-sync.server";

type Db = ReturnType<typeof createDb>;

/**
 * Gifts: the buyer pays and the Shopify contract is theirs, but the subscription belongs to the
 * recipient. The storefront sends the recipient as line item properties, which Shopify copies onto
 * the contract's line as `customAttributes`. They are written by the browser, so they're untrusted
 * and parsed here (see "Gifts" in docs/DECISIONS.md).
 */

export const GIFT_EMAIL_KEY = "Gift recipient email";
export const GIFT_NAME_KEY = "Gift recipient name";
export const GIFT_MESSAGE_KEY = "Gift message";

/** Flags a paid gift whose recipient couldn't be used. Becomes `MIXED_HANDLED` when the merchant has dealt with it. */
export const GIFT_INVALID_EVENT = "contract.gift_invalid";

const MAX_EMAIL = 254;
const MAX_NAME = 100;
export const MAX_MESSAGE = 500;

// One address, no display name, quotes, comments or separators: a stricter shape than the RFC on
// purpose, because this goes to Shopify and into the app's emails.
const EMAIL = /^[^\s@<>"'`,;:()[\]\\]+@[^\s@<>"'`,;:()[\]\\]+\.[^\s@<>"'`,;:()[\]\\]{2,}$/;

export type GiftDetails = {
  email: string;
  firstName: string;
  lastName: string | null;
  message: string | null;
};

export type ParsedGift =
  | { kind: "none" }
  | { kind: "gift"; gift: GiftDetails }
  | { kind: "invalid"; reason: "no_email" | "bad_email" | "several_lines" };

type Attribute = { key: string; value: string | null };

/** Only a prepaid bundle can be a gift: it's the only plan that sells a fixed number of releases. */
export const isGiftPlan = (plan: { giftable: boolean; billingMode: string }) =>
  plan.giftable && plan.billingMode === "PREPAID_BUNDLE";

const CONTROL_CHARS = "\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069";
const HAS_CONTROL = new RegExp(`[${CONTROL_CHARS}]`);
const CONTROL = new RegExp(`[${CONTROL_CHARS}]`, "g");

const first = (attributes: Attribute[], key: string) =>
  attributes.find((attribute) => attribute.key === key)?.value?.trim() ?? "";

/**
 * Reads the recipient from a line's attributes. No recipient fields at all is an ordinary purchase.
 * A name or message without a usable email is invalid, because the buyer meant a gift and paid:
 * the caller must make that visible rather than create a subscription for the buyer.
 * A bad name is cleaned and a long message cut, since neither says who gets the gift.
 */
export function parseGift(attributes: Attribute[]): ParsedGift {
  const email = first(attributes, GIFT_EMAIL_KEY);
  const name = first(attributes, GIFT_NAME_KEY);
  const message = first(attributes, GIFT_MESSAGE_KEY);
  if (!email && !name && !message) return { kind: "none" };
  if (!email) return { kind: "invalid", reason: "no_email" };
  if (email.length > MAX_EMAIL || !EMAIL.test(email) || HAS_CONTROL.test(email)) {
    return { kind: "invalid", reason: "bad_email" };
  }
  const words = name
    .replace(CONTROL, " ")
    .replace(/[<>]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
    .slice(0, MAX_NAME)
    .split(" ");
  const cleaned = message
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_MESSAGE);
  return {
    kind: "gift",
    gift: {
      // Shopify treats addresses as case-insensitive, and so must a lookup by one.
      email: email.toLowerCase(),
      firstName: words[0] ?? "",
      lastName: words.slice(1).join(" ") || null,
      message: cleaned || null,
    },
  };
}

/**
 * A contract's lines of one plan. Shopify puts every line of a plan on one contract, and a
 * contract has one subscription, so a gift can only be the plan's single line: a second line
 * (another recipient, or one for the buyer) would be paid for and have no subscription.
 */
export function parseGiftLines(lines: { customAttributes?: Attribute[] }[]): ParsedGift {
  const parsed = lines.map((line) => parseGift(line.customAttributes ?? []));
  if (parsed.every((line) => line.kind === "none")) return { kind: "none" };
  return parsed.length > 1 ? { kind: "invalid", reason: "several_lines" } : parsed[0];
}

const FIND = `#graphql
  query GiftRecipient($email: String!) {
    customerByIdentifier(identifier: { emailAddress: $email }) { id }
  }`;

const CREATE = `#graphql
  mutation GiftRecipientCreate($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer { id }
      userErrors { message }
    }
  }`;

/**
 * The recipient's Shopify customer: found by email, else created. Running twice finds the first
 * run's customer, and two running at once end the same way, because Shopify allows an email on one
 * customer only: the loser's create is refused and its second search finds the winner's. An existing
 * customer is never changed, so a buyer can't rewrite someone else's name by gifting to them.
 * Returns null if Shopify won't take the address. Nothing here is logged: it's personal data.
 */
export async function findOrCreateRecipient(
  graphql: Graphql,
  gift: GiftDetails,
): Promise<string | null> {
  const find = async () =>
    ((await graphql(FIND, { email: gift.email })).customerByIdentifier?.id ??
      null) as string | null;
  const found = await find();
  if (found) return found;
  const { customerCreate: created } = await graphql(CREATE, {
    input: {
      email: gift.email,
      ...(gift.firstName ? { firstName: gift.firstName } : {}),
      ...(gift.lastName ? { lastName: gift.lastName } : {}),
    },
  });
  return (created.customer?.id as string | undefined) ?? (await find());
}

const APP_INSTALLATION = `#graphql
  query GiftAppInstallation { currentAppInstallation { id } }`;

const SET_METAFIELD = `#graphql
  mutation GiftPlansSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { userErrors { message } }
  }`;

/**
 * Tells the plan picker which selling plans take a gift: the numeric IDs of the shop's giftable
 * bundles, comma separated and wrapped in commas (`,123,456,`), so Liquid can test for `,123,`. It's
 * a metafield on the app's installation, which the theme block reads as `app.metafields`. Run after
 * each plan sync, from the plans as they stand then. A failure never blocks a sync: the picker then
 * just shows the list it had.
 */
export async function publishGiftPlans(db: Db, graphql: Graphql, shopId: string) {
  try {
    const plans = await db.plan.findMany({
      where: {
        shopId,
        giftable: true,
        billingMode: "PREPAID_BUNDLE",
        active: true,
        sellingPlanGid: { not: null },
      },
      orderBy: { id: "asc" },
      select: { sellingPlanGid: true },
    });
    const ids = plans.map((plan) => plan.sellingPlanGid!.split("/").pop());
    const { currentAppInstallation: installation } = await graphql(APP_INSTALLATION);
    const { metafieldsSet: result } = await graphql(SET_METAFIELD, {
      metafields: [
        {
          ownerId: installation.id,
          namespace: "release_subscriptions",
          key: "giftable_plans",
          type: "single_line_text_field",
          value: `,${ids.join(",")},`,
        },
      ],
    });
    if (result.userErrors.length > 0) logEvent("error", "gift_plans.refused", {});
  } catch {
    logEvent("error", "gift_plans.failed", {});
  }
}

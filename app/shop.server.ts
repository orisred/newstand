import { COUNTRY_CODES } from "./countries";
import type { createDb } from "./db.server";
import { setAppMetafield } from "./gifts.server";
import { logEvent } from "./logger.server";
import type { Graphql } from "./plan-sync.server";
import { VOCABULARIES, type Vocabulary } from "./vocabulary";

type Db = ReturnType<typeof createDb>;

export const EMAIL_KEYS = [
  "welcome",
  "giftReceived",
  "preorderAnnounced",
  "upcomingCharge",
  "failedPayment",
  "lastReleaseShipping",
] as const;
export type EmailKey = (typeof EMAIL_KEYS)[number];

/**
 * Whether the shop wants this email sent. A key that is missing (a shop that never saved
 * its settings, or an email added later) means ON. Only an explicit `false` turns one off.
 */
export function isEmailEnabled(emailsEnabled: unknown, key: EmailKey) {
  if (typeof emailsEnabled !== "object" || emailsEnabled === null) return true;
  return (emailsEnabled as Record<string, unknown>)[key] !== false;
}

const shopSelect = {
  id: true,
  releaseWordSingular: true,
  releaseWordPlural: true,
  vocabulary: true,
  allowedCountries: true,
  orderTiming: true,
  emailsEnabled: true,
  timezone: true,
} as const;

/**
 * The shop's row, created on first use. The write happens once per shop, never on a
 * normal page load.
 */
export async function getOrCreateShop(db: Db, shopDomain: string) {
  const found = await db.shop.findUnique({
    where: { shopDomain },
    select: shopSelect,
  });
  if (found) return found;
  try {
    return await db.shop.create({ data: { shopDomain }, select: shopSelect });
  } catch (error) {
    // Two requests can race to create it: the loser reads the winner's row.
    const raced = await db.shop.findUnique({
      where: { shopDomain },
      select: shopSelect,
    });
    if (raced) return raced;
    throw error;
  }
}

export type SettingsInput = {
  releaseWordSingular: string;
  releaseWordPlural: string;
  vocabulary: Vocabulary;
  allowedCountries: string[];
  orderTiming: "READY_TO_SHIP" | "PREORDER_OPENS";
  emailsEnabled: Record<EmailKey, boolean>;
};

export type SettingsErrors = Partial<
  Record<
    | "releaseWordSingular"
    | "releaseWordPlural"
    | "vocabulary"
    | "allowedCountries"
    | "orderTiming",
    string
  >
>;

const MAX_WORD_LENGTH = 30;

function parseWord(raw: FormDataEntryValue | null, label: string) {
  const word = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!word) return { error: `Enter the ${label} word.` };
  if (word.length > MAX_WORD_LENGTH || /[<>\p{C}]/u.test(word)) {
    return {
      error: `Use up to ${MAX_WORD_LENGTH} letters, with no < or > characters.`,
    };
  }
  return { word };
}

/** Validates the settings form. Checkboxes are absent from the form data when off. */
export function parseSettings(
  form: FormData,
): { ok: true; values: SettingsInput } | { ok: false; errors: SettingsErrors } {
  const errors: SettingsErrors = {};

  const singular = parseWord(form.get("releaseWordSingular"), "singular");
  const plural = parseWord(form.get("releaseWordPlural"), "plural");
  if (singular.error) errors.releaseWordSingular = singular.error;
  if (plural.error) errors.releaseWordPlural = plural.error;

  const vocabulary = form.get("vocabulary");
  if (!(VOCABULARIES as readonly unknown[]).includes(vocabulary)) {
    errors.vocabulary = "Choose the words customers see.";
  }

  const countries = [
    ...new Set(
      String(form.get("allowedCountries") ?? "")
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((code) => code.toUpperCase()),
    ),
  ];
  const badCountry = countries.find((code) => !COUNTRY_CODES.has(code));
  if (countries.length === 0) {
    errors.allowedCountries = "Enter at least one country code, such as US.";
  } else if (badCountry) {
    errors.allowedCountries = `${badCountry.slice(0, 10)} is not a country code we recognize, such as US.`;
  }

  const orderTiming = form.get("orderTiming");
  if (orderTiming !== "READY_TO_SHIP" && orderTiming !== "PREORDER_OPENS") {
    errors.orderTiming = "Choose when orders are created.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    values: {
      releaseWordSingular: singular.word!,
      releaseWordPlural: plural.word!,
      vocabulary: vocabulary as Vocabulary,
      allowedCountries: countries,
      orderTiming: orderTiming as SettingsInput["orderTiming"],
      emailsEnabled: Object.fromEntries(
        EMAIL_KEYS.map((key) => [key, form.has(`email_${key}`)]),
      ) as Record<EmailKey, boolean>,
    },
  };
}

/** Saves settings for one shop. The shop ID comes from the session, never the form. */
export function saveSettings(db: Db, shopId: string, values: SettingsInput) {
  return db.shop.update({ where: { id: shopId }, data: values });
}

/**
 * Tells the plan picker which words the shop uses, for its own fallback text: the app-installation
 * metafield `release_subscriptions.vocabulary`. Run after each plan sync, which a change of words
 * starts. A failure never blocks a sync: the picker then keeps the words it had.
 */
export async function publishVocabulary(db: Db, graphql: Graphql, shopId: string) {
  try {
    const shop = await db.shop.findUnique({ where: { id: shopId }, select: { vocabulary: true } });
    if (shop && !(await setAppMetafield(graphql, "vocabulary", shop.vocabulary.toLowerCase()))) {
      logEvent("error", "vocabulary.refused", {});
    }
  } catch {
    logEvent("error", "vocabulary.failed", {});
  }
}

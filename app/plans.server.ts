import type { createDb } from "./db.server";
import { enqueueJobs } from "./jobs/runner.server";
import {
  BILLING_MODES,
  MAX_RELEASES_PER_TERM,
  MAX_TERM_MONTHS,
  NAME_MAX_LENGTH,
  RENEWAL_RULES,
  START_RULES,
  type BillingMode,
  type RenewalRule,
  type StartRule,
} from "./plan-options";

type Db = ReturnType<typeof createDb>;

const MAX_PRICE_CENTS = 99_999_999;
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d{1,20}$/;

export const SYNC_JOB = "plan.sync";

export const PRICE_POLICIES = ["KEEP_OLD_PRICE", "APPLY_AT_RENEWAL"] as const;
export type PricePolicy = (typeof PRICE_POLICIES)[number];
/** Time for the notice (Step 10). A renewal before this keeps the old price. */
const PRICE_NOTICE_DAYS = 30;

export type PlanInput = {
  name: string;
  displayName: string;
  /** What the plan includes, such as a tier's perks. Customers see it under the plan's name. */
  description?: string | null;
  /** The plan's own customer tag, beside the shop's member tag, so a tier can have perks of its own. */
  memberTag?: string | null;
  billingMode: BillingMode;
  releasesPerTerm: number;
  termMonths: number | null;
  renewalRule: RenewalRule;
  startRule: StartRule;
  priceCents: number;
  autoRenew: boolean;
  giftable: boolean;
  productGid: string;
  productTitle: string;
};

export type PlanErrors = Partial<
  Record<
    | "name"
    | "displayName"
    | "description"
    | "memberTag"
    | "billingMode"
    | "releasesPerTerm"
    | "termMonths"
    | "renewalRule"
    | "startRule"
    | "giftable"
    | "price"
    | "product",
    string
  >
>;

/** What the plan form can't change once the plan exists: it's what subscribers bought. */
export type PlanShape = Pick<
  PlanInput,
  "billingMode" | "releasesPerTerm" | "termMonths"
>;

function text(form: FormData, key: string) {
  const raw = form.get(key);
  return typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
}

function oneOf<T extends string>(options: readonly T[], value: string) {
  return (options as readonly string[]).includes(value) ? (value as T) : null;
}

function wholeNumber(value: string, min: number, max: number) {
  if (!/^\d{1,6}$/.test(value)) return null;
  const number = Number(value);
  return number >= min && number <= max ? number : null;
}

/** "25", "25.5" or "25.00", above zero. Returns whole cents. */
export function parsePriceCents(value: string) {
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(value)) return null;
  const [dollars, cents = ""] = value.split(".");
  const total = Number(dollars) * 100 + Number(cents.padEnd(2, "0"));
  return total > 0 && total <= MAX_PRICE_CENTS ? total : null;
}

export const DESCRIPTION_MAX_LENGTH = 500;
export const MEMBER_TAG_MAX_LENGTH = 40;

/** Plain text that keeps its line breaks. Empty is null. */
function parseDescription(form: FormData) {
  const raw = form.get("description");
  const value = (typeof raw === "string" ? raw : "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/[ \t]+/g, " "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!value) return { value: null };
  return value.length <= DESCRIPTION_MAX_LENGTH && !/[<>]|(?!\n)\p{C}/u.test(value)
    ? { value }
    : { error: `Use up to ${DESCRIPTION_MAX_LENGTH} characters, with no < or > characters.` };
}

/** A Shopify tag holds no comma: Shopify splits tags on them. Empty is null. */
function parseTag(value: string) {
  if (!value) return { value: null };
  return value.length <= MEMBER_TAG_MAX_LENGTH && !/[,<>\p{C}]/u.test(value)
    ? { value }
    : { error: `Use up to ${MEMBER_TAG_MAX_LENGTH} characters, with no commas or < > characters.` };
}

function parseLabel(value: string) {
  return value && value.length <= NAME_MAX_LENGTH && !/[<>\p{C}]/u.test(value)
    ? value
    : null;
}

/**
 * Validates the plan form. When `existing` is given, the billing mode, releases and term
 * come from it and the form's values for them are ignored. Checkboxes are absent when off.
 * A per-release plan has no term and sells one release at a time.
 */
export function parsePlan(
  form: FormData,
  existing?: PlanShape,
): { ok: true; values: PlanInput } | { ok: false; errors: PlanErrors } {
  const errors: PlanErrors = {};

  const name = parseLabel(text(form, "name"));
  if (!name)
    errors.name = `Enter a name of up to ${NAME_MAX_LENGTH} characters.`;
  const displayName = parseLabel(text(form, "displayName"));
  if (!displayName) {
    errors.displayName = `Enter the name customers see, up to ${NAME_MAX_LENGTH} characters.`;
  }

  const description = parseDescription(form);
  if (description.error) errors.description = description.error;
  const memberTag = parseTag(text(form, "memberTag"));
  if (memberTag.error) errors.memberTag = memberTag.error;

  const billingMode =
    existing?.billingMode ?? oneOf(BILLING_MODES, text(form, "billingMode"));
  if (!billingMode) errors.billingMode = "Choose how customers pay.";

  let releasesPerTerm = 1;
  let termMonths: number | null = null;
  if (existing) {
    ({ releasesPerTerm, termMonths } = existing);
  } else if (billingMode === "PREPAID_BUNDLE") {
    const releases = wholeNumber(
      text(form, "releasesPerTerm"),
      1,
      MAX_RELEASES_PER_TERM,
    );
    if (releases === null) {
      errors.releasesPerTerm = `Enter a whole number from 1 to ${MAX_RELEASES_PER_TERM}.`;
    } else releasesPerTerm = releases;
    termMonths = wholeNumber(text(form, "termMonths"), 1, MAX_TERM_MONTHS);
    if (termMonths === null) {
      errors.termMonths = `Enter a whole number of months from 1 to ${MAX_TERM_MONTHS}.`;
    }
  }

  const renewalRule =
    oneOf(RENEWAL_RULES, text(form, "renewalRule")) ??
    (billingMode === "PREPAID_BUNDLE" ? null : RENEWAL_RULES[0]);
  if (!renewalRule) errors.renewalRule = "Choose when the bundle renews.";
  // A bundle of one that ships at once would run out, and charge again, right after sign-up.
  if (
    billingMode === "PREPAID_BUNDLE" &&
    renewalRule === "ON_DEPLETION" &&
    releasesPerTerm < 2 &&
    !errors.releasesPerTerm
  ) {
    errors.renewalRule =
      "A bundle of one can't renew when it runs out. Choose another renewal, or a pay-per-release plan.";
  }
  const startRule = oneOf(START_RULES, text(form, "startRule"));
  if (!startRule)
    errors.startRule = "Choose which release new subscribers start on.";

  // A gift buys a fixed number of releases. A per-release plan buys one and then charges for each
  // later one, which a gift never does, so it can't be offered as one.
  if (form.has("giftable") && billingMode === "PER_RELEASE") {
    errors.giftable =
      "Only a prepaid bundle can be bought as a gift. A per-release plan has no fixed number of releases to give.";
  }

  const priceCents = parsePriceCents(text(form, "price"));
  if (priceCents === null) {
    errors.price = "Enter a price above 0, such as 25 or 25.50.";
  }

  const productGid = text(form, "productGid");
  const productTitle = text(form, "productTitle").slice(0, 255);
  if (!PRODUCT_GID.test(productGid)) errors.product = "Choose a product.";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    values: {
      name: name!,
      displayName: displayName!,
      description: description.value ?? null,
      memberTag: memberTag.value ?? null,
      billingMode: billingMode!,
      releasesPerTerm,
      termMonths,
      renewalRule: renewalRule!,
      startRule: startRule!,
      priceCents: priceCents!,
      autoRenew: form.has("autoRenew"),
      giftable: form.has("giftable"),
      productGid,
      productTitle,
    },
  };
}

const planListSelect = {
  id: true,
  name: true,
  displayName: true,
  billingMode: true,
  releasesPerTerm: true,
  termMonths: true,
  priceCents: true,
  currency: true,
  productTitle: true,
  active: true,
  syncStatus: true,
  syncMessage: true,
  syncedAt: true,
} as const;

/** The shop's plans, oldest first. Plans are few, so there's one page. */
export function listPlans(db: Db, shopId: string) {
  return db.plan.findMany({
    where: { shopId },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: planListSelect,
  });
}

/** One plan of this shop for the edit form; null for another shop's or a missing ID. */
export function getPlan(db: Db, shopId: string, id: string) {
  return db.plan.findFirst({
    where: { id, shopId },
    select: {
      ...planListSelect,
      renewalRule: true,
      startRule: true,
      autoRenew: true,
      giftable: true,
      productGid: true,
      description: true,
      memberTag: true,
    },
  });
}

/**
 * Creates a plan. `key` is the form's one-time token and becomes part of the ID, so a
 * double submit inserts once and the repeat reports `created: false`. The plan starts out
 * not synced: call `requestSync` next.
 */
export async function createPlan(
  db: Db,
  shopId: string,
  key: string,
  input: PlanInput,
) {
  const id = `${shopId}:${key}`;
  try {
    await db.plan.create({
      data: { id, shopId, ...input, syncRevision: 1 },
      select: { id: true },
    });
    return { created: true, id };
  } catch (error) {
    const taken = await db.plan.findUnique({
      where: { id },
      select: { id: true },
    });
    if (taken) return { created: false, id };
    throw error;
  }
}

/**
 * Saves an edit. The billing mode, releases and term never change, because they're what
 * subscribers bought; `parsePlan` keeps them from `existing`. The edit marks the plan not
 * synced.
 *
 * A new price always applies to new sign-ups. For existing subscribers the merchant decides each
 * time, and that decision is recorded here: `KEEP_OLD_PRICE` leaves their contracts alone, and
 * `APPLY_AT_RENEWAL` changes each contract just before its next charge once the notice period is
 * over (see `applyPriceChange`). The latest change is the only one that counts, so a merchant can
 * take one back. The plan is saved first: a crash between the two leaves the safe outcome.
 */
export async function updatePlan(
  db: Db,
  shopId: string,
  id: string,
  input: PlanInput,
  pricePolicy: PricePolicy = "KEEP_OLD_PRICE",
  now = new Date(),
) {
  const before = await db.plan.findFirst({
    where: { id, shopId },
    select: { priceCents: true },
  });
  const { count } = await db.plan.updateMany({
    where: { id, shopId },
    data: {
      name: input.name,
      displayName: input.displayName,
      description: input.description,
      memberTag: input.memberTag,
      renewalRule: input.renewalRule,
      startRule: input.startRule,
      priceCents: input.priceCents,
      autoRenew: input.autoRenew,
      giftable: input.giftable,
      productGid: input.productGid,
      productTitle: input.productTitle,
      syncStatus: "NOT_SYNCED",
      syncRevision: { increment: 1 },
    },
  });
  if (count === 1 && before && before.priceCents !== input.priceCents) {
    await db.priceChange.create({
      data: {
        planId: id,
        newPriceCents: input.priceCents,
        policy: pricePolicy,
        effectiveAt:
          pricePolicy === "APPLY_AT_RENEWAL"
            ? new Date(now.getTime() + PRICE_NOTICE_DAYS * 24 * 60 * 60 * 1000)
            : now,
      },
      select: { id: true },
    });
  }
  return count === 1;
}

/**
 * Turns a plan on or off. Off takes it off its product in Shopify, but nothing is deleted:
 * subscribers keep their plan, and turning it on again puts it back on the product.
 */
export async function setPlanActive(
  db: Db,
  shopId: string,
  id: string,
  active: boolean,
) {
  const { count } = await db.plan.updateMany({
    where: { id, shopId },
    data: {
      active,
      syncStatus: "NOT_SYNCED",
      syncRevision: { increment: 1 },
    },
  });
  return count === 1;
}

/**
 * Queues a sync of the plan's current state. Its job ID holds the plan's revision, so a
 * repeated or redelivered message runs once, while a change or a retry has a new revision
 * and runs again. If queueing fails the plan stays "not synced" and the merchant can retry.
 */
export async function requestSync(
  env: Pick<Env, "JOBS">,
  db: Db,
  shop: { id: string; shopDomain: string },
  planId: string,
) {
  const plan = await db.plan.findFirst({
    where: { id: planId, shopId: shop.id },
    select: { syncRevision: true },
  });
  if (!plan) return false;
  await enqueueJobs(env as Env, [
    {
      type: SYNC_JOB,
      id: `${SYNC_JOB}:${planId}:${plan.syncRevision}`,
      shop: shop.shopDomain,
      data: { planId, shopId: shop.id },
    },
  ]);
  return true;
}

/** A retry: a new revision, so its job isn't skipped as a repeat of the last one. */
export async function retrySync(
  env: Pick<Env, "JOBS">,
  db: Db,
  shop: { id: string; shopDomain: string },
  planId: string,
) {
  const { count } = await db.plan.updateMany({
    where: { id: planId, shopId: shop.id },
    data: { syncStatus: "NOT_SYNCED", syncRevision: { increment: 1 } },
  });
  return count === 1 && requestSync(env, db, shop, planId);
}

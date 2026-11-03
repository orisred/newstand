// Safe to import from route components: no server code.

export const BILLING_MODES = ["PER_RELEASE", "PREPAID_BUNDLE"] as const;
export const RENEWAL_RULES = [
  "TERM_DATE_HOLD_IF_LATE",
  "TERM_DATE",
  "ON_DEPLETION",
] as const;
export const START_RULES = [
  "PREORDER_SWITCHOVER",
  "CURRENT_IF_BEFORE_CUTOFF",
  "NEXT",
] as const;

export type BillingMode = (typeof BILLING_MODES)[number];
export type RenewalRule = (typeof RENEWAL_RULES)[number];
export type StartRule = (typeof START_RULES)[number];

export const NAME_MAX_LENGTH = 80;
export const MAX_RELEASES_PER_TERM = 100;
export const MAX_TERM_MONTHS = 36;

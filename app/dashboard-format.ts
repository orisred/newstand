import { formatZoned } from "./release-dates";

export const formatMoney = (cents: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);

/** A stored date as text on the store's clock. D1 can hold `2026-11-05 12:00:00` (UTC) or ISO. */
export const whenText = (value: string | Date | null, timezone: string | null) => {
  if (!value) return null;
  const at =
    typeof value === "string"
      ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`)
      : value;
  return formatZoned(at, timezone ?? "UTC");
};

export const idOf = (gid: string) => gid.split("/").pop();

export const STATUS_TEXT = {
  ACTIVE: "Active",
  PAUSED: "Paused",
  CANCELLED: "Cancelled",
  ENDED: "Ended",
} as const;

/** What the merchant sees for a subscription: a finished gift reads as finished, not active. */
export function stateOf(row: { status: string; releasesRemaining: number; finished: number | boolean }) {
  if (row.status === "ACTIVE" && row.finished) return { text: "Finished", tone: "neutral" } as const;
  if (row.status === "ACTIVE") return { text: "Active", tone: "success" } as const;
  if (row.status === "PAUSED") return { text: "Paused", tone: "critical" } as const;
  if (row.status === "CANCELLED") {
    return row.releasesRemaining > 0
      ? ({ text: "Cancelled, still shipping", tone: "warning" } as const)
      : ({ text: "Cancelled", tone: "neutral" } as const);
  }
  return { text: "Ended", tone: "neutral" } as const;
}

export const VIEWS = ["all", "live", "paused", "ending", "finished", "gifts"] as const;
export type View = (typeof VIEWS)[number];

export const parseView = (raw: string | null): View =>
  (VIEWS as readonly string[]).includes(raw ?? "") ? (raw as View) : "all";

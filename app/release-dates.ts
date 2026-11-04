// Dates are stored in UTC and shown and entered in the store's timezone. No Temporal on Workers.

function offsetMs(at: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(at)
      .map(({ type, value }) => [type, Number(value)]),
  );
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The moment a store's clock reads this date and hour, or null if it's no real date. An hour
 * skipped by daylight saving lands an hour either side of it, and a repeated one on one of its two.
 */
export function zonedToUtc(date: string, hour: number, timeZone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match || !Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const wall = Date.UTC(year, month - 1, day, hour);
  if (new Date(wall).getUTCDate() !== day) return null;
  const first = wall - offsetMs(new Date(wall), timeZone);
  return new Date(wall - offsetMs(new Date(first), timeZone));
}

/** A stored date as the form's fields, on the store's clock. */
export function zonedFields(at: Date, timeZone: string) {
  const local = new Date(at.getTime() + offsetMs(at, timeZone));
  return {
    date: local.toISOString().slice(0, 10),
    hour: local.getUTCHours(),
  };
}

export function formatZoned(at: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(at);
}

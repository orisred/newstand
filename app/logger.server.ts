export type LogFields = Record<string, string | number | boolean | undefined>;

// A second line of defence: callers pass IDs and counts, never secrets or customer data.
const FORBIDDEN_FIELD = /token|secret|authorization|password|email|phone|address|customer/i;

export function logEvent(
  level: "info" | "warn" | "error",
  event: string,
  fields: LogFields = {},
) {
  const safe = Object.fromEntries(
    Object.entries(fields).filter(([key]) => !FORBIDDEN_FIELD.test(key)),
  );
  console[level](JSON.stringify({ level, event, ...safe }));
}

/**
 * The parts of an error that are safe to log. Messages are left out on purpose:
 * Shopify and Prisma errors can quote tokens, addresses or customer details.
 */
export function describeError(error: unknown): LogFields {
  if (error instanceof Response) {
    return { errorName: "Response", errorStatus: error.status };
  }
  if (!(error instanceof Error)) return { errorName: typeof error };
  const { response } = error as { response?: { code?: number } };
  return {
    errorName: error.name === "Error" ? error.constructor.name : error.name,
    errorStatus: response?.code,
    errorAt: error.stack?.split("\n")[1]?.trim(),
  };
}

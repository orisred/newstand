/**
 * The one place that talks to the email provider (Cloudflare Email Service), so swapping it
 * means rewriting this file. It knows nothing about subscriptions.
 */

export type Outgoing = {
  to: string;
  /** The shop's name. The address is `EMAIL_FROM_ADDRESS`, the same for every shop. */
  fromName: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
};

/**
 * `wait`: nothing is wrong with this message. Cloudflare is throttling, out of daily quota, or
 *   unhappy with the sender or account, which is the same for every message: stop and try later.
 * `retry`: a hiccup on their side, or ours; try this message again, up to a cap.
 * `permanent`: this message will never go (suppressed or rejected address, bad content).
 */
export class EmailError extends Error {
  constructor(
    readonly kind: "wait" | "retry" | "permanent",
    readonly code: string,
  ) {
    super(code);
    this.name = "EmailError";
  }
}

export const RATE_LIMITED = "E_RATE_LIMIT_EXCEEDED";
const WAIT = new Set([
  RATE_LIMITED,
  "E_DAILY_LIMIT_EXCEEDED",
  // Sender and account problems are the same for every message, so they aren't the customer's failure.
  "E_SENDER_NOT_VERIFIED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_ACCOUNT_SUSPENDED",
]);

export function classifyEmailError(error: unknown) {
  const code = String((error as { code?: unknown })?.code ?? "E_UNKNOWN").slice(0, 60);
  if (WAIT.has(code)) return new EmailError("wait", code);
  // An unknown error is as likely ours as theirs, so it's retried, up to the caller's cap.
  if (code === "E_INTERNAL_SERVER_ERROR" || code === "E_UNKNOWN") {
    return new EmailError("retry", code);
  }
  return new EmailError("permanent", code);
}

/** Whether the address may be mailed. Unset means anyone: the filter is a safety for dev stores. */
export function recipientAllowed(env: object, address: string) {
  const domains = (env as { EMAIL_RECIPIENT_DOMAINS?: string }).EMAIL_RECIPIENT_DOMAINS;
  if (!domains) return true;
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  return domains
    .split(",")
    .some((allowed) => allowed.trim().toLowerCase() === domain);
}

/** Sends one email. Throws `EmailError`. Cloudflare has no idempotency key, so callers guard against repeats. */
export async function sendEmail(
  env: Pick<Env, "EMAIL" | "EMAIL_FROM_ADDRESS">,
  message: Outgoing,
): Promise<{ messageId: string }> {
  try {
    const result = await env.EMAIL.send({
      to: message.to,
      from: { email: env.EMAIL_FROM_ADDRESS, name: message.fromName },
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { messageId: String(result.messageId) };
  } catch (error) {
    throw classifyEmailError(error);
  }
}

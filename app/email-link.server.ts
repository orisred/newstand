/**
 * Signed, expiring links in emails. A link names a subscription (and a release) by internal ID
 * and says nothing about the customer. The signature stops anyone making up or changing one.
 *
 * Anyone who holds the link can use it until it expires, so it can do no more than record, on an
 * explicit click, that an address was confirmed. Anything else needs the customer to sign in.
 */

export type LinkKind = "address" | "card";

export type LinkPayload = {
  /** What the link is for. */
  k: LinkKind;
  /** The subscription ID. */
  s: string;
  /** The release ID, for an address link: with the subscription it identifies the Delivery. */
  r?: string;
  /** Expiry, in seconds since 1970. */
  e: number;
};

const LINK_DAYS = 30;
const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fromBase64Url = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );

// A key of its own, derived from the app secret, so the secret never signs anything directly.
async function linkKey(env: Pick<Env, "SHOPIFY_API_SECRET">, usage: "sign" | "verify") {
  const root = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.SHOPIFY_API_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign(
    "HMAC",
    root,
    encoder.encode("release-subscriptions/email-link/v1"),
  );
  return crypto.subtle.importKey(
    "raw",
    derived,
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export async function signLinkToken(
  env: Pick<Env, "SHOPIFY_API_SECRET">,
  link: { k: LinkKind; s: string; r?: string },
  now = new Date(),
) {
  const payload: LinkPayload = {
    ...link,
    e: Math.floor(now.getTime() / 1000) + LINK_DAYS * 86400,
  };
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await linkKey(env, "sign"),
    encoder.encode(body),
  );
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

/** The payload if the signature is ours and the link hasn't expired; otherwise null. */
export async function verifyLinkToken(
  env: Pick<Env, "SHOPIFY_API_SECRET">,
  token: string,
  now = new Date(),
): Promise<LinkPayload | null> {
  try {
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra !== undefined) return null;
    const valid = await crypto.subtle.verify(
      "HMAC",
      await linkKey(env, "verify"),
      fromBase64Url(signature),
      encoder.encode(body),
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body)));
    if (
      (payload.k !== "address" && payload.k !== "card") ||
      typeof payload.s !== "string" ||
      (payload.r !== undefined && typeof payload.r !== "string") ||
      typeof payload.e !== "number" ||
      payload.e * 1000 <= now.getTime()
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * The customer portal: the customer account extension, which shows on the Profile page. Signing in
 * is Shopify's, with the email address and a code. It shows only once a merchant has placed the
 * extension in the checkout and accounts editor (Customize on the customer accounts settings,
 * Apps, add it to Profile, Save); until then the Profile page has nothing of ours on it.
 */
export const portalUrl = (shopGid: string | undefined, shopDomain: string) =>
  shopGid
    ? `https://shopify.com/${shopGid.split("/").pop()}/account/profile`
    : `https://${shopDomain}/account`;

/** Where an email's button goes: the app's link page, which sends the customer on to the portal. */
export async function linkUrl(
  env: Pick<Env, "SHOPIFY_API_SECRET" | "SHOPIFY_APP_URL">,
  link: { k: LinkKind; s: string; r?: string },
  now = new Date(),
) {
  return `${env.SHOPIFY_APP_URL}/l/${await signLinkToken(env, link, now)}`;
}

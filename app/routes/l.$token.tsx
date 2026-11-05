import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { createDb } from "../db.server";
import { portalUrl, verifyLinkToken } from "../email-link.server";
import { graphqlOf } from "../plan-sync.server";
import { confirmAddress, portalCopy, upcomingFor } from "../portal.server";
import { linkLimited } from "../rate-limit.server";
import { unauthenticated } from "../shopify.server";

// The token is in the URL, so keep it out of caches and referrers.
export const headers = () => ({
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
});

/**
 * Where an email's address and card buttons land (see "Emails, Flow and the member tag" in
 * docs/DECISIONS.md). Anyone who holds the link can open it, so the token alone does two things
 * only: show this page, which says nothing personal, and, on an explicit click, record that the
 * address was confirmed. The address itself, changing it and the card are all in the customer's
 * account, which needs the customer to sign in. Opening the page, as a mail scanner does, changes nothing.
 */
async function load(env: Env, token: string) {
  const link = await verifyLinkToken(env, token);
  if (!link) return null;
  const db = createDb(env.DB);
  const subscription = await db.subscription.findFirst({
    where: {
      id: link.s,
      status: { not: "ENDED" },
      customerGid: { not: "redacted" },
    },
    select: {
      id: true,
      shopId: true,
      firstReleaseNumber: true,
      releasesRemaining: true,
      status: true,
      shop: {
        select: {
          shopDomain: true,
          releaseWordSingular: true,
          releaseWordPlural: true,
        },
      },
    },
  });
  return subscription ? { link, db, subscription } : null;
}

export const loader = async ({ params, context }: LoaderFunctionArgs) => {
  const env = context.cloudflare.env;
  const found = await load(env, String(params.token));
  if (!found) return { kind: null };
  const { link, db, subscription } = found;
  const { shop } = subscription;
  const words = {
    singular: shop.releaseWordSingular,
    plural: shop.releaseWordPlural,
  };
  const release =
    link.k === "address" && link.r
      ? (await upcomingFor(db, env.DB, subscription)).find(
          (r) => r.id === link.r,
        )
      : undefined;
  const title = release
    ? release.title
    : link.k === "address" && link.r
      ? ((
          await db.release.findFirst({
            where: { id: link.r, shopId: subscription.shopId },
            select: { title: true },
          })
        )?.title ?? null)
      : null;
  // Where the customer signs in. If Shopify can't be asked, the account's front door still works.
  let shopGid: string | undefined;
  try {
    const { admin } = await unauthenticated.admin(shop.shopDomain);
    shopGid = (
      await graphqlOf(admin)(`#graphql
      query PortalShop { shop { id } }`)
    ).shop.id;
  } catch {
    shopGid = undefined;
  }
  return {
    kind: link.k,
    word: words.singular,
    title,
    confirmable: release?.confirmable ?? false,
    confirmed: release?.confirmed ?? false,
    notice: release?.ordered
      ? portalCopy(words).started
      : portalCopy(words).closed,
    portal: portalUrl(shopGid, shop.shopDomain),
  };
};

export const action = async ({ params, context, request }: ActionFunctionArgs) => {
  const env = context.cloudflare.env;
  const found = await load(env, String(params.token));
  if (!found || found.link.k !== "address" || !found.link.r)
    return { done: false };
  // Counted per place it's pressed from: a forwarded link can't use up the customer's own presses, and
  // signing in to confirm is always there.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (await linkLimited(env.DB, found.subscription.id, ip)) {
    return { done: false, limited: true };
  }
  const done = await confirmAddress(
    found.db,
    env.DB,
    found.subscription,
    found.link.r,
  );
  return { done };
};

const page = {
  fontFamily: "system-ui, sans-serif",
  maxWidth: 480,
  margin: "4rem auto",
  padding: "0 1rem",
} as const;

export default function EmailLink() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  if (!data.kind) {
    return (
      <main style={page}>
        <h1>This link has expired</h1>
        <p>Please reply to the email you came from and we&apos;ll help.</p>
      </main>
    );
  }
  const confirmed = data.confirmed || result?.done;
  return (
    <main style={page}>
      {data.kind === "card" ? (
        <>
          <h1>Update your card</h1>
          <p>For your security, sign in to your account to update your card.</p>
        </>
      ) : (
        <>
          <h1>Confirm your delivery address</h1>
          {data.title ? <p>{data.title}</p> : null}
          {confirmed ? (
            <p>Thanks, your delivery address is confirmed.</p>
          ) : result && "limited" in result ? (
            <p>
              That&apos;s a lot of tries. Please wait a while, or sign in to
              confirm your address instead.
            </p>
          ) : data.confirmable ? (
            <>
              <p>
                Your order is created when it starts shipping, using the
                delivery address on your subscription. If it&apos;s right,
                confirm it here. To see it or change it, sign in to your
                account.
              </p>
              <Form method="post">
                <button type="submit">My delivery address is right</button>
              </Form>
            </>
          ) : (
            <p>
              {result?.done === false
                ? "This can't be confirmed any more. "
                : ""}
              {data.notice}
            </p>
          )}
        </>
      )}
      <p>
        <a href={data.portal}>
          {data.kind === "card"
            ? "Sign in to update your card"
            : "Sign in to check or change your address"}
        </a>
      </p>
      <p style={{ fontSize: 14, color: "#6d7175" }}>
        Sign in with the email address you subscribed with. We&apos;ll send you
        a code, and you don&apos;t need a password. If you can&apos;t get in,
        reply to the email you came from.
      </p>
    </main>
  );
}

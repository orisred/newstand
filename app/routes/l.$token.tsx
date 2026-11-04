import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { verifyLinkToken } from "../email-link.server";

// The token is in the URL, so keep it out of caches and referrers.
export const headers = () => ({
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
});

/**
 * Where an email's address and card buttons land. Step 11 replaces this with the customer
 * portal's address and card pages (see "Emails" in docs/DECISIONS.md). Until then it only says
 * whether the link is good: it records nothing, shows nothing about the customer and changes nothing.
 */
export const loader = async ({ params, context }: LoaderFunctionArgs) => {
  const link = await verifyLinkToken(context.cloudflare.env, String(params.token));
  return { kind: link?.k ?? null };
};

export default function EmailLink() {
  const { kind } = useLoaderData<typeof loader>();
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 480, margin: "4rem auto", padding: "0 1rem" }}>
      {kind ? (
        <>
          <h1>Thanks for opening this link</h1>
          <p>
            The page for {kind === "card" ? "updating your card" : "confirming your delivery address"} isn&apos;t
            ready yet. Please reply to the email you came from and we&apos;ll help.
          </p>
        </>
      ) : (
        <>
          <h1>This link has expired</h1>
          <p>Please reply to the email you came from and we&apos;ll help.</p>
        </>
      )}
    </main>
  );
}

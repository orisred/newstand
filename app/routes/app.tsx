import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { useTerms } from "../vocabulary";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return { apiKey: context.cloudflare.env.SHOPIFY_API_KEY };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  const t = useTerms();

  return (
    <AppProvider apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Releases</s-link>
        <s-link href="/app/subscribers">{t.Members}</s-link>
        <s-link href="/app/revenue">Revenue</s-link>
        <s-link href="/app/plans">{t.Plans}</s-link>
        <s-link href="/app/import">Import</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

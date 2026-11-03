import { renderToReadableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import { type EntryContext } from "react-router";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";

export const streamTimeout = 5000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext,
) {
  addDocumentResponseHeaders(request, responseHeaders);
  const userAgent = request.headers.get("user-agent");

  // Abort the React renderer after 6 seconds, which ensures React has enough
  // time to flush down the rejected boundary contents.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), streamTimeout + 1000);

  let body;
  try {
    body = await renderToReadableStream(
      <ServerRouter context={reactRouterContext} url={request.url} />,
      {
        signal: controller.signal,
        onError(error: unknown) {
          responseStatusCode = 500;
          console.error(error);
        },
      },
    );
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }

  const allReady = body.allReady.finally(() => clearTimeout(timeout));
  if (isbot(userAgent ?? "")) {
    await allReady;
  } else {
    // Errors after the shell has been sent already reached onError.
    allReady.catch(() => {});
  }

  responseHeaders.set("Content-Type", "text/html");
  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}

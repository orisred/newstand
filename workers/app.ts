import { createRequestHandler } from "react-router";

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  fetch(request, env, ctx) {
    return requestHandler(request, { cloudflare: { env, ctx } });
  },

  // Step 3 replaces these two stubs. They exist so the Cron Trigger and the
  // queue consumer have a handler to call.
  scheduled(controller) {
    console.log(`Tick ${controller.cron}: no jobs are defined yet`);
  },

  queue(batch) {
    console.error(
      `Queue ${batch.queue}: no consumer yet, retrying ${batch.messages.length} message(s)`,
    );
    batch.retryAll();
  },
} satisfies ExportedHandler<Env>;

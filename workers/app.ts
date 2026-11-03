import { createRequestHandler } from "react-router";
import { dueWorkFinders, jobHandlers } from "../app/jobs/registry.server";
import { consumeDeadJobs, consumeJobs, runTick } from "../app/jobs/runner.server";

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

  scheduled(controller, env) {
    return runTick(env, controller, dueWorkFinders);
  },

  queue(batch, env) {
    return batch.queue.endsWith("-dlq")
      ? consumeDeadJobs(batch, env)
      : consumeJobs(batch, env, jobHandlers);
  },
} satisfies ExportedHandler<Env>;

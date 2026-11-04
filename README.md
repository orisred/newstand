# Release Subscriptions

A Shopify app for subscriptions sold as **releases**: magazine and zine issues, record pressings, club drops, seasonal boxes. Dates are optional: by default the merchant moves each release from unannounced to pre-order to ready to ship by hand. A plan sells a number of releases, either paid per release or as a prepaid bundle. A bundle renews on its term date by default, waiting if its last paid release's order hasn't been created yet.

The first merchant is Cake Zine, moving off Conjured Memberships. A public App Store listing comes later.

## Why this exists

Shopify's selling plan anchors only repeat on a weekday, a day of the month or a day of the year. Generic subscription apps (Recharge, Seal, Appstle, Conjured) build on that, so billing drifts from real issue dates, the product has to be swapped by hand each issue, and prepaid orders created in advance miss address changes. See `docs/PLAN.md` for the research and sources.

## Stack

- Shopify app template (React Router), Polaris web components, App Bridge
- Cloudflare Workers (via `@cloudflare/vite-plugin`), D1 database through Prisma's D1 adapter
- Sessions in D1, refreshed on load (`app/session-storage.server.ts`)
- Cron Triggers (hourly tick) and Cloudflare Queues for background work
- Workers Paid plan ($5/month)
- Theme app extension (plan picker), customer account UI extension (portal) and a cart validation Function (one plan per checkout)
- Built-in emails, each switchable off in favor of Shopify Flow or Klaviyo

## Getting started

1. Install the Shopify CLI and log in with a Shopify Partner account. Log in to Cloudflare with `npx wrangler login`.
2. Run `npm install`, which also generates the Prisma client into `app/generated/`.
3. Copy `.dev.vars.example` to `.dev.vars` and fill in the client secret from `shopify app env show`.
4. Run `npm run dev` (`shopify app dev`). It applies D1 migrations locally and runs the app in `workerd` through Vite.

To run the built Worker instead, use `npm run build`, `npm run db:migrate:local` and `npx wrangler dev`. It needs a public URL for Shopify to reach, such as `npx wrangler tunnel quick-start http://localhost:8787`, set as `SHOPIFY_APP_URL` in `.dev.vars` before the build and as `application_url` in `shopify.app.toml`.

## Deploying

- Worker: `npm run db:migrate:remote`, then `npm run deploy:worker`. The client secret is stored with `wrangler secret put SHOPIFY_API_SECRET`.
- App configuration (URLs, webhooks, scopes): `npm run deploy` (`shopify app deploy`).
- A scope change needs both: `npm run deploy` releases it and merchants are asked to approve it in the admin (the `app/scopes_update` webhook then updates the stored session, and a token refresh returns the new scope too). `SHOPIFY_APP_URL` and `SCOPES` in `wrangler.jsonc` must match `application_url` and `access_scopes.scopes` in `shopify.app.toml`.
- `shopify app dev` leaves a dev preview on the store that overrides `application_url`. Run `shopify app dev clean` when you finish, or the store keeps using the dead tunnel.

## Plan picker block

The theme app extension in `extensions/plan-picker` adds a **Plan picker** app block to the product page. Release it with `npm run deploy`. A merchant adds it in the theme editor: Customize the theme, open a product template, **Add block** on the product information section, choose **Plan picker** under Apps, move it above the buy buttons and save. It shows only this app's plans (`app_id`), with the first chosen, and joins the theme's product form through the `form` attribute, so it needs no JavaScript. The form is assumed to be `product-form-<section id>` (Dawn and its descendants); another theme sets **Product form ID** in the block. Its heading and subscription terms are block settings; empty terms show nothing. A theme that adds its own `selling_plan` to the cart request, or lists selling plans itself, will clash with it (the dev store's theme did, and was patched).

## One plan per checkout

The Function in `extensions/one-plan-per-cart` stops a cart holding two different selling plans, because Shopify can merge them onto one contract, which can't be charged separately. `npm run deploy` builds and releases it, and the first plan sync after that turns it on. A merchant can turn it off under Settings > Checkout > Checkout rules. See "Subscriptions in" in `docs/DECISIONS.md`.

## Database changes

Edit `prisma/schema.prisma`, then generate the next SQL file with `npx prisma migrate diff`, save it as `migrations/NNNN_name.sql`, and apply it with `wrangler d1 migrations apply`. `prisma migrate deploy` doesn't work on D1. Check the SQL before applying it: Prisma writes JSON defaults unquoted, which is invalid, and it rebuilds a table (drop and copy) for changes that need only `ALTER TABLE ... ADD COLUMN`, so write those by hand (see `migrations/0003_plan_sync.sql`).

## Background jobs

Add a job type and, if the tick should find it, a finder in `app/jobs/registry.server.ts`. Merchant actions call `enqueueJobs` directly. Give each job a stable `id`: that's its idempotency key, so the same ID runs once however often it's enqueued or delivered.

A job that keeps failing is retried with backoff for about half an hour, then goes to the dead-letter queue, which logs `job.dead` and keeps the message in `JobRun` with status `DEAD`. It never runs again by itself. To run it again, delete its row and send the stored `body` to the queue.

Logs are JSON with `event`, `jobType`, `jobId` and `shop`. Find failures in the Workers logs by searching for `job.failed` or `job.dead`. Search `payment_order.not_visible` for payment orders the app couldn't mark, and `delivery.duplicate_orders` for a repeated $0 order.

A release's run recovers by itself: the tick starts a new chain of `release.run` slices every hour for each open release at its order step, so don't resend a dead one. Search `release_run.throttled` for Shopify's limit at work, and `release_run.left_for_tick` or `release_run.order_failed` for orders that keep failing. See "Release runs" in `docs/DECISIONS.md`.

Charges recover the same way: the tick finds renewals due, retries due and attempts with no result. Search `billing.failed` for failed charges, `billing.unknown_attempt` for a charge the app didn't make, and `session.refresh_rejected` for a shop whose token has died. See "Renewals and charges" in `docs/DECISIONS.md`.

Then follow `docs/BUILD_STEPS.md`, one agent thread per step.

## Docs

- `docs/PLAN.md`: scope, MVP, architecture, data model, edge cases, build order
- `docs/DECISIONS.md`: every product decision and the public-app setting it implies
- `docs/BUILD_STEPS.md`: the build split into steps, each assigned an agent model and effort
- `AGENTS.md`: instructions for coding agents working in this repo

# Release Subscriptions

A Shopify app for subscriptions sold as **releases**: magazine and zine issues, record pressings, club drops, seasonal boxes. Each release has its own date and order cutoff. A plan sells a number of releases, and renewal charges when the paid releases run out.

The first merchant is Cake Zine, moving off Conjured Memberships. A public App Store listing comes later.

## Why this exists

Shopify's selling plan anchors only repeat on a weekday, a day of the month or a day of the year. Generic subscription apps (Recharge, Seal, Appstle, Conjured) build on that, so billing drifts from real issue dates, the product has to be swapped by hand each issue, and prepaid orders created in advance miss address changes. See `docs/PLAN.md` for the research and sources.

## Stack

- Shopify app template (React Router), Polaris web components, App Bridge
- Cloudflare Workers (via `@cloudflare/vite-plugin`), D1 database through Prisma's D1 adapter
- Sessions in Cloudflare KV (`@shopify/shopify-app-session-storage-kv`)
- Cron Triggers (hourly tick) and Cloudflare Queues for background work
- Workers Paid plan ($5/month)
- Theme app extension (plan picker) and customer account UI extension (portal)
- Built-in emails, each switchable off in favor of Shopify Flow or Klaviyo

## Getting started

1. Install the Shopify CLI and log in with a Shopify Partner account.
2. Scaffold the app into this repo: `shopify app init --template=https://github.com/Shopify/shopify-app-template-react-router` (merge the generated files with this folder; keep `docs/` and `AGENTS.md`).
3. Port the template to Workers: add `wrangler.jsonc` with D1, KV and Queue bindings, switch the build to `@cloudflare/vite-plugin`, replace Node-only rendering (`renderToPipeableStream`) with `renderToReadableStream`, and swap Prisma session storage for the KV adapter.
4. Replace the template's Prisma schema with `prisma/schema.draft.prisma`. Generate SQL with `prisma migrate diff` and apply it with `wrangler d1 migrations apply`.
5. Create a development store and run `shopify app dev`.

Then follow `docs/BUILD_STEPS.md`, one agent thread per step.

## Docs

- `docs/PLAN.md`: scope, MVP, architecture, data model, edge cases, build order
- `docs/DECISIONS.md`: every product decision and the public-app setting it implies
- `docs/BUILD_STEPS.md`: the build split into steps, each assigned an agent model and effort
- `AGENTS.md`: instructions for coding agents working in this repo

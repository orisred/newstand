# Plan

Full scoping doc with research and sources: https://claude.ai/artifact/1CveYyqBcxAYVx5Y9rDNDE
This file is the build-facing summary. Settled product decisions live in `DECISIONS.md`.

## What we are building

A Shopify app for subscriptions sold as releases. A release moves from unannounced to pre-order to ready to ship, either when the merchant presses a button (default) or on scheduled dates; it can also have a quantity. Every plan takes its initial charge at sign-up. After that, a plan is either pay-per-release (each later release is charged at the same moment its order is created, by default when it starts shipping) or a prepaid bundle of releases with its own display name ("Yearly subscription", "2 issues paid upfront"). A bundle renews on its term date, for example 1 year after sign-up, but if its last paid release is late, the renewal is charged when that release's order is created. The renewal rule is a per-plan setting.

Shopify holds the checkout, the saved card, the subscription contract and the orders. The app owns the release calendar, when each subscriber is charged, who receives each release, the customer portal and the merchant admin.

## Why existing apps fall short

- Shopify selling plan anchors only repeat on a weekday, day of month or day of year, so generic apps can't follow irregular release dates.
- The product changes each release; generic apps need a manual swap per issue.
- Prepaid apps create future orders early, so address changes miss them.
- Closest existing apps are vertical-specific: Subi (magazines), CrushSuite Clubs (wine), Manage Comics 2 (comics). Subi is the benchmark to beat.

## MVP

1. Plans synced to Shopify selling plans: pay-per-release, or prepaid bundles with a merchant-chosen display name.
2. Releases without fixed dates: each release stays unannounced until the merchant announces its pre-order, then is marked ready to ship. Merchants who prefer dates can schedule both steps instead.
3. Start rule: the switchover is when the next release's pre-order opens. Before that, a new subscriber gets the latest released issue, shipped right away; after it, they get the pre-order issue.
4. Release runs: when a release is marked ready to ship (or when its pre-order opens, per shop setting), create one $0 Shopify order per subscriber and export the run as CSV.
5. Renewal engine: bundles renew on their term date, or when the last paid release's order is created if it is late; per-release plans charge when each release's order is created, following the shop's order timing; retry failures, then pause.
6. Customer portal (customer account UI extension): address, card, cancel, upcoming releases.
7. Built-in emails: welcome, **pre-order announced**, upcoming charge, failed payment, last paid release shipping. Each can be switched off.
    - **Pre-order announced** goes to every subscriber who will receive the new release (gift recipients, not buyers). It says they'll get the new issue as soon as it starts shipping, and that their order is created when shipping starts. The main call to action is "Confirm or update your delivery address", linking to the address page in the portal. Confirmations are recorded per delivery so the admin can see who hasn't confirmed. Paused subscribers get "update your card" as the main call to action instead.
8. Gift subscriptions: buyer pays, fixed number of releases, never auto-renews.
9. Member discount for active subscribers via a customer tag, plus Shopify Flow triggers.
10. Merchant admin: subscribers, release runs, revenue per release, churn.
11. Import of existing subscribers.

Deferred: bundles, swaps, add-ons with a release, print-run caps, gated digital content, Klaviyo and shipping-label integrations, multi-currency, advanced analytics.

## Architecture

- Shopify app template (React Router), Polaris web components, App Bridge, ported to Cloudflare Workers.
- Data in D1 (SQLite) via Prisma's D1 adapter; sessions in KV.
- One Worker with three handlers: `fetch` (embedded app, webhooks, portal API), `scheduled` (hourly Cron Trigger finds due work), `queue` (Cloudflare Queues consumer does billing, order runs, emails).
- Workers Paid plan: about $5 a month for Cake Zine and roughly $5 to $10 at 500 shops.
- Jobs: pre-order announcement (switch new subscribers), order run at the shop's order timing step (create orders and charge per-release plans together), renewal billing, retries, reminder emails, member tag updates.
- Webhooks: subscription contract create/update, billing attempt success/failure, customer and shop GDPR, app uninstalled.
- Extensions: theme app extension (plan picker), customer account UI extension (portal).

## Data model

| Table | Holds | Key fields |
| --- | --- | --- |
| Shop | Merchant settings | release word, allowed countries, order timing, email toggles, member discount |
| Release | One issue, drop or box | number, title, preorderOpensAt?, cutoffAt?, shipAt?, triggerMode, quantity?, status (unannounced, preorder, ready, shipped, cancelled) |
| Plan | What a customer buys | sellingPlanId, billingMode, displayName, releasesPerTerm, termMonths, renewalRule, price, autoRenew, startRule, giftable |
| Subscription | One subscriber's term | contractId, status, releasesRemaining, nextReleaseId, gift buyer/recipient, lockedPrice, source |
| Delivery | One subscription receiving one release | releaseId, orderId, status, addressConfirmedAt |
| BillingAttempt | Each renewal charge and retry | attempt, result, errorCode, nextRetryAt |
| PriceChange | A plan price increase | newPrice, policy, noticeSentAt |
| Event | Audit log and Flow trigger source | type, payload, sentToFlowAt |

Draft Prisma models are in `prisma/schema.draft.prisma`.

## Edge cases

| Situation | What the app does |
| --- | --- |
| Sign-up between issues | Before the next pre-order opens: latest released issue, $0 order generated right after checkout and shipped now. After: the pre-order issue, charged at sign-up, $0 order created when shipping starts along with existing subscribers' orders |
| Last paid release is late past the renewal date | Renewal is held and charged when that release's order is created; subscriber gets a notice |
| Release cancelled | Doesn't count against paid releases |
| Extra release before a bundle's renewal date | Not included; renewal stays on the term date and the new term starts with the next release. A bundle buys N releases, not every release in 12 months |
| Renewal card still failing when orders are created | Subscription pauses; that release ships late once paid |
| Address change after a release's orders exist | Applies from the next release; the portal says so |
| Address outside the US | Blocked at checkout and in the portal |
| Cancellation mid-term | Auto-renew off; remaining paid releases still ship |
| Member discount after cancelling | Tag removed after the last paid release ships |
| Gift ends | Recipient offered a subscription; buyer never charged again |
| Gift to an existing subscriber | Second subscription (two copies) |
| Same customer subscribes twice | Two subscriptions, two copies |
| Price increase | Merchant chooses per change: keep old price or apply at next renewal with notice |
| Chargeback on a renewal | Pause and flag |
| GDPR redact | Erase personal data; order history stays in Shopify |

## Migration from Conjured

- Conjured exports contacts only. Rebuild each subscriber's term from Shopify order history: last annual purchase, plan bought, issues shipped since.
- Our app can't read Conjured's contracts through the API. Create new contracts against each customer's saved Shopify Payments card; confirm this works on a dev store first.
- 250 to 1,000 subscribers: spot-check the rebuilt list by hand.
- Cut over before the next issue run (more than 3 months away as of 2026-11-01). Switch off Conjured renewals at cutover.

## Build order

1. Scaffold: Partner account, dev store, template ported to Workers (D1, KV, Queues, Cron).
2. Releases and plans: admin screens, scopes requested, selling plan sync, theme extension plan picker.
3. Subscriptions in: contract webhook creates a subscription with its first release.
4. Release runs: announce and ready-to-ship actions (manual or scheduled); the run creates $0 orders, closes the release, CSV export.
5. Renewals: term-date renewals with late-release hold, per-release charges, retries, pause, price-change policy, emails.
6. Portal, gifts and perks: customer account extension, gift checkout, member tag, Flow triggers.
7. Migration: import script, dry run, cutover.
8. Public listing: Billing API, GDPR webhooks, onboarding, listing, review.

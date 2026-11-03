# Decisions

All decided by N on 2026-11-01. "Cake Zine" is the first merchant's behavior; "Public app setting" is how other merchants will vary it.

| Topic | Cake Zine | Public app setting |
| --- | --- | --- |
| What a subscription buys | Pay per issue, or a prepaid bundle (e.g. 2 issues) | Billing mode per plan; a bundle has its own display name, such as "Yearly subscription" or "2 issues paid upfront" |
| First release | Switches when the next issue's pre-order is announced: before, the latest released issue (ships now); after, the pre-order issue | Start rule per plan: pre-order switchover (default), current release if before its cutoff, or always next |
| Initial charge | At sign-up, on every plan (N, 2026-11-03) | Same |
| Renewal timing (bundles) | Term date (1 year after sign-up, assuming 2 issues a year). If the last paid issue hasn't shipped by then, the renewal is charged when that issue's order is created | Renewal rule per plan: term date with late hold (default), term date only, or when paid releases run out |
| Extra issue before renewal | Not included; wait for normal renewal (bundle = N issues, not all issues in 12 months) | Same |
| Subscription and issue orders | The subscription is its own item: checkout and billing orders record payment and never ship an issue. Each issue ships on a separate generated $0 order, including an already released first issue. Checkout always collects a shipping address; the app marks payment orders fulfilled without notifying the customer (N, 2026-11-03) | Same |
| First order for a new subscriber | Issue already released: issue order generated right after checkout, ships right away. Sign-up during a pre-order: charged at sign-up, issue order created when shipping starts, same as existing subscribers (N, 2026-11-03) | Same |
| Renewal timing (per issue) | After the first issue, charge and order happen at the same time, when the issue starts shipping (changed by N on 2026-11-03; was before each issue's cutoff) | Same: the charge follows the shop's order timing setting, with no separate charge setting |
| Auto-renew | On, with a reminder; opt out anytime | Auto, manual, or subscriber's choice |
| Orders | One Shopify order per issue, created when the issue is ready to ship | Shop setting: create orders when ready to ship (default) or when the pre-order opens |
| Release dates | None until the pre-order is announced; the merchant triggers each step by hand | Per release: manual triggers (default) or scheduled dates |
| Failed renewal | Retry, then pause; missed issue ships late once paid | Pause or cancel after retries |
| Cancellation | Ship remaining paid issues, no refund | Optional refund of unshipped releases |
| Shipping | US only | Regional pricing |
| Price increases | Decide each time | Same |
| Gifts | At launch; gift to an existing subscriber is a second subscription | Same |
| Add-ons with a release | No | Optional later |
| Shop perks | Automatic member discount | Discount and tag rules |
| Print-run cap | No | Optional per release |
| Automations | Shopify Flow and customer tags | Flow triggers, tags, metafields |
| Emails | Built-in, each switchable off | Same |
| Pre-order announcement email | Tell subscribers they get the new issue as soon as it ships and that the order is created then; main CTA: confirm or update delivery address | Same, wording editable |
| Payments | Shopify Payments | Shopify-vaulted gateways |
| Target market | Release-based products, publications first | Release word per shop |
| Build vs buy | Build; Subi is the benchmark | n/a |

## Stack

| Topic | Decision |
| --- | --- |
| Framework | Shopify app template (React Router), Polaris web components, App Bridge, Prisma |
| Hosting | Cloudflare Workers (Paid, $5/month); chosen 2026-11-03 over Fly.io + Neon because it is cheapest at App Store scale |
| Database | D1 (SQLite) via Prisma D1 adapter, including sessions (see the note below; was KV until 2026-11-03) |
| Jobs | Hourly Cron Trigger + Cloudflare Queues |
| Coding tool | T3 Code |

### Offline tokens moved from KV to D1 (2026-11-03)

Background jobs depend on Shopify's expiring offline tokens, so Step 3 tested them on `newstand-dev`.

- **Safe:** two refreshes at once, or a refresh from a stale read. The old refresh token keeps working until its successor is used, and it returns the same successor.
- **Safe, as far as tested:** two token exchanges at once. In 2 of 2 rounds on a cold token they returned the same token, and in 3 more on a fresh one both results still refreshed. Both used one ID token, because App Bridge returned the same one. Shopify doesn't document this, so it could change. It's why nothing stops the admin's parallel loaders from each running an exchange on first load.
- **Not safe:** a refresh racing a token exchange. In 2 of 3 rounds both returned 200 but the refresh's new refresh token was already dead, and in the third the refresh itself got a 401. If the dead token is stored last, jobs fail once the access token expires, until the merchant next opens the app. An exchange on a token that has gone cold also retires the previous refresh token straight away.

The library ran an exchange whenever an admin request found a token within 5 minutes of expiry, and a job refreshing at that moment could hit this race. So `app/session-storage.server.ts` now refreshes on load, for admin requests and jobs alike, and an exchange only happens when there's no session or Shopify rejects the refresh token. This departs from Shopify's advice to use a token exchange during an active merchant session, because that advice is what makes the race possible.

Sessions moved to D1 because the KV adapter doesn't fit refreshing: its per-shop list grows on every store and is read key by key on uninstall, and KV limits writes to one per second per key, which two parallel loaders can exceed. D1 has neither problem and no stale reads. The cost is one small D1 read per `authenticate.admin` call.

### Plans and selling plans (2026-11-03)

Technical choices from Step 5 that Steps 6, 7 and 9 live with.

- **One selling plan group per plan, holding one selling plan**, attached to one product. The group's `merchantCode` is the plan's ID, which is how a sync finds a group whose ID never reached D1. Shopify's admin shows that code as the group's title on the product (cosmetic).
- **Customers see `displayName`** as both the group and the selling plan name; the group's option is named "Subscription".
- **Price:** a fixed `PRICE` pricing policy, so the plan's price replaces the product's at checkout. The selling plan's currency is the store's, read at sync time and stored on the plan.
- **Schedule:** Shopify never bills a contract by itself, only a `subscriptionBillingAttemptCreate` from the app does, and the delivery policy only labels the contract. So the intervals are chosen to be harmless: a bundle uses its term (`YEAR` x years if the term is whole years, else `MONTH` x months), so the contract's next billing date is the term date; a per-release plan uses `YEAR` x 1. No anchors, cutoff, minimum or maximum cycles. The delivery policy is `FULFILLMENT_BEGIN` with `ASAP`. **Not verified live:** a contract needs a checkout, which is Step 6. Step 7 should confirm what `nextBillingDate` is on a real contract, and Step 9 should confirm that a billing attempt outside the cycle date is accepted (`billingCycleSelector`, `originTime`) and that the early or late attempt doesn't change the order's fulfillment timing.
- **Turning a plan off** removes it from its product and keeps the group and selling plan in Shopify, so contracts that reference them are untouched. Nothing is deleted. Turning it on puts it back.
- **Editing:** the billing mode, releases per term and term length can't change once a plan exists, because they're what subscribers bought. Name, display name, price, renewal rule, start rule, auto-renew, giftable and product can. A new price applies to new sign-ups; Shopify's contracts keep their own price (documented behavior, not verified live). Step 9's price-change policy goes in `updatePlan` in `app/plans.server.ts`.
- **Sync runs on the queue** (`plan.sync`, job ID `plan.sync:{planId}:{revision}`), reading the plan's current state, not a snapshot. Write order: lease the plan in D1, find the group (stored ID, else by code), create or update it in Shopify, store the group and selling plan IDs in D1 at once, fix the attached products, read the group back and compare, then write the status unless the plan was edited meanwhile. Statuses: not synced, syncing, in sync, differs from Shopify, error. Shopify's search by `merchant_code` is loose and needs the value quoted when it has colons; results are matched exactly.
- **Scopes** (set in `shopify.app.toml` and `SCOPES`): `write_products`, `read_customers`, `write_customers`, `read_customer_payment_methods`, `write_own_subscription_contracts`, `write_orders`, `write_merchant_managed_fulfillment_orders`. The `read_` forms are implied by `write_`. `read_all_orders` is left for Step 14, which needs orders older than 60 days.
- **`app/scopes_update` webhook:** it used to write back the whole session it loaded, which could undo a refresh that landed in between. It now changes only the stored scope, with a compare-and-set (`updateScope`).
- **Countries:** `allowedCountries` is checked against Shopify's `CountryCode` list (243 codes, `app/countries.ts`). It isn't enforced at checkout yet.

## Cake Zine facts

- 1 to 2 issues a year; 250 to 1,000 active subscribers.
- Next issue cutoff more than 3 months away (as of 2026-11-01).
- Conjured is used only for annual billing; it exports contacts only.


Cake Zine's choices are defaults, not the only mode: every row above with a public app setting must support the other options too.

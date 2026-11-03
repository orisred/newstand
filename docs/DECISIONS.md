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
- **Schedule:** Shopify never bills a contract by itself, only a `subscriptionBillingAttemptCreate` from the app does, and the delivery policy only labels the contract. So the intervals are chosen to be harmless: a bundle uses its term (`YEAR` x years if the term is whole years, else `MONTH` x months), so the contract's next billing date is the term date; a per-release plan uses `YEAR` x 1. No anchors, cutoff, minimum or maximum cycles. The delivery policy is `FULFILLMENT_BEGIN` with `ASAP`. **Verified live in Step 6 (two test checkouts):** both contracts read back `billingPolicy` and `deliveryPolicy` as `YEAR` x 1 with no anchors or cycle limits, and `nextBillingDate` is one year after checkout, at 16:00 UTC (11:00 in the store's New York time) rather than the checkout time. Step 9 should confirm that a billing attempt outside the cycle date is accepted (`billingCycleSelector`, `originTime`) and that the early or late attempt doesn't change the order's fulfillment timing.
- **Group `appId`:** every group carries `appId: "release-subscriptions"` (`SELLING_PLAN_APP_ID`). Liquid exposes it as `selling_plan_group.app_id`, which is how the theme block shows only this app's plans; it was `null` before, so there was no other way to tell the app's groups apart. A sync puts it on groups made earlier.
- **One-time purchases:** while a product has a plan attached, the sync sets `requiresSellingPlan` on it, so Shopify refuses a cart without a plan (checked: add to cart and a `/cart/<variant>:1` link both fail). When a plan leaves a product that now has no selling plan group at all, the sync sets it back to false, because a product that requires a plan and has none can't be bought. A product that still has any group (this app's or another's) keeps it.
- **Shippable check:** the sync reports MISMATCH when a variant of the product isn't a physical product (`requiresShipping` false), because checkout then collects no shipping address (checked live: only a billing address was asked). The app doesn't change the variant.
- **Contract facts (Step 6, test gateway, guest checkout):** the contract is `ACTIVE`, its line's `sellingPlanId` is the plan's selling plan, and its `originOrder` is the checkout order: `PAID`, `UNFULFILLED`, with a `SHIPPING` fulfillment order `OPEN` at the shop location (the app must mark it fulfilled in Step 7). The order's line item has the plan too. The store's customer accounts setting is optional, and checkout worked as a guest, so a contract can belong to a customer with no account (state `DISABLED`).
- **Turning a plan off** removes it from its product and keeps the group and selling plan in Shopify, so contracts that reference them are untouched. Nothing is deleted. Turning it on puts it back.
- **Editing:** the billing mode, releases per term and term length can't change once a plan exists, because they're what subscribers bought. Name, display name, price, renewal rule, start rule, auto-renew, giftable and product can. A new price applies to new sign-ups; Shopify's contracts keep their own price (documented behavior, not verified live). Step 9's price-change policy goes in `updatePlan` in `app/plans.server.ts`.
- **Sync runs on the queue** (`plan.sync`, job ID `plan.sync:{planId}:{revision}`), reading the plan's current state, not a snapshot. Write order: lease the plan in D1, find the group (stored ID, else by code), create or update it in Shopify, store the group and selling plan IDs in D1 at once, fix the attached products, read the group back and compare, then write the status unless the plan was edited meanwhile. Statuses: not synced, syncing, in sync, differs from Shopify, error. Shopify's search by `merchant_code` is loose and needs the value quoted when it has colons; results are matched exactly.
- **Scopes** (set in `shopify.app.toml` and `SCOPES`): `write_products`, `read_customers`, `write_customers`, `read_customer_payment_methods`, `write_own_subscription_contracts`, `write_orders`, `write_merchant_managed_fulfillment_orders`, `write_validations` (added in Step 7 for the cart rule below). The `read_` forms are implied by `write_`. `read_all_orders` is left for Step 14, which needs orders older than 60 days.
- **`app/scopes_update` webhook:** it used to write back the whole session it loaded, which could undo a refresh that landed in between. It now changes only the stored scope, with a compare-and-set (`updateScope`).
- **Countries:** `allowedCountries` is checked against Shopify's `CountryCode` list (243 codes, `app/countries.ts`). It isn't enforced at checkout yet.

### Subscriptions in (2026-11-03)

Technical choices from Step 7 that Steps 8, 9, 12 and 14 live with. Checked with real test checkouts on `newstand-dev`.

- **`releasesRemaining` is the number of paid releases whose order hasn't been created.** It starts at `releasesPerTerm` for a bundle and 1 for a per-release plan, because the sign-up charge pays for the first release. It goes down by exactly 1 in the same batch that stores `Delivery.orderGid` (`createDeliveryOrder`), and at no other time: not at sign-up, not when a Delivery is assigned, not when a release ships. It counts releases, not copies. So 0 means every paid release has its order, which is what the late hold asks. A cancelled release never reaches an order, so it never counts.
- **Start rules** are evaluated at the contract's `createdAt`, so a webhook handled late gets the answer the customer signed up under. Status says whether a step has happened; a date only says whether it had happened by then, and a release with no date counts as early. Cancelled releases never count. "Current" is the latest release whose pre-order had opened at sign-up.
  - `PREORDER_SWITCHOVER`: the current release, shipped now if it's already out.
  - `CURRENT_IF_BEFORE_CUTOFF`: the current release if it wasn't yet ready to ship at sign-up; otherwise the next.
  - `NEXT`: the first release whose pre-order opens after sign-up.
  - With no release to give yet (none at all, only cancelled, or only unannounced), the subscription has no Delivery and waits. `Subscription.firstReleaseNumber` is the lowest release number it can receive, so Step 8 can tell which runs it joins. `nextReleaseId` is unused: a `PENDING` Delivery says what's next.
- **Order step:** `orderStepReached(status, orderTiming)` says whether a release's orders are due. If it's true when a sign-up is handled, the app creates that subscriber's order at once, which covers a sign-up during a pre-order under `PREORDER_OPENS` after the run has finished. Otherwise the Delivery stays `PENDING` for the run. The check runs after the Delivery is written, and the run must flip the status before it lists subscribers, so one side always sees the other.
- **$0 orders can't dedupe in Shopify.** Checked live: `orderCreate` accepts `@idempotent` and ignores it (the same key made two orders), and a metafield definition with unique values doesn't stop a second order either (it made one and silently dropped the value). So `createDeliveryOrder` takes a 5-minute lease on the Delivery, searches `source_identifier` for a marker (`release-subscriptions:delivery:<id>`), creates the order with that marker, then stores it. The search index lagged about 5 seconds when measured, and a crash leaves the lease to lapse, so the retry finds the order. Shopify's search is eventually consistent and promises no limit on that delay, so a duplicate needs an outage of the index lasting past the lease; two matches log `delivery.duplicate_orders`.
- **$0 order settings:** `sendReceipt` and `sendFulfillmentReceipt` are false, so Shopify sends nothing when the order is created. They don't affect a later shipment email, and the order gets its email address from the associated customer (both checked live). That email depends on the "Notify customer" toggle a merchant sees when fulfilling, which the app can't set: on, the timeline shows the shipping confirmation sent; off, nothing is sent. It was off at first on both $0 and checkout orders, and Shopify then remembers the last choice. `inventoryBehaviour` is `DECREMENT_IGNORING_POLICY`, because a paid release must not fail for being out of stock: checked live, it oversells and Shopify flags the order. `requiresShipping` comes from the variant, because Shopify otherwise marks the line as not shipping. No shipping or tax lines, and tax is 0 on a $0 line.
- **Orders that can't be created stay visible.** With no product, the Delivery stays `PENDING` and the releases screen shows who's waiting. A refusal from Shopify (or a contract with no address, such as pickup) is kept in `Delivery.orderError` and shown too. Choosing a product, even the same one, queues them again. "Too many attempts" isn't a refusal, though it arrives as a `userError` with no code: it throws and the job retries. Dev stores allow 5 new orders a minute.
- **`Release.productGid` holds a variant ID.** The picker is the product picker, because the variant picker shows a one-variant product with no name.
- **Payment orders:** `fulfillmentOrderClose` is for fulfillment services, so "mark fulfilled" is `fulfillmentCreate` with `notifyCustomer: false`, on only the lines belonging to a contract, so another product in the same checkout still ships. It refuses a $0 order by its marker. A fulfillment order assigned to a fulfillment service isn't visible with `write_merchant_managed_fulfillment_orders`, and since API version 2024-10 only that service can fulfill it, so no scope fixes this: the subscription product must stock at a merchant-managed location. The job logs `payment_order.not_visible`. Measured on three checkouts, the mark lands 17 to 18 seconds after the order is created.
- **Quantity above 1:** one Subscription with `quantity`; each $0 order ships that many copies. The contract already bills for them all, so nothing is lost and renewals stay right.
- **Several lines of one plan** add up. **A turned-off plan** still gets its subscription, because the customer has paid. **A contract with no plan of this shop's** is ignored.
- **Two plans on one contract (decided by N, 2026-11-03).** Shopify merges plans with the same billing cycle onto one contract (seen live: Yearly and Pay per issue), and a billing attempt charges a whole contract. So two things apply. A cart rule, the `one-plan-per-cart` validation Function, stops two different selling plans in a cart: checked live, `/cart/add.js` answers 422 with its message. It's turned on by the plan sync and left alone after that, so a merchant can turn it off in Shopify's checkout rules, and it lets checkouts through if it fails at runtime. It counts every app's selling plans, because a function's input doesn't say whose they are. And if a mixed contract gets through anyway, it gets no Subscription, its order stays unfulfilled, and the releases screen flags it until the merchant marks it handled.
- **Missed webhooks:** a tick finder enqueues one `contracts.reconcile` job per installed shop per hour, which reads the newest contracts and enqueues any with no Subscription under the webhook's own job ID. Shopify stops retrying after a few hours, and a contract lost that way is a customer who paid and gets nothing.
- **Cake Zine's setup (from N, 2026-11-03).** On Shopify Basic. No fulfillment app or 3PL: orders are fulfilled by hand in the Shopify admin, so nothing races the payment order's mark. Shipping is included in the plan price, through a free rate on the subscription product's shipping profile; product, shipping and handling costs get recorded separately for profit reporting (Step 13). The "every year" wording at checkout stays for now, with the terms text in the plan picker explaining the real schedule; Step 17 looks for something better. Which app holds the contracts is held until Step 16.
- **GDPR:** no names, addresses or emails are stored, only Shopify IDs, statuses, dates and a gift message. `customers/data_request` writes that as a `gdpr.data_request` Event for the merchant to hand over, with no screen yet. `customers/redact` sets `customerGid` to `redacted`, clears gift fields and address confirmations, ends the subscription, cancels unfulfilled Deliveries and deletes its Events; it keeps the contract ID so a replay can't recreate the subscription, and keeps order IDs. `shop/redact` deletes every row in one batch, children first: Event, BillingAttempt, Delivery, Subscription, PriceChange, Plan, Release, Shop, plus JobRun and OfflineSession. These jobs use Shopify's webhook ID and carry no `shop`, so `JobRun` keeps neither.

## Cake Zine facts

- 1 to 2 issues a year; 250 to 1,000 active subscribers.
- Next issue cutoff more than 3 months away (as of 2026-11-01).
- Conjured is used only for annual billing; it exports contacts only.


Cake Zine's choices are defaults, not the only mode: every row above with a public app setting must support the other options too.

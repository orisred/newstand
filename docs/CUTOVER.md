# Cutover runbook: Cake Zine from Conjured to Release Subscriptions

This runbook moves Cake Zine's subscribers from Conjured to this app. Follow it in order. Every step lists who does it, what it needs first, how to check it worked, and how to back out of it, or what makes it impossible to undo.

- **N** is the store owner. Every step that touches the real store, its customers or real money is N's, or needs N's say at that moment.
- **Operator** is whoever runs the repo, Cloudflare and the Shopify CLI (a build thread or a developer). The operator never prints, logs or commits a token or secret.
- **Deadline:** all of Stage E is done before the next issue's pre-order is announced. N says there's time (2026-11-05), so there's no near date. The first app charge can't come sooner than 21 days after the real run (see "Timeline"), so the real run should be at least 4 weeks before the pre-order.

Facts this runbook relies on are in `docs/DECISIONS.md`, under "Migration import", "Hardening" and "Cutover and install". Anything marked **unproved** has only been reasoned about or read in Shopify's docs. The step that proves it says so.

## Stage A: decisions

Nothing here touches the store. N answered the first round on 2026-11-05.

| # | Decision | State |
| --- | --- | --- |
| A1 | **Sending domain for the app's emails.** `cakezine.com` looks like the store's domain (it points at Shopify). Its DNS is at GoDaddy, not Cloudflare, and Cloudflare Email Service can only onboard a domain on Cloudflare DNS | **Owed by N ("later").** Recommendation: move `cakezine.com`'s DNS to Cloudflare (registrar stays GoDaddy, free plan) and send from `no-reply@mail.cakezine.com`. Copy every record (Shopify's A and CNAME, Google mail's MX, Shopify's email-authentication CNAMEs) as DNS-only, at least a week before cutover. If N doesn't want to move DNS, buy a dedicated domain into Cloudflare. Not `mail.chill.cool`, a domain customers have never seen. Until then `wrangler.jsonc`'s production sending address is a placeholder that can't send |
| A2 | **One Worker or two, and which app holds the contracts** | **Decided: two apps and two Workers.** A new production app, created for Cake Zine's store, holds Cake Zine's contracts on its own Worker and D1. Today's app stays the dev app on `ne-dev`, with `newstand-dev` (see "Why two apps") |
| A3 | **What switching Conjured off means.** Does pausing renewals email customers, can it be turned back on, and do the cards it vaulted stay on the customers when its contracts end? | **Owed by N** (from Conjured's support). Recommendation: pause renewals inside Conjured. Don't cancel its contracts or uninstall it until F5 |
| A4 | **Who the card proof is charged to** (D5) | **Owed by N.** Recommendation: N's own customer record, if Conjured holds a card for it. Better still, one whose Conjured subscription is already cancelled but whose card is still listed |
| A5 | **Lapsed subscribers on a date-only list** (D3) | **Owed by N** after the first dry run, from the count. See D3 |
| A6 | **Gifts while the cart rule can't run** | **Decided: gifting stays on.** The plan picker's gift-email check is built (B1) |
| A7 | **The pre-order date** for the next issue | **No near deadline** ("we have time"). N gives the date when it's set |

## Stage B: production setup, without the real store

The operator does this. It costs nothing beyond the Workers Paid plan the account already has.

### B1. Code changes (built)

N asked for these on 2026-11-05. They're in the repo and checked on `newstand-dev` (see "Built after N's answers" in `DECISIONS.md`).

1. **Production config.** `wrangler.jsonc` has an `env.production` block for Cake Zine: Worker `release-subscriptions-cake-zine`, its own D1 and queues, the Cron trigger, the required `SHOPIFY_API_SECRET`, and no `EMAIL_RECIPIENT_DOMAINS`. Its `PLACEHOLDER` values (client ID, D1 ID, sending address) are filled in at B2 to B4. `shopify.app.cake-zine.toml` is the new app's config, with a placeholder client ID. Its `extension_directories` list only the plan picker and the portal, because on Basic a custom app can't run the cart rule Function or Flow triggers. Leaving them out also removes any chance that Shopify refuses the install over them. Once A1 is decided, a custom domain (for example `subs.cakezine.com`) can replace the `workers.dev` URL in both files.
2. **The portal's `API`** is set per deployment: `npm run deploy:cake-zine` runs `scripts/deploy-app.mjs`. It refuses while the config has a placeholder, sets `API` from the config's `application_url` for the deploy, and puts the source back afterwards. The source always holds the dev app's URL, and a test checks that. **Always deploy the production app with this script, never with a bare `shopify app deploy --config cake-zine`.**
3. **Per-issue plans on their own contract:** per-release plans bill `MONTH` x 12, and checkout says "every 12 months". A bundle and a per-issue plan bought together now make two contracts and two subscriptions, on Basic too. Cake Zine's plans get it from creation.
4. **Plan picker, gift email:** while "This is a gift" is ticked, Add to cart and Buy it now refuse without a valid recipient email, even on a theme whose form has `novalidate`.
5. **Plan picker, Buy it now:** checks out the plan chosen.

Not built, and not asked for: a bulk "Release holds" button (ask if D2 shows more than a handful of holds), and a dry-run flag where a customer's default address differs from their last purchase's shipping address (see D2).

### B2. Create the production app

- **Who:** N, with the operator.
- **First:** nothing (A2 is decided).
- **Do:** In the Dev Dashboard (organization "Cake Zine"), open Apps, open Release Subscriptions' ⋯ menu and choose **Install app**. That opens Shopify's store picker for the organization. **Don't pick a store.** Just look at whether Cake Zine's real store is listed, then close the tab. If it is listed, create the new app in this Dev Dashboard (Create app). If it isn't, create the app from Cake Zine's own admin (Settings, Apps, Develop apps, then build in the Dev Dashboard), so it lands in the store's own organization. Name it so it can't be confused with the dev app, for example rename the dev app "Release Subscriptions (dev)".
- **Check:** the operator links the new config (`shopify app config link --config cake-zine`, with flags) and deploys a version with the full scope list. The version must be created without an `app_access` error on `scopes`. Shopify refuses a version that declares a protected scope the organization isn't approved for, and the dev app's versions with the same scopes were accepted.
- **Back out:** delete the app. Nothing is installed yet.

### B3. Production Worker, D1 and queues

- **Who:** operator.
- **First:** B2 (the app's client ID and secret). Fill in the `PLACEHOLDER` values in `wrangler.jsonc`'s `env.production` and in `shopify.app.cake-zine.toml`.
- **Do:** create the D1 database and apply every migration. Create the queue `release-subscriptions-cake-zine-jobs` and its dead-letter queue `release-subscriptions-cake-zine-jobs-dlq`, setting the main queue's retention to 14 days (`wrangler queues update ... --message-retention-period-secs 1209600`), so a pause (see "Fast stop") keeps messages as long as possible. Set the secret with `wrangler secret put SHOPIFY_API_SECRET --env production`, from the new app. **Don't set `EMAIL_RECIPIENT_DOMAINS`** on this Worker. It stays on the dev Worker only. Deploy the Worker with `npm run deploy:worker:cake-zine`, then the app version with `npm run deploy:cake-zine -- --allow-updates`.
- **Check:** `wrangler secret list --env production` shows only `SHOPIFY_API_SECRET`. The Worker's URL answers. The Cron trigger is listed. The deployed extension's `API` points at production.
- **Back out:** delete the Worker, D1 and queues. Nothing depends on them yet.

### B4. Sending domain

- **Who:** operator, with N for DNS.
- **First:** A1 decided, and the domain on Cloudflare.
- **Do:** onboard the sending subdomain in Cloudflare Email Service. Cloudflare adds the `cf-bounce` MX, SPF and DKIM records. Add a DMARC record starting at `p=none`. Fill in Cloudflare's limit increase form for a daily quota of at least **1,000**, saying it's transactional mail for about 1,000 subscribers. The form is linked from Email Service's limits page. Cloudflare publishes no starting figure.
- **Check:** send one of each email (welcome, pre-order announced, upcoming charge, failed payment, last release, gift received, price change) from the production Worker to N's own Gmail, Outlook and iCloud inboxes. B5's dev store gives subscriptions to send them for. Note for each inbox whether it landed in the inbox, promotions or spam, and whether links point at the production domain.
- **Back out:** remove the sending domain in Cloudflare. Shopify's own emails are untouched.

### B5. Smoke test the production app on a throwaway dev store

This takes the guesswork out of cutover day.

- **Who:** operator.
- **First:** B3.
- **Do:** create a new dev store in the organization (not `newstand-dev`, `cz-dev` or `BTMM`) and install the production app on it. Create plans, run a test checkout, announce and ship a release, try the portal, and send the B4 emails. Then uninstall the app.
- **Check:** everything above works through the production Worker, with no errors in its logs. 48 hours after the uninstall, Shopify sends `shop/redact`, which deletes the store's rows. Check they're gone before Stage C.
- **Back out:** not needed. It's a dev store.

## Stage C: install on Cake Zine and set up, before anyone can sign up

### C1. Install

- **Who:** N installs. The operator watches the logs.
- **First:** Stage B done.
- **Do:** Dev Dashboard, the production app's ⋯ menu, **Install app**, choose Cake Zine, read the grant screen, and approve.
- **Check:** the operator runs a read-only query (`shopify app execute --config cake-zine --store <cake-zine>.myshopify.com -q '{ currentAppInstallation { accessScopes { handle } } }'`). The CLI only allows queries, not mutations, on a store that isn't a dev store. The list must include `write_own_subscription_contracts`, `read_own_subscription_contracts`, `read_customer_payment_methods` and `read_all_orders`. If any is missing, stop: that's a request to Shopify (see "Protected scopes" in "Cutover and install", `DECISIONS.md`).
- **Back out:** uninstall. Before uninstalling, turn every plan off in the app and wait for the sync, or the product is left requiring a selling plan it no longer has. 48 hours after an uninstall, Shopify cancels every contract the app still owns, and `shop/redact` deletes the app's data.

### C2. Prove `read_all_orders` and customer data

- **Who:** operator.
- **First:** C1.
- **Do:** run a read-only query for the oldest order (`orders(first: 1, sortKey: CREATED_AT) { nodes { name createdAt } }`) and for one customer's name and default address. Open the app's Import page.
- **Check:** an order created more than 60 days ago comes back, and the Import page shows no "Can't read old orders yet" banner. The customer's name and address come back unredacted. Shopify's docs say custom apps always have protected customer data at level 1 and 2.
- **Back out:** nothing to undo. It's a read.

### C3. Settings, shipping and the product

- **Who:** N, in the Shopify admin and the app.
- **First:** C1.
- **Do:**
  1. In the app's Settings: release word "issue"/"issues", countries US, order timing ready to ship, and which emails are on.
  2. **Free shipping rate:** put the subscription product in its own shipping profile with one free rate for the US. It must be in place before the first sign-up, because a contract keeps the shipping price it started with.
  3. The subscription product is physical (requires shipping), is stocked at a location N fulfills (not a fulfillment service), and its inventory policy is what N wants. The stock warning reads `inventoryQuantity`.
  4. Use a **new** subscription product for the app's plans, not the one Conjured sells today. Publish it to the online store but don't link it from navigation, collections or the home page until D6 step 3, so nobody can sign up before the import. Create the plans in the app (Yearly bundle, Pay per issue), with renewal rule, start rule and giftable as decided (A6), and check each says "In sync". The imported contracts use this product too.
- **Check:** a plan's selling plan shows on the product in Shopify, and the plans screen says In sync.
- **Back out:** turn the plans off. The sync removes them from the product and resets "requires a selling plan".

### C4. Theme

- **Who:** N.
- **First:** C3.
- **Do:** on a **duplicate** of the live theme (unpublished), add the Plan picker block to the subscription product's template, and set "Product form ID" if the theme's form isn't `product-form-<section id>`.
- **Check, in the theme preview:** each plan can be chosen, and both Add to cart and Buy it now take the plan chosen, with checkout saying "every year" for the bundle and "every 12 months" for pay per issue. Adding a second plan isn't refused on Basic, but makes a second contract. With a giftable plan, "This is a gift" shows its fields, and both buttons refuse without a recipient email. With a recipient filled in, **Buy it now's checkout lists the gift recipient email, name and message under the item** (on `newstand-dev` that carried through to the contract and a gift subscription for the recipient, #1282). If they're missing on Cake Zine's theme, the gift would become the buyer's own subscription: turn the dynamic checkout buttons off and report it. If the theme shows branded buttons (Shop Pay and the like), try them with a blank gift too: only the unbranded Buy it now was checked. The picker doesn't clash with the theme's own variant or quantity controls.
- **Back out:** delete the duplicate theme.

### C5. One real sign-up, by N

- **Who:** N, with N's own card. **N authorizes the money at the time.**
- **First:** C3, C4.
- **Do:** from the theme preview, buy the cheapest plan with N's own email.
- **Check:** within a minute the app has a subscriber for N. The payment order is marked fulfilled by itself with no shipping email, and shipping on the order and on the contract is $0. In the Shopify admin's fulfill panel for a release order later, **"Notify customer" is on** (Shopify remembers the last choice per staff member).
- **Back out:** N cancels the subscription in the portal (C6) or Shopify, then refunds the order without notifying.

### C6. Customer portal

- **Who:** N.
- **First:** C5.
- **Do:**
  1. Settings, Customer accounts: Cake Zine must use the new customer accounts. The extension doesn't run on legacy ones, and Shopify says legacy accounts are deprecated.
  2. Settings, Customer accounts, Customize: switch the page to Profile, open Apps, add "Subscription" to Profile, and Save.
  3. Sign in to the store's account as N (C5's customer) and open Profile.
  4. From the portal, use "update card". Shopify emails a secure link: open it, save a card, and watch the operator's logs.
- **Check:** the subscription shows after Addresses, with its upcoming issue. The card email arrives in N's real inbox. A `customer_payment_methods/update` or `/create` webhook arrives and its job finds N's customer. The operator reads the job row, not the payload. Retrying a failed charge after a card is saved was proved on the dev store with a signed webhook and with Step 15's `create`, not with a real declining card. Watch the first real subscriber who saves a card while in Payment problems (F3).
- **Back out:** remove the block in the editor.

## Stage D: the import

### D1. The Conjured export and the shipped list

- **Who:** N gathers. The operator checks.
- **First:** nothing. Do this as early as possible, because the export hasn't arrived yet.
- **Do:**
  1. **Columns:** open the export and note the email column and any status column, with the exact values that mean cancelled. There's still no real sample, so nothing is assumed.
  2. **No status column?** The import then marks everyone `STATUS_UNKNOWN`. Someone who cancelled with a term running would come in active, protected only by the 21-day upcoming-charge email. So get a real list of who cancelled from Conjured's own admin, and add a `Status` column to the file before the dry run. Shopify's customer segments have a `product_subscription_status` filter (values include `CANCELED` and `EXPIRED`). It's **unproved** whether it covers Conjured's contracts, so check it on two customers N knows before relying on it.
  3. **Past issues, as far back as purchases go:** one line per issue, `number | title | date | what its order lines match`. If issues ever went out on Shopify orders (for example through the store's draft-order apps), put the line item name in the last column: that counts who really got each issue and avoids the date rule below. Any purchase from before the first listed issue is flagged `HISTORY_BEFORE_LIST` and its balance isn't counted.
  4. **Plan mapping:** which order line names mean Yearly and which mean Pay per issue.
- **Check:** the operator confirms the file parses on the Import page, the list reaches back past the earliest purchase N expects, and every plan has lines mapped.
- **Back out:** nothing to undo.

### D2. First dry run, and reading it

- **Who:** N starts it. The operator helps read it.
- **First:** C2, D1.
- **Do:** Import page, fill in the columns, choose the file, **Start dry run**. Then download the report CSV.
- **Check, in this order:**
  1. **Cards are visible.** Count `NO_CARD`. If nearly everyone has it, the app can't see Conjured's cards: **stop**, because the cards can't be charged. A handful is normal.
  2. **Counts by category.** Write them down: READY, each HOLD_, CANCELLED_OWED, LAPSED and every left-out category.
  3. **Lapsed subscribers (date-only list):** in the CSV, count rows with `SHIPPED_AFTER_TERM` in Flags, and rows in category `HOLD_TERM_PAST`, with their "Term ends". These people come in on hold however long ago they lapsed, get the pre-order email, and are shipped at the next run. Take this to N for D3.
  4. `STATUS_UNKNOWN`, `TWO_SUBSCRIPTIONS`, `HISTORY_BEFORE_LIST`, `CARRIED_OVER`, `GIFT`, `HOLD_ZERO_PRICE` and `PAID_SHIPPING`: note each count.
  5. **Spot-check 20 by hand** against what N knows and what Conjured shows: plan, term end, issues left, price, card and address. Shopify makes a release order's shipping address the customer's default address, and the import reads that default. A checkout or a billing order doesn't (proved on the dev store). So for each of the 20, also compare the default address with the shipping address of their last subscription order. If several differ, ask for the address-differs flag in the dry run (not built).
- **Back out:** nothing. A dry run only writes its report.

### D3. N's choice on lapsed subscribers

- **Who:** N.
- **First:** D2 item 3.
- **Choose one:**
  - **List order lines** (D1 item 3), if any order shows who got each issue. Most accurate. Then run D2 again.
  - **Count everyone owed:** accept what the report says. Each such person gets an extra copy at the next issue. Cheap if the count is small.
  - **Cut-off date:** anyone whose last term ended before a date N picks is treated as lapsed. **No code is needed:** delete those contacts' lines from the contacts file (using the CSV's "Contact line" and "Term ends") and run D2 again. Delete a line only if every row for that contact is past the cut-off, because the line covers all of a customer's plans. Code would only be worth it if this has to be repeated: a setting in the import form making such rows `LAPSED` (about 15 lines and a test).
- **Recommendation:** count first. If it's under about 20, go through them by hand and use the cut-off file edit for the clearly old ones. If it's larger and issues were ever on orders, list order lines.

### D4. Final dry run

- **Who:** N.
- **First:** D3, and the bulk hold button asked for if holds are many.
- **Do:** start a new dry run on the final file the day of the real run, while Conjured is still on.
- **Check:** the counts match what N expects after D3.

### D5. Prove one real Conjured card, with $1

- **Who:** the operator runs it. **N authorizes the $1 at that moment.**
- **First:** C1, A4, and the customer told about it beforehand, because Shopify emails an order confirmation for it.
- **Do:** with a short script that reads the production offline token from D1 into a variable and never prints it (the CLI can't run mutations here):
  1. `subscriptionContractAtomicCreate` for the A4 customer: one line on the Yearly selling plan at **$1.00**, `deliveryPrice` 0, their address, their Conjured-vaulted `paymentMethodId` from the dry run, and the contract attribute `_release_subscriptions_import` with the value `card-proof`. The app ignores a contract carrying that attribute, so no subscription is made.
  2. `subscriptionBillingAttemptCreate` with idempotency key `card-proof:<contract id>:1`.
  3. Read the attempt. Success means Shopify Payments accepts a charge on a card Conjured vaulted, through this app's contract.
  4. Cancel the contract, refund the $1 order without notifying, and mark that order fulfilled (or cancel it).
- **Rehearsed on `newstand-dev`:** the same calls on the test gateway charged $1 (#1278). The app recorded nothing (no subscription, no billing row, and the settle job did nothing). Creating and cancelling the contract sent the customer no email. The charge sent Shopify's order confirmation.
- **If the charge is refused:** stop. Every imported card would fail the same way, so the import waits for an answer from Shopify Support about using cards from another app's contracts.
- **Back out:** steps 4 above. Nothing else was created.

### D6. Real run, storefront switch, Conjured off

Do all of this on one day, in this order.

| Step | Who | Do | Check | Back out |
| --- | --- | --- | --- | --- |
| 1 | N | Import page, the D4 report, **Start real run**. Tick the status box only if D1's cancelled list is in the file | The report shows every READY, HOLD_ and CANCELLED_OWED row going to DONE. FAILED rows show a code. `CONTRACT_EXISTS` means an earlier try made the contract and it was reused | See "Rollback", stage 2 |
| 2 | N | Releases screen: choose a product on the **latest** back-filled issue (the run writes them as shipped) | The latest issue has a product. New sign-ups get it first and ship at once, so without a product their order waits | Choose another product |
| 3 | N | Stop Conjured's sign-ups: unpublish or unlink Conjured's product (or remove its plans in Conjured). Publish the C4 theme and link the C3 product where Conjured's was | A real visitor can only reach this app's plans | Republish the old theme and relink Conjured's product. Any sign-ups made here are real and stay |
| 4 | N | **Pause Conjured's renewals** (A3) | Conjured shows renewals paused, and no customer was emailed | Turn them back on, before any app charge |
| 5 | N | **Dry run again**, on a fresh Conjured export (it catches anyone who signed up in Conjured between D4 and step 3) | Read `RENEWED_SINCE_IMPORT`: it should be 0. Any new READY rows are late Conjured sign-ups | n/a |
| 6 | N | If step 5 has new rows, **Start real run** on it. Rows already DONE are skipped | Those rows reach DONE | As step 1 |
| 7 | Operator | Check sign-ups made during the import got subscriptions (below) | Every new contract has a subscription | n/a |

**Why this order:** Conjured stays on until the import has worked, so nobody goes unbilled if the run has to stop. It goes off the same day, long before the app's first possible charge (see "Timeline"). Anyone Conjured charges between D4 and step 1 is read afresh by the real run (`CHANGED_SINCE_DRY_RUN`). Anyone it charges between step 1 and step 4 shows as `RENEWED_SINCE_IMPORT` in step 5.

**If `RENEWED_SINCE_IMPORT` isn't 0:** that subscriber paid Conjured after their contract here was made, and their term date here is the old one. If they're on hold, keep the hold. If they're active, the operator puts them on hold now with N's say (`status` `PAUSED`, `pausedReason` `IMPORT_HOLD`). Then set the new term end and add the renewed issues to `releasesRemaining`, by hand in D1, with N checking each, and only then release the hold. There's no screen for this. If there are more than a couple, ask for one.

**Sign-ups during the import (step 7):** the hourly missed-webhook check stops at the first page holding a known contract, so a lost sign-up could hide under the imported contracts. The operator runs a read-only query for contracts created on or after the day of step 1 (`subscriptionContracts(query: "created_at:>=<date of step 1>")`, paging to the end), then keeps those whose `createdAt` is after step 1. Shopify's filter only works to the day: on `newstand-dev` a time of day in it also returned contracts from hours earlier. Every contract kept without the `_release_subscriptions_import` attribute must have a Subscription in D1 with that `contractGid`. Enqueue `contract.sync` for any that don't.

### D7. After the import

| Item | Who | Do | Check |
| --- | --- | --- | --- |
| Holds | N | Subscribers, filter "On hold from import". Release each with **Release hold** on the subscriber page, **only after D6 step 4**. A term date under 22 days away moves to 22 days out, so the notice always goes first | The count goes down. If there are more than a few, ask for a bulk button (not built) |
| `HOLD_ZERO_PRICE` | N | Decide each one. Releasing keeps the contract at $0, because the app can't change a contract's price. Leave them held, or cancel them in Shopify and ask the customer to sign up again | Each has a decision written down |
| Gifts from Conjured | N | The `GIFT` rows aren't imported. For each recipient still owed issues, keep a list and send their issues by hand at each release (a manual order to them) until they're used up | The list exists, with the issues owed |
| Contracts look right | Operator and N | Open 10 imported contracts in Shopify: customer, address, price, card, $0 shipping, next billing date (a label only) | All right |
| No welcome emails | Operator | Email rows: imported subscribers get no welcome or tag jobs at import. The hourly member-tag job tags them within the hour | No `welcome` rows for `IMPORTED` subscribers. The tag appears on a sample customer |
| Member discount | N | The automatic discount for the segment `customer_tags CONTAINS 'active-subscriber'` | A tagged customer sees the discount |

## Stage E: open the doors

| # | Who | Do | Check |
| --- | --- | --- | --- |
| E1 | Operator | Confirm `email.waiting` hasn't appeared in the logs since the import, and that the daily quota increase (B4) was granted | Upcoming-charge emails are going out as terms come within 21 days |
| E2 | N | Watch the first new sign-ups | Each has a subscriber, its first issue order (the latest issue, shipped at once) and a welcome email |
| E3 | N | Before the pre-order: check the releases screen has no red banners left (sign-ups needing you, gifts, charged twice, data requests) | None |
| E4 | N | Announce the next issue's pre-order | `email.waiting` doesn't appear. If it does, the daily quota is too low: the rest go out after the wait, and the operator chases the increase |

## Stage F: the first real charges

Nothing here is new behavior. It's watching what the dev store could only fake.

| # | Watch for | Where | What it means and what to do |
| --- | --- | --- | --- |
| F1 | `billing.double_charge` | Red "charged twice" banner on the releases screen, and logs | A bank's challenge was completed after another try had paid. Refund the order named in the banner, then mark it handled |
| F2 | `billing.price_held` | Logs only | A price rise was held for someone whose notice didn't go. Expected for imported subscribers after a rise saved before the import. Nothing to do |
| F3 | The first `ACTION_REQUIRED` | Payment problems ("Their bank asked them to confirm") | The operator reads that attempt from Shopify and records `state` and `action.status` (`OFF_SESSION_REJECTED` or `ON_SESSION_CHALLENGED`), and then once a day how long until it becomes `EXPIRED_BUYER_ACTION` or succeeds. Write both into `DECISIONS.md`, because only Shopify's schema says what these mean today |
| F4 | A challenge that never closes | Weekly, the operator runs the query below | That subscriber stays paused until the challenge ends, they save a new card, or the merchant presses Retry after it ends. Ask the customer to update their card |
| F5 | Conjured uninstall | N, only after the first 10 imported renewals have succeeded | Read the card-proof customer's `paymentMethods` before and after. Shopify cancels Conjured's contracts 48 hours after it's uninstalled. That the cards survive is **unproved** until then, unless A4's customer already showed it |

Open challenges older than a week (D1, read-only):

```sql
SELECT b."subscriptionId", b."shopifyAttemptGid", b."createdAt"
FROM "BillingAttempt" b JOIN "Subscription" s ON s."id" = b."subscriptionId"
WHERE b."errorCode" = 'ACTION_REQUIRED' AND s."paymentProblemSince" IS NOT NULL
  AND julianday(b."createdAt") < julianday('now', '-7 days')
  AND NOT EXISTS (SELECT 1 FROM "BillingAttempt" n WHERE n."subscriptionId" = b."subscriptionId"
                  AND n."chargeFor" = b."chargeFor" AND n."attempt" > b."attempt");
```

## Timeline

Day 0 is the real run (D6 step 1).

| When | What happens |
| --- | --- |
| Before day 0 | Dry runs read Shopify only. Conjured keeps charging. A Conjured renewal before the real run is picked up by its fresh read |
| Day 0 | Contracts are created with no email from Shopify or the app. Conjured goes off the same day (D6 step 4) |
| Day 0 to day 1 | A dry run reads `RENEWED_SINCE_IMPORT`. Holds can be released from here on |
| Day 0 onward | The upcoming-charge email goes 21 days before each active bundle's term end. The earliest is a few hours after the import, for terms just past 21 days |
| Day 21 at the earliest | **First possible app charge.** Anyone due sooner came in on hold, and a released hold moves out to 22 days after its release. A pay-per-issue subscriber at 0 is charged only when the next issue ships, with its notice at the pre-order |
| Pre-order date | The pre-order email goes to everyone a run would give the issue to, including held subscribers with a paid issue left |

**The window that matters:** Conjured must be off before day 21, and before N releases any hold or presses Ready to ship. This runbook turns it off on day 0.

## What Basic means on the real install

On Basic, a custom app gets no Functions and no Flow triggers in the editor (N accepted this, 2026-11-05).

- **Before payment, the plan picker still:** shows only this app's plans, one at a time. It never offers a one-time purchase, because the product requires a plan. It offers gift fields only on a giftable plan. It doesn't stop a second plan in the cart, but a bundle and a pay-per-issue plan now make separate contracts. While a gift is ticked it refuses Add to cart and Buy it now without a valid recipient email, even where the product form has `novalidate`.
- **After payment, the app flags:**
  - **Two plans on one contract** (`contract.mixed_plans`, seen again on the dev store with the rule off, #1277). There's no subscription, the order stays unfulfilled, and a red banner shows on the releases screen. **What N does:** refund the order and cancel the contract in Shopify, ask the customer to buy each plan on its own, then press Mark as handled. Since B1 item 3, Cake Zine's bundle and pay-per-issue plan can't merge. Two bundles with the same term, or two pay-per-issue plans, still would.
  - **A gift that can't be delivered** (`contract.gift_invalid`): no recipient email, a bad one, or one beside another subscription. **What N does:** contact the buyer, fix the cause if possible (create the customer, make the plan giftable) and press Try again, or else refund and cancel the contract, then press Mark as handled. The buyer hears nothing from the app.
  - **A ticked gift with every field blank** would become the buyer's own auto-renewing subscription with no flag, but the picker now stops it before payment (B1 item 4). A cart built around the picker (a crafted `/cart/add` link) still could.
- **Flow:** Cake Zine can't use the app's triggers. The app's Flow job will log refusals. That's harmless. B1 item 1 leaves the triggers out of the production app, so those refusals are expected.

## Fast stop

If anything looks wrong, stop all background work (charges, orders, emails, imports) within seconds:

```
npx wrangler queues pause-delivery <production jobs queue>
```

**Proved on the dev queue:** while paused, a contract webhook was accepted and its job didn't run. 30 seconds after `resume-delivery`, it had run. Webhooks keep arriving and wait, up to the queue's retention (14 days, from B3). Merchant buttons still queue work, which waits too. Everything is state-driven, so the hourly tick finds it all again after resume. A billing attempt Shopify already accepted still completes, and is recorded after resume. Resume with `npx wrangler queues resume-delivery <queue>`.

## Rollback

| Stage | What can be undone | How | What can't |
| --- | --- | --- | --- |
| B (setup) | Everything | Delete the app, Worker, D1 and queues | Nothing |
| C (installed, no import) | The install and plans | Turn plans off, wait for the sync, uninstall | N's own test sign-up: cancel and refund it. Shopify cancels any contract left 48 hours after uninstall, and `shop/redact` deletes the app's data |
| D5 (card proof) | All of it | Cancel the contract, refund $1 | Shopify's order confirmation was sent to the customer |
| D6 (after the real run, before any email or charge) | The import | Fast stop. Cancel every imported contract (`subscriptionContractCancel`, which emailed nobody when tried on the dev store). Then, with the operator, set those subscriptions to `ENDED` in D1, so the next run doesn't ship their paid issues. Turn Conjured back on | The member tag may already be on them. Ending the subscriptions removes it within the hour |
| After upcoming-charge emails went | The same, but customers were told a date | As above, then N emails those customers | Their notice can't be recalled |
| After the first app charges | Future charges | Fast stop, then cancel contracts or turn auto-renew off as needed | A charge that succeeded must be refunded in Shopify. The app refunds nothing |

## Why two apps

- An app has one `application_url` and one set of webhook URLs per active version. So one app can't send the dev store to the dev Worker and Cake Zine to production.
- **Same app, dev store uninstalled:** every later change would be tested on the real store. The dev store's contracts would be cancelled 48 hours after uninstall, and its data deleted. Rejected.
- **Same app, one Worker for both stores:** the dev store's made-up customers and hourly jobs would share Cake Zine's D1. `EMAIL_RECIPIENT_DOMAINS` would have to go for both, so dev emails would reach whatever addresses test customers have. Rejected.
- **Two apps** cost about an hour to set up and nothing extra per month on Workers Paid. Every change is deployed twice (dev first, then production). Testing carries on exactly as now. A contract belongs to the app that made it, so the production app is the one that must run the import, and Cake Zine stays on it for good. Step 17's public app is a third app, in a Partner organization, and can't take over these contracts without Shopify's help.

## Row 16 checklist

| Row 16 item | Where |
| --- | --- |
| Which app holds the contracts, and the install type | A2; `DECISIONS.md`, "Cutover and install" |
| Cart rule and mixed-plan fallback on Basic | "What Basic means"; B1 items 3 to 5 |
| Free shipping rate | C3 |
| "Notify customer" | C5 |
| Sending domain, onboarding, `EMAIL_RECIPIENT_DOMAINS`, spam placement, quota | A1, B3, B4, E1, E4 |
| Flow on a custom install | "What Basic means"; B1 item 1 |
| Plan picker on the real theme | C4 |
| Switch off Conjured, run the import, verify, monitor | D6, D7, F |
| Portal: new accounts, activation, `API` constant, real card update | C6, B1 item 2 |
| Stock check and inventory policy | C3 |
| Challenge states and how long they last | F3, F4 |
| `billing.double_charge` and `billing.price_held` | F1, F2 |
| Conjured export columns and who cancelled | D1 |
| Past issues as far back as purchases go | D1 |
| One real saved card with a small charge | D5 |
| Conjured off before the first app charge, and the dry run after it | D6; "Timeline" |
| Product on the latest back-filled release | D6 step 2 |
| Releasing holds, and a bulk button | D7; D4 (bulk button not built) |
| `HOLD_ZERO_PRICE` | D7 |
| Sign-ups during the import | D6 step 7 |
| Gifts from the old app | D7 |
| The app that holds the contracts runs the import | "Why two apps" |
| `read_all_orders` on the real install, with an order over 60 days old | C1, C2 |

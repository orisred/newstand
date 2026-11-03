# Decisions

All decided by N on 2026-11-01. "Cake Zine" is the first merchant's behavior; "Public app setting" is how other merchants will vary it.

| Topic | Cake Zine | Public app setting |
| --- | --- | --- |
| What a subscription buys | Pay per issue, or a prepaid bundle (e.g. 2 issues) | Billing mode per plan; a bundle has its own display name, such as "Yearly subscription" or "2 issues paid upfront" |
| First release | Switches when the next issue's pre-order is announced: before, the latest released issue (ships now); after, the pre-order issue | Start rule per plan: pre-order switchover (default), current release if before its cutoff, or always next |
| Renewal timing (bundles) | Term date (1 year after sign-up), held until the last paid issue's order is created if that issue is late | Renewal rule per plan: term date with late hold (default), term date only, or when paid releases run out |
| Extra issue before renewal | Not included; wait for normal renewal (bundle = N issues, not all issues in 12 months) | Same |
| Renewal timing (per issue) | Charge before each issue's cutoff | Same |
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
| Database | D1 (SQLite) via Prisma D1 adapter; sessions in KV |
| Jobs | Hourly Cron Trigger + Cloudflare Queues |
| Coding tool | T3 Code |

## Cake Zine facts

- 1 to 2 issues a year; 250 to 1,000 active subscribers.
- Next issue cutoff more than 3 months away (as of 2026-11-01).
- Conjured is used only for annual billing; it exports contacts only.


Cake Zine's choices are defaults, not the only mode: every row above with a public app setting must support the other options too.

# Order email import (#25)

The owner's decisions are on #25 (2026-09-28): a dedicated Fastmail account the owner forwards order emails to, polled through JMAP with a read-only API token; a processed-ids table; a sender trust check; product links through the existing link import; a "From your orders" review list; opt-in config. This is how it is built.

## Config and whose items they are

- `ORDER_MAIL_JMAP_TOKEN`: the Fastmail API token, made under Settings › Privacy & Security › Manage API tokens with **Email** and **Read-only access** ticked ([Fastmail's help](https://www.fastmail.help/hc/en-us/articles/5254602856719-API-tokens)). A read-only token offers only `urn:ietf:params:jmap:core` and `urn:ietf:params:jmap:mail`, which is all the poll uses. Empty or unset: the feature is off. No JMAP client, no timer, no menu entry, and the review list is a 404.
- `ORDER_MAIL_SENDERS`: the owner's own addresses, comma-separated. Required with the token.
- `ORDER_MAIL_OWNER`: the sign-in email of the closet account the items belong to. Required with the token. Closet is single-owner here, so the account is named by the one identifier the owner types anyway. The poll looks the account up each run. If no account has that email, the run fails, which reaches metrics and Bugsink, rather than guessing.
- `ORDER_MAIL_POLL_MINUTES`: 1 to 60, default 5.

The JMAP session URL is fixed (`https://api.fastmail.com/jmap/session`). Only the specs swap it, through `AppOptions.orderMail` as the weather's stand-in does. It is never an env var.

## JMAP calls

All JMAP traffic goes through its own `createOutboundFetcher` instance with `hosts: ['api.fastmail.com']`: every hop is pinned to a public address, bounded by a timeout, capped at 512 KB of JSON, and logged by host only. The fetcher gains an `authorization` header and a JSON `body` (POST), but only for requests that name `hosts`, and such requests never follow a redirect. So the token can reach only the named host.

1. **Session**: `GET` the session URL with `Authorization: Bearer <token>`. Read `apiUrl` and `primaryAccounts["urn:ietf:params:jmap:mail"]`. An `apiUrl` on another host is refused by the host list.
2. **Query**: one `POST apiUrl` with `using: [core, mail]` and two calls:
   - `Mailbox/query {filter: {role: "inbox"}}`
   - `Email/query {filter: {inMailbox: #ref, after: <watermark>}, sort: receivedAt ascending, limit: 50}`
     The watermark is the newest `received_at` in the processed table (none on the first poll). JMAP's `after` is inclusive, and the processed ids drop what was already done.
3. **Get**: for each id not yet processed, at most 5 per poll (the rest wait for the next poll), one `Email/get` of that id:
   - `properties: id, receivedAt, from, header:Authentication-Results:asText:all, htmlBody`
   - `bodyProperties: partId, type`
   - `fetchHTMLBodyValues: true`, `maxBodyValueBytes: 200000`
     `htmlBody` falls back to the text part when a message has no HTML, so one list covers both. JMAP truncates each body value at the cap, which is the per-email size bound. A response over the fetcher's 512 KB is recorded as `too-large` and never retried.

The answers are schema-checked with TypeBox, as Open-Meteo's are. A method-level `error` response is a failure.

## Trust check

An email is processed only when both of these hold:

- Its `From` is exactly one address, and that address is in `ORDER_MAIL_SENDERS` (compared case-insensitively).
- The topmost `Authentication-Results` passes. That header is the one Fastmail's own MX added, and its authserv-id must end in `messagingengine.com`, so a header the sender forged lower down counts for nothing. It passes when either:
  - `dkim=pass` with `header.d` equal to the From domain or a parent of it, or
  - `spf=pass` with the `smtp.mailfrom` domain aligned the same way.

Anything else is recorded as `untrusted` and logged at warn with the From domain and the reason, never the body.

Manual forwarding keeps the owner as `From`. A mailbox auto-forward rule keeps the retailer as `From` and is ignored by design.

## Links

The body is never rendered. It is only scanned.

- **HTML parts**: `<a href>` values, read by the link import's linear tag scanner (`html.ts`, which gains `hrefs`, capped at 200).
- **Text parts**: an http(s) URL regex.

Then, per email:

1. **Unwrap.** A link whose query holds an http(s) URL (`?url=`, `?q=`, `?u=`, `?redirect=`...) is replaced by that URL, up to 3 levels deep. An opaque tracker (`click.shop.com/ls/click?upn=...`) is unwrapped by following it: the fetcher follows at most 3 redirects, each checked like the first.
2. **Drop.** Remove mailto, non-http(s), social and app-store hosts, and paths about accounts, help, unsubscribing, privacy, returns and order tracking.
3. **Normalise.** Strip tracking parameters (`utm_*`, `gclid`, `fbclid`, `mc_*`, `_hs*`) and the fragment, then dedupe.
4. **Order and cap.** Product-looking paths go first (`/p/`, `/product`, `/dp/`, a long numeric id). At most 12 links per email are fetched, 3 at a time, through the app's user-URL fetcher with `accept: ['html']`. That is the SSRF-safe path the link import uses.
5. **Keep products.** Each page goes through `extractProduct`. It counts as a product when it has schema.org Product JSON-LD or a stated price. At most 10 items per email are kept.

The product link stored is the fetched page's final URL, normalised the same way.

## Tables (migration 0029)

- **`order_email`**: one row per processed JMAP email.
  - Columns: `account_id`, `email_id` (unique together), `received_at`, `processed_at`, `outcome`, `items`.
  - `outcome` is one of `imported`, `no-products`, `untrusted`, `too-large`.
  - The row is written in one transaction with that email's items, after its links were fetched.
- **`order_item`**: the review list.
  - Columns: `owner_id` (cascade), `order_email_id` (cascade), `product_url`, `name`, `brand`, `price`, `currency`, `ordered_on` (the day received, in `APP_TIMEZONE`), `state`, `garment_id` (set null), `decided_at`.
  - `state` is `pending`, `added` or `dismissed`, and each row moves at most once: `pending` to `added` (with the garment), or `pending` to `dismissed`. Each move has one writer.
  - Unique on `(owner_id, product_url)`. A product's confirmation and shipping emails list it once. A product seen again later is skipped (logged).

**Rollback**: the tables are new and nothing else references them. The previous image ignores them. To remove them: `DROP TABLE order_item; DROP TABLE order_email;`, and delete the 0029 row from `drizzle.__drizzle_migrations`.

## Review list UX

`/wardrobe/orders` is linked from the Wardrobe's ⋯ menu as "From your orders", for the configured owner only. Anyone else gets a 404, and so does everyone when the feature is off.

Each pending item is a card showing the name (else the store's host), brand, price, store, the day ordered and "View product". It has two actions:

- **Add to closet** (a native post) runs the link import on the product link: photo choices, a pending photo, and the extracted details. It opens the ordinary new-garment form for the closet, prefilled with the order's day as the acquired date and its price. The form carries `orderItem`, and `POST /wardrobe` marks the item `added` in the garment's own transaction, as a plan candidate link is written (`WithGarment`). An item no longer pending is refused, so a double save cannot add it twice. If the page cannot be fetched now, the form opens prefilled from what the poll stored, with a notice.
- **Dismiss** (a native post, 303 back to the list).

**Why not wishlist rows.** The owner asked to reuse the wishlist where it fits. It does not fit here, for three reasons:

- The wishlist is shared with VIEW grantees for gifting, so an order (a gift for that grantee, say) would show to them.
- Wishlist items feed "Goes with my closet", the plans' candidates and the MCP tools.
- A garment row would store a photo and queue a cutout for every charger and return in an order.

So the list is its own small table, and confirming reuses the link import and the garment form whole.

## Failure handling and scheduling

The poll is `scheduleMinutely` with `everyMinutes: ORDER_MAIL_POLL_MINUTES`: never overlapping, and stopped with the other timers at `preClose`. Its run is `metrics.timeJob('order_mail', ...)`. A JMAP failure (network, 401, a method error, an unexpected shape) or an unknown `ORDER_MAIL_OWNER` throws, which gives outcome `failure` and a Bugsink event. Nothing is recorded for the email in hand, so the next poll retries it.

- A product link that fails to fetch is skipped and logged with its host.
- A run cut off mid-email re-processes that email next time, and the unique product link keeps its items from doubling.
- The poll logs one line per email (its outcome, links found, items kept) and one per run.

The token appears only in the JMAP fetcher's `Authorization` header. The fetcher logs hosts only. Refusals carry a reason, never a header. `scrubEvent` also filters Fastmail token shapes (`fmu1-...`) and any key named like the token.

## Out of scope

- The LLM fallback for items with no usable link (a paid follow-up).
- Auto-forwarded mail.
- Attachments (PDF invoices).
- Photos on the review list (they are fetched at "Add to closet").
- Undoing a dismissal.
- More than one owner.

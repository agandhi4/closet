# Order email import, "From your orders" (#25)

Part of the Wardrobe (`CLAUDE.md` in this directory). Plan: `docs/plans/2026-09-28-order-email-import.md`. Owner setup: `docs/deployment.md`, Order email import (the token: Settings › Privacy & Security › Manage API tokens, Email and Read-only access ticked; [Fastmail's help](https://www.fastmail.help/hc/en-us/articles/5254602856719-API-tokens)).

The owner forwards order emails to a dedicated Fastmail account. Closet polls it through JMAP with a read-only token and lists the products it finds for review. **Opt-in**: without `ORDER_MAIL_JMAP_TOKEN`, `createApp()` builds nothing, so there is no timer or menu entry and the review list's routes answer 404. With the token, `ORDER_MAIL_SENDERS` and `ORDER_MAIL_OWNER` are required, and `loadConfig` refuses the boot without them.

## Layout

```
  order-mail/          jmap.ts (the JMAP client: session, inbox ids since a watermark, envelopes, bodies),
                       trust.ts (judgeSender, pure), links.ts (productLinkCandidates, normalizedLink, pure),
                       poll.ts (pollOrderMail: server.ts's timed job), queries.ts (order_email, order_item),
                       routes.tsx + review-page.tsx (/wardrobe/orders), urls.ts
  src/wardrobe/order-items.ts   the outcome and state vocabularies, orderItemTransition
```

## The poll

`scheduleMinutely({ everyMinutes: ORDER_MAIL_POLL_MINUTES })`, wrapped in `metrics.timeJob('order_mail')`: a failure is the job's `failure` outcome and a Bugsink event. Each run:

1. Opens the JMAP session.
2. Reads `ORDER_MAIL_OWNER`'s account and the watermark (the newest `order_email.received_at` of the session's account) in one statement (`pollStart`, #173; the watermark needs the session's account id, so the owner is looked up after the session). No account is `OrderMailOwnerError`, before any email is read or recorded.
3. Queries the inbox from the watermark, drops the ids already processed and takes at most `MAX_EMAILS_PER_POLL` (5).
4. Fetches the envelopes (From, `Authentication-Results`) and judges each sender.
5. Fetches the body of a trusted email only.
6. Reads its links, fetches each through the link import's `readProductPage` (the user-URL fetcher), and keeps product pages.
7. Records the email and its items atomically (`recordOrderEmail`): with products, one transaction of four statements (the email and its items in one CTE statement, then its count and outcome); without, one insert.

Statements per run: 2 when nothing is new (the poll every few minutes), plus per new email 1 without products or 4 with them (`order-mail.spec.ts` pins them).

An email a run did not finish has no row and is read again next time. `order_item`'s `(owner_id, product_url)` uniqueness makes a re-read, or a shipping email naming the same product, list nothing twice. Logs use context `OrderMail`.

## The review list

`GET /wardrobe/orders`, and `POST /wardrobe/orders/:id/add` and `/dismiss`, both native `PostForm`s with `needsNetwork`. They answer only the `ORDER_MAIL_OWNER` account; anyone else, and everyone with the order mail off, gets a 404. They are registered even when off: unregistered, `/wardrobe/orders` fell to `/wardrobe/:id`, whose id check answered 400. The Wardrobe's ⋯ menu links the list when `ViewContext.orderReview` is set.

"Add to closet" runs `importLink` on the stored product link and renders the ordinary new-garment form for the closet. The form carries the photo choices, the order's day as `dateAquired`, the stored price when the page has none in dollars, and `orderItem` (hidden, with a notice). `POST /wardrobe` resolves `orderItem` in `postedDestination`: the requester's own pending item in their own wardrobe, else a 404 before anything is stored. It then marks the item `added` in the garment's own transaction (`WithGarment`, as a plan candidate link). A page that cannot be fetched now opens the form with the stored details and a notice. Fetching counts against a `LINK_IMPORT_LIMIT` checker of its own.

Tests: `test/integration/order-mail.spec.ts` (the poll against the JMAP stub and a local shop, the review list, the off state), `test/order-review.spec.ts` (the list at 390 px, seeded rows, dismiss, the fallback form).

## Gotchas

- **The token reaches only the session URL's host.** The JMAP client passes `hosts` and `authorization` to its own outbound fetcher. A request with a credential or a body follows no redirect, and the fetcher throws, as a programming error, when either comes without `hosts` (Request security, Outbound fetches). Every error is a `JmapError` naming the step and the fetcher's reason, never a header. `scrubEvent` also filters `fm?N-…` token shapes and the `ORDER_MAIL_JMAP_TOKEN` key.
- **Only the topmost `Authentication-Results` counts, and it must be Fastmail's** (its inbound MX names itself `*-mx-NN.messagingengine.com`). A sender can add passing headers of their own below it. `judgeSender` also needs the single From address to be in `ORDER_MAIL_SENDERS`, and DKIM, SPF or DMARC to pass for a domain aligned with it. An untrusted email's body is never fetched.
- **An email's HTML is scanned, never rendered.** Its links come from the link import's linear scanner (`hrefs`, at most 200). The review page shows only what the product page said (name, brand, price) and the store's host.
- **A fetched link keeps its query as written, since a tracker's may be signed.** Tracking parameters come off only the product page's final address (`normalizedLink`), which is what is stored and compared.
- **An order item is never a garment or a wishlist row until it is added.** The wishlist is shared with VIEW grantees (a gift would show), and it feeds "Goes with my closet", plan candidates and the MCP tools. A new reader of `order_item` names its owner. A new move of `state` goes through `decideOrderItem` (pending only, once).

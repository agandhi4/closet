# Order mail fixtures

`forwarded-order.json` is a JMAP `Email` (the properties Fastmail's `Email/get` answers, parsed) of an order confirmation the owner forwarded by hand from Gmail: a `multipart/alternative` whose HTML part holds the retailer's email under Gmail's "Forwarded message" block, with Fastmail's `Authentication-Results` on top. Its product links are real-world shapes: a click tracker that carries its product page in its query (`/ls/click?upn=...&url=...`, with `utm_` parameters; an opaque one with no target is never fetched, #946), a link Gmail wrapped in `google.com/url?q=`, and the usual navigation, account, help, social, `mailto:` and unsubscribe links around them.

`{{SHOP}}` and `{{SHOP_ENCODED}}` stand for the spec's local shop (`test/integration/link-sites.ts`) and are replaced when the spec loads the file (`test/integration/order-mail.spec.ts`).

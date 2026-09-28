import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  html,
  jpeg,
  type LinkSites,
  productShot,
} from '../integration/link-sites';
import type { StubEmail } from './jmap-stub';

/**
 * The forwarded order email (test/fixtures/order-mail/forwarded-order.json)
 * and the shop its links lead to (#25): the order mail's integration spec
 * (test/integration/order-mail.spec.ts) and the page audit's poll step
 * (scripts/audit/) read the same email against the same pages.
 */

/** Who forwarded it: the address ORDER_MAIL_SENDERS must trust. */
export const ORDER_SENDER = 'owner.forwarder@gmail.com';

const FIXTURE = join(
  __dirname,
  '..',
  'fixtures',
  'order-mail',
  'forwarded-order.json',
);

const LINEN_PAGE = (image: string) => `<!doctype html>
<html><head><title>Relaxed Linen Shirt | Northfield</title>
<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'Relaxed Linen Shirt',
  brand: { '@type': 'Brand', name: 'Northfield' },
  color: 'Sage green',
  material: '100% linen',
  image: [image],
  offers: { '@type': 'Offer', price: '49.90', priceCurrency: 'USD' },
})}</script></head><body><h1>Relaxed Linen Shirt</h1></body></html>`;

const SOCKS_PAGE = `<!doctype html>
<html><head><title>Merino Crew Socks</title>
<meta property="og:type" content="product">
<meta property="og:title" content="Merino Crew Socks (3-pack)">
<meta property="product:price:amount" content="24.00">
<meta property="product:price:currency" content="USD">
</head><body></body></html>`;

// A category page: a title and no product data, so never listed.
const COLLECTION_PAGE = `<!doctype html><html><head><title>New arrivals</title>
<meta property="og:title" content="New arrivals"></head><body></body></html>`;

export const ORDER_TRACKER =
  '/ls/click?upn=u001.Qp9x7-2FbT0kL3rN8vYh-2BsE4eZ1aJ6cG5mW-3D&utm_campaign=order';

/**
 * Serves the order's pages on `sites` and returns the email, its links
 * pointing there: a tracker that redirects to the linen shirt, Gmail's
 * wrapped link to the socks, and collection pages that list nothing.
 */
export async function serveForwardedOrder(
  sites: LinkSites,
): Promise<StubEmail> {
  const shop = sites.url('');
  const forwarded = JSON.parse(
    (await readFile(FIXTURE, 'utf8'))
      .replaceAll('{{SHOP_ENCODED}}', encodeURIComponent(shop))
      .replaceAll('{{SHOP}}', shop),
  ) as StubEmail;

  // The tracker redirects to the product page with its campaign tags,
  // as a retailer's click tracking does.
  sites.serve(ORDER_TRACKER, {
    status: 302,
    type: 'text/plain',
    body: '',
    headers: {
      location: sites.url(
        '/products/relaxed-linen-shirt?utm_source=email&utm_medium=order&variant=sage#reviews',
      ),
    },
  });
  const image = sites.url('/img/linen-shirt.jpg');
  // Where the tracker lands, and the stored link "Add to closet" reads.
  for (const path of [
    '/products/relaxed-linen-shirt?utm_source=email&utm_medium=order&variant=sage',
    '/products/relaxed-linen-shirt?variant=sage',
  ]) {
    sites.serve(path, html(LINEN_PAGE(image)));
  }
  sites.serve('/img/linen-shirt.jpg', jpeg(await productShot('#8a9a7b')));
  sites.serve(
    '/products/merino-crew-socks?utm_source=order_confirmation',
    html(SOCKS_PAGE),
  );
  for (const path of ['women', 'men', 'new-arrivals']) {
    sites.serve(
      `/collections/${path}?utm_source=order_confirmation`,
      html(COLLECTION_PAGE),
    );
  }
  return forwarded;
}

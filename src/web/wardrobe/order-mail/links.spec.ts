import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  emailLinks,
  isProductLink,
  judgeLink,
  MAX_LINKS_PER_EMAIL,
  MAX_TRACKERS_PER_EMAIL,
  normalizedLink,
} from './links';

const htmlPart = (value: string) => ({ type: 'text/html', value });

describe('judgeLink', () => {
  it.each([
    [
      'a plain product link',
      'https://shop.example/products/tee',
      'https://shop.example/products/tee',
    ],
    [
      'a product link with campaign tags and a referrer',
      'https://shop.example/p/123?utm_source=x&ref=y',
      'https://shop.example/p/123?utm_source=x&ref=y',
    ],
    [
      "Gmail's wrapper",
      'https://www.google.com/url?q=https://shop.example/p/123&sa=D&source=gmail',
      'https://shop.example/p/123',
    ],
    [
      "Outlook's safe link, encoded twice",
      'https://nam12.safelinks.protection.outlook.com/?url=https%253A%252F%252Fshop.example%252Fp%252F9&data=05',
      'https://shop.example/p/9',
    ],
    [
      'a redirector inside a redirector',
      `https://click.example/r?u=${encodeURIComponent('https://www.google.com/url?q=https://shop.example/dp/B0C1')}`,
      'https://shop.example/dp/B0C1',
    ],
    [
      'a product whose name starts like a refused word',
      'https://shop.example/products/track-pant',
      'https://shop.example/products/track-pant',
    ],
    [
      'a product whose name is a refused word and more (whole segments)',
      'https://shop.example/products/confirm-hoodie',
      'https://shop.example/products/confirm-hoodie',
    ],
    [
      "Amazon's /gp/product/ page",
      'https://www.amazon.com/gp/product/B0ABCDEFGH?ref=x',
      'https://www.amazon.com/gp/product/B0ABCDEFGH?ref=x',
    ],
    [
      "a SKU page (Zara's shape)",
      'https://www.shop.example/us/en/linen-shirt-p01234567.html?v1=9',
      'https://www.shop.example/us/en/linen-shirt-p01234567.html?v1=9',
    ],
    [
      'a plain product slug',
      'https://shop.example/products/blue-tee',
      'https://shop.example/products/blue-tee',
    ],
    [
      'an Amazon product',
      'https://www.amazon.com/gp/product/B0ABCDEFGH',
      'https://www.amazon.com/gp/product/B0ABCDEFGH',
    ],
  ])('selects %s as a product', (_, href, link) => {
    expect(judgeLink(href)).toEqual({ link, kind: 'product' });
  });

  it.each([
    [
      "SendGrid's tracker, its query as written",
      'https://shop.example/ls/click?upn=abc-2Fdef&utm_campaign=x#top',
      'https://shop.example/ls/click?upn=abc-2Fdef&utm_campaign=x',
    ],
    [
      'a click. host',
      'https://click.shop.example/q/abc',
      'https://click.shop.example/q/abc',
    ],
    [
      'a links. host',
      'https://links.shop.example/u/abc',
      'https://links.shop.example/u/abc',
    ],
    [
      "SES's tracker",
      'https://r.shop.example/CL0/abc/1/x',
      'https://r.shop.example/CL0/abc/1/x',
    ],
  ])('selects %s as a tracker', (_, href, link) => {
    expect(judgeLink(href, 'Relaxed Linen Shirt')).toEqual({
      link,
      kind: 'tracker',
    });
  });

  it.each([
    ['plain http', 'http://shop.example/products/tee'],
    ['a home page', 'https://shop.example/'],
    [
      'a home page with campaign tags',
      'https://shop.example/?utm_source=email',
    ],
    ['a category page', 'https://shop.example/collections/new'],
    ['an account page', 'https://shop.example/account/orders/123'],
    ["Amazon's order page", 'https://www.amazon.com/gp/your-account/order'],
    [
      "Amazon's order details",
      'https://www.amazon.com/gp/your-account/order-details?orderID=1',
    ],
    ["Amazon's order history", 'https://www.amazon.com/gp/css/order-history'],
    [
      'a cancel link with an order id',
      'https://shop.example/orders/cancel/12345678',
    ],
    ['a confirm link', 'https://shop.example/confirm/12345678'],
    ['a review request', 'https://shop.example/products/tee/review'],
    ['help', 'https://help.shop.example/articles/returns-policy'],
    ['unsubscribing', 'https://shop.example/email?unsubscribe=1&e=abc'],
    [
      'a product path naming an action',
      'https://shop.example/products/x?action=cancel',
    ],
    [
      'a product path whose query value is one',
      'https://shop.example/p/1?step=confirm',
    ],
    ['a sign-in token', 'https://shop.example/p/1?token=abc'],
    ['a signature, in any case', 'https://shop.example/p/1?SIG=abc'],
    ['a discount code (fail closed)', 'https://shop.example/p/1?code=SAVE10'],
    ['social', 'https://www.instagram.com/shop'],
    ['an app store', 'https://apps.apple.com/app/id123'],
    [
      'a wrapped social link',
      'https://www.google.com/url?q=https://pinterest.com/shop',
    ],
    [
      'a tracker wrapping a cancel page in plain sight',
      `https://links.shop.example/ls/click?url=${encodeURIComponent('https://shop.example/account/cancel')}`,
    ],
    ['an opaque link of no known shape', 'https://shop.example/c/abc123'],
    ['an opaque link on an email. host', 'https://email.shop.example/x/abc'],
    [
      'a percent-encoded denied word in a product path',
      'https://shop.example/products/123/%63ancel',
    ],
    ['a bare numeric id', 'https://shop.example/u/1234567890'],
    ['a numeric id below a path', 'https://shop.example/a/s/12345678/view'],
    [
      'a SKU-like page naming an action',
      'https://shop.example/cancel-order-12345678.html',
    ],
  ])('refuses %s', (_, href) => {
    expect(judgeLink(href)?.kind).toBe('refused');
  });

  it.each([
    'Cancel your order',
    "Didn't place this order? Cancel it",
    'Confirm your email',
    'Verify your address',
    'View order',
    'Sign in',
    'Log in to see it',
    'Manage your subscription',
    'Unsubscribe',
  ])('refuses a tracker whose text says "%s"', (text) => {
    expect(judgeLink('https://shop.example/ls/click?upn=abc', text)?.kind).toBe(
      'refused',
    );
  });

  it.each([
    ['mail', 'mailto:care@shop.example'],
    ['a relative link', '/products/tee'],
    ['javascript', 'javascript:alert(1)'],
    [
      'a link past the length cap',
      `https://shop.example/p/${'a'.repeat(2100)}`,
    ],
  ])('passes over %s, which is no web link', (_, href) => {
    expect(judgeLink(href)).toBeUndefined();
  });
});

describe('one canonical form (#949)', () => {
  const encoded = 'https://shop.example/%6Cs/click?upn=abc';

  it('reads a percent-encoded tracker path as the tracker it is, and judges its text', () => {
    expect(judgeLink(encoded, 'Tee')).toEqual({
      link: 'https://shop.example/ls/click?upn=abc',
      kind: 'tracker',
    });
    expect(judgeLink(encoded, 'Cancel order')?.kind).toBe('refused');
  });

  it('decodes the path for a redirect hop as for a first link', () => {
    expect(
      isProductLink(new URL('https://shop.example/products/123/%63ancel')),
    ).toBe(false);
    expect(
      isProductLink(new URL('https://shop.example/products/blue-%74ee')),
    ).toBe(true);
  });
});

describe('isProductLink', () => {
  it.each([
    ['https://shop.example/products/linen?variant=sage', true],
    ['https://www.shop.example/dp/B0C1?utm_medium=order', true],
    ['http://shop.example/products/linen', false],
    ['https://shop.example/account/cancel', false],
    ['https://shop.example/ls/click?upn=abc', false],
    ['https://shop.example/en-us/', false],
  ])('%s is %s', (href, expected) => {
    expect(isProductLink(new URL(href))).toBe(expected);
  });
});

describe('normalizedLink', () => {
  it('strips tracking parameters and the fragment, and keeps the rest', () => {
    expect(
      normalizedLink(
        new URL(
          'https://shop.example/products/tee?utm_source=a&variant=4&gclid=x&mc_eid=1&_hsenc=2#reviews',
        ),
      ),
    ).toBe('https://shop.example/products/tee?variant=4');
  });

  it('leaves a query without tracking parameters as it was written', () => {
    expect(
      normalizedLink(new URL('https://shop.example/p?id=a%20b&x=1+2')),
    ).toBe('https://shop.example/p?id=a%20b&x=1+2');
  });
});

describe('emailLinks', () => {
  it('selects only the product path and the tracker of a forwarded confirmation', () => {
    const email = JSON.parse(
      readFileSync(
        join(
          __dirname,
          '../../../../test/fixtures/order-mail/forwarded-order.json',
        ),
        'utf8',
      ),
    ) as { bodyValues: Record<string, { value: string }> };
    const shop = 'https://shop.test';
    const parts = ['1', '2'].map((id) => ({
      type: id === '1' ? 'text/plain' : 'text/html',
      value: email.bodyValues[id].value
        .replaceAll('{{SHOP_ENCODED}}', encodeURIComponent(shop))
        .replaceAll('{{SHOP}}', shop),
    }));
    expect(emailLinks(parts)).toEqual({
      links: [
        'https://shop.test/products/merino-crew-socks?utm_source=order_confirmation',
        'https://shop.test/ls/click?upn=u001.Qp9x7-2FbT0kL3rN8vYh-2BsE4eZ1aJ6cG5mW-3D&utm_campaign=order',
      ],
      // The home page, three collections, "View or manage your order",
      // help, two social sites, unsubscribe and privacy.
      skipped: 10,
    });
  });

  it('never selects a cancel, confirm or view-order link, behind a tracker or not', () => {
    const { links } = emailLinks([
      htmlPart(
        `<a href="https://shop.example/ls/click?upn=one">Didn't place this order? Cancel it</a>
         <a href="https://click.shop.example/q/two"><img alt="Confirm your email" src="x"></a>
         <a href="https://links.shop.example/u/three">View your order</a>
         <a href="https://shop.example/orders/12345678/cancel">Cancel</a>
         <a href="https://shop.example/products/tee">Tee</a>`,
      ),
    ]);
    expect(links).toEqual(['https://shop.example/products/tee']);
  });

  it('fetches a tracker with no text of its own only when an HTML anchor names it', () => {
    const text = {
      type: 'text/plain',
      value:
        'Cancel your order: https://shop.example/ls/click?upn=c\nLinen shirt: https://shop.example/ls/click?upn=s',
    };
    // A text part's links have no anchor to read: never fetched alone.
    expect(emailLinks([text])).toEqual({ links: [], skipped: 2 });
    expect(
      emailLinks([
        text,
        htmlPart(
          '<a href="https://shop.example/ls/click?upn=s">Linen shirt</a>',
        ),
      ]),
    ).toEqual({ links: ['https://shop.example/ls/click?upn=s'], skipped: 1 });
  });

  it('refuses a tracker when any of its anchors names an action', () => {
    expect(
      emailLinks([
        htmlPart(
          `<a href="https://shop.example/ls/click?upn=x">Tee</a>
           <a href="https://shop.example/ls/click?upn=x">Cancel</a>`,
        ),
      ]),
    ).toEqual({ links: [], skipped: 1 });
  });

  it("reads an HTML part's links and a text part's, product paths first, each once", () => {
    const { links } = emailLinks([
      htmlPart(
        `<a href="https://shop.example/ls/click?upn=1">Tee</a>
         <a href="https://shop.example/products/tee?a=1&amp;b=2">Tee</a>
         <a href="https://shop.example/products/tee?a=1&amp;b=2#img">Tee again</a>`,
      ),
      {
        type: 'text/plain',
        value: 'Your socks: https://shop.example/p/55555. Thanks!',
      },
    ]);
    expect(links).toEqual([
      'https://shop.example/products/tee?a=1&b=2',
      'https://shop.example/p/55555',
      'https://shop.example/ls/click?upn=1',
    ]);
  });

  it(`selects at most ${MAX_TRACKERS_PER_EMAIL} trackers and ${MAX_LINKS_PER_EMAIL} links from one email`, () => {
    const anchors = (path: (i: number) => string) =>
      Array.from(
        { length: 20 },
        (_, i) => `<a href="https://shop.example${path(i)}">${i}</a>`,
      ).join('');
    const trackers = anchors((i) => `/ls/click?upn=${i}`);
    const both = emailLinks([htmlPart(trackers + anchors((i) => `/p/${i}`))]);
    expect(both.links).toHaveLength(MAX_LINKS_PER_EMAIL);
    expect(both.links.every((link) => link.includes('/p/'))).toBe(true);
    expect(both.skipped).toBe(40 - MAX_LINKS_PER_EMAIL);
    expect(emailLinks([htmlPart(trackers)]).links).toHaveLength(
      MAX_TRACKERS_PER_EMAIL,
    );
  });

  it('never throws on broken or hostile markup', () => {
    for (const value of [
      '<a href="https://shop.example/p/1',
      '<a href=https://shop.example/p/2>x</a><a href=>',
      '<<<<a href="https://[::1">',
      `<a ${'x="y" '.repeat(5000)}href="https://shop.example/p/3">`,
      `<a href="https://shop.example/ls/click?upn=1">${'<b'.repeat(5000)}`,
      'https://'.repeat(10_000),
    ]) {
      expect(() => emailLinks([htmlPart(value)])).not.toThrow();
      expect(() => emailLinks([{ type: 'text/plain', value }])).not.toThrow();
    }
  });
});

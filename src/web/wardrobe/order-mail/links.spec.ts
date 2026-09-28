import { describe, expect, it } from 'vitest';
import {
  candidateLink,
  MAX_LINKS_PER_EMAIL,
  normalizedLink,
  productLinkCandidates,
} from './links';

const htmlPart = (value: string) => ({ type: 'text/html', value });

describe('candidateLink', () => {
  it.each([
    [
      'a plain product link',
      'https://shop.example/products/tee',
      'https://shop.example/products/tee',
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
      'an opaque tracker, left for the fetcher to follow, its query as written',
      'https://click.shop.example/ls/click?upn=abc-2Fdef&utm_campaign=x#top',
      'https://click.shop.example/ls/click?upn=abc-2Fdef&utm_campaign=x',
    ],
  ])('keeps %s', (_, href, expected) => {
    expect(candidateLink(href)).toBe(expected);
  });

  it.each([
    ['mail', 'mailto:care@shop.example'],
    ['a relative link', '/products/tee'],
    ['javascript', 'javascript:alert(1)'],
    ['a home page', 'https://shop.example/'],
    [
      'a home page with campaign tags',
      'https://shop.example/?utm_source=email',
    ],
    ['an account page', 'https://shop.example/account/orders/123'],
    ['order tracking', 'https://shop.example/orders/123/track'],
    ['help', 'https://help.shop.example/articles/returns-policy'],
    ['unsubscribing', 'https://shop.example/email?unsubscribe=1&e=abc'],
    ['privacy', 'https://shop.example/privacy'],
    ['social', 'https://www.instagram.com/shop'],
    ['an app store', 'https://apps.apple.com/app/id123'],
    [
      'a wrapped social link',
      'https://www.google.com/url?q=https://pinterest.com/shop',
    ],
    [
      'a link past the length cap',
      `https://shop.example/p/${'a'.repeat(2100)}`,
    ],
  ])('drops %s', (_, href) => {
    expect(candidateLink(href)).toBeUndefined();
  });

  it('keeps a product whose name merely starts like an excluded word', () => {
    expect(candidateLink('https://shop.example/products/track-pant')).toBe(
      'https://shop.example/products/track-pant',
    );
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

describe('productLinkCandidates', () => {
  it("reads an HTML part's links and a text part's, product paths first, each once", () => {
    const links = productLinkCandidates([
      htmlPart(
        `<a href="https://shop.example/collections/new">New</a>
         <a href="https://click.shop.example/c?id=1">Tee</a>
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
      'https://shop.example/collections/new',
      'https://click.shop.example/c?id=1',
    ]);
  });

  it(`fetches at most ${MAX_LINKS_PER_EMAIL} links from one email`, () => {
    const anchors = Array.from(
      { length: 40 },
      (_, i) => `<a href="https://shop.example/look/${i}">${i}</a>`,
    ).join('');
    expect(productLinkCandidates([htmlPart(anchors)])).toHaveLength(
      MAX_LINKS_PER_EMAIL,
    );
  });

  it('never throws on broken or hostile markup', () => {
    for (const value of [
      '<a href="https://shop.example/p/1',
      '<a href=https://shop.example/p/2>x</a><a href=>',
      '<<<<a href="https://[::1">',
      `<a ${'x="y" '.repeat(5000)}href="https://shop.example/p/3">`,
      'https://'.repeat(10_000),
    ]) {
      expect(() => productLinkCandidates([htmlPart(value)])).not.toThrow();
      expect(() =>
        productLinkCandidates([{ type: 'text/plain', value }]),
      ).not.toThrow();
    }
  });
});

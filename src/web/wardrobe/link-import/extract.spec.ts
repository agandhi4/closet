import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ExtractedProduct,
  extractProduct,
  MAX_IMAGE_CANDIDATES,
  parsePrice,
} from './extract';

const fixture = (name: string) =>
  readFileSync(join(__dirname, 'fixtures', name), 'utf8');

const NOTHING: ExtractedProduct = {
  source: null,
  name: null,
  brand: null,
  price: null,
  colors: [],
  category: null,
  type: null,
  materials: [],
  fabricWeight: null,
  warmth: null,
  images: [],
};

describe('extractProduct', () => {
  it('reads a Shopify product page from its ProductGroup JSON-LD', () => {
    const page = new URL(
      'https://acme-supply.test/products/heavyweight-pocket-tee?variant=4401',
    );

    expect(extractProduct(fixture('shopify-product.html'), page)).toEqual({
      source: 'json-ld',
      name: 'Heavyweight Pocket Tee – Navy',
      brand: 'Acme Supply Co.',
      // On the variant only, as Shopify writes it.
      price: { amount: '48.00', currency: 'USD' },
      colors: ['blue'],
      category: 'tops',
      type: 't-shirt',
      materials: ['cotton'],
      fabricWeight: 240,
      // A stated weight leaves warmth to the form's presets.
      warmth: null,
      images: [
        'https://acme-supply.test/cdn/shop/files/pocket-tee-navy-front.jpg?v=1712345678&width=1920',
        'https://acme-supply.test/cdn/shop/files/pocket-tee-navy-back.jpg?v=1712345678&width=1920',
        'https://acme-supply.test/cdn/shop/files/pocket-tee-navy-front.jpg?v=1712345678',
        'http://acme-supply.test/cdn/shop/files/pocket-tee-navy-front.jpg?v=1712345678',
      ],
    });
  });

  it('finds the Product in an @graph, repairing a raw newline in a string', () => {
    const page = new URL('https://irondenim.test/produkt/selvedge-jeans/');

    expect(extractProduct(fixture('woocommerce-graph.html'), page)).toEqual({
      source: 'json-ld',
      name: 'Selvedge Jeans 14 oz',
      brand: 'Iron Denim',
      price: { amount: '1299.00', currency: 'SEK' },
      colors: ['blue'],
      category: 'bottoms',
      type: 'jeans',
      materials: ['cotton', 'denim'],
      fabricWeight: 475,
      warmth: null,
      images: [
        'https://irondenim.test/wp-content/uploads/2026/03/selvedge-jeans.jpg',
      ],
    });
  });

  it('falls back to Open Graph, resolving images against <base href>', () => {
    const page = new URL('https://knitwear.test/products/merino-crew');

    expect(extractProduct(fixture('open-graph-only.html'), page)).toEqual({
      source: 'open-graph',
      name: 'Merino Crew Sweater',
      brand: 'Knitwear Co.',
      price: { amount: '120', currency: 'EUR' },
      colors: ['grey'],
      category: 'tops',
      type: 'sweater',
      materials: ['merino'],
      fabricWeight: null,
      warmth: null,
      images: [
        'https://cdn.knitwear.test/assets/images/merino-crew-charcoal.jpg',
        'https://cdn.knitwear.test/assets/images/merino-crew-detail.jpg',
      ],
    });
  });

  it('falls back to <title> without the site name', () => {
    const html =
      '<html><head><title>Linen Shirt Dress | Boutique</title></head></html>';

    expect(extractProduct(html, new URL('https://boutique.test/p/1'))).toEqual({
      ...NOTHING,
      source: 'title',
      name: 'Linen Shirt Dress',
      category: 'dresses',
      type: 'day-dress',
      materials: ['linen'],
    });
  });

  it('finds nothing on a page without any of it', () => {
    const html = '<html><body><h1>Access denied</h1></body></html>';

    expect(extractProduct(html, new URL('https://shop.test/'))).toEqual(
      NOTHING,
    );
  });

  it('guesses warmth from "heavyweight" when no weight is stated', () => {
    const html = `<script type="application/ld+json">
      {"@type": "Product", "name": "Heavyweight Hoodie"}</script>`;

    expect(extractProduct(html, new URL('https://shop.test/'))).toMatchObject({
      category: 'tops',
      type: 'hoodie',
      fabricWeight: null,
      warmth: 4,
    });
  });

  it.each([
    ['an image string', '"https://cdn.test/a.jpg"', ['https://cdn.test/a.jpg']],
    [
      'an ImageObject list',
      '[{"@type": "ImageObject", "contentUrl": "/a.jpg"}, {"url": ["/b.jpg"]}]',
      ['https://shop.test/a.jpg', 'https://shop.test/b.jpg'],
    ],
    ['a number', '42', []],
  ])('reads %s as image candidates', (_label, image, expected) => {
    const html = `<script type="application/ld+json">
      {"@type": "Product", "name": "Tee", "image": ${image}}</script>`;

    expect(extractProduct(html, new URL('https://shop.test/p')).images).toEqual(
      expected,
    );
  });

  it(`keeps at most ${MAX_IMAGE_CANDIDATES} image candidates`, () => {
    const images = Array.from({ length: 20 }, (_, i) => `"/img/${i}.jpg"`);
    const html = `<script type="application/ld+json">
      {"@type": "Product", "name": "Tee", "image": [${images.join(',')}]}</script>`;

    expect(
      extractProduct(html, new URL('https://shop.test/')).images,
    ).toHaveLength(MAX_IMAGE_CANDIDATES);
  });

  it('reads a brand given as a plain string, a Brand, or a list', () => {
    for (const brand of [
      '"Acme"',
      '{"@type": "Brand", "name": "Acme"}',
      '[{"name": "Acme"}]',
    ]) {
      const html = `<script type="application/ld+json">
        {"@type": "Product", "name": "Tee", "brand": ${brand}}</script>`;
      expect(extractProduct(html, new URL('https://shop.test/')).brand).toBe(
        'Acme',
      );
    }
  });

  it('passes over an empty Product node to the one that says something', () => {
    const html = `
      <script type="application/ld+json">{"@type": "Product", "@id": "#product"}</script>
      <script type="application/ld+json">{"@graph": [
        {"@type": "Product", "@id": "#product"},
        {"@type": "Product", "name": "Oxford Shirt", "brand": "Acme"}
      ]}</script>`;

    expect(extractProduct(html, new URL('https://shop.test/'))).toMatchObject({
      source: 'json-ld',
      name: 'Oxford Shirt',
      brand: 'Acme',
    });
  });

  it('does not credit JSON-LD when its only Product is empty', () => {
    const html = `
      <script type="application/ld+json">{"@type": "Product", "@id": "#product"}</script>
      <meta property="og:title" content="Oxford Shirt">`;

    expect(extractProduct(html, new URL('https://shop.test/'))).toMatchObject({
      source: 'open-graph',
      name: 'Oxford Shirt',
    });
  });

  it.each([
    'application/ld+json; charset=utf-8',
    'Application/LD+JSON ;charset="UTF-8"',
  ])('reads JSON-LD typed %s', (type) => {
    const html = `<script type='${type}'>{"@type": "Product", "name": "Tee"}</script>`;

    expect(extractProduct(html, new URL('https://shop.test/'))).toMatchObject({
      source: 'json-ld',
      name: 'Tee',
    });
  });

  it('bounds the name to the form field', () => {
    const html = `<script type="application/ld+json">
      {"@type": "Product", "name": "${'Tee '.repeat(200)}"}</script>`;

    expect(
      extractProduct(html, new URL('https://shop.test/')).name!.length,
    ).toBeLessThanOrEqual(200);
  });

  describe('hostile or broken pages', () => {
    const page = new URL('https://shop.test/');

    it.each([
      [
        'JSON-LD that is not JSON',
        '<script type="application/ld+json">{"@type": "Product", "name": </script>',
      ],
      [
        'JSON-LD that is a string',
        '<script type="application/ld+json">"Product"</script>',
      ],
      [
        'JSON-LD that is null',
        '<script type="application/ld+json">null</script>',
      ],
      [
        'a Product without fields',
        '<script type="application/ld+json">{"@type": "Product"}</script>',
      ],
      [
        'fields of the wrong types',
        '<script type="application/ld+json">{"@type": "Product", "name": {"a": 1}, "brand": 7, "offers": "free", "image": {"url": {"x": 1}}, "hasVariant": 3, "material": {}}</script>',
      ],
      [
        'an @type that is not a string',
        '<script type="application/ld+json">{"@type": {"x": 1}, "@graph": 5}</script>',
      ],
      [
        'deep nesting',
        `<script type="application/ld+json">${'['.repeat(5000)}${']'.repeat(5000)}</script>`,
      ],
      [
        'a nested Product past the depth bound',
        `<script type="application/ld+json">${'{"a":'.repeat(50)}{"@type":"Product","name":"Deep"}${'}'.repeat(50)}</script>`,
      ],
      [
        'an unclosed script',
        '<script type="application/ld+json">{"@type": "Product", "name": "Tee"}',
      ],
      ['an unclosed tag', '<meta property="og:title" content="Tee'],
      ['an unclosed comment', '<!-- <title>Hidden</title>'],
      [
        'a prototype key',
        '<script type="application/ld+json">{"__proto__": {"@type": "Product"}, "constructor": 1}</script>',
      ],
      [
        'bad character references',
        '<title>&#xD800; &#99999999; &bogus;</title>',
      ],
      [
        'a base that is not http',
        '<base href="javascript:alert(1)"><meta property="og:image" content="/a.jpg">',
      ],
    ])('survives %s', (_label, html) => {
      expect(() => extractProduct(html, page)).not.toThrow();
    });

    it('ignores a base href that is not http(s)', () => {
      const html =
        '<base href="javascript:alert(1)"><meta property="og:image" content="/a.jpg">';

      expect(extractProduct(html, page).images).toEqual([
        'https://shop.test/a.jpg',
      ]);
    });

    it('stops at the depth bound instead of walking forever', () => {
      const html = `<script type="application/ld+json">${'{"a":'.repeat(50)}{"@type":"Product","name":"Deep"}${'}'.repeat(50)}</script>`;

      expect(extractProduct(html, page).source).toBeNull();
    });

    it('skips a broken block and reads the next', () => {
      const html = `
        <script type="application/ld+json">{"@type": "Product", "name": </script>
        <script type="application/ld+json">{"@type": "Product", "name": "Second"}</script>`;

      expect(extractProduct(html, page).name).toBe('Second');
    });

    it('does not read a title or JSON-LD out of a script, a style or a comment', () => {
      const html = `
        <script>var s = '<title>From script</title>';</script>
        <style>/* <title>From style</title> */</style>
        <!-- <script type="application/ld+json">{"@type":"Product","name":"From comment"}</script> -->
        <title>Real &amp; Proper</title>`;

      expect(extractProduct(html, page)).toMatchObject({
        source: 'title',
        name: 'Real & Proper',
      });
    });

    it('reads attributes in any quoting and order, with ">" inside a value', () => {
      const html = `<meta content='A > B Tee' property=og:title>`;

      expect(extractProduct(html, page).name).toBe('A > B Tee');
    });

    it('scans a large page in linear time', () => {
      // Many unterminated scripts and quotes: a backtracking scanner would
      // take minutes here.
      const html =
        '<script type="application/ld+json">'.repeat(20000) +
        '<a href="'.repeat(20000) +
        'x'.repeat(1024 * 1024);
      const started = performance.now();

      extractProduct(html, page);

      expect(performance.now() - started).toBeLessThan(1000);
    });
  });
});

describe('parsePrice', () => {
  it.each([
    [48, '48'],
    [48.5, '48.5'],
    ['48.00', '48.00'],
    ['$1,299.00', '1299.00'],
    ['29,99', '29.99'],
    ['USD 120', '120'],
  ])('reads %j as %s', (value, expected) => {
    expect(parsePrice(value)).toBe(expected);
  });

  it.each([0, '0.00', '', 'free', '1.299,00', -5, '1e9', null, undefined])(
    'refuses %j',
    (value) => {
      expect(parsePrice(value)).toBeNull();
    },
  );
});

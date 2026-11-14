import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { garment, orderEmail, orderItem } from '../../src/db/schema';
import { t as text } from '../../src/web/i18n';
import { JmapError } from '../../src/web/wardrobe/order-mail/jmap';
import {
  OrderMailOwnerError,
  pollOrderMail,
} from '../../src/web/wardrobe/order-mail/poll';
import {
  type JmapStub,
  startJmapStub,
  type StubEmail,
} from '../support/jmap-stub';
import {
  ORDER_SENDER as SENDER,
  serveForwardedOrder,
} from '../support/order-mail-shop';
import {
  createTestApp,
  OWNER_EMAIL,
  recordQueries,
  type TestApp,
  unescapeHtml,
} from './harness';
import { type LinkSites, startLinkSites } from './link-sites';
import {
  expectAppBar,
  expectFullPage,
  expectNativePostForms,
  expectNoRawI18nKeys,
  expectNoScriptNavigation,
} from './pages';

/**
 * The order email import (#25; plan docs/plans/2026-09-28-order-email-
 * import.md): the poll against a stand-in for Fastmail's JMAP API
 * (test/support/jmap-stub.ts) and a local shop (link-sites.ts) behind the
 * real outbound fetchers, then the "From your orders" review list and its
 * "Add to closet" through the link import's garment form. No spec reaches
 * Fastmail or the internet.
 */

// Fastmail's shape (fmu1- and hex groups): the scrubbing and log checks
// look for exactly this.
const TOKEN = 'fmu1-0a1b2c3d-4e5f60718293a4b5c6d7e8f9a0b1c2d3-0-e4f5a6b7c8d9';

/** The rules every page keeps (pages.spec.ts), for pages only this feature has. */
function expectPageRules(res: LightMyRequestResponse): void {
  expectFullPage(res);
  expectAppBar(res);
  expectNativePostForms(res);
  expectNoRawI18nKeys(res);
  expectNoScriptNavigation(res);
}

describe('order email import', () => {
  let t: TestApp;
  let sites: LinkSites;
  let jmap: JmapStub;
  let forwarded: StubEmail;

  const poll = () => pollOrderMail(t.orderMail!);
  const items = () => t.db.select().from(orderItem).orderBy(orderItem.id);
  const emailRow = async (emailId: string) =>
    (
      await t.db
        .select()
        .from(orderEmail)
        .where(eq(orderEmail.emailId, emailId))
    )[0];

  /** An email like `forwarded` with its own id, arrival and overrides. */
  const variant = (
    id: string,
    receivedAt: string,
    overrides: Partial<StubEmail> = {},
  ): StubEmail => ({ ...forwarded, id, receivedAt, ...overrides });

  beforeAll(async () => {
    sites = await startLinkSites();
    jmap = await startJmapStub(TOKEN);
    forwarded = await serveForwardedOrder(sites);

    t = await createTestApp(
      {
        ORDER_MAIL_JMAP_TOKEN: TOKEN,
        ORDER_MAIL_SENDERS: `${SENDER.toUpperCase()}, other@example.com`,
        ORDER_MAIL_OWNER: OWNER_EMAIL,
      },
      { outboundFetch: sites.outboundFetch, orderMail: jmap.options },
    );
  });

  afterAll(async () => {
    await t.cleanup();
    await jmap.close();
    await sites.close();
  });

  beforeEach(() => {
    jmap.failWith(undefined);
  });

  describe('the poll', () => {
    it('lists the products of a forwarded order email, unwrapping its tracking links', async () => {
      jmap.deliver(forwarded);
      sites.hits.length = 0;

      let summary: Awaited<ReturnType<typeof poll>> | undefined;
      const recorded = await recordQueries(async () => {
        summary = await poll();
      });

      expect(summary).toEqual({ queried: 1, read: 1, listed: 2 });
      // #173: the owner and the watermark in one statement, which of the
      // inbox's ids are known, then the email: begin, the email and its
      // items in one statement, its count and outcome, commit.
      expect(recorded.statements).toBe(6);
      const rows = await items();
      expect(
        rows.map(({ productUrl, name, brand, price, currency, state }) => ({
          productUrl,
          name,
          brand,
          price,
          currency,
          state,
        })),
      ).toEqual([
        {
          // Gmail's google.com/url?q= wrapper, unwrapped without a fetch;
          // a product path, so read first.
          productUrl: sites.url('/products/merino-crew-socks'),
          name: 'Merino Crew Socks (3-pack)',
          brand: null,
          price: '24.00',
          currency: 'USD',
          state: 'pending',
        },
        {
          // The tracker's redirect, followed; its campaign tags and the
          // fragment stripped, the variant kept.
          productUrl: sites.url('/products/relaxed-linen-shirt?variant=sage'),
          name: 'Relaxed Linen Shirt',
          brand: 'Northfield',
          price: '49.90',
          currency: 'USD',
          state: 'pending',
        },
      ]);
      // The day it arrived in the household's zone (13:20 UTC is the
      // morning of the 26th in New York).
      expect(rows.every((row) => row.orderedOn === '2026-09-26')).toBe(true);
      expect(await emailRow(forwarded.id)).toMatchObject({
        outcome: 'imported',
        items: 2,
      });

      // Only product candidates were fetched: never the account, help,
      // unsubscribe or privacy pages, the home page, a social site, the
      // tracking pixel or a product image.
      const paths = sites.hits.map((hit) => hit.split('?')[0]);
      expect(paths).toContain('/ls/click');
      expect(paths).toContain('/products/relaxed-linen-shirt');
      expect(paths).toContain('/products/merino-crew-socks');
      for (const never of [
        '/',
        '/account/orders/NF-204817',
        '/help',
        '/unsubscribe',
        '/pages/privacy',
        '/open.gif',
        '/img/linen-shirt.jpg',
      ]) {
        expect(paths).not.toContain(never);
      }
    });

    it('reads nothing twice: a second poll lists nothing and fetches no body', async () => {
      const before = await items();
      const bodies = jmap.calls.filter((c) => c === 'Email/get body').length;
      sites.hits.length = 0;

      let summary: Awaited<ReturnType<typeof poll>> | undefined;
      const recorded = await recordQueries(async () => {
        summary = await poll();
      });

      expect(summary).toEqual({ queried: 1, read: 0, listed: 0 });
      // #173: the poll every few minutes is two statements (it was three):
      // the owner with the watermark, then which ids are known.
      expect(recorded.statements).toBe(2);
      expect(recorded.sql.join('\n')).not.toMatch(/"password"/);
      expect(await items()).toEqual(before);
      expect(jmap.calls.filter((c) => c === 'Email/get body')).toHaveLength(
        bodies,
      );
      expect(sites.hits).toEqual([]);
    });

    it('lists a product once, even when a later email (the shipping one) names it again', async () => {
      jmap.deliver(variant('Mshipped01', '2026-09-27T09:00:00Z'));
      await poll();
      expect(await items()).toHaveLength(2);
      expect(await emailRow('Mshipped01')).toMatchObject({
        outcome: 'no-products',
        items: 0,
      });
    });

    it("ignores mail that is not from the owner's addresses, without reading its body", async () => {
      const bodies = jmap.calls.filter((c) => c === 'Email/get body').length;
      jmap.deliver(
        variant('Mstranger1', '2026-09-27T10:00:00Z', {
          from: [{ email: 'deals@northfield.test' }],
        }),
      );
      // The owner's address as From, but sent from elsewhere: DKIM and SPF
      // fail at Fastmail, and a passing header the sender added lower down
      // counts for nothing.
      jmap.deliver(
        variant('Mspoofed01', '2026-09-27T10:05:00Z', {
          authenticationResults: [
            'mx2.messagingengine.com; dkim=none (no signatures found); dmarc=fail policy.published-domain-policy=none header.from=gmail.com; spf=softfail smtp.mailfrom=owner.forwarder@gmail.com',
            'mx.google.com; dkim=pass header.d=gmail.com; spf=pass smtp.mailfrom=owner.forwarder@gmail.com',
          ],
        }),
      );
      // A passing result under another server's name is not Fastmail's.
      jmap.deliver(
        variant('Mforeign01', '2026-09-27T10:10:00Z', {
          authenticationResults: [
            'mx.evil.test; dkim=pass header.d=gmail.com; spf=pass smtp.mailfrom=owner.forwarder@gmail.com',
          ],
        }),
      );
      t.logs.clear();

      await poll();

      for (const id of ['Mstranger1', 'Mspoofed01', 'Mforeign01']) {
        expect(await emailRow(id)).toMatchObject({
          outcome: 'untrusted',
          items: 0,
        });
      }
      expect(jmap.calls.filter((c) => c === 'Email/get body')).toHaveLength(
        bodies,
      );
      expect(await items()).toHaveLength(2);
      const warnings = t.logs.messages('warn', 'OrderMail');
      expect(warnings).toEqual([
        'Order mail Mstranger1 ignored: untrusted (sender-not-allowed, from northfield.test)',
        'Order mail Mspoofed01 ignored: untrusted (authentication-failed, from gmail.com)',
        'Order mail Mforeign01 ignored: untrusted (foreign-authserv, from gmail.com)',
      ]);
    });

    it('records an email without product links as having none', async () => {
      jmap.deliver(
        variant('Mplain0001', '2026-09-27T11:00:00Z', {
          htmlBody: [{ partId: '1', type: 'text/plain' }],
          bodyValues: {
            '1': {
              value:
                'Fwd: Your order has shipped.\n\nQuestions? Reply to this email.\n',
            },
          },
        }),
      );
      // #173: an email without products is one insert, no transaction.
      const recorded = await recordQueries(() => poll());
      expect(recorded.statements).toBe(3);
      expect(await emailRow('Mplain0001')).toMatchObject({
        outcome: 'no-products',
        items: 0,
      });
      expect(await items()).toHaveLength(2);
    });

    it('fails the run when JMAP refuses, recording nothing, and never logs the token', async () => {
      jmap.deliver(variant('Mlater0001', '2026-09-27T12:00:00Z'));
      jmap.failWith(401);
      await expect(poll()).rejects.toThrow(JmapError);
      await expect(poll()).rejects.toThrow(
        'JMAP session refused (http-status 401)',
      );
      expect(await emailRow('Mlater0001')).toBeUndefined();

      jmap.failWith(undefined);
      await poll();
      expect(await emailRow('Mlater0001')).toMatchObject({
        outcome: 'no-products',
      });
      expect(t.logs.text()).not.toContain(TOKEN);
      expect(JSON.stringify(t.logs.records)).not.toContain(TOKEN);
    });
  });

  describe('the review list', () => {
    const pending = async () =>
      (await items()).filter((row) => row.state === 'pending');
    const pendingNamed = async (name: string) =>
      (await pending()).find((row) => row.name === name)!;

    it('lists the pending items, linked from the Wardrobe menu, for the order account owner', async () => {
      const page = await t.inject({ method: 'GET', url: '/wardrobe/orders' });
      expect(page.statusCode).toBe(200);
      expectPageRules(page);
      const body = unescapeHtml(page.body);
      expect(body).toContain('Relaxed Linen Shirt');
      expect(body).toContain('Merino Crew Socks (3-pack)');
      expect(body).toContain('$49.90');
      expect(body).toContain(
        `href="${sites.url('/products/relaxed-linen-shirt?variant=sage')}"`,
      );
      // No markup from the email ever reaches the page.
      expect(body).not.toContain('Forwarded message');

      const wardrobe = await t.inject({ method: 'GET', url: '/wardrobe' });
      expect(wardrobe.body).toContain('href="/wardrobe/orders"');
    });

    it('is nobody else’s: another user gets a 404, no menu entry, and cannot claim an item', async () => {
      const cookie = await t.register('housemate@example.com');
      const page = await t.inject({
        method: 'GET',
        url: '/wardrobe/orders',
        headers: { cookie },
      });
      expect(page.statusCode).toBe(404);
      const wardrobe = await t.inject({
        method: 'GET',
        url: '/wardrobe',
        headers: { cookie },
      });
      expect(wardrobe.body).not.toContain('href="/wardrobe/orders"');

      const [item] = await pending();
      const dismiss = await t.inject({
        method: 'POST',
        url: `/wardrobe/orders/${item.id}/dismiss`,
        headers: { cookie },
      });
      expect(dismiss.statusCode).toBe(404);
      const save = await t.inject({
        method: 'POST',
        url: '/wardrobe',
        payload: {
          category: 'tops',
          name: 'Mine now',
          orderItem: String(item.id),
        },
        headers: { cookie },
      });
      expect(save.statusCode).toBe(404);
      expect((await pending()).map((row) => row.id)).toContain(item.id);
    });

    it('adds an item to the closet through the prefilled garment form, once', async () => {
      const shirt = await pendingNamed('Relaxed Linen Shirt');
      const form = await t.inject({
        method: 'POST',
        url: `/wardrobe/orders/${shirt.id}/add`,
      });
      expect(form.statusCode).toBe(200);
      expectPageRules(form);
      const body = unescapeHtml(form.body);
      expect(body).toContain(`name="orderItem" value="${shirt.id}"`);
      expect(body).toContain('value="Relaxed Linen Shirt"');
      expect(body).toContain('value="2026-09-26"');
      expect(body).toContain(text('orders.FROM_ORDER'));
      const linkPhoto = /name="linkPhoto" value="([^"]+)"/.exec(body)?.[1];
      expect(linkPhoto).toBeDefined();

      const fields = {
        category: 'tops',
        name: 'Relaxed Linen Shirt',
        product: '1',
        sourceUrl: shirt.productUrl,
        price: '49.90',
        dateAquired: '2026-09-26',
        orderItem: String(shirt.id),
      };
      const saved = await t.inject({
        method: 'POST',
        url: '/wardrobe',
        payload: { ...fields, linkPhoto: linkPhoto! },
      });
      expect(saved.statusCode).toBe(302);
      const garmentId = Number(
        /^\/wardrobe\/(\d+)\?created=1$/.exec(saved.headers.location!)?.[1],
      );
      const [row] = await items().then((rows) =>
        rows.filter((r) => r.id === shirt.id),
      );
      expect(row).toMatchObject({ state: 'added', garmentId });
      expect(row.decidedAt).not.toBeNull();
      const [created] = await t.db
        .select()
        .from(garment)
        .where(eq(garment.id, garmentId));
      expect(created).toMatchObject({
        status: 'closet',
        acquiredOn: '2026-09-26',
        price: '49.90',
      });

      // The same form again (a double tap, no photo left): refused, and
      // no second garment.
      const count = await t.db.$count(garment);
      const again = await t.inject({
        method: 'POST',
        url: '/wardrobe',
        payload: fields,
      });
      expect(again.statusCode).toBe(404);
      expect(await t.db.$count(garment)).toBe(count);

      // Off the list; its "Add" again goes back to the list.
      const list = await t.inject({ method: 'GET', url: '/wardrobe/orders' });
      expect(list.body).not.toContain('Relaxed Linen Shirt');
      const reopen = await t.inject({
        method: 'POST',
        url: `/wardrobe/orders/${shirt.id}/add`,
      });
      expect(reopen.statusCode).toBe(303);
      expect(reopen.headers.location).toBe('/wardrobe/orders');
    });

    it("opens the form with the order's details when the product page cannot be read now", async () => {
      const socks = await pendingNamed('Merino Crew Socks (3-pack)');
      sites.serve('/products/merino-crew-socks', {
        status: 503,
        type: 'text/html',
        body: 'down',
      });
      const form = await t.inject({
        method: 'POST',
        url: `/wardrobe/orders/${socks.id}/add`,
      });
      expect(form.statusCode).toBe(200);
      const body = unescapeHtml(form.body);
      expect(body).toContain('value="Merino Crew Socks (3-pack)"');
      expect(body).toContain('value="24.00"');
      expect(body).toContain(text('orders.PAGE_UNAVAILABLE'));
      expect(body).toContain(`name="orderItem" value="${socks.id}"`);
    });

    it('dismisses an item', async () => {
      const socks = await pendingNamed('Merino Crew Socks (3-pack)');
      const res = await t.inject({
        method: 'POST',
        url: `/wardrobe/orders/${socks.id}/dismiss`,
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/wardrobe/orders');
      expect(await pending()).toEqual([]);
      const [row] = (await items()).filter((r) => r.id === socks.id);
      expect(row).toMatchObject({ state: 'dismissed', garmentId: null });
      const list = await t.inject({ method: 'GET', url: '/wardrobe/orders' });
      expect(list.body).toContain(text('orders.EMPTY'));
    });
  });

  it('fails the run when ORDER_MAIL_OWNER names no account', async () => {
    const other = await createTestApp(
      {
        ORDER_MAIL_JMAP_TOKEN: TOKEN,
        ORDER_MAIL_SENDERS: SENDER,
        ORDER_MAIL_OWNER: 'nobody@example.com',
      },
      { outboundFetch: sites.outboundFetch, orderMail: jmap.options },
    );
    try {
      await expect(pollOrderMail(other.orderMail!)).rejects.toThrow(
        OrderMailOwnerError,
      );
    } finally {
      await other.cleanup();
    }
  });
});

describe('order email import, off', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it('has no poll, no review list and no menu entry without a token', async () => {
    expect(t.orderMail).toBeUndefined();
    // A 404 like a route that is not there, never /wardrobe/:id's 400.
    const page = await t.inject({ method: 'GET', url: '/wardrobe/orders' });
    expect(page.statusCode).toBe(404);
    expect(page.body).not.toContain(text('orders.INTRO'));
    for (const action of ['add', 'dismiss']) {
      const post = await t.inject({
        method: 'POST',
        url: `/wardrobe/orders/1/${action}`,
      });
      expect(post.statusCode).toBe(404);
    }
    const wardrobe = await t.inject({ method: 'GET', url: '/wardrobe' });
    expect(wardrobe.body).not.toContain('href="/wardrobe/orders"');
  });
});

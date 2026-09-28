import { describe, expect, it } from 'vitest';
import { judgeSender, parseAuthenticationResults } from './trust';

const OWNER = 'owner@gmail.com';
const FASTMAIL_PASS =
  'mx6.messagingengine.com; arc=none (no signatures); dkim=pass (2048-bit rsa key sha256) header.d=gmail.com header.i=@gmail.com header.b=Xk3p; dmarc=pass (p=none) header.from=gmail.com; spf=pass smtp.mailfrom=owner@gmail.com smtp.helo=mail-wr1-f54.google.com';

const judge = (from: string | null, results: string[], allowed = [OWNER]) =>
  judgeSender(
    {
      from: from === null ? null : [{ email: from }],
      authenticationResults: results,
    },
    allowed,
  );

describe('judgeSender', () => {
  it("trusts the owner's forward that Fastmail authenticated, in any case", () => {
    expect(judge('Owner@Gmail.com', [FASTMAIL_PASS])).toEqual({
      trusted: true,
      sender: OWNER,
    });
  });

  it.each([
    [
      'DKIM alone',
      'mx1.messagingengine.com; dkim=pass header.d=gmail.com; spf=fail smtp.mailfrom=gmail.com',
    ],
    [
      'SPF alone',
      'mx1.messagingengine.com; dkim=none; spf=pass smtp.mailfrom=owner@gmail.com',
    ],
    [
      'DMARC alone',
      'mx1.messagingengine.com; dkim=fail header.d=gmail.com; dmarc=pass header.from=gmail.com',
    ],
    [
      'a signing subdomain',
      'mx1.messagingengine.com; dkim=pass header.d=mail.gmail.com',
    ],
  ])('passes on %s', (_, results) => {
    expect(judge(OWNER, [results]).trusted).toBe(true);
  });

  it.each([
    ['no From', null, [FASTMAIL_PASS], 'no-single-sender'],
    ['a stranger', 'deals@shop.example', [FASTMAIL_PASS], 'sender-not-allowed'],
    ['no Authentication-Results', OWNER, [], 'no-authentication-results'],
    [
      "a result under another server's name",
      OWNER,
      ['mx.evil.example; dkim=pass header.d=gmail.com'],
      'foreign-authserv',
    ],
    [
      'a name that only ends like Fastmail',
      OWNER,
      ['evilmessagingengine.com; dkim=pass header.d=gmail.com'],
      'foreign-authserv',
    ],
    [
      'failures at Fastmail, whatever the sender added below',
      OWNER,
      [
        'mx2.messagingengine.com; dkim=none; dmarc=fail header.from=gmail.com; spf=softfail smtp.mailfrom=owner@gmail.com',
        FASTMAIL_PASS,
      ],
      'authentication-failed',
    ],
    [
      "a pass for another domain (the sender's own)",
      OWNER,
      [
        'mx1.messagingengine.com; dkim=pass header.d=evil.example; spf=pass smtp.mailfrom=bounce@evil.example',
      ],
      'authentication-failed',
    ],
    [
      'a pass for a domain that only ends like the owner’s',
      OWNER,
      ['mx1.messagingengine.com; dkim=pass header.d=xgmail.com'],
      'authentication-failed',
    ],
    [
      'a pass named only in a comment',
      OWNER,
      [
        'mx1.messagingengine.com; dkim=fail (dkim=pass header.d=gmail.com) header.d=gmail.com',
      ],
      'authentication-failed',
    ],
  ])('refuses %s', (_, from, results, reason) => {
    expect(judge(from, results)).toMatchObject({ trusted: false, reason });
  });

  it('refuses a From with two addresses, even when one is the owner', () => {
    expect(
      judgeSender(
        {
          from: [{ email: OWNER }, { email: 'other@example.com' }],
          authenticationResults: [FASTMAIL_PASS],
        },
        [OWNER],
      ),
    ).toMatchObject({ trusted: false, reason: 'no-single-sender' });
  });

  it('names only the domain of a refused sender', () => {
    expect(judge('deals@shop.example', [FASTMAIL_PASS])).toEqual({
      trusted: false,
      reason: 'sender-not-allowed',
      domain: 'shop.example',
    });
  });
});

describe('parseAuthenticationResults', () => {
  it('reads the authserv-id, each method and its properties, without comments', () => {
    const parsed = parseAuthenticationResults(FASTMAIL_PASS);
    expect(parsed.authservId).toBe('mx6.messagingengine.com');
    expect(
      parsed.methods.map(({ method, result, properties }) => [
        method,
        result,
        Object.fromEntries(properties),
      ]),
    ).toEqual([
      ['arc', 'none', {}],
      [
        'dkim',
        'pass',
        {
          'header.d': 'gmail.com',
          'header.i': '@gmail.com',
          'header.b': 'xk3p',
        },
      ],
      ['dmarc', 'pass', { 'header.from': 'gmail.com' }],
      [
        'spf',
        'pass',
        {
          'smtp.mailfrom': 'owner@gmail.com',
          'smtp.helo': 'mail-wr1-f54.google.com',
        },
      ],
    ]);
  });

  it('never throws on a garbled header', () => {
    for (const header of [
      '',
      ';;;',
      '(((',
      'x; =pass',
      `a; ${'dkim=pass '.repeat(5000)}`,
    ]) {
      expect(() => parseAuthenticationResults(header)).not.toThrow();
    }
  });
});

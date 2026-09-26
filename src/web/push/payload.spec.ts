import { describe, expect, it } from 'vitest';
import { notificationTarget, parsePushPayload } from './payload';

const ORIGIN = 'https://closet.test';

describe('parsePushPayload', () => {
  it('reads the payload the sender writes', () => {
    expect(
      parsePushPayload({
        title: 'Today',
        body: 'Linen blazer',
        url: '/calendar',
        tag: 'today',
      }),
    ).toEqual({
      title: 'Today',
      body: 'Linen blazer',
      url: '/calendar',
      tag: 'today',
    });
    expect(parsePushPayload({ title: 'T', body: 'B', url: '/' })).toEqual({
      title: 'T',
      body: 'B',
      url: '/',
    });
  });

  it.each([
    ['null', null],
    ['a string', 'hello'],
    ['the old nested shape', { title: 'T', options: { body: 'B' } }],
    ['no url', { title: 'T', body: 'B' }],
    ['a numeric title', { title: 1, body: 'B', url: '/' }],
    ['a non-string tag', { title: 'T', body: 'B', url: '/', tag: 3 }],
  ])('refuses %s', (_label, value) => {
    expect(parsePushPayload(value)).toBeUndefined();
  });
});

describe('notificationTarget', () => {
  it.each([
    ['/calendar', `${ORIGIN}/calendar`],
    ['/calendar?week=2026-09-20', `${ORIGIN}/calendar?week=2026-09-20`],
    [`${ORIGIN}/outfits/3`, `${ORIGIN}/outfits/3`],
  ])('opens the same-origin %s', (url, expected) => {
    expect(notificationTarget(url, ORIGIN)).toBe(expected);
  });

  it.each([
    'https://evil.test/phish',
    '//evil.test/phish',
    'javascript:alert(1)',
    'http://closet.test/calendar',
    'http://[',
  ])('opens the app root instead of %s', (url) => {
    expect(notificationTarget(url, ORIGIN)).toBe(`${ORIGIN}/`);
  });
});

import { describe, expect, it } from 'vitest';
import { presentedBearer } from './bearer';

const request = (authorization: unknown, rawHeaders: string[] = []) =>
  ({
    headers: authorization === undefined ? {} : { authorization },
    raw: { rawHeaders },
  }) as unknown as Parameters<typeof presentedBearer>[0];

describe('presentedBearer', () => {
  it.each(['Bearer tok', 'bearer tok', 'BEARER tok', 'Bearer   tok  '])(
    'reads %j',
    (header) => {
      expect(
        presentedBearer(request(header, ['Authorization', header])),
      ).toEqual({ token: 'tok' });
    },
  );

  it.each([
    ['no header', undefined, 'no bearer token'],
    ['another scheme', 'Basic tok', 'malformed header'],
    ['a token and more', 'Bearer tok more', 'malformed header'],
    ['the scheme alone', 'Bearer', 'malformed header'],
    ['two values folded into one', 'Bearer a, Bearer b', 'malformed header'],
  ])('refuses %s', (_case, header, refused) => {
    expect(presentedBearer(request(header))).toEqual({ refused });
  });

  it('refuses two headers Node folded into the first', () => {
    expect(
      presentedBearer(
        request('Bearer a', [
          'authorization',
          'Bearer a',
          'Authorization',
          'Bearer b',
        ]),
      ),
    ).toEqual({ refused: 'duplicate header' });
  });
});

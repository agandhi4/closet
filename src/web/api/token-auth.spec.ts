import { describe, expect, it } from 'vitest';
import { carriesQueryToken } from './token-auth';

describe('carriesQueryToken', () => {
  it.each([
    [{ access_token: 'x' }],
    [{ token: '' }],
    [{ Access_Token: 'x' }],
    [{ q: 'closet_abc' }],
    [{ q: 'Bearer closet_abc' }],
    [{ q: ['fine', 'closet_abc'] }],
  ])('finds a token in %j', (query) => {
    expect(carriesQueryToken(query)).toBe(true);
  });

  it.each([[{}], [{ ownerId: '3' }], [{ q: ['a', 'b'] }], [undefined]])(
    'finds none in %j',
    (query) => {
      expect(carriesQueryToken(query)).toBe(false);
    },
  );
});

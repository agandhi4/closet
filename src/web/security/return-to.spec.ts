import { describe, expect, it } from 'vitest';
import { safeReturnTo } from './return-to';

describe('safeReturnTo', () => {
  it.each([
    '/',
    '/calendar',
    '/outfits/12',
    '/outfits/12/edit?returnTo=/calendar',
    '/calendar?week=2026-09-21',
  ])('keeps the same-site path %s', (path) => {
    expect(safeReturnTo(path, '/outfits')).toBe(path);
  });

  it.each([
    ['a javascript: URL', "javascript:alert('x')"],
    ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
    ['a protocol-relative URL', '//evil.com'],
    ['a backslash protocol-relative URL', '/\\evil.com'],
    ['an absolute URL', 'https://evil.com'],
    ['an absolute URL with a path', 'https://evil.com/outfits'],
    ['a relative path', 'outfits'],
    ['a tab hiding a second slash', '/\t/evil.com'],
    ['a newline hiding a second slash', '/\n/evil.com'],
    ['an empty value', ''],
    ['no value', undefined],
  ])('falls back for %s', (_label, value) => {
    expect(safeReturnTo(value, '/outfits')).toBe('/outfits');
  });
});

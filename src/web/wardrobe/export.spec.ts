import { describe, expect, it } from 'vitest';
import { csvCell, csvValue } from './export';

describe('csvCell', () => {
  it.each([
    ['=SUM(A1:A2)', "'=SUM(A1:A2)"],
    ['+1', "'+1"],
    ['-M', "'-M"],
    ['@brand', "'@brand"],
    ['\tTabbed', "'\tTabbed"],
    ['\rReturn', `"'\rReturn"`],
  ])('defuses the formula start of %j', (text, cell) => {
    expect(csvCell(text)).toBe(cell);
  });

  it.each([
    ['plain', 'plain'],
    ['a, b', '"a, b"'],
    ['say "hi"', '"say ""hi"""'],
    ['two\nlines', '"two\nlines"'],
    ['=a,"b"', `"'=a,""b"""`],
    ['', ''],
    ['mid=dle', 'mid=dle'],
  ])('quotes %j as RFC 4180 does', (text, cell) => {
    expect(csvCell(text)).toBe(cell);
  });
});

describe('csvValue', () => {
  it.each<[Parameters<typeof csvValue>[0], string]>([
    [null, ''],
    [['black', 'white'], 'black, white'],
    [true, 'true'],
    [3, '3'],
    ['24.90', '24.90'],
  ])('writes %j as %j', (value, text) => {
    expect(csvValue(value)).toBe(text);
  });
});

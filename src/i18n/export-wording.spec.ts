import { describe, expect, it } from 'vitest';
import english from './en/lang.json';

// #654: the export is a garment list; backups are the operator's database
// dump plus the photo share. A string promising the export as a backup
// would make a user keep a spreadsheet believing it is their closet.
describe('the garment export is never called a backup', () => {
  const strings = Object.entries(english.profile).concat(
    Object.entries(english).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );

  it('no string pairs "export" with an affirmative "backup"', () => {
    const offenders = strings
      .filter(([, text]) => /export/i.test(text) && /back ?up/i.test(text))
      .filter(([, text]) => !/not a backup/i.test(text))
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });

  it("Profile's hint says what the export holds and leaves out", () => {
    const hint = english.profile.EXPORT_HINT;
    expect(hint).toContain('garment list');
    expect(hint).toContain('no photo files');
    expect(hint).toContain('outfits');
    expect(hint).toContain('It is not a backup');
  });

  it('the delete-account page says the export keeps no photos, outfits or history', () => {
    expect(english.DELETE_ACCOUNT_WARNING).toContain(
      'keeps no photos, outfits or history',
    );
  });
});

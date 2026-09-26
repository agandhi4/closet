import { describe, expect, it } from 'vitest';
import { SECTION_HOME, sectionOf } from './sections';

describe('sectionOf', () => {
  it.each([
    ['/wardrobe', 'wardrobe'],
    ['/wardrobe?category=tops&keyword=raw', 'wardrobe'],
    ['/wardrobe?select=1', 'wardrobe'],
    ['/wardrobe?pick=3', 'wardrobe'],
    ['/wardrobe/12', 'wardrobe'],
    ['/wardrobe/12/edit', 'wardrobe'],
    ['/wardrobe/new', 'wardrobe'],
    ['/wardrobe/new/from-link', 'wardrobe'],
    ['/wardrobe/tag', 'wardrobe'],
    ['/capsules', 'wardrobe'],
    ['/capsules/new', 'wardrobe'],
    ['/capsules/4', 'wardrobe'],
    ['/capsules/4/edit?ownerId=2', 'wardrobe'],
    ['/outfits', 'outfits'],
    ['/outfits/new?capsule=4', 'outfits'],
    ['/outfits/7', 'outfits'],
    ['/outfits/7/edit?returnTo=/calendar', 'outfits'],
    ['/calendar', 'calendar'],
    ['/calendar?week=2026-09-20&calMonth=2026-10', 'calendar'],
  ])('puts %s in %s', (path, section) => {
    expect(sectionOf(path)).toBe(section);
  });

  it.each([
    '/',
    '',
    '/auth/profile',
    '/auth/login',
    '/wardrobe-share/manage',
    '/wardrobe-share/invite/abc',
    '/share?garment=1',
    '/about',
    '/offline.html',
    '/wardrobes',
    '/outfitsx',
    '/calendar-old',
  ])('puts %s in no section', (path) => {
    expect(sectionOf(path)).toBeUndefined();
  });

  it('matches the path, not a query or fragment that names a section', () => {
    expect(sectionOf('/auth/profile?next=/wardrobe')).toBeUndefined();
    expect(sectionOf('/about#/calendar')).toBeUndefined();
  });

  it('puts every section home in its own section', () => {
    for (const [section, home] of Object.entries(SECTION_HOME)) {
      expect(sectionOf(home)).toBe(section);
    }
  });
});

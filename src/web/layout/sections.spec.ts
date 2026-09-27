import { describe, expect, it } from 'vitest';
import { DOCK_TABS, SECTION_HOME, sectionOf } from './sections';

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
    ['/styling', 'styling'],
    ['/styling?with=12&ownerId=2', 'styling'],
    ['/styling/garments?role=top&before=9', 'styling'],
    ['/outfits', 'outfits'],
    ['/outfits/ideas?for=day:2026-10-05', 'outfits'],
    ['/outfits/7', 'outfits'],
    ['/calendar', 'calendar'],
    ['/calendar?week=2026-09-20&calMonth=2026-10', 'calendar'],
    ['/trips', 'calendar'],
    ['/trips/3', 'calendar'],
    ['/trips/3/outfits/new?day=2026-10-05', 'calendar'],
    ['/', 'today'],
    ['/?from=push', 'today'],
  ])('puts %s in %s', (path, section) => {
    expect(sectionOf(path)).toBe(section);
  });

  it.each([
    '',
    '//',
    '/today/ideas',
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
    '/tripsy',
    '/stylingx',
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

  it('docks Today, Wardrobe, Style, Outfits and Calendar (#43)', () => {
    expect(DOCK_TABS).toEqual([
      'today',
      'wardrobe',
      'styling',
      'outfits',
      'calendar',
    ]);
  });

  it('docks sections once each, every one with a home', () => {
    expect(new Set(DOCK_TABS).size).toBe(DOCK_TABS.length);
    for (const section of DOCK_TABS)
      expect(SECTION_HOME[section]).toMatch(/^\//);
  });
});

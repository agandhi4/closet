import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './harness';
import { createAccessToken, tool } from './mcp';

/**
 * get_style_profile (#34, the week #16; tools/style.ts since #337): the
 * caller's own profile and week template as the profile pages save them,
 * with the rhythm derived from the week. Another user reads their own.
 */
describe('MCP: the style profile', () => {
  let t: TestApp;
  let token: string;
  let strangerToken: string;

  const post = (url: string, payload: object) =>
    t.inject({ method: 'POST', url, payload });

  beforeAll(async () => {
    t = await createTestApp();
    token = await createAccessToken(t);
    strangerToken = await createAccessToken(t, {
      cookie: await t.register('stranger-style@example.com'),
    });
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  it('reads the style profile: null until saved, then every part, and the week template with its rhythm (#16)', async () => {
    const emptyWeek = Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      day: null,
      around: [],
    }));
    expect(await tool(t, token, 'get_style_profile')).toEqual({
      profile: null,
      week: { template: emptyWeek, rhythm: [] },
    });
    await post('/auth/profile/style', {
      styles: ['minimal'],
      budget: 'premium',
      palette: ['black'],
    });
    await post('/auth/profile/week', {
      'day-1': 'work',
      'day-2': 'work',
      'around-2': ['workout', 'night-out'],
      'day-6': 'daytime',
    });
    const answer = await tool<{ week: { template: unknown[] } }>(
      t,
      token,
      'get_style_profile',
    );
    expect(answer).toEqual({
      profile: {
        styles: ['minimal'],
        budget: 'premium',
        palette: ['black'],
        notes: null,
      },
      week: {
        template: expect.any(Array),
        rhythm: [
          { occasion: 'workout', perWeek: 1 },
          { occasion: 'work', perWeek: 2 },
          { occasion: 'daytime', perWeek: 1 },
          { occasion: 'night-out', perWeek: 1 },
        ],
      },
    });
    expect(answer.week.template[2]).toEqual({
      weekday: 2,
      day: 'work',
      around: ['workout', 'night-out'],
    });
  });

  it('is the caller’s own: another user reads theirs, still empty', async () => {
    expect(await tool(t, strangerToken, 'get_style_profile')).toMatchObject({
      profile: null,
      week: { rhythm: [] },
    });
  });
});

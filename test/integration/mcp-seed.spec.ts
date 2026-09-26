import { PassThrough, Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeed } from '../../src/seed/seed';
import { createTestApp, OWNER_EMAIL, type TestApp, userIdOf } from './harness';
import { createAccessToken, tool } from './mcp';

/**
 * The MCP endpoint against the seed personas (#32, #33), the loop the
 * owner runs: Theo (demo) shared with the owner, the owner's Claude
 * searching his wardrobe and comparing it with their own; and the seed's
 * own token (`--token`), with which Theo's Claude reads his closet and
 * compares it with Dana's (sparse), shared with him.
 */
describe('MCP over the seed personas', () => {
  let t: TestApp;
  let stdout = '';
  let demoToken: string;
  let ownerToken: string;

  beforeAll(async () => {
    t = await createTestApp();
    const output = new PassThrough();
    output.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    const status = await runSeed({
      args: [
        ...['--persona', 'demo', '--persona', 'sparse'],
        ...['--anchor', '2026-09-26', '--password-stdin'],
        ...['--share-with', OWNER_EMAIL, '--token'],
      ],
      db: t.db,
      photos: t.photos,
      logger: t.logger,
      timeZone: 'America/New_York',
      input: Readable.from(['Closet-demo-1\n']),
      output,
      errors: new PassThrough(),
      now: new Date('2026-09-26T16:00:00Z'),
    });
    expect(status, stdout).toBe(0);
    demoToken = /demo: MCP token (closet_\S+) /.exec(stdout)![1];
    ownerToken = await createAccessToken(t);
  }, 120_000);

  afterAll(async () => {
    await t?.cleanup();
  });

  it('prints each persona’s token once, and never logs it', () => {
    expect(stdout.match(/MCP token closet_/g)).toHaveLength(2);
    expect(JSON.stringify(t.logs.records)).not.toContain(demoToken);
  });

  it('lets the owner’s Claude search Theo’s wardrobe through the share', async () => {
    const demoId = await userIdOf(t, 'demo@closet.invalid');
    const { wardrobes } = await tool<{
      wardrobes: { ownerId: number; name: string; permission: string }[];
    }>(t, ownerToken, 'list_shared_wardrobes');
    expect(wardrobes).toContainEqual({
      ownerId: demoId,
      name: 'Theo',
      permission: 'VIEW',
    });
    const boots = await tool<{ total: number; garments: { role: string }[] }>(
      t,
      ownerToken,
      'search_garments',
      { ownerId: demoId, category: 'footwear' },
    );
    expect(boots.total).toBeGreaterThan(0);
    expect(new Set(boots.garments.map((g) => g.role))).toEqual(
      new Set(['footwear']),
    );
    const office = await tool<{ capsules: { name: string }[] }>(
      t,
      ownerToken,
      'list_capsules',
      { ownerId: demoId },
    );
    expect(office.capsules.map((c) => c.name)).toContain('Office');
  });

  it('compares the owner’s (empty) closet with Theo’s: every kind is a gap', async () => {
    const demoId = await userIdOf(t, 'demo@closet.invalid');
    const compared = await tool<{
      counts: Record<string, { owned: number; shared: number }>;
      gaps: { kind: string; shared: { price: string | null }[] }[];
      overlap: unknown[];
      complete: boolean;
    }>(t, ownerToken, 'compare_with_shared_wardrobe', { ownerId: demoId });
    expect(compared.complete).toBe(true);
    expect(compared.overlap).toEqual([]);
    expect(compared.counts.top.shared).toBeGreaterThan(0);
    // Theo's pieces are real products: the gaps come with prices.
    expect(
      compared.gaps.some((gap) => gap.shared.some((g) => g.price !== null)),
    ).toBe(true);
  });

  it('lets Theo’s own token read his closet and compare it with Dana’s', async () => {
    const sparseId = await userIdOf(t, 'sparse@closet.invalid');
    const own = await tool<{ total: number }>(t, demoToken, 'search_garments');
    expect(own.total).toBe(80);
    const compared = await tool<{
      overlap: unknown[];
      onlyOwned: unknown[];
    }>(t, demoToken, 'compare_with_shared_wardrobe', { ownerId: sparseId });
    expect(compared.overlap.length).toBeGreaterThan(0);
    expect(compared.onlyOwned.length).toBeGreaterThan(0);
    const laundry = await tool<{ garments: unknown[] }>(
      t,
      demoToken,
      'laundry_status',
    );
    expect(Array.isArray(laundry.garments)).toBe(true);
  });
});

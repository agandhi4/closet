import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment, selfie } from '../../src/db/schema';
import { variantFileName } from '../../src/web/files/image-variant';
import { acceptInvite, createInvite } from '../../src/web/sharing/queries';
import { countToTag, nextToTag } from '../../src/web/wardrobe/queries';
import {
  createGarment,
  jpegPhoto,
  photoFileName,
  uploadPhoto,
} from './garments';
import { createTestApp, type TestApp, userIdOf } from './harness';
import { callTool, createAccessToken, mcpRequest, tool } from './mcp';
import { planEntry, takeSelfie } from './selfies';

/**
 * Garment photos for tagging by the owner's own Claude (#90):
 * get_garment_photo answers a garment's 400px thumb as an MCP image block,
 * for the caller's garments and a wardrobe shared with them, never a
 * selfie and never another user's unshared garment; search_garments'
 * needsTagging lists exactly tagging mode's queue (needsTags). The tool is
 * logged like every other, never with the image's bytes.
 */

interface ToolContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

describe('MCP garment photos and tagging', () => {
  let t: TestApp;
  let token: string;
  let viewer: { cookie: string; id: number; token: string };
  let stranger: { cookie: string; id: number; token: string };
  let photographed: number;
  let bare: number;

  const signUp = async (email: string) => {
    const cookie = await t.register(email);
    const id = await userIdOf(t, email);
    return { cookie, id, token: await createAccessToken(t, { cookie }) };
  };

  /** A garment through the form, as the tagging spec makes them. */
  const create = async (payload: Record<string, string>) => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      payload: { props: '1', ...payload },
    });
    expect(res.statusCode).toBe(302);
    return Number(/^\/wardrobe\/(\d+)/.exec(String(res.headers.location))![1]);
  };

  /** get_garment_photo's raw content blocks. */
  const photoContent = async (
    callerToken: string,
    args: Record<string, unknown>,
  ) => {
    const res = await mcpRequest(t, callerToken, 'tools/call', {
      name: 'get_garment_photo',
      arguments: args,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{
      result: { content: ToolContent[]; isError?: boolean };
    }>().result;
  };

  beforeAll(async () => {
    t = await createTestApp();
    photographed = await createGarment(t, {
      name: 'Photographed tee',
      category: 'tops',
    });
    await uploadPhoto(t, photographed, await jpegPhoto(1200, 800));
    bare = await createGarment(t, { name: 'No photo yet', category: 'tops' });

    token = await createAccessToken(t);
    viewer = await signUp('viewer@example.com');
    stranger = await signUp('stranger@example.com');
    const invite = await createInvite(t.db, t.owner.id, 'VIEW');
    expect(
      (await acceptInvite(t.db, invite.inviteToken, viewer.id)).accepted,
    ).toBe(true);
  });

  afterAll(() => t?.cleanup());

  describe('get_garment_photo', () => {
    it("answers the garment's thumb, not the original, as an image block", async () => {
      const result = await photoContent(token, { id: photographed });
      expect(result.isError).toBeUndefined();
      const [about, image] = result.content;
      expect(about.type).toBe('text');
      expect(JSON.parse(about.text!)).toEqual({
        id: photographed,
        name: 'Photographed tee',
        category: 'tops',
      });
      expect(image).toMatchObject({ type: 'image', mimeType: 'image/webp' });

      const bytes = Buffer.from(image.data!, 'base64');
      const name = await photoFileName(t, photographed);
      const thumb = await readFile(
        join(t.dataPath, variantFileName(name, 'thumb')),
      );
      const original = await readFile(join(t.dataPath, name));
      expect(bytes.equals(thumb)).toBe(true);
      expect(bytes.equals(original)).toBe(false);
      const { format, width, height } = await sharp(bytes).metadata();
      expect(format).toBe('webp');
      expect(Math.max(width, height)).toBeLessThanOrEqual(400);
    });

    it('answers a wardrobe shared with the caller (VIEW)', async () => {
      const result = await photoContent(viewer.token, {
        id: photographed,
        ownerId: t.owner.id,
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[1]).toMatchObject({ type: 'image' });
    });

    it("treats another user's unshared garment as not found", async () => {
      // Addressed as the stranger's own wardrobe: the id is not theirs.
      expect(
        await callTool(t, stranger.token, 'get_garment_photo', {
          id: photographed,
        }),
      ).toEqual({ isError: true, value: { error: 'Garment not found' } });
      // Addressed as the owner's wardrobe: no share, so no wardrobe.
      expect(
        await callTool(t, stranger.token, 'get_garment_photo', {
          id: photographed,
          ownerId: t.owner.id,
        }),
      ).toEqual({ isError: true, value: { error: 'Wardrobe not found' } });
    });

    it('refuses a garment without a photo', async () => {
      expect(
        await callTool(t, token, 'get_garment_photo', { id: bare }),
      ).toEqual({ isError: true, value: { error: 'Garment has no photo' } });
    });

    it("never answers a selfie's photo, even through a garment that points at it", async () => {
      const tee = await createGarment(t, { name: 'Mirror tee' });
      const res = await t.inject({
        method: 'POST',
        url: '/outfits',
        payload: { name: 'Mirror', category: 'shirt', garmentId: String(tee) },
      });
      expect(res.statusCode).toBe(302);
      const outfitId = Number(
        /^\/outfits\/(\d+)$/.exec(res.headers.location as string)![1],
      );
      const entryId = await planEntry(t, outfitId, t.today());
      const taken = await takeSelfie(t, entryId);
      const [row] = await t.db
        .select({ photoId: selfie.photoId })
        .from(selfie)
        .where(eq(selfie.id, taken.id));

      // The tool addresses garments only: an id that is no garment of the
      // caller's is not found, whatever else carries it.
      expect(
        await callTool(t, token, 'get_garment_photo', { id: 2_000_000 }),
      ).toEqual({ isError: true, value: { error: 'Garment not found' } });

      // A garment row wrongly pointing at the selfie's file is still refused
      // (isPrivatePhoto), as the public /file routes refuse its name.
      await t.db
        .update(garment)
        .set({ photoId: row.photoId })
        .where(eq(garment.id, tee));
      try {
        expect(
          await callTool(t, token, 'get_garment_photo', { id: tee }),
        ).toEqual({ isError: true, value: { error: 'Garment not found' } });
        expect(t.logs.messages('warn', 'Web')).toContainEqual(
          `Refused a selfie as garment ${tee}'s photo to user ${t.owner.id} (MCP)`,
        );
      } finally {
        await t.db
          .update(garment)
          .set({ photoId: null })
          .where(eq(garment.id, tee));
      }
    });

    it('is logged with its tool and user, never the image bytes', async () => {
      const result = await photoContent(token, { id: photographed });
      const data = result.content[1].data!;
      expect(t.logs.messages('info', 'Mcp')).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `^MCP get_garment_photo by user ${t.owner.id} \\(token \\d+\\): ok `,
          ),
        ),
      );
      expect(JSON.stringify(t.logs.records)).not.toContain(data.slice(0, 64));
    });

    it('is listed as a read-only tool', async () => {
      const res = await mcpRequest(t, token, 'tools/list');
      const { tools } = res.json<{
        result: {
          tools: { name: string; annotations: { readOnlyHint: boolean } }[];
        };
      }>().result;
      expect(
        tools.find((listed) => listed.name === 'get_garment_photo')?.annotations
          .readOnlyHint,
      ).toBe(true);
    });
  });

  describe("search_garments' needsTagging", () => {
    let ids: Record<
      'done' | 'bag' | 'heavy' | 'blank' | 'archived' | 'wished',
      number
    >;

    beforeAll(async () => {
      ids = {
        done: await create({
          name: 'Done tee',
          category: 'tops',
          type: 't-shirt',
          warmth: '2',
          formality: '2',
        }),
        // A bag has no warmth: its type and formality are asked.
        bag: await create({ name: 'Tote', category: 'bags', type: 'tote' }),
        heavy: await create({
          name: 'Heavy tee',
          category: 'tops',
          warmth: '3',
        }),
        blank: await create({ name: 'Blank tee', category: 'tops' }),
        archived: await create({ name: 'Old tee', category: 'tops' }),
        wished: await create({
          name: 'Wished tee',
          category: 'tops',
          to: 'wishlist',
          wishlist: '1',
        }),
      };
      const archived = await t.inject({
        method: 'POST',
        url: `/wardrobe/${ids.archived}/archive`,
      });
      expect(archived.statusCode).toBeLessThan(400);
    });

    /** Tagging mode's queue, card by card, as its Next walks it. */
    const taggingQueue = async (ownerId: number) => {
      const queue: number[] = [];
      let before: number | undefined;
      for (;;) {
        const next = await nextToTag(t.db, ownerId, before);
        if (!next) return queue;
        queue.push(next.id);
        before = next.id;
      }
    };

    it("lists exactly tagging mode's queue, in its order", async () => {
      const queue = await taggingQueue(t.owner.id);
      expect(queue).toEqual(
        expect.arrayContaining([ids.bag, ids.heavy, ids.blank]),
      );
      expect(queue).not.toContain(ids.done);
      expect(queue).not.toContain(ids.archived);
      expect(queue).not.toContain(ids.wished);

      const found = await tool<{ total: number; garments: { id: number }[] }>(
        t,
        token,
        'search_garments',
        { needsTagging: true },
      );
      expect(found.garments.map((g) => g.id)).toEqual(queue);
      expect(found.total).toBe(await countToTag(t.db, t.owner.id));
    });

    it('leaves archived garments out even with includeArchived', async () => {
      const found = await tool<{ garments: { id: number }[] }>(
        t,
        token,
        'search_garments',
        { needsTagging: true, includeArchived: true },
      );
      expect(found.garments.map((g) => g.id)).toEqual(
        await taggingQueue(t.owner.id),
      );
    });

    it('combines with the other filters', async () => {
      const found = await tool<{ garments: { id: number }[] }>(
        t,
        token,
        'search_garments',
        { needsTagging: true, category: 'bags' },
      );
      expect(found.garments.map((g) => g.id)).toEqual([ids.bag]);
    });

    it('answers the queue of a wardrobe shared with the caller', async () => {
      const found = await tool<{ garments: { id: number }[] }>(
        t,
        viewer.token,
        'search_garments',
        { needsTagging: true, ownerId: t.owner.id },
      );
      expect(found.garments.map((g) => g.id)).toEqual(
        await taggingQueue(t.owner.id),
      );
    });

    it('lists fully tagged garments without it', async () => {
      const found = await tool<{ garments: { id: number }[] }>(
        t,
        token,
        'search_garments',
      );
      expect(found.garments.map((g) => g.id)).toContain(ids.done);
    });
  });
});

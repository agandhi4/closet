import { readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { File } from '../../src/dal/entity/file.entity';
import { Garment } from '../../src/dal/entity/garment.entity';
import { User } from '../../src/dal/entity/user.entity';
import { variantFileName } from '../../src/file/image-variant';
import { createGarment, jpegPhoto, uploadPhoto } from './garments';
import { createTestApp, TEST_PASSWORD, TestApp } from './harness';

/**
 * Deleting an account removes the user's photos from storage, not only the
 * rows the database cascade drops.
 */
describe('account deletion', () => {
  let t: TestApp;
  const email = 'carol@example.com';
  const bystanderEmail = 'dave@example.com';

  const storedFiles = async () =>
    (await readdir(t.dataPath)).filter((name) => name.endsWith('.webp'));

  const deleteAccount = (cookie: string, payload: Record<string, string>) =>
    t.inject({
      method: 'POST',
      url: '/auth/delete-account',
      headers: { cookie },
      payload,
    });

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  it('removes the user, their garments, their File rows and every stored variant', async () => {
    const cookie = await t.register(email);
    const bystanderCookie = await t.register(bystanderEmail);
    const garmentId = await createGarment(t, { name: 'Coat', cookie });
    await uploadPhoto(t, garmentId, await jpegPhoto(), cookie);
    const bystanderGarment = await createGarment(t, {
      name: 'Hat',
      cookie: bystanderCookie,
    });
    await uploadPhoto(t, bystanderGarment, await jpegPhoto(), bystanderCookie);

    const em = t.em();
    const user = await em.findOneOrFail(User, { email });
    const fileName = (
      await em.findOneOrFail(Garment, garmentId, { populate: ['photo'] })
    ).photo!.fileName;
    const bystanderFile = (
      await em.findOneOrFail(Garment, bystanderGarment, { populate: ['photo'] })
    ).photo!.fileName;
    expect(await storedFiles()).toEqual(
      expect.arrayContaining([fileName, variantFileName(fileName, 'thumb')]),
    );

    // The confirmation must be this account's own credentials.
    const wrongPassword = await deleteAccount(cookie, {
      email,
      password: 'not-the-password',
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongPassword.headers.location).toBeUndefined();
    const someoneElse = await deleteAccount(cookie, {
      email: bystanderEmail,
      password: TEST_PASSWORD,
    });
    expect(someoneElse.statusCode).toBe(401);
    expect(someoneElse.headers.location).toBeUndefined();
    const malformed = await deleteAccount(cookie, { email });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.headers.location).toBeUndefined();
    expect(await t.em().findOne(User, { id: user.id })).not.toBeNull();
    expect(
      await t.em().findOne(User, { email: bystanderEmail }),
    ).not.toBeNull();

    const res = await deleteAccount(cookie, { email, password: TEST_PASSWORD });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    const cleared = res.cookies.find((c) => c.name === 'access_token');
    expect(cleared?.value).toBe('');

    const after = t.em();
    expect(await after.findOne(User, { id: user.id })).toBeNull();
    expect(await after.count(Garment, { owner: user.id })).toBe(0);
    expect(await after.count(File, { createdBy: user.id })).toBe(0);
    expect(await after.findOne(File, { fileName })).toBeNull();
    const files = await storedFiles();
    expect(files).not.toContain(fileName);
    expect(files).not.toContain(variantFileName(fileName, 'thumb'));
    expect(files).not.toContain(variantFileName(fileName, 'nobg'));

    // The other household member is untouched.
    expect(
      await after.findOne(File, { fileName: bystanderFile }),
    ).not.toBeNull();
    expect(files).toContain(bystanderFile);

    // The old session is dead.
    const profile = await t.inject({
      method: 'GET',
      url: '/auth/profile',
      headers: { cookie },
    });
    expect(profile.statusCode).toBe(302);
    expect(profile.headers.location).toBe('/auth/login');
  });
});

import { randomBytes } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PhotoStorage } from '../../src/web/files/storage';
import { captureLogs } from '../support/log-capture';

/**
 * PhotoStorage (src/web/files/storage.ts) on a real directory: the races
 * between a reader, a writer and a delete of one name, and the line between
 * a missing file (an answer) and a broken DATA_PATH (an error). That line
 * matters downstream: reconciliation deletes what list() and exists() say
 * is gone, so a dead NFS mount must throw, never read as "no photos".
 */
describe('photo storage on disk', () => {
  let directory: string;
  let storage: PhotoStorage;
  let logs: ReturnType<typeof captureLogs>['logs'];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'closet-storage-'));
    const captured = captureLogs();
    logs = captured.logs;
    storage = new PhotoStorage(directory, captured.logger);
    storage.prepare();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const incoming = () => readdir(join(directory, '.incoming'));

  /** `chunks` pieces, `gapMs` apart: a write still arriving. */
  function slowStream(chunks: Buffer[], gapMs: number): Readable {
    return Readable.from(
      (async function* () {
        for (const chunk of chunks) {
          await new Promise((resolve) => setTimeout(resolve, gapMs));
          yield chunk;
        }
      })(),
    );
  }

  it('boots by removing partial writes abandoned over an hour ago, never a live one', async () => {
    await writeFile(join(directory, '.incoming', 'dead-a.webp'), 'partial');
    await writeFile(join(directory, '.incoming', 'live-b.webp'), 'arriving');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(
      join(directory, '.incoming', 'dead-a.webp'),
      twoHoursAgo,
      twoHoursAgo,
    );

    storage.prepare();

    expect(await incoming()).toEqual(['live-b.webp']);
    expect(logs.messages('warn')).toEqual([
      'Removed abandoned partial write dead-a.webp',
    ]);
  });

  it('never shows a reader a partial write: the old file whole until the new one is', async () => {
    const before = randomBytes(64 * 1024);
    await storage.store('a.webp', Readable.from([before]));
    const after = [randomBytes(64 * 1024), randomBytes(64 * 1024)];

    let stored = false;
    const writing = storage
      .store('a.webp', slowStream(after, 30))
      .then(() => (stored = true));
    const seen: Buffer[] = [];
    while (!stored) {
      const stream = await storage.get('a.webp');
      const chunks: Buffer[] = [];
      for await (const chunk of stream!) chunks.push(chunk as Buffer);
      seen.push(Buffer.concat(chunks));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await writing;

    // Every read got one of the two files whole; the ones made while the
    // new bytes were still arriving got the old file.
    const whole = Buffer.concat(after);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[0].equals(before)).toBe(true);
    for (const bytes of seen) {
      expect(bytes.equals(before) || bytes.equals(whole)).toBe(true);
    }
    expect((await readFile(join(directory, 'a.webp'))).equals(whole)).toBe(
      true,
    );
    expect(await incoming()).toEqual([]);
  });

  it('leaves the previous file and no temp file when a write fails midway', async () => {
    await storage.store('b.webp', Readable.from([Buffer.from('previous')]));
    const failing = Readable.from(
      (async function* () {
        yield Buffer.from('half a pho');
        await Promise.resolve();
        throw new Error('upload reset by peer');
      })(),
    );

    await expect(storage.store('b.webp', failing)).rejects.toThrow(
      'upload reset by peer',
    );

    expect(await readFile(join(directory, 'b.webp'), 'utf8')).toBe('previous');
    expect(await incoming()).toEqual([]);
  });

  it('streams a file whole that is deleted after it was opened', async () => {
    await storage.store('c.webp', Readable.from([Buffer.from('still here')]));

    const stream = await storage.get('c.webp');
    await storage.delete('c.webp');

    expect(await text(stream!)).toBe('still here');
    expect(await storage.get('c.webp')).toBeUndefined();
    expect(await storage.exists('c.webp')).toBe(false);
  });

  it('answers a missing file as absent, and deleting one as done', async () => {
    expect(await storage.get('never.webp')).toBeUndefined();
    expect(await storage.exists('never.webp')).toBe(false);
    await expect(storage.delete('never.webp')).resolves.toBeUndefined();
  });

  it('counts only files as objects: a directory is neither one nor listed', async () => {
    await storage.store('d.webp', Readable.from([Buffer.from('d')]));
    await mkdir(join(directory, 'not-a-photo'));

    expect(await storage.exists('d.webp')).toBe(true);
    expect(await storage.exists('not-a-photo')).toBe(false);
    expect(await storage.exists('.incoming')).toBe(false);
    const names: string[] = [];
    for await (const object of storage.list()) names.push(object.name);
    expect(names).toEqual(['d.webp']);
  });

  it('lists what is still there when files are deleted during the listing', async () => {
    const names = ['e1.webp', 'e2.webp', 'e3.webp', 'e4.webp'];
    for (const name of names) {
      await storage.store(name, Readable.from([Buffer.from(name)]));
    }

    // The directory is read once, before the first object; each is then
    // stat'ed as the caller asks. Deleting the rest after the first object
    // is the nightly reconciliation racing a garment deletion.
    const listed: string[] = [];
    let survivor: string | undefined;
    for await (const object of storage.list()) {
      if (listed.length === 0) {
        const others = names.filter((name) => name !== object.name);
        survivor = others[0];
        await Promise.all(
          others.slice(1).map((name) => unlink(join(directory, name))),
        );
      }
      listed.push(object.name);
      expect(object.lastModified).toBeInstanceOf(Date);
    }

    expect(listed).toEqual([listed[0], survivor]);
  });

  describe('when DATA_PATH is not a directory (a mount gone wrong)', () => {
    let broken: PhotoStorage;

    beforeEach(async () => {
      const notADirectory = join(directory, 'mount');
      await writeFile(notADirectory, 'a file where the photos should be');
      broken = new PhotoStorage(notADirectory, captureLogs().logger);
    });

    it('fails every read instead of answering "no such photo"', async () => {
      await expect(broken.get('f.webp')).rejects.toMatchObject({
        code: 'ENOTDIR',
      });
      await expect(broken.exists('f.webp')).rejects.toMatchObject({
        code: 'ENOTDIR',
      });
      await expect(
        broken.list()[Symbol.asyncIterator]().next(),
      ).rejects.toMatchObject({
        code: 'ENOTDIR',
      });
    });

    it('fails a delete instead of reporting it done', async () => {
      await expect(broken.delete('f.webp')).rejects.toMatchObject({
        code: 'ENOTDIR',
      });
    });
  });
});

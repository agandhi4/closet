import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureLogs } from '../../../test/support/log-capture';
import {
  HeicDecodeError,
  HeicDecoder,
  type HeicDecoderOptions,
} from './heic-decoder';

// Real threads: the real worker on libheif's own example image, and the
// stub (test/support/heic-stub-worker.ts) for what libheif cannot be made
// to do on cue: block, hang, crash, run out of heap.
const FIXTURE = join(__dirname, '../../../test/fixtures/example.heic');
const STUB = join(__dirname, '../../../test/support/heic-stub-worker.ts');

const decoders: HeicDecoder[] = [];
afterEach(async () => {
  await Promise.all(decoders.splice(0).map((decoder) => decoder.close()));
});

const build = (options: HeicDecoderOptions = {}) => {
  const { logger, logs } = captureLogs('debug');
  const decoder = new HeicDecoder(logger, options);
  decoders.push(decoder);
  return { decoder, logs };
};

/** A container the stub reads as its command. */
const command = (text: string) => () => Promise.resolve(Buffer.from(text));

const failureOf = (work: Promise<unknown>) =>
  work.then(
    () => undefined,
    (error: unknown) => (error as HeicDecodeError).reason,
  );

describe('HeicDecoder on the real worker', () => {
  it('decodes a real HEIC off the event loop, starting the thread without a warning', async () => {
    const container = await readFile(FIXTURE);
    const stderr = vi.spyOn(process.stderr, 'write');
    const { decoder } = build();

    const { width, height, pixels } = await decoder.decode(
      () => Promise.resolve(container),
      64_000_000,
    );

    expect(width).toBeGreaterThan(400);
    expect(pixels.byteLength).toBe(width * height * 4);
    // From src/ the thread runs heic-worker.ts under type stripping; its
    // module-type warning would be on every first upload in development.
    const written = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    stderr.mockRestore();
    expect(written).not.toContain('MODULE_TYPELESS_PACKAGE_JSON');
  }, 20_000);

  it('refuses more pixels than allowed from the container, then still decodes', async () => {
    const container = await readFile(FIXTURE);
    const { decoder } = build();

    await expect(
      failureOf(decoder.decode(() => Promise.resolve(container), 100)),
    ).resolves.toBe('too-large');
    await expect(
      failureOf(decoder.decode(command('not a heic container'), 64_000_000)),
    ).resolves.toBe('undecodable');
    await expect(
      decoder.decode(() => Promise.resolve(container), 64_000_000),
    ).resolves.toMatchObject({ width: expect.any(Number) as number });
  }, 20_000);
});

describe('HeicDecoder bounds', () => {
  it('terminates a decode past its deadline and decodes the next on a fresh thread', async () => {
    const { decoder, logs } = build({ workerPath: STUB, deadlineMs: 300 });

    await expect(failureOf(decoder.decode(command('hang'), 100))).resolves.toBe(
      'timeout',
    );
    await expect(decoder.decode(command('ok'), 100)).resolves.toMatchObject({
      width: 2,
      height: 2,
    });
    expect(logs.messages('warn')).toEqual([
      expect.stringMatching(/deadline .* terminated$/),
    ]);
  });

  it('answers a crashed thread as crashed, and the next decode works', async () => {
    const { decoder } = build({ workerPath: STUB });

    await expect(
      failureOf(decoder.decode(command('crash'), 100)),
    ).resolves.toBe('crashed');
    await expect(decoder.decode(command('ok'), 100)).resolves.toMatchObject({
      width: 2,
    });
  });

  it("answers a thread out of heap as crashed: resourceLimits bound it, not the server's", async () => {
    const { decoder, logs } = build({ workerPath: STUB });

    await expect(failureOf(decoder.decode(command('oom'), 100))).resolves.toBe(
      'crashed',
    );
    expect(logs.messagesWithError('error').join('\n')).toContain(
      'reaching memory limit',
    );
    await expect(decoder.decode(command('ok'), 100)).resolves.toMatchObject({
      width: 2,
    });
  }, 20_000);

  it("refuses a decode past the queue before reading it; one deadline covers a decode's wait and its run", async () => {
    const { decoder } = build({
      workerPath: STUB,
      maxWaiting: 1,
      deadlineMs: 400,
    });

    const running = failureOf(decoder.decode(command('hang'), 100));
    // Let the first be read and handed to the thread: it no longer waits.
    await new Promise((resolve) => setImmediate(resolve));
    const waiting = failureOf(decoder.decode(command('ok'), 100));
    await new Promise((resolve) => setImmediate(resolve));
    const read = vi.fn(command('ok'));

    await expect(failureOf(decoder.decode(read, 100))).resolves.toBe('busy');
    expect(read).not.toHaveBeenCalled();
    // One deadline from the queue: the waiting decode's covers its wait.
    await expect(running).resolves.toBe('timeout');
    await expect(waiting).resolves.toBe('timeout');
  });

  it('holds no place for an upload still sending its bytes', async () => {
    const { decoder } = build({ workerPath: STUB, maxWaiting: 1 });
    const stillSending = () => new Promise<Buffer>(() => undefined);
    for (let upload = 0; upload < 3; upload++) {
      void decoder.decode(stillSending, 100);
    }

    await expect(decoder.decode(command('ok'), 100)).resolves.toMatchObject({
      width: 2,
    });
  });

  it('rejects what is unanswered when closed', async () => {
    const { decoder } = build({ workerPath: STUB });
    const running = failureOf(decoder.decode(command('hang'), 100));
    await new Promise((resolve) => setImmediate(resolve));
    const waiting = failureOf(decoder.decode(command('ok'), 100));
    await new Promise((resolve) => setImmediate(resolve));

    await decoder.close();

    await expect(running).resolves.toBe('closed');
    await expect(waiting).resolves.toBe('closed');
    await expect(failureOf(decoder.decode(command('ok'), 100))).resolves.toBe(
      'closed',
    );
  });
});

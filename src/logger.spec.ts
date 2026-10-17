import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { LogCapture } from '../test/support/log-capture';
import { createLogger, createLoggerTo } from './logger';

describe('createLoggerTo', () => {
  it('never writes a credential header, whoever logs a request', () => {
    const logs = new LogCapture();
    const logger = createLoggerTo('info', logs);
    logger.info(
      {
        req: {
          headers: {
            cookie: 'access_token=cookie-secret',
            authorization: 'Bearer auth-secret',
            'user-agent': 'test',
          },
        },
        res: { headers: { 'set-cookie': 'access_token=set-secret' } },
      },
      'request',
    );
    const [record] = logs.records;
    expect(record.req).toEqual({
      headers: {
        cookie: '[redacted]',
        authorization: '[redacted]',
        'user-agent': 'test',
      },
    });
    expect(record.res).toEqual({ headers: { 'set-cookie': '[redacted]' } });
  });

  it('names the module on every line of a child, and keeps LOG_LEVEL', () => {
    const logs = new LogCapture();
    const photos = createLoggerTo('info', logs).child({ logger: 'Photos' });
    photos.debug('hidden');
    photos.info('shown');
    expect(logs.records).toEqual([
      expect.objectContaining({
        level: 'info',
        logger: 'Photos',
        msg: 'shown',
      }),
    ]);
  });
});

describe('the err serializer', () => {
  function loggedErr(error: unknown) {
    const logs = new LogCapture();
    createLoggerTo('info', logs).warn({ err: error }, 'failed');
    return logs.records[0].err;
  }

  it('redacts an upstream URL and key=value pairs, keeping file:// frames', () => {
    const cause = new Error(
      'connect ECONNREFUSED postgres://ci:hunter2@10.0.0.5/closet',
    );
    const error = Object.assign(
      new Error('GET https://api.example/v1?key=s3cret failed, token=abc', {
        cause,
      }),
      { code: 'E_UPSTREAM', status: 502, options: { key: 's3cret' } },
    );
    const err = loggedErr(error);
    const text = JSON.stringify(err);
    expect(text).not.toMatch(/s3cret|hunter2|abc/);
    expect(err).toEqual({
      type: 'Error',
      message: 'GET <url> failed, <param> connect ECONNREFUSED <url>',
      stack: expect.stringContaining(
        'caused by: Error: connect ECONNREFUSED <url>',
      ),
      code: 'E_UPSTREAM',
      status: 502,
    });
    expect(err?.stack).toMatch(/\(file:\/\/|\bat .*logger\.spec\.ts/);
  });

  it('cuts a long message and logs a thrown non-Error by its type alone', () => {
    expect(loggedErr(new Error('x'.repeat(300)))?.message).toBe(
      `${'x'.repeat(200)}…`,
    );
    expect(loggedErr('upstream body text')).toEqual({ type: 'string' });
  });
});

describe('the line shape', () => {
  it('writes ts (RFC 3339 UTC), the level by name, the version and the logger', () => {
    const lines: string[] = [];
    const logger = createLoggerTo(
      'info',
      { write: (line: string) => lines.push(line) },
      'abc1234',
    );
    logger.child({ logger: 'Photos' }).warn({ count: 2 }, 'shown');
    expect(JSON.parse(lines[0])).toEqual({
      ts: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
      level: 'warn',
      version: 'abc1234',
      logger: 'Photos',
      count: 2,
      msg: 'shown',
    });
  });
});

describe('createLogger', () => {
  // app.log is written by a worker thread: wait for the line to land.
  async function appLogOf(format: 'json' | 'text'): Promise<string> {
    const dataPath = await mkdtemp(join(tmpdir(), 'closet-logger-'));
    try {
      const logger = createLogger({
        LOG_LEVEL: 'info',
        LOG_FORMAT: format,
        DATA_PATH: dataPath,
        APP_VERSION: 'abc1234',
      });
      logger.child({ logger: 'Spec' }).info('format check');
      for (let waited = 0; waited < 5000; waited += 50) {
        const text = await readFile(join(dataPath, 'app.log'), 'utf8').catch(
          () => '',
        );
        if (text.includes('format check')) return text;
        await sleep(50);
      }
      throw new Error(`app.log never got the ${format} line`);
    } finally {
      await rm(dataPath, { recursive: true, force: true });
    }
  }

  it('writes one JSON object per line with LOG_FORMAT=json (production)', async () => {
    const [line] = (await appLogOf('json')).trim().split('\n');
    expect(JSON.parse(line)).toMatchObject({
      level: 'info',
      version: 'abc1234',
      logger: 'Spec',
      msg: 'format check',
    });
  });

  it('writes pretty lines with LOG_FORMAT=text (a terminal)', async () => {
    const text = await appLogOf('text');
    expect(text).toMatch(/INFO.*format check/);
    expect(() => JSON.parse(text.trim())).toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { LogCapture } from '../test/support/log-capture';
import { createLoggerTo } from './logger';

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
    const photos = createLoggerTo('info', logs).child({ context: 'Photos' });
    photos.debug('hidden');
    photos.info('shown');
    expect(logs.records).toEqual([
      expect.objectContaining({
        level: 'info',
        context: 'Photos',
        msg: 'shown',
      }),
    ]);
  });
});

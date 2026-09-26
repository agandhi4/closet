import pino from 'pino';

/** For specs that call a plain module directly and do not assert its logs. */
export const silentLogger = pino({ level: 'silent' });

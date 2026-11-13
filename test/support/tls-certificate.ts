import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

/**
 * A throwaway self-signed certificate (ECDSA P-256, one hour back to one
 * day ahead) for the fake sites' TLS servers, built in-process so no key is
 * committed and no spec shells out to an `openssl` whose flags differ by
 * platform. The fetcher trusts one only through its specs-only `tls.ca`
 * option (outbound-fetch.ts): a self-signed certificate in `ca` is its own
 * trust anchor, and one left out of it is untrusted, as on the internet.
 */
export interface TestCertificate {
  /** PEM, for the server's `cert` and the fetcher's `tls.ca`. */
  cert: string;
  /** PEM (PKCS#8), for the server's `key`. */
  key: string;
}

export function selfSignedCertificate(
  names: readonly string[],
): TestCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });
  const name = sequence(set(sequence(oid('2.5.4.3'), utf8(names[0]))));
  const now = Date.now();
  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))), // v3
    integer(serialNumber()),
    sequence(oid(ECDSA_WITH_SHA256)),
    name, // issuer: self-signed
    sequence(utcTime(now - HOUR_MS), utcTime(now + DAY_MS)),
    name, // subject
    publicKey,
    tlv(
      0xa3,
      sequence(
        sequence(
          oid('2.5.29.17'), // subjectAltName
          tlv(
            0x04,
            sequence(
              ...names.map((dns) => tlv(0x82, Buffer.from(dns, 'ascii'))),
            ),
          ),
        ),
      ),
    ),
  );
  const der = sequence(
    tbs,
    sequence(oid(ECDSA_WITH_SHA256)),
    // An ECDSA signature is DER already; a BIT STRING leads with its unused bits.
    tlv(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey)),
  );
  return {
    cert: pem(der),
    key: privateKey,
  };
}

const ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function tlv(tag: number, ...contents: Buffer[]): Buffer {
  const body = Buffer.concat(contents);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest % 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const sequence = (...items: Buffer[]) => tlv(0x30, ...items);
const set = (...items: Buffer[]) => tlv(0x31, ...items);
const utf8 = (text: string) => tlv(0x0c, Buffer.from(text, 'utf8'));

/** A non-negative INTEGER: a leading 0 when the high bit is set. */
function integer(value: Buffer): Buffer {
  return tlv(
    0x02,
    value[0] & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value,
  );
}

function serialNumber(): Buffer {
  const serial = randomBytes(8);
  serial[0] = (serial[0] & 0x7f) | 0x01; // positive, no leading zero byte
  return serial;
}

function oid(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const base128 = [arc & 0x7f];
    for (let n = arc >>> 7; n > 0; n >>>= 7) base128.unshift((n & 0x7f) | 0x80);
    bytes.push(...base128);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** UTCTime, YYMMDDHHMMSSZ: valid through 2049, which a day-long cert is. */
function utcTime(epochMs: number): Buffer {
  const at = new Date(epochMs);
  const text = [
    at.getUTCFullYear() % 100,
    at.getUTCMonth() + 1,
    at.getUTCDate(),
    at.getUTCHours(),
    at.getUTCMinutes(),
    at.getUTCSeconds(),
  ]
    .map((part) => String(part).padStart(2, '0'))
    .join('');
  return tlv(0x17, Buffer.from(`${text}Z`, 'ascii'));
}

function pem(der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

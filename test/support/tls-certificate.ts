import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

/**
 * A throwaway self-signed certificate (ECDSA P-256, valid from 2000 with no
 * expiry: VALIDITY) for the fake sites' TLS servers, built in-process so no
 * key is committed and no spec shells out to an `openssl` whose flags differ
 * by platform. The fetcher trusts one only through its specs-only `tls.ca`
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
  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))), // v3
    integer(serialNumber()),
    sequence(oid(ECDSA_WITH_SHA256)),
    name, // issuer: self-signed
    VALIDITY,
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

/**
 * Fixed, never read from `Date`: OpenSSL checks the window against the real
 * clock while the gate's clock-shift jobs move the JS one a year ahead (test/AGENTS.md),
 * so a window dated from `Date.now()` was "not yet valid" there. notBefore
 * 2000-01-01 as UTCTime; notAfter RFC 5280's "no well-defined expiration"
 * (4.1.2.5), 9999-12-31 23:59:59 as GeneralizedTime.
 */
const VALIDITY = sequence(
  tlv(0x17, Buffer.from('000101000000Z', 'ascii')),
  tlv(0x18, Buffer.from('99991231235959Z', 'ascii')),
);

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

function pem(der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

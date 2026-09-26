import { isIPv4, isIPv6 } from 'node:net';

/**
 * Whether an IP address is on the public internet, the only kind the server
 * may connect to on a user's behalf (outbound-fetch.ts, the link import).
 * The server sits on the homelab LAN beside the NAS, pgvault, the router and
 * the tailnet, so anything that is not globally reachable is refused, not
 * just RFC 1918: loopback, link-local (cloud metadata lives at
 * 169.254.169.254), 100.64/10 (Tailscale), multicast, documentation and
 * reserved ranges. IPv6 is an allow-list (global unicast, 2000::/3) minus its
 * special blocks, and every IPv6 form that carries an IPv4 address
 * (IPv4-mapped, NAT64, 6to4) is judged by that IPv4 address, so
 * `::ffff:127.0.0.1` is loopback. Anything that is not an IP address, and a
 * scoped IPv6 address (`fe80::1%eth0`), is refused.
 *
 * Source: the IANA IPv4 and IPv6 Special-Purpose Address Registries.
 */
export function isPublicAddress(address: string): boolean {
  if (isIPv4(address)) return isPublicIPv4(ipv4Bytes(address));
  if (isIPv6(address) && !address.includes('%')) {
    return isPublicIPv6(ipv6Bytes(address));
  }
  return false;
}

type Prefix = readonly [bytes: readonly number[], length: number];

const BLOCKED_IPV4: readonly Prefix[] = [
  [[0, 0, 0, 0], 8], // "this network"
  [[10, 0, 0, 0], 8], // RFC 1918
  [[100, 64, 0, 0], 10], // shared address space (CGNAT, Tailscale)
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local, cloud metadata
  [[172, 16, 0, 0], 12], // RFC 1918
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2, 0], 24], // TEST-NET-1
  [[192, 88, 99, 0], 24], // 6to4 relay anycast
  [[192, 168, 0, 0], 16], // RFC 1918
  [[198, 18, 0, 0], 15], // benchmarking
  [[198, 51, 100, 0], 24], // TEST-NET-2
  [[203, 0, 113, 0], 24], // TEST-NET-3
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved, and the broadcast address
];

// Only 2000::/3 (global unicast) is ever public; inside it these are not.
const GLOBAL_UNICAST: Prefix = [[0x20], 3];
const BLOCKED_IPV6: readonly Prefix[] = [
  [[0x20, 0x01, 0x00], 23], // IETF protocol assignments (Teredo, ORCHID, ...)
  [[0x20, 0x01, 0x0d, 0xb8], 32], // documentation
  [[0x3f, 0xff, 0x00], 20], // documentation (RFC 9637)
];

// IPv6 forms that carry an IPv4 address, and where it sits.
const EMBEDDED_IPV4: readonly (readonly [Prefix, offset: number])[] = [
  [[[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96], 12], // IPv4-mapped
  [[[0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96], 12], // NAT64
  [[[0x20, 0x02], 16], 2], // 6to4
];

function isPublicIPv4(bytes: readonly number[]): boolean {
  return !BLOCKED_IPV4.some((prefix) => inPrefix(bytes, prefix));
}

function isPublicIPv6(bytes: readonly number[]): boolean {
  for (const [prefix, offset] of EMBEDDED_IPV4) {
    if (inPrefix(bytes, prefix)) {
      return isPublicIPv4(bytes.slice(offset, offset + 4));
    }
  }
  return (
    inPrefix(bytes, GLOBAL_UNICAST) &&
    !BLOCKED_IPV6.some((prefix) => inPrefix(bytes, prefix))
  );
}

function inPrefix(bytes: readonly number[], [prefix, length]: Prefix): boolean {
  for (let bit = 0; bit < length; bit += 8) {
    const byte = bit >> 3;
    const bits = Math.min(8, length - bit);
    const mask = (0xff << (8 - bits)) & 0xff;
    if ((bytes[byte] & mask) !== ((prefix[byte] ?? 0) & mask)) return false;
  }
  return true;
}

function ipv4Bytes(address: string): number[] {
  return address.split('.').map(Number);
}

/** The 16 bytes of an address `isIPv6` accepted (no zone). */
function ipv6Bytes(address: string): number[] {
  let text = address;
  // A trailing dotted quad (`::ffff:1.2.3.4`) is the last two groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = ipv4Bytes(dotted[1]);
    const tail = `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    text = text.slice(0, dotted.index) + tail;
  }
  const [head, rest] = text.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = rest ? rest.split(':') : [];
  const zeros = new Array<string>(
    8 - headGroups.length - tailGroups.length,
  ).fill('0');
  const groups =
    rest === undefined ? headGroups : [...headGroups, ...zeros, ...tailGroups];
  return groups.flatMap((group) => {
    const value = parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

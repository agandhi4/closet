import { describe, expect, it } from 'vitest';
import { isPublicAddress } from './public-address';

describe('isPublicAddress', () => {
  it.each([
    '93.184.215.14',
    '8.8.8.8',
    '1.1.1.1',
    '151.101.1.140',
    '100.63.255.255', // just below 100.64/10
    '100.128.0.0', // just above it
    '172.15.255.255', // just below 172.16/12
    '172.32.0.0', // just above it
    '2606:4700:4700::1111',
    '2a00:1450:4001:82a::200e',
    '::ffff:93.184.215.14', // IPv4-mapped public
    '64:ff9b::808:808', // NAT64 of 8.8.8.8
    '2002:5db8:d70e::1', // 6to4 of 93.184.215.14
  ])('lets %s through', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    ['this network', '0.0.0.0'],
    ['this network', '0.1.2.3'],
    ['RFC 1918', '10.0.0.1'],
    ['RFC 1918', '10.255.255.255'],
    ['RFC 1918', '172.16.0.1'],
    ['RFC 1918', '172.31.255.254'],
    ['RFC 1918', '192.168.1.20'], // topology example
    ['CGNAT / Tailscale', '100.64.0.1'], // topology example
    ['CGNAT / Tailscale', '100.100.100.100'], // topology example
    ['CGNAT / Tailscale', '100.127.255.255'], // topology example
    ['loopback', '127.0.0.1'],
    ['loopback', '127.1.2.3'],
    ['link-local (cloud metadata)', '169.254.169.254'],
    ['IETF protocol assignments', '192.0.0.8'],
    ['TEST-NET-1', '192.0.2.1'],
    ['6to4 relay anycast', '192.88.99.1'],
    ['benchmarking', '198.18.0.1'],
    ['TEST-NET-2', '198.51.100.1'],
    ['TEST-NET-3', '203.0.113.1'],
    ['multicast', '224.0.0.1'],
    ['multicast', '239.255.255.250'],
    ['reserved', '240.0.0.1'],
    ['broadcast', '255.255.255.255'],
    ['IPv6 unspecified', '::'],
    ['IPv6 loopback', '::1'],
    ['IPv6 loopback, long form', '0:0:0:0:0:0:0:1'],
    ['IPv4-compatible IPv6', '::127.0.0.1'],
    ['IPv6 ULA', 'fd00::1'],
    ['IPv6 ULA', 'fc00::1'],
    ['IPv6 link-local', 'fe80::1'],
    ['IPv6 link-local with a zone', 'fe80::1%eth0'],
    ['IPv6 site-local', 'fec0::1'],
    ['IPv6 multicast', 'ff02::1'],
    ['IPv6 documentation', '2001:db8::1'],
    ['IPv6 documentation (RFC 9637)', '3fff::1'],
    ['Teredo', '2001:0:4136:e378:8000:63bf:3fff:fdd2'],
    ['IPv6 discard', '100::1'],
    ['NAT64 local use', '64:ff9b:1::1'],
    ['outside global unicast', '4000::1'],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1'],
    ['IPv4-mapped loopback, hex form', '::ffff:7f00:1'],
    ['IPv4-mapped RFC 1918', '::ffff:10.0.0.1'],
    ['IPv4-mapped RFC 1918, hex form', '::ffff:c0a8:8ad'],
    ['IPv4-mapped link-local', '::ffff:169.254.169.254'],
    ['IPv4-mapped CGNAT', '::ffff:100.64.0.1'], // topology example
    ['IPv4-mapped, long form', '0:0:0:0:0:ffff:7f00:1'],
    ['NAT64 of loopback', '64:ff9b::7f00:1'],
    ['NAT64 of RFC 1918', '64:ff9b::10.0.0.1'],
    ['6to4 of RFC 1918', '2002:c0a8:0101::1'],
    ['6to4 of loopback', '2002:7f00:1::'],
  ])('refuses %s (%s)', (_label, address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    '',
    'localhost',
    'example.com',
    '1.2.3',
    '1.2.3.4.5',
    '::g',
    '[::1]',
  ])('refuses %j, which is not an IP address', (value) => {
    expect(isPublicAddress(value)).toBe(false);
  });
});

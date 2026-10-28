// Which IP addresses outbound requests may reach (FR-HUB-5 AC3, T11). Only
// public unicast addresses pass. IPv6 forms that embed an IPv4 address
// (mapped, compatible, NAT64, 6to4) are judged by the embedded address.
import { BlockList, isIP } from 'node:net';

const v4 = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. broadcast
] as const) {
  v4.addSubnet(net, bits, 'ipv4');
}

const v6 = new BlockList();
for (const [net, bits] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
  ['2001:db8::', 32], // documentation
  ['100::', 64], // discard
] as const) {
  v6.addSubnet(net, bits, 'ipv6');
}

/** 16 bytes of a valid IPv6 address (with an optional trailing dotted quad). */
export function ipv6Bytes(addr: string): number[] {
  let text = addr.toLowerCase();
  const tail: number[] = [];
  const quad = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (quad?.[1]) {
    tail.push(...quad[1].split('.').map(Number));
    text = `${text.slice(0, -quad[1].length)}0:0`;
  }
  const [head = '', rest] = text.split('::');
  const groups = (s: string) => (s === '' ? [] : s.split(':'));
  const left = groups(head);
  const right = rest === undefined ? [] : groups(rest);
  const fill = 8 - left.length - right.length;
  const all = [...left, ...Array<string>(rest === undefined ? 0 : fill).fill('0'), ...right];
  const bytes = all.flatMap((g) => {
    const n = parseInt(g, 16);
    return [(n >> 8) & 0xff, n & 0xff];
  });
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}

const dotted = (b: readonly number[]) => b.join('.');

/** The IPv4 address embedded in an IPv6 address, if it is one of the embedding forms. */
export function embeddedIpv4(addr: string): string | null {
  const b = ipv6Bytes(addr);
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return dotted(b.slice(12)); // ::ffff:a.b.c.d (mapped)
  if (zero(0, 12) && !zero(12, 16)) return dotted(b.slice(12)); // ::a.b.c.d (compatible)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return dotted(b.slice(12)); // NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return dotted(b.slice(2, 6)); // 6to4
  return null;
}

/** True when `address` (an IP literal) must not be contacted; anything that is not an IP is blocked. */
export function isBlockedAddress(address: string): boolean {
  const a = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = isIP(a);
  if (family === 4) return v4.check(a, 'ipv4');
  if (family === 6) {
    const inner = embeddedIpv4(a);
    if (inner !== null) return v4.check(inner, 'ipv4');
    return v6.check(a, 'ipv6');
  }
  return true;
}

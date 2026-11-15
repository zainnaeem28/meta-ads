import { BlockList, isIP } from 'node:net';

/** Every range an allow-listed provider host must never resolve to (private, loopback, link-local, metadata, reserved). */
const blocked = new BlockList();
const V4: readonly [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const V6: readonly [string, number][] = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];
for (const [net, prefix] of V4) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of V6) blocked.addSubnet(net, prefix, 'ipv6');
blocked.addAddress('169.254.169.254', 'ipv4');
blocked.addAddress('fd00:ec2::254', 'ipv6');

/** `::ffff:a.b.c.d` or `::ffff:aabb:ccdd` (and the deprecated `::a.b.c.d`) carry an IPv4 address; null otherwise. */
function embeddedV4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted?.[1] !== undefined) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex?.[1] !== undefined && hex[2] !== undefined) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return null;
}

/** True when the address must not be connected to. Anything that is not a valid IP literal counts as blocked. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 4) return blocked.check(address, 'ipv4');
  const v4 = embeddedV4(address);
  if (v4 !== null && isIP(v4) === 4) return blocked.check(v4, 'ipv4');
  return blocked.check(address, 'ipv6');
}

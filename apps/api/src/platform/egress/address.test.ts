import { describe, expect, it } from 'vitest';
import { isBlockedAddress } from './address.js';

describe('isBlockedAddress (TC-EGR-01)', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '172.16.5.4',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd00:ec2::254',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.5',
    '::ffff:a9fe:a9fe',
    '64:ff9b::7f00:1',
    '2002:7f00:1::1',
    'ff02::1',
    'not-an-ip',
    '',
  ])('blocks %s', (address) => expect(isBlockedAddress(address)).toBe(true));

  it.each(['8.8.8.8', '104.18.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'allows %s',
    (address) => expect(isBlockedAddress(address)).toBe(false),
  );
});

import { describe, expect, it } from 'vitest';
import {
  campaignKey,
  isOwnedKey,
  ownerPrefixes,
  quarantineKey,
  smokeKey,
  uploadKey,
} from './keys.js';

const OWNER = '0197a1b2-0000-7000-8000-000000000001';
const OTHER = '0197a1b2-0000-7000-8000-000000000002';
const MEDIA = '0197a1b2-0000-7000-8000-0000000000a1';
const CAMPAIGN = '0197a1b2-0000-7000-8000-0000000000c1';

describe('storage keys', () => {
  it('builds each key from server-side ids only', () => {
    expect(quarantineKey(OWNER, MEDIA)).toBe(`q/${OWNER}/${MEDIA}`);
    expect(uploadKey(OWNER, MEDIA)).toBe(`u/${OWNER}/media/${MEDIA}`);
    expect(campaignKey(OWNER, CAMPAIGN, 'final', MEDIA, 'mp4')).toBe(
      `u/${OWNER}/c/${CAMPAIGN}/final/${MEDIA}.mp4`,
    );
    expect(smokeKey(MEDIA)).toBe(`smoke/${MEDIA}`);
  });

  it.each(['../x', 'a/b', '', 'not-a-uuid', `${OWNER}/..`, OWNER.toUpperCase()])(
    'refuses %j as an identifier (no client path reaches a key)',
    (bad) => {
      expect(() => quarantineKey(bad, MEDIA)).toThrow(TypeError);
      expect(() => uploadKey(OWNER, bad)).toThrow(TypeError);
      expect(() => smokeKey(bad)).toThrow(TypeError);
      expect(() => campaignKey(OWNER, bad, 'clip', MEDIA, 'mp4')).toThrow(TypeError);
    },
  );

  it('refuses a kind that is not generated and an unsafe extension', () => {
    expect(() => campaignKey(OWNER, CAMPAIGN, 'upload' as never, MEDIA, 'mp4')).toThrow(TypeError);
    for (const ext of ['', 'MP4', 'mp4/..', 'toolong', 'a.b']) {
      expect(() => campaignKey(OWNER, CAMPAIGN, 'clip', MEDIA, ext)).toThrow(TypeError);
    }
  });

  it('knows which keys an owner holds', () => {
    expect(ownerPrefixes(OWNER)).toEqual([`q/${OWNER}/`, `u/${OWNER}/`]);
    expect(isOwnedKey(OWNER, quarantineKey(OWNER, MEDIA))).toBe(true);
    expect(isOwnedKey(OWNER, uploadKey(OWNER, MEDIA))).toBe(true);
    expect(isOwnedKey(OWNER, uploadKey(OTHER, MEDIA))).toBe(false);
    expect(isOwnedKey(OWNER, smokeKey(MEDIA))).toBe(false);
    expect(isOwnedKey('bad', 'q/bad/x')).toBe(false);
  });
});

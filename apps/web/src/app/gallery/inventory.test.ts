import { describe, expect, it } from 'vitest';
import { INVENTORY, LIVE_IDS, SHEETS } from './inventory';

describe('gallery inventory (UI-UX §6)', () => {
  it('lists the 32 live CMP IDs, none reserved or unassigned', () => {
    expect(LIVE_IDS).toHaveLength(32);
    expect(LIVE_IDS).not.toContain('CMP-009');
    expect(LIVE_IDS).not.toContain('CMP-029');
    expect(INVENTORY.map((e) => e.id)).toEqual(LIVE_IDS);
  });

  it('gives every component a sheet, an anchor and at least one state, each with a selector', () => {
    for (const entry of INVENTORY) {
      expect(SHEETS, entry.id).toContain(entry.sheet);
      expect(entry.anchor, entry.id).not.toBe('');
      expect(entry.states.length, entry.id).toBeGreaterThan(0);
      for (const st of entry.states) expect(st.selector, `${entry.id} ${st.state}`).not.toBe('');
      expect(
        new Set(entry.states.map((st) => st.state)).size,
        `${entry.id} duplicate state names`,
      ).toBe(entry.states.length);
    }
  });

  it('puts the four sheets in the spec on the components UI-UX §6 names', () => {
    const on = (sheet: string) => INVENTORY.filter((e) => e.sheet === sheet).map((e) => e.id);
    expect(on('CMP-SHEET-04')).toEqual(['CMP-001']);
    expect(on('CMP-SHEET-01')).toEqual([
      'CMP-002',
      'CMP-003',
      'CMP-004',
      'CMP-005',
      'CMP-006',
      'CMP-007',
      'CMP-008',
      'CMP-010',
      'CMP-024',
    ]);
    expect(on('CMP-SHEET-02')).toEqual([
      'CMP-011',
      'CMP-012',
      'CMP-014',
      'CMP-015',
      'CMP-016',
      'CMP-017',
      'CMP-018',
      'CMP-019',
    ]);
    expect(on('CMP-SHEET-03')).toEqual([
      'CMP-013',
      'CMP-020',
      'CMP-021',
      'CMP-022',
      'CMP-023',
      'CMP-025',
      'CMP-026',
      'CMP-027',
      'CMP-028',
    ]);
  });
});

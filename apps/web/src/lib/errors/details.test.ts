import { describe, expect, it } from 'vitest';
import { mapErrorDetails } from './details';

const controls = {
  'segments.*.dialogue': (n: number[]) => ({
    id: `dialogue-${n[0]}`,
    label: `Segment ${n[0]} dialogue`,
  }),
  calloutText: { id: 'callout', label: 'Call-out text' },
};

describe('mapErrorDetails (UI-UX §9.1 details[] rules)', () => {
  it('maps a path to its control, numbers segments from 1, shows the server message and never the detail code', () => {
    const mapped = mapErrorDetails(
      [
        {
          field: 'segments.1.dialogue',
          code: 'too_long',
          message: 'Keep it under 200 characters.',
        },
        { field: 'calloutText', code: 'claim_rule', message: 'Remove the health claim.' },
      ],
      controls,
    );
    expect(mapped.fieldErrors).toEqual({
      'dialogue-2': 'Keep it under 200 characters.',
      callout: 'Remove the health claim.',
    });
    expect(mapped.entries.map((e) => e.target?.label)).toEqual([
      'Segment 2 dialogue',
      'Call-out text',
    ]);
    expect(JSON.stringify(mapped)).not.toContain('too_long');
    expect(mapped.entries.map((e) => e.message).join(' ')).not.toContain('segments.1');
  });

  it('lists an entry with no visible control, or an unknown path, in the summary only', () => {
    const mapped = mapErrorDetails(
      [{ field: 'nope.0', code: 'x', message: 'Not on screen.' }],
      controls,
    );
    expect(mapped.fieldErrors).toEqual({});
    expect(mapped.entries).toHaveLength(1);
    expect(mapped.entries[0]!.target).toBeUndefined();
    expect(mapped.entries[0]!.message).toBe('Not on screen.');
  });

  it('does not treat a pattern as a prefix and escapes path dots', () => {
    const mapped = mapErrorDetails(
      [{ field: 'segmentsX1Xdialogue', code: 'x', message: 'm' }],
      controls,
    );
    expect(mapped.entries[0]!.target).toBeUndefined();
    expect(
      mapErrorDetails([{ field: 'segments.1.dialogue.extra', code: 'x', message: 'm' }], controls)
        .entries[0]!.target,
    ).toBeUndefined();
  });

  it('shows nothing for a 5xx (rule h)', () => {
    expect(
      mapErrorDetails([{ field: 'calloutText', code: 'x', message: 'm' }], controls, false),
    ).toEqual({
      entries: [],
      fieldErrors: {},
    });
  });
});

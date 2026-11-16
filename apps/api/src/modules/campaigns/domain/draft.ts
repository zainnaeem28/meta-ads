import { DomainError } from '../../../platform/http/domain-error.js';

// The draft record and its rules (ARCHITECTURE §3.3, §5.3; SB-D1, SB-D13). Completeness is checked at submit, not here:
// while drafting every field may be missing, and `null` clears one.

export const SEGMENT_SECONDS = 15;

export interface Audience {
  readonly ageMin?: number;
  readonly ageMax?: number;
  readonly gender?: 'all' | 'female' | 'male';
  readonly interests?: readonly string[];
}

export interface Direction {
  readonly goal?: 'awareness' | 'conversion' | 'retention';
  readonly tone?: string;
  readonly segmentCount?: number;
}

export interface DraftRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly version: number;
  readonly step: number;
  readonly adStyle: 'ugc';
  readonly intakeMode: 'description' | 'script';
  readonly productName: string | null;
  readonly productDescription: string | null;
  readonly audience: Audience | null;
  readonly direction: Direction | null;
  readonly concept: string | null;
  readonly script: string | null;
  readonly productMediaId: string | null;
  readonly campaignId: string | null;
  /** PostgreSQL timestamptz text with microseconds, e.g. `2026-11-15 23:53:22.123456+00`. */
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The fields a create or a patch may set: absent leaves a field alone, `null` clears it. */
export interface DraftFields {
  readonly step?: number;
  readonly adStyle?: 'ugc';
  readonly intakeMode?: 'description' | 'script';
  readonly productName?: string | null;
  readonly productDescription?: string | null;
  readonly audience?: Audience | null;
  readonly direction?: Direction | null;
  readonly concept?: string | null;
  readonly script?: string | null;
  readonly productMediaId?: string | null;
}

/** `segmentCount` x 15 seconds (REQ-005): 1 gives 15, 4 gives 60. */
export function durationSeconds(direction: Direction | null): number | null {
  const count = direction?.segmentCount;
  return count === undefined ? null : count * SEGMENT_SECONDS;
}

/** The maximum age may not be below the minimum; both are optional while drafting. */
export function assertAudience(audience: Audience | null | undefined): void {
  if (audience === null || audience === undefined) return;
  const { ageMin, ageMax } = audience;
  if (ageMin !== undefined && ageMax !== undefined && ageMax < ageMin) {
    throw new DomainError('validation_failed', 'The request is not valid.', [
      { field: 'audience.ageMax', code: 'out_of_range', message: 'Must be at least the minimum age.' },
    ]);
  }
}

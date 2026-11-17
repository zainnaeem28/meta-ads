import type { Classification } from '../../../../platform/egress/index.js';

// TextAIPort (ARCHITECTURE §1.3): the brief's text and vision calls behind one port. The key travels as a Buffer the
// caller zeroes; the port never logs or stores it. The one adapter is OpenAI's (`infrastructure/openai-text-ai.ts`).

export const TEXT_AI_PORT = Symbol('TEXT_AI_PORT');

/** The owner's unsealed provider key for one call. */
export interface ProviderCredential {
  readonly apiKey: Buffer;
}

export interface BriefInput {
  readonly productName: string;
  readonly productDescription: string;
  readonly audience: {
    readonly ageMin: number | null;
    readonly ageMax: number | null;
    readonly gender: string | null;
    readonly interests: readonly string[];
  };
  readonly direction: { readonly goal: string | null; readonly tone: string | null };
  readonly segmentCount: number;
  readonly mode: 'description' | 'script';
  /** The concept (description mode) or the script (script mode). */
  readonly source: string;
  /** The exact call to action the last segment must carry. */
  readonly callToAction: string;
}

export interface DraftSegment {
  readonly position: number;
  readonly dialogue: string;
  readonly prompt: string;
}

export interface BriefDraft {
  readonly segments: readonly DraftSegment[];
}

export interface TextAIPort {
  /** Call 1 of a brief generation: one segment per position `1..input.segmentCount`. */
  generateBrief(credential: ProviderCredential, input: BriefInput): Promise<BriefDraft>;
  /** Call 2: the same segments with each dialogue at or under `maxWords` (prompt untouched). */
  shortenSegments(
    credential: ProviderCredential,
    segments: readonly DraftSegment[],
    maxWords: number,
  ): Promise<readonly DraftSegment[]>;
  /** Describes the product in the image; the bytes go inline in the request, never as a URL (REQ-020, TD-D26). */
  describeProduct(
    credential: ProviderCredential,
    imageBytes: Buffer,
    contentType: string,
  ): Promise<string>;
}

/** The provider answered but the body is not the JSON the schema asks for. The call was made and is billed. */
export class ProviderInvalidResponse extends Error {
  constructor(readonly reason: string) {
    super(`provider returned an invalid response: ${reason}`);
    this.name = 'ProviderInvalidResponse';
  }
}

/** The call failed; `classification` is the ARCHITECTURE §5.10 row (cause class, usage effect, auth failure). */
export class ProviderCallFailed extends Error {
  constructor(readonly classification: Classification) {
    super(`provider call failed: ${classification.causeClass}`);
    this.name = 'ProviderCallFailed';
  }
}

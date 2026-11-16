/** Domain vocabulary of the usage module (ARCHITECTURE §5.9, SB v6 §3.3). Framework-free. */

export const PROVIDERS = ['openai', 'wavespeed', 'assembly_vendor'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const JOB_TYPES = [
  'brief_generation',
  'image_analysis',
  'video',
  'qc',
  'thumbstopper',
  'assembly',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

/** `unconfirmed` is the unknown outcome of SB-D9: the estimate stays counted until the provider says otherwise. */
export type UsageOutcome = 'succeeded' | 'failed' | 'rejected' | 'unconfirmed';
export type CostBasis = 'estimate' | 'zero_rejected' | 'unconfirmed_estimate';

/** One paid provider call: the price-table key the estimate is looked up with. */
export interface BillableCall {
  readonly provider: Provider;
  /** The price-table operation key: the configured model, or the vendor operation. */
  readonly operation: string;
}

/** The price a call is estimated at (a price-table row effective now). */
export interface PriceRow {
  readonly provider: Provider;
  readonly operation: string;
  /** `YYYY-MM-DD` (UTC). */
  readonly effectiveFrom: string;
  readonly unit: string;
  readonly unitPriceUsd: string;
  readonly unitsPerCall: string;
}

/** A configured model or operation has no price row effective now (TD-D39): never an uncosted paid call. */
export class PriceMissingError extends Error {
  constructor(readonly call: BillableCall) {
    super(`no price row is effective now for ${call.provider} ${call.operation}`);
    this.name = 'PriceMissingError';
  }
}

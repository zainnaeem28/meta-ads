/** ARCHITECTURE 5.10: one classification function used by every provider adapter. */
export type CauseClass =
  | 'configuration'
  | 'credit'
  | 'temporary'
  | 'outcome_unknown'
  | 'provider_timeout'
  | 'output_unreachable'
  | 'reference_unreachable';

/** What the usage event of the call becomes: no call, rejected with zero usage, unconfirmed, or the submit event stands. */
export type UsageEffect = 'none' | 'rejected_zero' | 'unconfirmed' | 'submit_stands' | 'not_applicable';

export type ProviderFailure =
  | { kind: 'http'; status: number; errorCode?: string | undefined }
  | { kind: 'transport'; phase: 'before_send' | 'after_send' }
  | { kind: 'poll_failed'; authError?: boolean | undefined }
  | { kind: 'poll_timeout' }
  | {
      kind: 'output';
      problem: 'unreachable' | 'wrong_type' | 'too_large' | 'disallowed_host';
      /** Unreachable output is only final once the copy window has passed. */
      copyWindowPassed?: boolean | undefined;
    }
  | { kind: 'reference_unreachable' };

export interface Classification {
  causeClass: CauseClass;
  /** Text naming the cause for the user; absent where the table gives none. Never carries a provider body. */
  message?: string;
  countsAsAuthFailure: boolean;
  /** 429 before acceptance counts toward the 401/429 alert. */
  countsTowardRateAlert: boolean;
  usageEvent: UsageEffect;
  /** False only for an unreachable output inside the copy window (the copy is retried). */
  final: boolean;
}

const CREDIT_CODES = /^(insufficient_quota|project_spend_limit_exceeded|insufficient[_ ]?(balance|credit|credits|funds))$/i;

function make(
  causeClass: CauseClass,
  usageEvent: UsageEffect,
  extra: Partial<Classification> = {},
): Classification {
  return {
    causeClass,
    countsAsAuthFailure: false,
    countsTowardRateAlert: false,
    usageEvent,
    final: true,
    ...extra,
  };
}

export function classifyProviderFailure(provider: string, failure: ProviderFailure): Classification {
  switch (failure.kind) {
    case 'http': {
      const { status, errorCode } = failure;
      if (status === 401) {
        return make('configuration', 'rejected_zero', {
          message: `your ${provider} key was not accepted`,
          countsAsAuthFailure: true,
        });
      }
      if (status === 403) {
        return make('configuration', 'rejected_zero', { message: `your ${provider} key lacks permission` });
      }
      if (status === 402 || (status === 429 && errorCode !== undefined && CREDIT_CODES.test(errorCode)) ||
        (errorCode !== undefined && /^insufficient[_ ]?balance$/i.test(errorCode) && status >= 400 && status < 500)) {
        return make('credit', 'rejected_zero', {
          message: `your ${provider} account is out of credit or at its spend limit`,
        });
      }
      if (status === 429) {
        return make('temporary', 'rejected_zero', {
          message: 'provider is busy, try again',
          countsTowardRateAlert: true,
        });
      }
      if (status === 400 || status === 422) {
        return make('temporary', 'rejected_zero', {
          message: 'provider refused the request; edit the prompt',
        });
      }
      if (status >= 500) {
        return make('outcome_unknown', 'unconfirmed', {
          message: 'check your provider account before retrying',
        });
      }
      // Any other refusal (404, 409, ...) was rejected before acceptance: nothing was charged, a retry is safe.
      return make('temporary', 'rejected_zero');
    }
    case 'transport':
      return failure.phase === 'after_send'
        ? make('outcome_unknown', 'unconfirmed', { message: 'check your provider account before retrying' })
        : make('temporary', 'none');
    case 'poll_failed':
      return make(failure.authError === true ? 'configuration' : 'temporary', 'submit_stands');
    case 'poll_timeout':
      return make('provider_timeout', 'submit_stands');
    case 'output':
      return make('output_unreachable', 'submit_stands', {
        final: failure.problem !== 'unreachable' || failure.copyWindowPassed === true,
      });
    case 'reference_unreachable':
      return make('reference_unreachable', 'not_applicable');
  }
}

/** The classification of an egress failure of a provider call (the transport row of the table). */
export function classifyEgressFailure(
  provider: string,
  phase: 'before_send' | 'after_send',
): Classification {
  return classifyProviderFailure(provider, { kind: 'transport', phase });
}

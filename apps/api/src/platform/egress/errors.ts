/** Why a fetch was refused or failed. Names the cause only: never the URL path, query, headers or any body. */
export type EgressCause =
  | 'provider_unknown'
  | 'invalid_url'
  | 'not_https'
  | 'host_not_allowed'
  | 'blocked_address'
  | 'dns_failure'
  | 'connection_failed'
  | 'redirect_refused'
  | 'too_large'
  | 'timeout'
  | 'wrong_type'
  | 'network_error';

/** `before_send`: the request never left (refused, DNS, refused connection). `after_send`: it may have been received. */
export type EgressPhase = 'before_send' | 'after_send';

export class EgressError extends Error {
  readonly reason: EgressCause;
  readonly phase: EgressPhase;
  readonly host: string | undefined;

  constructor(cause: EgressCause, phase: EgressPhase, message: string, host?: string) {
    super(message);
    this.name = 'EgressError';
    this.reason = cause;
    this.phase = phase;
    this.host = host;
  }
}

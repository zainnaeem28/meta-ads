export interface ErrorDetail {
  field: string;
  code: string;
  message: string;
}

/** Framework-free base of every business refusal. The http layer binds `code` to the registry (one status each). */
export class DomainErrorBase<Code extends string = string> extends Error {
  constructor(
    readonly code: Code,
    readonly safeMessage: string,
    readonly details?: readonly ErrorDetail[],
  ) {
    super(safeMessage);
    this.name = new.target.name;
  }
}

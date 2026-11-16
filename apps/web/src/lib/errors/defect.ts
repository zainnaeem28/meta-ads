/** A response the UI should never see (`method_not_allowed`, `idempotency_key_reused`): a client bug or a stale link. */
export interface DefectReport {
  code: string;
  route: string;
  requestId: string | null;
}

type Sink = (report: DefectReport) => void;

let sink: Sink = (report) => {
  console.error('[defect]', JSON.stringify(report));
};

/** Replaces the destination (tests, or an error tracker); returns a function that restores the previous one. */
export const setDefectSink = (next: Sink): (() => void) => {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
};

/** Logs the route and request ID; QA reads this to record any occurrence as a failure. */
export const reportDefect = (report: DefectReport): void => sink(report);

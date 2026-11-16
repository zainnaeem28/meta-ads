'use client';

import { ClaimIssue } from './ClaimIssue';

const noop = () => {};

/** Gallery host: high risk, other and closed claim issues. */
export function ClaimIssueGallery() {
  return (
    <div className="flex max-w-xl flex-col gap-3">
      <ClaimIssue
        claimClass="high-risk"
        segment={1}
        quote="Cures every illness."
        instruction="Remove the medical claim."
      />
      <ClaimIssue
        claimClass="other"
        segment={2}
        quote="Number one in the world."
        instruction="Add proof or remove the superlative."
        onClear={noop}
      />
      <ClaimIssue
        claimClass="other"
        segment={3}
        quote="Best taste."
        instruction="Soften the claim."
        closed
        closedNote="Closed: cleared with a reason"
      />
    </div>
  );
}

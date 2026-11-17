import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import { canClear } from '../domain/index.js';
import { BRIEF_REPOSITORY } from './brief-ports.js';
import type { BriefRepository, IssueRecord } from './brief-ports.js';

/**
 * Clearing a claim issue with a reason (API-054; REQ-008). Only the `other` class can be cleared; a high-risk issue is
 * closed by an edit that stops its rule firing and by nothing else, so there is no path here that closes it.
 */
@Injectable()
export class IssuesService {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(BRIEF_REPOSITORY) private readonly repository: BriefRepository,
  ) {}

  /** Records the reason and the clearing user. An issue that is already cleared is returned unchanged. */
  clear(userId: string, issueId: string, reason: string): Promise<IssueRecord> {
    return this.database.uow.run(async (tx) => {
      const issue = await this.repository.findIssue(tx, userId, issueId, true);
      if (issue === null) throw new DomainError('not_found', 'Not found.');
      if (!canClear(issue.class)) {
        throw new DomainError(
          'claim_not_clearable',
          'This issue cannot be cleared with a reason. Edit the text until the check no longer applies.',
        );
      }
      if (issue.resolution === 'cleared_with_reason') return issue;
      if (issue.resolution !== 'open') {
        throw new DomainError('state_conflict', 'This issue was already closed by an edit.');
      }
      const cleared = await this.repository.clearIssue(tx, issueId, userId, reason);
      await this.repository.recordEvents(tx, userId, issue.briefId, [
        { issueId, class: issue.class, outcome: 'cleared_with_reason' },
      ]);
      return cleared;
    });
  }
}

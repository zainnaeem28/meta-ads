import { ERROR_CODES } from '@shroomap/contracts';
import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../api/errors';
import { ERROR_TABLE, FALLBACK_ROW, type CopyContext, type Presentation } from './copy';
import { resolveError, safeServerMessage } from './resolve';

const fail = (code: string, extra: Partial<ConstructorParameters<typeof ApiClientError>[0]> = {}) =>
  new ApiClientError({ status: 400, code, ...extra });

// Spec (UI-UX §9.1) for each of the 36 codes: copy without server text, action label, presentation (page load).
const SPEC: Record<string, { message: string; action: string; presentation: Presentation }> = {
  internal_error: {
    message:
      'Something went wrong on our side. Your work was not changed by this request. Try again, and if it keeps happening quote the reference below.',
    action: 'Try again',
    presentation: 'page',
  },
  service_unavailable: {
    message: 'ShrooMap is temporarily unavailable. Try again in a moment.',
    action: 'Try again',
    presentation: 'page',
  },
  method_not_allowed: {
    message: 'This action is not available. Reload the page and try again.',
    action: 'Reload',
    presentation: 'alert',
  },
  qc_confirmation_required: {
    message: 'The final ad will include these clips as they are. Your confirmation is recorded.',
    action: 'Include these clips and assemble',
    presentation: 'dialog',
  },
  validation_failed: {
    message: 'Check the highlighted fields and try again.',
    action: 'Correct and resubmit',
    presentation: 'field',
  },
  unauthenticated: {
    message: 'Your session ended. Sign in to continue.',
    action: 'Sign in',
    presentation: 'redirect',
  },
  not_linked: {
    message:
      'Your account is not set up for this workspace yet. Ask for access below, or ask an administrator for an invitation.',
    action: 'Request access',
    presentation: 'message-page',
  },
  forbidden_role: {
    message: 'This page is not available.',
    action: 'Go Home',
    presentation: 'page',
  },
  mfa_required: {
    message: 'Two-step verification is required. Set it up to continue.',
    action: 'Set up',
    presentation: 'redirect',
  },
  recent_auth_required: {
    message: 'For your security, confirm it is you again to continue.',
    action: 'Confirm sign-in',
    presentation: 'dialog',
  },
  not_found: {
    message: 'This page or item is not available.',
    action: 'Go Home',
    presentation: 'page',
  },
  version_conflict: {
    message:
      'This was changed somewhere else. Reload to see the latest version before you edit again.',
    action: 'Show the latest version',
    presentation: 'alert',
  },
  state_conflict: {
    message: 'This cannot be done in its current state. Refresh to see what changed.',
    action: 'Refresh',
    presentation: 'alert',
  },
  idempotency_key_reused: {
    message: 'This request was already sent with different details. Reload the page and try again.',
    action: 'Reload',
    presentation: 'alert',
  },
  key_missing: {
    message: 'Add your provider key to continue. Your work is saved.',
    action: 'Add provider key',
    presentation: 'alert',
  },
  key_disabled: {
    message: 'Your provider key was disabled after repeated failures. Replace it to continue.',
    action: 'Replace key',
    presentation: 'alert',
  },
  key_invalid: {
    message: 'The provider did not accept this key. Check it and try again. Nothing was saved.',
    action: 'Try again',
    presentation: 'field',
  },
  spend_cap_reached: {
    message: 'A usage limit has been reached, so this cannot start.',
    action: 'Contact your administrator',
    presentation: 'alert',
  },
  assembly_daily_limit: {
    message: 'You have used all final-ad assemblies for today. Try again after midnight UTC.',
    action: '',
    presentation: 'alert',
  },
  storage_quota_reached: {
    message:
      'Your storage limit is full. Delete a draft or campaign to free space, then upload again.',
    action: 'Go to campaigns',
    presentation: 'file-row',
  },
  payload_too_large: {
    message: 'This file is too large. Choose a smaller file.',
    action: 'Choose another file',
    presentation: 'file-row',
  },
  unsupported_media_type: {
    message: 'This file type is not supported. Use JPEG, PNG, WebP or GIF.',
    action: 'Choose another file',
    presentation: 'file-row',
  },
  media_not_ready: {
    message: 'The image is still being processed. Wait a moment and try again.',
    action: 'Try again',
    presentation: 'alert',
  },
  clip_not_completed: {
    message: 'A clip is not finished. Remove it from the selection or wait for it to complete.',
    action: 'Update selection',
    presentation: 'alert',
  },
  brief_not_accepted: {
    message: 'Accept the brief before you generate clips.',
    action: 'Open the brief',
    presentation: 'alert',
  },
  claim_not_clearable: {
    message: 'This issue cannot be cleared. Edit the segment until the check passes.',
    action: 'Edit the segment',
    presentation: 'alert',
  },
  open_claim_issues: {
    message: 'Fix the flagged claim issues before you continue.',
    action: 'Fix the flagged text',
    presentation: 'field',
  },
  confirmation_mismatch: {
    message: "That does not match. Type the account's email address exactly to confirm.",
    action: 'Retype',
    presentation: 'field',
  },
  report_window_too_large: {
    message: 'Choose a window of 366 days or fewer.',
    action: 'Change the dates',
    presentation: 'field',
  },
  last_admin: {
    message: 'This is the last administrator. Make another account an administrator first.',
    action: 'Close',
    presentation: 'alert',
  },
  self_action: {
    message: 'You cannot do this to your own account.',
    action: 'Close',
    presentation: 'alert',
  },
  account_suspended: {
    message: 'Your account is suspended. Contact your administrator.',
    action: '',
    presentation: 'message-page',
  },
  account_removed: {
    message: 'This account has been removed.',
    action: '',
    presentation: 'message-page',
  },
  invite_domain_not_allowed: {
    message: 'Invitations are limited to approved email domains. Use an approved address.',
    action: 'Change the address',
    presentation: 'field',
  },
  signup_open_prerequisites: {
    message: 'Open sign-up cannot be turned on yet.',
    action: 'Close',
    presentation: 'alert',
  },
  rate_limited: {
    message: 'Too many attempts. Try again in a moment.',
    action: 'Try again',
    presentation: 'alert',
  },
};

describe('error copy table (UI-UX §9.1)', () => {
  it('has exactly one row for each of the 36 registry codes', () => {
    expect(ERROR_CODES).toHaveLength(36);
    expect(Object.keys(SPEC).sort()).toEqual([...ERROR_CODES].sort());
    expect(Object.keys(ERROR_TABLE).sort()).toEqual([...ERROR_CODES].sort());
  });

  it.each(ERROR_CODES)('%s renders its row copy, action and presentation', (code) => {
    // The status is deliberately wrong: the copy follows the code only.
    const view = resolveError(fail(code, { status: 418 }));
    const spec = SPEC[code]!;
    expect(view.known).toBe(true);
    expect(view.row).toBe(ERROR_TABLE[code]);
    expect(view.message).toBe(spec.message);
    expect(view.action.label).toBe(spec.action);
    expect(view.presentation).toBe(spec.presentation);
  });

  it('shows the server message only on the rows that name one', () => {
    const named = new Set([
      'spend_cap_reached',
      'signup_open_prerequisites',
      'payload_too_large',
      'unsupported_media_type',
      'clip_not_completed',
    ]);
    const text = 'Monthly limit of 40 videos reached.';
    for (const code of ERROR_CODES) {
      const shown = resolveError(fail(code, { message: text })).message;
      if (named.has(code)) expect(shown).toContain(text);
      else if (code !== 'qc_confirmation_required') expect(shown).not.toContain(text);
    }
    expect(
      resolveError(fail('qc_confirmation_required', { message: 'Segment 2 failed its check.' }))
        .message,
    ).toContain('Segment 2 failed its check.');
  });

  it('brief_not_accepted shows the server message only when it says the segment is not active', () => {
    expect(
      resolveError(fail('brief_not_accepted', { message: 'Segment 3 is not active.' })).message,
    ).toBe('Segment 3 is not active.');
    expect(
      resolveError(fail('brief_not_accepted', { message: 'The brief is draft.' })).message,
    ).toBe('Accept the brief before you generate clips.');
  });

  it('falls back to the internal_error copy for an unknown code, a plain Error and a transport failure', () => {
    for (const error of [
      fail('brand_new_code', { status: 422, message: 'secret detail' }),
      new Error('boom'),
      'x',
      null,
    ]) {
      const view = resolveError(error);
      expect(view.known).toBe(false);
      expect(view.row).toBe(FALLBACK_ROW);
      expect(view.message).toBe(SPEC.internal_error!.message);
      expect(view.presentation).toBe('page');
    }
    expect(resolveError(fail('toString')).row).toBe(FALLBACK_ROW);
  });

  it('uses the context presentation of rows that differ inside a form, dialog or action', () => {
    expect(resolveError(fail('internal_error'), { surface: 'context' }).presentation).toBe('alert');
    expect(resolveError(fail('service_unavailable'), { surface: 'context' }).presentation).toBe(
      'alert',
    );
    expect(resolveError(fail('not_found'), { surface: 'context' }).presentation).toBe('toast');
    const forbidden = resolveError(fail('forbidden_role'), { surface: 'context' });
    expect(forbidden.presentation).toBe('alert');
    expect(forbidden.message).toBe('You do not have permission to do this.');
    expect(forbidden.action).toEqual({ kind: 'close', label: 'Close' });
    expect(resolveError(fail('forbidden_role')).action.label).toBe('Go Home');
  });

  it('shows the Reference only for 500 and 503 (and the fallback)', () => {
    for (const code of ERROR_CODES) {
      const view = resolveError(fail(code, { requestId: 'req-1' }));
      const expected = code === 'internal_error' || code === 'service_unavailable' ? 'req-1' : null;
      expect(view.reference).toBe(expected);
    }
    expect(resolveError(fail('mystery', { requestId: 'req-2' })).reference).toBe('req-2');
  });

  it('never carries details[] content for a 5xx', () => {
    const details = [{ field: 'a', code: 'x', message: 'm' }];
    expect(resolveError(fail('internal_error', { details })).details).toEqual([]);
    expect(resolveError(fail('mystery', { details })).details).toEqual([]);
    expect(resolveError(fail('validation_failed', { details })).details).toEqual(details);
  });

  it('flags exactly method_not_allowed and idempotency_key_reused as defects', () => {
    const defects = ERROR_CODES.filter((code) => resolveError(fail(code)).defect);
    expect(defects.sort()).toEqual(['idempotency_key_reused', 'method_not_allowed']);
  });

  it('retry waits: Retry-After, 5 s default for 503 and 429, none for a 500', () => {
    expect(resolveError(fail('service_unavailable', { retryAfterSeconds: 30 })).waitSeconds).toBe(
      30,
    );
    expect(resolveError(fail('service_unavailable')).waitSeconds).toBe(5);
    expect(resolveError(fail('rate_limited')).waitSeconds).toBe(5);
    expect(resolveError(fail('rate_limited', { retryAfterSeconds: 12 })).waitSeconds).toBe(12);
    expect(resolveError(fail('internal_error', { retryAfterSeconds: 12 })).waitSeconds).toBe(0);
  });

  it('puts the wait into the 503 and 429 copy, in minutes above 120 s', () => {
    expect(resolveError(fail('service_unavailable', { retryAfterSeconds: 30 })).message).toBe(
      'ShrooMap is temporarily unavailable. You can try again in 30 seconds.',
    );
    expect(resolveError(fail('rate_limited', { retryAfterSeconds: 1 })).message).toBe(
      'Too many attempts. Try again in 1 second.',
    );
    expect(resolveError(fail('rate_limited', { retryAfterSeconds: 300 })).message).toBe(
      'Too many attempts. Try again in 5 minutes.',
    );
  });
});

describe('copy lint: no status, stack, table name or provider detail', () => {
  const banned = [
    /\bhttp\b/i,
    /\b[1-5]\d\d\b(?! days)/,
    /\bstatus\b/i,
    /\bstack\b|\btrace\b|\bexception\b/i,
    /\b(table|column|schema|sql|postgres|query|constraint|row)\b/i,
    /\b(clerk|stripe|sentry|cloudflare|neon|supabase|elevenlabs|openai|anthropic|google|r2)\b/i,
    /\.(ts|tsx|js)\b|\bat .*:\d+/,
  ];
  const contexts: CopyContext[] = [
    { server: null, wait: null },
    { server: 'Monthly limit of 40 videos reached.', wait: 30 },
    { server: null, wait: 300 },
  ];

  it('holds for every row, with and without server text and wait', () => {
    for (const row of Object.values(ERROR_TABLE)) {
      const texts = [
        row.action.label,
        row.title ?? '',
        row.pageMessage ?? '',
        ...contexts.map((c) => row.message(c)),
      ];
      for (const text of texts)
        for (const pattern of banned) expect(text, `${row.code}: ${text}`).not.toMatch(pattern);
    }
  });

  it('screens a server message that carries such detail', () => {
    for (const bad of [
      'Request failed with status 500',
      'HTTP 503 from upstream',
      'error: relation "users" does not exist',
      'at Object.run (/srv/app/dist/main.js:10:5)',
      'Clerk rejected the token',
      'x'.repeat(301),
      '',
      42,
    ]) {
      expect(safeServerMessage(bad), String(bad)).toBeNull();
    }
    expect(safeServerMessage('Monthly limit of 400 videos reached.')).toBe(
      'Monthly limit of 400 videos reached.',
    );
    expect(
      resolveError(fail('spend_cap_reached', { message: 'Clerk exploded at status 500' })).message,
    ).toBe('A usage limit has been reached, so this cannot start.');
  });
});

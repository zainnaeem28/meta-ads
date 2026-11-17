import { describe, expect, it } from 'vitest';
import { classifyEgressFailure, classifyProviderFailure } from './classify.js';

const c = (failure: Parameters<typeof classifyProviderFailure>[1]) =>
  classifyProviderFailure('openai', failure);

describe('provider error classification (ARCHITECTURE 5.10, one test per row)', () => {
  it('401: configuration, counts as an auth failure', () => {
    expect(c({ kind: 'http', status: 401 })).toMatchObject({
      causeClass: 'configuration',
      message: 'your openai key was not accepted',
      countsAsAuthFailure: true,
      usageEvent: 'rejected_zero',
    });
  });
  it('403: configuration, lacks permission, no auth failure', () => {
    expect(c({ kind: 'http', status: 403 })).toMatchObject({
      causeClass: 'configuration',
      message: 'your openai key lacks permission',
      countsAsAuthFailure: false,
      usageEvent: 'rejected_zero',
    });
  });
  it.each([
    [402, undefined],
    [429, 'insufficient_quota'],
    [429, 'project_spend_limit_exceeded'],
    [400, 'insufficient_balance'],
  ])('credit: %s %s', (status, errorCode) => {
    expect(c({ kind: 'http', status, errorCode })).toMatchObject({
      causeClass: 'credit',
      message: 'your openai account is out of credit or at its spend limit',
      usageEvent: 'rejected_zero',
      countsAsAuthFailure: false,
    });
  });
  it('429 rate limit: temporary and counts toward the alert', () => {
    expect(c({ kind: 'http', status: 429, errorCode: 'rate_limit_exceeded' })).toMatchObject({
      causeClass: 'temporary',
      message: 'provider is busy, try again',
      countsTowardRateAlert: true,
      usageEvent: 'rejected_zero',
    });
  });
  it.each([400, 422])('%s refusal: temporary, edit the prompt', (status) => {
    expect(c({ kind: 'http', status })).toMatchObject({
      causeClass: 'temporary',
      message: 'provider refused the request; edit the prompt',
      countsTowardRateAlert: false,
      usageEvent: 'rejected_zero',
    });
  });
  it.each([500, 502, 503])('%s: outcome unknown, unconfirmed', (status) => {
    expect(c({ kind: 'http', status })).toMatchObject({
      causeClass: 'outcome_unknown',
      message: 'check your provider account before retrying',
      usageEvent: 'unconfirmed',
    });
  });
  it('other 4xx: temporary, rejected', () => {
    expect(c({ kind: 'http', status: 404 })).toMatchObject({
      causeClass: 'temporary',
      usageEvent: 'rejected_zero',
    });
  });
  it('transport after sending: outcome unknown; before sending: temporary, no call', () => {
    expect(c({ kind: 'transport', phase: 'after_send' })).toMatchObject({
      causeClass: 'outcome_unknown',
      usageEvent: 'unconfirmed',
    });
    expect(c({ kind: 'transport', phase: 'before_send' })).toMatchObject({
      causeClass: 'temporary',
      usageEvent: 'none',
    });
    expect(classifyEgressFailure('openai', 'before_send').causeClass).toBe('temporary');
  });
  it('poll failed: temporary, or configuration when auth; submit stands', () => {
    expect(c({ kind: 'poll_failed' })).toMatchObject({
      causeClass: 'temporary',
      usageEvent: 'submit_stands',
    });
    expect(c({ kind: 'poll_failed', authError: true })).toMatchObject({
      causeClass: 'configuration',
      usageEvent: 'submit_stands',
    });
  });
  it('poll timeout: provider_timeout', () => {
    expect(c({ kind: 'poll_timeout' })).toMatchObject({
      causeClass: 'provider_timeout',
      usageEvent: 'submit_stands',
    });
  });
  it('output problems: final at once except unreachable inside the copy window', () => {
    for (const problem of ['wrong_type', 'too_large', 'disallowed_host'] as const) {
      expect(c({ kind: 'output', problem })).toMatchObject({
        causeClass: 'output_unreachable',
        final: true,
      });
    }
    expect(c({ kind: 'output', problem: 'unreachable' })).toMatchObject({ final: false });
    expect(c({ kind: 'output', problem: 'unreachable', copyWindowPassed: true })).toMatchObject({
      final: true,
    });
  });
  it('reference unreachable', () => {
    expect(c({ kind: 'reference_unreachable' })).toMatchObject({
      causeClass: 'reference_unreachable',
    });
  });
  it('messages never carry a provider body', () => {
    expect(
      JSON.stringify(c({ kind: 'http', status: 400, errorCode: 'secret-body-text' })),
    ).not.toContain('secret-body-text');
  });
});

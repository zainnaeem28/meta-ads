/** Copy for SCREEN-001 and SCREEN-003 (UI-UX §8 and §9.1). */
export const AUTH_COPY = {
  productName: 'AI UGC Ad Director',
  signInIntro: 'Sign in with the email address your administrator invited.',
  sessionExpired: 'Your session ended. Sign in to continue.',
  mfaTitle: 'Two-step verification',
  mfaEnrolTitle: 'Set up two-step verification',
  mfaChallengeIntro: 'Open your authenticator app and enter the 6-digit code.',
  mfaEnrolIntro:
    'Required for every account. You will not be able to use ShrooMap until it is set up. Scan the code with an authenticator app, then enter the 6-digit code.',
  mfaRequired: 'Two-step verification is required. Set it up to continue.',
  mfaCodeError: 'That code is not right or has expired. Enter the current code.',
  recovery: 'Recovery needs another second factor or an administrator to verify you. An email alone is not enough.',
} as const;

export type MfaStep = 'enrol' | 'challenge';

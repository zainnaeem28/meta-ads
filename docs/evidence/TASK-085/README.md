# TASK-085 web security headers and CSP

Files: `apps/web/src/lib/security/` (policy builder, static header list, per-request context), `apps/web/src/middleware.ts`
(applies it), `apps/web/next.config.mjs` (static files), `apps/web/tests/security/headers.test.ts` (header test over every
route class, `pnpm --filter @shroomap/web test:headers`), `apps/web/e2e/security-headers.spec.ts` (`@TASK-085`, built app).
Screenshots (390 and 1440 px, sign-in under the enforced policy) are in `screenshots/`, axe results in `axe/`.

## Policy rationale (for the Security Reviewer)

- Enforced `Content-Security-Policy` on every middleware response, never report-only; `default-src 'none'`, then explicit lists.
- `script-src 'self' 'nonce-<per-request>'` plus the identity provider's frontend API origin (from the publishable key) and,
  off the key page, `challenges.cloudflare.com` (the provider's bot check). No `unsafe-inline`; `unsafe-eval` only in `next dev`.
  The framework marks its own scripts with the nonce (middleware forwards `x-nonce` and the policy on the request).
  `script-src-attr 'none'`; `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`; `frame-ancestors 'none'` plus `X-Frame-Options: DENY`.
- Key page (`/settings/provider-keys`, REQ-019): script sources are self, nonce and the provider's session script origin only;
  no challenge origin, no provider image origin, `frame-src 'none'`, `Cache-Control: no-store`.
  Residual risk (SEC-1, decision-log): the provider's own session script is needed there for `getToken()`, so REQ-019's "no third-party
  scripts" is met except for the required identity origin. Self-hosting it would remove even that origin. A test asserts the key page's
  `script-src` holds only self, the nonce and the provider origin.
- `connect-src` self, the api origin, the provider origin, the Sentry ingest origin (when a browser DSN is set).
  `img-src`/`media-src` self, `blob:`, `data:` (media only: the gallery's inline media) and the signed-storage origin (`R2_ENDPOINT`, path and bucket-host forms).
- `style-src 'self' 'unsafe-inline'`: React style attributes and the provider widgets' style elements. Accepted residual (SEC-2): inline styles cannot execute script, `script-src` and `script-src-attr` stay strict; removing it needs a style nonce for every React style attribute, which the framework does not offer.
- Other headers: `Referrer-Policy: same-origin`, `X-Content-Type-Options: nosniff`, `Permissions-Policy` (camera, microphone, geolocation, payment, usb ... denied),
  `X-Robots-Tag`, `Strict-Transport-Security` and `upgrade-insecure-requests` when `APP_ENV` is staging or production, no `X-Powered-By`.
- Zod runs interpreted (`lib/security/zod-jitless.ts`): its compiled path probes `Function("")`, which the policy reports as a violation.

## Deviations and hand-offs

- Edits outside the allowed paths, all required to wire the work in: `apps/web/src/middleware.ts` (applies headers),
  `apps/web/src/providers/app-providers.tsx` (one import), `apps/web/package.json` (`test:headers`), `apps/web/vitest.config.ts` (include `tests/security`),
  and removal of `apps/web/src/lib/auth/headers.ts` (superseded by `lib/security`). Orchestrator: confirm as a change request.
- The storage origin is read from `R2_ENDPOINT`/`R2_BUCKET` in the web process; the registry lists them for api, worker and backup only. DevOps: add `web` as a consumer.
- Clerk's real hosted script and widget loading could not be exercised here (no keys); the provider origins are derived from the key and unit-tested.
- Not caused by this ticket: the chromium visual baselines of TASK-069 differ by 1 px in height in this environment, the same on a clean `origin/dev`.

## Notes for reviewers

- `tests/security/headers.test.ts` calls the middleware directly; the fetch-level check is `e2e/security-headers.spec.ts` against the built app (FR-3).
- The e2e no longer waits for `networkidle` (INT-1): routes not yet built show the 404 screen whose "Go home" link prefetches forever.
  It waits for `load` plus a fixed window, then asserts no violation. The framing test now requires the frame's `load`, an empty body and the browser's error document (`chrome-error:`) as the frame URL.
- `/campaigns`, `/access` and `/settings/provider-keys` currently render the 404 screen (not built yet); their screenshots
  (`provider-keys-*`, `signed-in-campaigns-*`) show that state under the policy and will change when the screens land.

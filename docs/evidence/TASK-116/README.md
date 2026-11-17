# TASK-116 evidence: personal-data, MFA-recovery and zero-trust negative tests

Run: `pnpm --filter @shroomap/api test:security` (script `test:security`, config `apps/api/tests/security/vitest.config.ts`).
Reports: `apps/api/reports/security/junit.xml`, `apps/api/reports/security/lcov.info` (the suite's own harness: lines 98.8%, branches 78.3%). The gate report is `submit-check.md` next to this file.

Everything runs through the real api composition root (`createApiApp`, `fastify.inject`), the real worker composition root (`createWorkerApp`), real PostgreSQL, an in-process S3 stand-in that also plays the `erasure-ledger` bucket, and a local TLS server standing in for the OpenAI API. No real provider, no real identity vendor.

## Case map (SECURITY-DESIGN §10.9 and §16.4, TEST-CASES §10)

| Case | Test file (`apps/api/tests/security/`) | What it proves |
| --- | --- | --- |
| SECT-PD-01, TC-DEL-05, T-15 | `personal-data.security.test.ts` | schema walker: every table with an owner or user column is in the erasure registry (a new table fails); erased tables hold zero rows of a removed subject, ID-only tables keep IDs |
| SECT-PD-02, TC-ZT-10 | `personal-data`, `images` | zero rows and zero objects; keys deleted in the removal operation; likeness image stored privately, EXIF and GPS removed, sent to the provider as bytes only, erased with the account |
| SECT-PD-06 | `personal-data` | invitations and access requests removed by email and by subject, provider invitation revoked |
| SECT-PD-07, SECT-LOG-05, TC-NFR-09 | `personal-data`, `logs` | personal-data inventory matrix: each class only in its allowed tables; no email, key, content or description in audit, usage, key events, runs, alerts, queue or ledger; no JSON or free-text column in the history tables; no transcript column anywhere |
| SECT-PD-08 | `personal-data` | removed subject refused at the API, the run is listed with IDs only |
| SECT-PD-10, SECT-PD-11, T-22 | `personal-data` | a restored dump brings the erased account back; replaying the ledger IDs through the product's own erasure run erases it again; a re-invite of the address gives a new account with none of the old data |
| SECT-PD-15 | `images` | adversarial vision output: every word of the sensitive-attribute list dropped through the real worker before storage; extra fields in the answer fail the job and are stored nowhere; evasion wordings (case, punctuation, line breaks, list items) |
| SECT-LOG-01, 03, 05, TC-LOG-01, TC-LOG-03 | `logs` | full journey (key entry, failing provider call, 500 with the canaries in its message, reads, signed URL, image analysis, campaign deletion, suspend, reinstate, removal and erasure): no canary, address, auth ID, token, content or signed-URL query in the api or worker log; the logger drops transcript and description fields |
| SECT-ZT-01, 02, 03, 05, 06, SECT-AZ-04, 10, 11, 13, SECT-AUTH-05, TC-ZT-01, 02, 03, 06, TC-AUT-12, 13 | `zero-trust` | revocation matrix generated from the OpenAPI file over every routed operation: anonymous, cookie, other schemes, query token, expired, not-yet-valid, wrong party, wrong issuer, unknown key, provider down (fail closed), suspended, removed, demoted and promoted, unlinked identity, forged headers and fields, foreign versus missing object, administrator without a role-based read |
| SECT-MFA-01, 03, 04, 08, SECT-ADM-07, TC-ACC-15, 16, TC-ZT-11 (API part) | `mfa` | every guarded operation refuses a token without second-factor evidence (`all`); admins mode; recent-auth step-up; the contract and router have no reset or recovery operation (TD-D40(e)); an "email-only recovery" session never gets past `mfa_required`; no factor material anywhere |
| SECT-AZ-07, SECT-UP-07, SECT-LOG-03, TC-ZT-07 | `cache` | signed URL: one object, bounded life, signed, never cached, refused for a foreign, missing, processing or rejected object with the same answer; no-store on every response; no validator; a shared cache keyed by method and URL could keep nothing |
| SECT-R2-02 | `personal-data`, `cache` | bucket listings happen only inside the erasure sweep, in the subject's own prefix |
| wiring (TC-LOG-03) | `gate` | the sink scanner runs through the real `submit_check.py`: it fails on the committed leaking fixture (rules named, no value printed), passes on the committed clean fixture and on the tree (the reports and evidence this suite writes) |

## Cases left to a human or a deploy check (explicit references)

- SECT-PD-10 and SECT-PD-13 as a drill on the real backup artifacts, SECT-PD-12 (token scopes of the ledger bucket), SECT-R2-01, SECT-R2-03, SECT-AZ-08 (unsigned GET, guessed path, listing, signed URL life at the bucket): Stage 4 deploy and drill cases, TEST-CASES §11 (TC-LED-03, TC-BKP-14..16, the TC-H cases). The in-process S3 stand-in does not verify signatures, so the suite proves what the API controls (who gets a URL, for which object, for how long).
- The provider part of MFA recovery (the provider's own recovery flow and admin verification): human case TC-H-02 on the provider's test tenant. SECT-MFA-05..07, 10, 11 belong to an admin MFA-reset operation that OpenAPI design.5 does not contain (TD-D40(e)); SECT-MFA-09 is the startup-configuration unit case TC-ACC-18.
- Operations API-070, 071, 075, 076 are not routed in this revision; the matrix is generated from the OpenAPI file and the running router, so they are covered the day they are routed.

## Findings (stable IDs, round 1)

| ID | Severity | Finding | Requirement | Owner | Test |
| --- | --- | --- | --- | --- | --- |
| SEC116-F2 | High | Scope `A` does not require recent authentication. `authorizeScope` (`apps/api/src/platform/http/auth.guard.ts`) applies `requireRecentAuth` only to `U+RA`; OpenAPI says `x-scope: A` is admin, MFA and recent auth, and TEST-CASES §16.2 (TC-ACC-15, 16) says step-up 403 `recent_auth_required` for all `U+RA` and `A` operations. An admin session whose first or second factor is older than the window (10 minutes) can still suspend, remove, change roles and send invitations. Reproduction: an admin token with `fva` `[30, 30]` on `GET /admin/users` answers 200. Fix: `requireRecentAuth` for `A` as well as `U+RA`, and the admin screens must handle `recent_auth_required`. | SECT-ADM-07, NFR-10, REQ-004 | identity / http platform (guard) | `mfa.security.test.ts`, marked `[SEC116-F2 open]` |
| SEC116-F1 | Medium | The queue `identity.revoke-sessions` has no handler in the worker. `revokeSessionsHandler` is exported by the identity module but never registered in `bootstrap/worker.module.ts`, so the job queued by suspend (API-101) and by a status change is never consumed and the provider sessions of a suspended user stay alive. The API still refuses the user on the next request (status is read every time) and the removal run revokes sessions itself, so this is hardening, not an access bypass. Reproduction: suspend a user, wait: `sessionRevocations` of the identity provider never gains the subject and the job stays queued. | SECT-ID-02, SECT-AUTH-06 | identity (worker wiring) | `zero-trust.security.test.ts`, marked `[SEC116-F1 open]` |
| SEC116-L1 | Low | The logger scrubs value shapes (keys, tokens, addresses, signed URLs) in message text and drops every field outside its allow-list, but free text interpolated into a message (for example a transcript sentence) is not recognised. No such call exists today (the journey scan passes); a lint rule against interpolated log messages would close it. | NFR-09 | platform logging | observation, no test |

The two open defects are written as `it.fails` cases (`openDefect` in `support/stack.ts`): the suite is green while they are open and turns red the day the product is fixed, which forces the marker out. Both need a correction ticket from the Orchestrator.

## Files outside the allowed paths

- `apps/api/package.json`: one line, the `test:security` script the required command names. No config of the other suites was touched.
- The test transform does not read the decorator flags of the source tsconfig, so the suite applies the two Nest decorators it needs by hand (`support/stack.ts`).

## Notes

- Coverage measured is the suite's own harness (`tests/security/support`), like the grants suite of TASK-025: the product code it drives is covered by its owners' suites.
- The sink scanner (`support/scan-sinks.mjs`) writes SARIF and never prints a value; `reports/sinks.sarif` is passed to `submit_check.py` as a secrets report.

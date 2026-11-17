# TASK-108 FLOW-05: findings

| ID | Severity | Finding | Owner |
| --- | --- | --- | --- |
| F-1 | Low | After a sign-in whose return path is the home path (no `return`, or an unsafe one that `safeReturnPath` replaces with `/`), the server action redirects to `/`. The middleware sends `/` on to `/campaigns`, but the client keeps `/` in the address bar while showing the campaigns; a reload lands on `/campaigns`. Fix: `localSignIn` and `localVerify` in `apps/web/src/app/(auth)/actions.ts` redirect to `ROUTES.campaigns` when the screened path is `ROUTES.home`. Outside this ticket's allowed paths. | TASK-087 (fe-screen-001-003) |
| F-2 | Info | In local identity mode `localSignIn` goes straight to the return path; the second step (SCREEN-003) is reached only when the return path names it. The provider decides the step in hosted mode, which cannot run here (no provider keys). The test drives the chain with `return=/mfa?step=enrol&return=/campaigns`. | none (documented limitation) |

The test pins F-1: it asserts the campaigns heading is shown, then a reload lands on `/campaigns`.

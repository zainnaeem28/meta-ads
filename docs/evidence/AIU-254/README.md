# AIU-254 evidence

Built artifacts (`next start` AUTH_MODE=local, compiled api IDENTITY_MODE=local, OWNER_EMAIL set, real migrations, no mocked api answer):
`apps/web/tests/e2e/local-token/` (see `e2e-built-artifacts.txt`).

- Signed-in owner email: `/local-token` -> `POST /api/v1/dev/token` -> bearer on `/api/v1/me`, `/api/v1/admin/users`, `/api/v1/admin/erasures`, answers 200 (first administrator, MFA satisfied). Checked directly against the api too: `/me` is `role: admin, mfa.satisfied: true, recentAuth.satisfied: true`; `GET /admin/users` lists the user.
- Without a session no bearer is sent.
- Defects found and fixed on the way: `/local-token` read the token at the top level but the api wraps answers as `{success, data}` (route always 502); the generated client sent `credentials: 'include'` against an api whose CORS has no credentials mode (every cross-origin call blocked in a browser); the first user becoming known cancelled in-flight queries.
- Further users/invitations need no fixture shortcut: any email gets a token from the same route; an invited email links by invitation, an admin token calls the admin routes.

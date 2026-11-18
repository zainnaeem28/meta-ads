# AIU-307 evidence
SCREEN-011 (accounts) rendered from the built web app on dev + AIU-281 port, chromium, 390 px and 1440 px, all 9 states
(e2e/fe-screen-011.spec.ts, EVIDENCE=1; API answered by the spec's contract fixtures). Updated e2e baselines are in
apps/web/e2e/__baselines__/chromium/fe-screen-011-*. The AdminShell menu trigger keeps aria-label "Account menu" (Menu label prop);
the visible "Administrator" text is a decorative duplicate.

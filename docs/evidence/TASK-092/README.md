# TASK-092 SCREEN-006 New brief wizard 2/2 (product image, review and generate)

- `apps/web/src/features/fe-screen-006b/`: `NewBriefWizard` (the SCREEN-006 wizard now behind `/campaigns/new`; steps 1 to 3 as TASK-091, plus the image and step 4), `ProductImage` (CMP-021 with API-030, 031, 035, 036), `copy.ts`, `draft.ts` (adds `productMediaId`, `concept`, `script` to the draft write), component tests (MSW).
- Route `apps/web/src/app/(operator)/campaigns/new/page.tsx` now renders the 006b wizard (the 006a one is no longer routed; its helpers `copy.ts`, `draft.ts` and `SessionEndedDialog` are reused).
- `apps/web/e2e/fe-screen-006b.spec.ts` (`@TASK-092`): states default, uploading, processing, ready, upload-rejected, upload-too-large, step-4, generating, key-missing, cap-reached, cap-reached-on-submit at 390 and 1440 px with axe (zero violations, `axe/`), screenshots (`screenshots/`) and baselines; a keyboard-only run of the whole journey with the exact call set; two real-api tests (API-022 and API-030 reach the running api and its 401 opens the session dialog). Run with `node docs/evidence/TASK-092/e2e-with-database.mjs`.

## What is real and what is scripted
The running api answers the two real-api tests. Everything else in e2e is a contract-shaped mock of API-021 to 025, 030, 031, 035, 036 (no operator session in this environment). Real UI-API-DB proof is the flow ticket's.

## Decision log
| # | Question | Choice | Reason |
| --- | --- | --- | --- |
| D1 | `fe-screen-006a` is outside the allowed paths and cannot take the new fields | 006b holds a full copy of the wizard that extends the 006a draft helpers; the route imports it | Allowed paths; avoids editing TASK-091 files |
| D2 | TASK-091 e2e baselines (14 files) no longer matched the route (step 2 is taller, step 4 changed) | Regenerated them (`--update-snapshots`) with no code change to that spec | Same route, intended change; needs UI/UX confirmation |
| D3 | Upload progress | `uploadMedia` is a plain `fetch` with no progress events; the row shows "Uploading" until the answer | No progress hook in the contract client; CMP-021 only renders a value |
| D4 | Product image required? | Optional; Next waits while it uploads or processes; a rejected image is never attached | API-024 attaches the image only when present; media_not_ready is handled at submit |
| D5 | Likeness consent text (NFR-09) | A visible notice under the drop zone; no checkbox | UI-UX §8 asks for text only; wording is mine, for Product Manager review |
| D6 | key_missing / spend_cap_reached on submit | Block alert, Generate disabled; key_disabled and media_not_ready use the shared ErrorNotice rows | UI-UX §9.1 |
| D7 | Thumbnail of the uploaded image | Not shown | API-032 (signed URL) is not in this ticket's operations |

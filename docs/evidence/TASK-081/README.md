# TASK-081 evidence (gallery completion)

The gallery (`/gallery`, built web app, `GALLERY_ENABLED=true`, never in production) now carries an inventory registry of UI-UX §6 and a check that fails when a component or a listed state has no entry.

- `apps/web/src/app/gallery/inventory.ts`: the 32 live CMP IDs (CMP-001..008, 010..028, 030..034; CMP-009 reserved, CMP-029 never assigned), each with its sheet, its states and a Playwright selector for each state. States reached by interaction (hover, focus, pressed, the invalid form, a dismissed toast) carry the action that reaches them and the check fails if it changes nothing.
- `apps/web/src/app/gallery/inventory.test.ts` (Vitest): 32 IDs in order, no 009/029, every component has a sheet, an anchor, uniquely named states with selectors, and the four sheets hold the components UI-UX §6 names.
- `apps/web/tests/gallery/gallery-complete.e2e.ts` (Playwright `@TASK-081`, through `next start` beside the built api): registry page check (no ID outside the inventory is named on the page), every state of every component at 390 and 1440 px, axe over the whole gallery at 390 and 1440 px, axe with each live dialog open, one baseline per component at both widths, and the evidence screenshots.
- Baselines: `apps/web/e2e/__baselines__/chromium/gallery-CMP-*-{390,1440}.png` (64 files). They need UI/UX approval before they are the design-system baseline set.
- Axe results: `axe/` (whole gallery and dialogs, 0 violations at WCAG 2.2 AA tags). Screenshots with the real fonts: `screenshots/` (`<sheet>-<CMP id>-<width>.png`).

## Sheet parity input for UI/UX (CMP-SHEET-01..04)
Sheets are assigned from the "Gallery frame" column of UI-UX §6. CMP-030..034 name no sheet there (they sit on the screen frames), so they are listed as `SCREENS` and compared with the SCREEN-001..015 frames, not with a sheet.

| CMP | Component | Sheet | States | State list | Screenshots |
| --- | --- | --- | --- | --- | --- |
| CMP-001 | Brand: lockup, mark, favicon and app icons | CMP-SHEET-04 | 8 | light lockup; light mark; dark lockup; dark mark; mono-ink lockup; mono-ink mark; mono-cream lockup; mono-cream mark | `gallery-CMP-001-390.png`, `gallery-CMP-001-1440.png` |
| CMP-002 | Icon set | CMP-SHEET-01 | 2 | 16 px; decorative, aria-hidden | `gallery-CMP-002-390.png`, `gallery-CMP-002-1440.png` |
| CMP-003 | Button | CMP-SHEET-01 | 27 | primary default; primary disabled; primary pending; secondary default; secondary disabled; secondary pending; outline default; outline disabled; outline pending; ghost default; ghost disabled; ghost pending; destructive default; destructive disabled; destructive pending; destructive-outline default; destructive-outline disabled; destructive-outline pending; hover; focus; active; small; with icon; icon-only default; icon-only disabled; icon-only pending; anchor | `gallery-CMP-003-390.png`, `gallery-CMP-003-1440.png` |
| CMP-004 | Input and textarea | CMP-SHEET-01 | 15 | text empty; text filled; text invalid; text disabled; text read-only; textarea empty; textarea filled; textarea invalid; textarea disabled; textarea read-only; key empty; key filled; key invalid; key disabled; focus | `gallery-CMP-004-390.png`, `gallery-CMP-004-1440.png` |
| CMP-005 | Select | CMP-SHEET-01 | 5 | single empty; single filled; single invalid; single disabled; focus — n/a: read-only (a native select has no read-only state) | `gallery-CMP-005-390.png`, `gallery-CMP-005-1440.png` |
| CMP-006 | Choice controls | CMP-SHEET-01 | 14 | radio-card default; radio-card checked; radio-card disabled; checkbox default; checkbox checked; checkbox disabled; switch default; switch checked; switch disabled; checkbox not in this release; switch not in this release; segmented control; hover; focus | `gallery-CMP-006-390.png`, `gallery-CMP-006-1440.png` |
| CMP-007 | Badge / status | CMP-SHEET-01 | 7 | neutral; primary; success; info; warning; destructive; with icon | `gallery-CMP-007-390.png`, `gallery-CMP-007-1440.png` |
| CMP-008 | Loading: spinner, progress, skeleton | CMP-SHEET-01 | 4 | spinner; progress determinate; progress indeterminate; skeleton region | `gallery-CMP-008-390.png`, `gallery-CMP-008-1440.png` |
| CMP-010 | Form field | CMP-SHEET-01 | 3 | valid; disabled; invalid with error summary | `gallery-CMP-010-390.png`, `gallery-CMP-010-1440.png` |
| CMP-011 | Alert | CMP-SHEET-02 | 4 | info; success; warning; destructive | `gallery-CMP-011-390.png`, `gallery-CMP-011-1440.png` |
| CMP-012 | Toast | CMP-SHEET-02 | 6 | success; info; error; appearing; visible; dismissed | `gallery-CMP-012-390.png`, `gallery-CMP-012-1440.png` |
| CMP-013 | Dialog | CMP-SHEET-03 | 6 | open, confirm; typed confirm; form dialog; pending; error; dirty-discard | `gallery-CMP-013-390.png`, `gallery-CMP-013-1440.png` |
| CMP-014 | Tabs | CMP-SHEET-02 | 6 | selected; default; disabled; count badges; hover; focus | `gallery-CMP-014-390.png`, `gallery-CMP-014-1440.png` |
| CMP-015 | Stepper | CMP-SHEET-02 | 4 | done; current; upcoming; last step current | `gallery-CMP-015-390.png`, `gallery-CMP-015-1440.png` |
| CMP-016 | Table / list | CMP-SHEET-02 | 7 | content; loading skeleton; no results; no matches; error; row selected; row action pending | `gallery-CMP-016-390.png`, `gallery-CMP-016-1440.png` |
| CMP-017 | Filter bar and pagination | CMP-SHEET-02 | 3 | default; selected; no matches | `gallery-CMP-017-390.png`, `gallery-CMP-017-1440.png` |
| CMP-018 | Card | CMP-SHEET-02 | 6 | plain; section; loading; content; empty; unavailable | `gallery-CMP-018-390.png`, `gallery-CMP-018-1440.png` |
| CMP-019 | Empty and error state | CMP-SHEET-02 | 3 | empty; no matches; load error | `gallery-CMP-019-390.png`, `gallery-CMP-019-1440.png` |
| CMP-020 | Menu | CMP-SHEET-03 | 6 | account menu open; row action menu open; item disabled; item hover; item focus; closed | `gallery-CMP-020-390.png`, `gallery-CMP-020-1440.png` |
| CMP-021 | File upload | CMP-SHEET-03 | 6 | idle; drag-over; uploading; processing; ready; rejected with reason | `gallery-CMP-021-390.png`, `gallery-CMP-021-1440.png` |
| CMP-022 | Job card (clip) | CMP-SHEET-03 | 11 | pending; created; processing; completed; failed; failed, temporary; failed, configuration; failed, unknown; QC passed; QC failed; QC skipped | `gallery-CMP-022-390.png`, `gallery-CMP-022-1440.png` |
| CMP-023 | Claim issue | CMP-SHEET-03 | 4 | high risk; other; open; closed | `gallery-CMP-023-390.png`, `gallery-CMP-023-1440.png` |
| CMP-024 | Segment editor | CMP-SHEET-01 | 5 | within target; short; over 45, blocked; saving; saved | `gallery-CMP-024-390.png`, `gallery-CMP-024-1440.png` |
| CMP-025 | Provider key card | CMP-SHEET-03 | 12 | openai active; openai untested; openai disabled; openai none; openai testing; openai delete-confirm; wavespeed active; wavespeed untested; wavespeed disabled; wavespeed none; wavespeed testing; wavespeed delete-confirm | `gallery-CMP-025-390.png`, `gallery-CMP-025-1440.png` |
| CMP-026 | Final preview | CMP-SHEET-03 | 4 | assembling; done; failed; out-of-date | `gallery-CMP-026-390.png`, `gallery-CMP-026-1440.png` |
| CMP-027 | Campaign row | CMP-SHEET-03 | 6 | history; draft; default; deleting; hover; focus | `gallery-CMP-027-390.png`, `gallery-CMP-027-1440.png` |
| CMP-028 | Metric tile and inline bar | CMP-SHEET-03 | 5 | counts value; estimated cost value; loading; no data; inline bar | `gallery-CMP-028-390.png`, `gallery-CMP-028-1440.png` |
| CMP-030 | Operator shell | SCREENS | 13 | shell-user-sidebar; shell-nav-states; shell-rail; shell-tabbar; shell-menu-user; shell-admin; shell-key-missing; shell-key-disabled; shell-toast; shell-nav-disabled; shell-nav-focus; shell-key-focus; shell-auto | `gallery-CMP-030-390.png`, `gallery-CMP-030-1440.png` |
| CMP-031 | Admin shell | SCREENS | 12 | admin-sidebar; admin-nav-states; admin-no-alerts; admin-many-alerts; admin-rail; admin-tabbar; admin-menu; admin-toast; admin-nav-disabled; admin-nav-focus; admin-unavailable; admin-auto | `gallery-CMP-031-390.png`, `gallery-CMP-031-1440.png` |
| CMP-032 | Auth shell | SCREENS | 5 | auth-signin; auth-message; auth-mfa; auth-loading; auth-error | `gallery-CMP-032-390.png`, `gallery-CMP-032-1440.png` |
| CMP-033 | Page header | SCREENS | 2 | default; breadcrumb and stage tabs | `gallery-CMP-033-390.png`, `gallery-CMP-033-1440.png` |
| CMP-034 | Page grid | SCREENS | 1 | 12 columns | `gallery-CMP-034-390.png`, `gallery-CMP-034-1440.png` |

## Outside the allowed list (needed)
- `apps/web/e2e/gallery-complete.spec.ts` (one import): Playwright's `testDir` is `e2e`, so the suite in `apps/web/tests/gallery` is loaded from there.
- `apps/web/e2e/__baselines__/chromium/gallery-CMP-*.png`: the snapshot template puts every baseline under `e2e/__baselines__`.

## Limitations
- Chromium only. Hover, focus and pressed are verified as a visible style change, not against pixel baselines (pseudo-states are not baselined, as in earlier tickets).
- CMP-005: a native select has no read-only state; recorded as not applicable in the inventory.
- The UI/UX parity report and baseline approval are the next review stage; none is claimed here.
- Running the whole `axe` grep of the e2e folder also runs earlier tickets' specs, whose `comp-forms-1440` baseline differed from a run on this branch (image height 1123 against 1379 px); the `@TASK-081` selection passes twice with identical baselines.

# UI and UX specification — ShrooMap AI UGC Ad Director

Status: **PROPOSED** (no independent review yet). Mockups are design evidence rendered from HTML frames, never screenshots of the running product.

## 1. Inputs and revisions

- PRD rev 2 (AIU-11 `prd` `c3220ab0`), including BA features F-01..F-13 and journeys J-01..J-08 (FLOW-01..FLOW-13).
- Shared boundaries v5 (AIU-12 `shared-boundaries` `96738dd7`); OpenAPI `1.0.0-design.2` (AIU-13 `openapi` `24f91d86`). Every `API-` ID below is an `x-api-id` of that file. Route paths and the `SCREEN-` numbering are proposed here; the Architect confirms routes against `apps/web` (open item 13.1).
- BRAND-BRIEF.md revision 1. Frames: `design/mockups/frames/*.html` (commit `94f30b1`); rendered PNG manifest `design/mockups/png/manifest.json`; overview sheets `UI-Mockups-Desktop.png`, `UI-Mockups-Mobile.png` (provenance: rendered from the frames by `render-frames.mjs` and `compose-overviews.mjs`, proposal status, no runtime data).
- Identity provider: sign-in, MFA enrolment and challenge, and password recovery are **provider-hosted components** themed with the tokens (shared boundaries; PRD FLOW-05). Frames show the provider slot (`idp-slot`) as a design proposal; the real provider UI is verified at build time.

## 2. Visual system

Tokens, type roles, spacing, radius, elevation and motion are defined in BRAND-BRIEF.md §4 to §6 and `tokens.css`; this document refers to them by name. Component-level additions (all in `tokens.css`): `--header-h` 56, `--tabbar-h` 64, `--sidebar-width` 240, `--rail-width` 64, `--content-narrow` 720, `--content-max` 1120, `--content-wide` 1200, `--control-h` 40 / `-sm` 32 / `-touch` 44, `--media-placeholder`. Portal override: `[data-portal="admin"]` replaces `--primary*` and `--sidebar-accent*` only.

## 3. Portals, shells and navigation

| Portal/role | Accent override | Shell | Nav items in order (label, icon, route, visible to) | User menu and context switcher | 1440 px | 768 px | 390 px | Frame |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Auth (anonymous or not linked) | none; dark brand panel on `--surface-inverse` | CMP-032 auth shell: split layout, brand panel + card | none | none | Two columns: brand panel 50%, card centred 420 px | Single column; panel hidden, lockup above card | Single column, card full width, 16 px margins | SCREEN-001..004 |
| Operator (role `user`, also admins in workspace) | none (`--primary` green) | CMP-030: sticky header 56 px, sidebar 240 px | Campaigns (`clapperboard`, `/campaigns`), New brief (`square-pen`, `/campaigns/new`), Provider keys (`key-round`, `/settings/provider-keys`); all active users | Avatar menu (CMP-020): "Signed in as Operator/Administrator", Provider keys, **Switch to administration** (admins only), Account and security (provider-hosted, external), Sign out. Header also shows a key-state badge: "Add provider keys" (warning) or "Key disabled" (destructive) linking to the key screen | Sidebar with labels | Icon rail 64 px, labels as `title` and `aria-label` | No sidebar; bottom tab bar 64 px with icon + short label | SCREEN-005..010 |
| Administrator | `[data-portal="admin"]` navy primary, 3 px top rule on header, "Administration" portal tag | CMP-031: same grid as operator | Accounts (`users`, `/admin/accounts`), Invitations (`mail-plus`, `/admin/invitations`), Usage report (`chart-column`, `/admin/usage`), Alerts (`bell`, `/admin/alerts`, count badge of unacknowledged), Settings (`settings`, `/admin/settings`); admins only (a non-admin gets 403 and sees the unavailable state). Sidebar foot: "Back to workspace" | Same menu; "Switch to workspace" | Sidebar 240 px | Icon rail; alert count becomes a dot | Tab bar, five items | SCREEN-011..015 |

States of a nav item (sidebar, rail and tab bar): default (`--sidebar-foreground`); hover (`--accent` background); focus (2 px `--ring` outline, 2 px offset, never clipped by the sticky header); current (`aria-current="page"`, `--sidebar-accent` background, 600 weight, 3 px `--primary` inset marker, the tab bar uses a top marker); disabled (`--disabled-foreground`, `aria-disabled`, only used for campaign stage tabs); collapsed rail (label hidden visually but kept as accessible name). A **skip link** ("Skip to content") is the first focusable element in every shell. **Page title pattern:** `<h1>` page title + optional one-line description (`.page-header`), primary action at the right (full width on phones); document title "Page · ShrooMap". **Breadcrumb** only inside a campaign: Campaigns › *campaign name*, with stage tabs (CMP-014) Brief, Clips, Final below it. Home route: signed-in users reach `/campaigns`, signed-out visitors reach sign-in (REQ-029).

## 4. Layout grid and content width

| Breakpoint | Columns | Gutter | Page margin | Max content width | Sidebar/rail width | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 320–767 (design at 390) | 1 (CMP-034 grid collapses) | 16 px | 16 px | fluid | none; bottom tab bar 64 px | Control height 44 px; tables become labelled stacked blocks; dialogs full width with stacked buttons; page scrolls vertically only |
| 768–1023 (design at 768) | 12 | 16 px | 24 px | fluid, capped by the page class | rail 64 px | Admin tables stay tabular with inner horizontal scroll if needed; two-column forms stay |
| 1024 and up (design at 1440) | 12 | 24 px | 32 px | `--content-max` 1120 default; `--content-wide` 1200 for tables and the workspace; `--content-narrow` 720 for forms and settings | sidebar 240 px | Content is centred in the main area; line length stays under about 75 characters via the page widths |

## 5. Fonts and icons

Inter variable (OFL 1.1), self-hosted latin and latin-ext files, weights 400/500/600, `font-display: swap`; fallback stack and licence as in BRAND-BRIEF.md §5. Lucide 1.73.0 (ISC) at 16, 20 and 24 px, 2 px stroke, one SVG per icon (list in `design/mockups/assets/icons/`). Mockups load the same files; no CDN.

### 5.1 Layout stability (CLS <= 0.1; decision AIU-295, NFR-02)

Nothing that arrives after first paint may change the size or position of anything already drawn. Three rules; the Frontend implements them in `packages/ui` only, no product scope changes.

**Inter fallback (size-adjusted, local).** Keep `font-display: swap` and add a metric-matched fallback face in `theme.css`, listed right after Inter in `--font-sans`:

```css
@font-face {
  font-family: 'Inter Fallback';
  src: local('Arial'), local('Liberation Sans'), local('Arimo'), local('Helvetica');
  font-weight: 400 600;
  size-adjust: 107.4%;
  ascent-override: 90.2%;
  descent-override: 22.48%;
  line-gap-override: 0%;
}
/* tokens.css */ --font-sans: "Inter", "Inter Fallback", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
```
The two real faces and their `unicode-range` stay as they are. Preloading is a second step, only if the measured font-swap CLS stays above 0.01: `<link rel="preload" as="font" type="font/woff2" crossorigin>` for the latin file in the app root layout (not latin-ext).

**Count slots (CMP-014 tab count, CMP-017 chip count).** A count is always drawn in a slot of fixed minimum width, in `tabular-nums`, centred. While the count is unknown (`count === null`, new state) the slot shows a muted placeholder of the same size (`--muted` pill, no animation under `prefers-reduced-motion`, `aria-hidden`, the control's accessible name has no number). `undefined` still means "this chip or tab has no count".
| Component | Slot | Loading | Loaded |
| --- | --- | --- | --- |
| CMP-014 tab count pill | `min-w-6` (24 px), height unchanged, `px-2`, `tabular-nums text-center` | pill with no text, 24 px wide | number; widths above 99 grow only inside the 24 px minimum up to 3 digits (`min-w-7` 28 px when the list can exceed 99) |
| CMP-017 chip count | `min-w-[2ch]` inside the chip, `tabular-nums text-center` | invisible text node `00` width, `bg-muted` 2 ch pill | number |
The chip group on phone is a single row that scrolls horizontally (`flex-nowrap overflow-x-auto`, no wrap) so a chip never moves to another line. A chip's label never changes after first paint. Screens pass `count: null` until the list query answers; they never mount counts one by one.

**Key-state slot (CMP-030).** The header key badge sits in a slot that exists in every state, including `ok` (empty). Slot size: 44 x 44 px under 768 px (icon only, as now); 8.5 rem x 24 px (136 px) from 768 px, content right-aligned. `KeyState` gains `unknown` (before API-010 answers): the slot draws a muted pill of the slot size (`aria-hidden`), then the real badge (`missing`, `disabled`) or nothing (`ok`) replaces it without changing the slot size. The badge text truncates (`truncate`) inside the slot; it never widens it. The account menu and nav do not move.

## 6. Component inventory and anatomy

All components take their values from tokens and live in `components.css` (class names in parentheses). Screens use components only by ID. Gallery frames: `CMP-SHEET-01` foundations and form controls, `-02` feedback, navigation and data, `-03` dialogs, upload and domain composites, `-04` brand and tokens (all at 1440 and 390).

| CMP ID | Component | Layer | Parts | Variants | Sizes | States | Tokens used | Keyboard/ARIA | Gallery frame | Used by |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CMP-001 | Brand: lockup, mark, favicon and app icons, social preview, manifest | Foundation | SVG lockup (light/dark/mono), mark, icon files, `site.webmanifest`, `social-preview.png` (1200×630) | Light, dark, mono ink, mono cream, maskable | Lockup ≥ 120 px wide; mark ≥ 24 px; favicon 16/32/48; 180; 192; 512 | n/a (static asset) | `--brand-*`, `--surface-inverse*` | Header lockup is a link with `aria-label="ShrooMap home"`; the image has `alt="ShrooMap"`; decorative uses `alt=""` | CMP-SHEET-04, BRAND-social-preview | All shells, SCREEN-001..004 |
| CMP-002 | Icon set | Foundation | Lucide SVG | n/a | 16, 20, 24 | n/a | `currentColor` | Decorative `aria-hidden`; icon-only buttons named | CMP-SHEET-01 | All |
| CMP-003 | Button | Primitive | Label, optional icon, spinner | Primary, secondary, outline, ghost, destructive, destructive-outline, icon-only | 40 (44 on phone), small 32 (44 on phone) | Default, hover, focus, active, disabled, pending (label changes, width stable, `aria-busy`) | `--primary*`, `--secondary*`, `--destructive*`, `--ring` | Native `button`/`a`; Enter and Space; icon-only has `aria-label` | CMP-SHEET-01 | All |
| CMP-004 | Input and textarea | Primitive | Control, optional counter | Text, textarea with counter, masked key input (`autocomplete="off"`, no reveal) | 40 / 44 | Empty, filled, focus, invalid, disabled, read-only | `--input`, `--card`, `--destructive`, `--ring` | Native; `aria-invalid`, `aria-describedby` | CMP-SHEET-01 | SCREEN-006, 007, 010, 011, 012 |
| CMP-005 | Select | Primitive | Native select styled | Single | 40 / 44 | Same as CMP-004 | as CMP-004 | Native select | CMP-SHEET-01 | SCREEN-006, 005 |
| CMP-006 | Choice controls | Primitive | Radio card, checkbox, segmented control, switch | Selected/unselected | 44 hit region | Default, hover, focus, checked, disabled (with "Not in this release" text) | `--primary`, `--input` | Native radio/checkbox; segmented as radio group; switch `role="switch"` | CMP-SHEET-01 | SCREEN-006, 009, 013 |
| CMP-007 | Badge / status | Primitive | Icon (optional) + text | Neutral, primary, success, info, warning, destructive | One size (caption/UI) | n/a; always text, never colour only | `--*-subtle`, `--*` | Text content is the label | CMP-SHEET-01 | All lists |
| CMP-008 | Loading: spinner, progress, skeleton | Primitive | Spinner, bar, skeleton blocks | Determinate/indeterminate | n/a | Reduced motion: static | `--muted`, `--primary` | `role="progressbar"` with value; skeleton region `aria-busy="true"` plus a visible text status | CMP-SHEET-01 | All loading states |
| CMP-009 | (reserved, unused) | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| CMP-010 | Form field | Composite | Label, required/optional mark, control, help text, error | Stacked, two-column grid on 768+ | n/a | Valid, invalid (error text with icon), disabled | `--destructive`, `--muted-foreground` | `label for`, help and error linked by `aria-describedby`; error summary focus on submit failure | CMP-SHEET-01 | All forms |
| CMP-011 | Alert | Composite | Icon, title, body, optional action | Info, success, warning, destructive | Full width | Persistent (no auto-dismiss); `role="status"` or `role="alert"` for blocking errors | `--*-subtle`, `--*-border`, `--*` | Announced on insert | CMP-SHEET-02 | All |
| CMP-012 | Toast | Composite | Message, optional action, close | Success, info, error | Top-right 360 px (full width less 32 px on phone) | Appearing, visible, dismissed; error toasts also stay in context; critical errors do not auto-dismiss | `--popover`, `--shadow-md` | Live region; close button named | CMP-SHEET-02 | SCREEN-005, 010, 012 |
| CMP-013 | Dialog | Composite | Title, body, optional typed confirmation, footer buttons | Confirm, typed confirm, form dialog | 480 px (full width less 24 px on phone) | Open, pending, error, dirty-discard | `--popover`, `--overlay` | `role="dialog"`, `aria-modal`, labelled title, focus moved in, trapped, Escape closes, focus returned | CMP-SHEET-03 | SCREEN-005, 007, 010, 011, 012 |
| CMP-014 | Tabs | Composite | Tab list, panels | Underline; stage tabs with count badges | 44 on phone | Selected, default, hover, focus, disabled | `--primary`, `--border` | `role="tablist"`, arrow keys, `aria-selected`; disabled tab `aria-disabled` | CMP-SHEET-02 | SCREEN-005, 007..009, 012 |
| CMP-015 | Stepper | Composite | Numbered steps with labels | 4-step wizard | Phone shows the current label only | Done, current, upcoming | `--primary`, `--muted` | `aria-current="step"`, ordered list with "Progress" label | CMP-SHEET-02 | SCREEN-006 |
| CMP-016 | Table / list | Composite | Header, rows, row actions | Table; stacked under 768 px (labelled blocks) | Row about 44 px | Loading skeleton, no results, error, row selected, row action pending | `--card`, `--border`, `--muted` | `th scope`, scroll region has `tabindex="0"`, `role="region"` and a label; sort buttons named | CMP-SHEET-02 | SCREEN-011, 012, 015 |
| CMP-017 | Filter bar and pagination | Composite | Search field, filter chips with counts, clear-all, Previous/Next with "n rows" | Chips single-select | Chips 44 on phone | Default, selected, no matches | `--primary-subtle` | Chips are toggle buttons with `aria-pressed`; pagination buttons named; URL state `?q=&status=&page=` | CMP-SHEET-02 | SCREEN-005, 011 |
| CMP-018 | Card | Composite | Header, body, footer | Plain, section | Fluid | Loading, content, empty, unavailable | `--card`, `--border` | Heading level inside; no nested interactive in one clickable area | CMP-SHEET-02 | All |
| CMP-019 | Empty and error state | Composite | Icon, heading, one sentence, first useful action | Empty, no matches, load error (Try again) | Fluid | n/a | `--muted-foreground` | Error uses `role="alert"` | CMP-SHEET-02 | SCREEN-005, 008, 009, 010, 011, 012, 014, 015 |
| CMP-020 | Menu | Composite | Label, items | Account menu; row action menu | Min 220 px; on phone full width less 24 px | Open, item hover, focus, disabled | `--popover`, `--shadow-md` | `aria-haspopup="menu"`, `role="menuitem"`, arrows, Escape returns focus | CMP-SHEET-03 | Shells, SCREEN-005, 011 |
| CMP-021 | File upload | Composite | Drop zone, file rows (name, size, status), remove | Image only | Fluid | Idle, drag-over, uploading (progress), processing, ready, rejected with reason | `--input`, `--primary-subtle`, `--destructive` | Zone is a labelled button that opens the file picker; status text per file, announced; no drag-only path | CMP-SHEET-03 | SCREEN-006 |
| CMP-022 | Job card (clip) | Domain | Segment label, status badge, 9:16 player or placeholder, QC row, actions (Generate, Retry, Re-run check) | Per job state: pending, created, processing, completed, failed (temporary, configuration or credit, outcome unknown) | Fluid; clip max 220 px wide on phone | All job states; QC passed, failed, skipped (reason) | status tokens | Buttons named with segment ("Retry segment 2"); status in text | CMP-SHEET-03 | SCREEN-008, 009 |
| CMP-023 | Claim issue | Domain | Class badge (High risk / Other), segment, quoted text, instruction, optional clear-with-reason field | High risk (no clear action), other (clear with reason), closed | Fluid | Open, closed | `--destructive-subtle`, `--warning-subtle` | Reason field labelled; clear button disabled until a reason exists | CMP-SHEET-03 | SCREEN-007 |
| CMP-024 | Segment editor | Domain | Segment heading, dialogue textarea, word counter, issues | Per segment 1..4 | Fluid | Within target (32 to 42), over 45 (blocked), saving, saved | `--success`, `--warning` | Counter text announced politely, not per keystroke | CMP-SHEET-01 (textarea with counter) | SCREEN-007 |
| CMP-025 | Provider key card | Domain | Provider name, state badge (Active, Untested, Disabled), hint (last 4), fingerprint, last tested, actions Replace and Delete, key-event trail link | Per provider (OpenAI, WaveSpeed) | Fluid | Active, untested, disabled, none, testing, delete-confirm | status tokens | Actions named per provider; hint in monospace; no reveal control exists | CMP-SHEET-03 | SCREEN-010 |
| CMP-026 | Final preview | Domain | 9:16 player, QC summary, download button (5-minute link re-issued on click), out-of-date notice, thumbstopper | Assembling, done, failed, out of date | Player max 220 px (phone), 320 px (desktop) | Pending to done states per REQ-011 | `--surface-inverse` | Player has controls and a text alternative (title, duration); download is a button that requests a fresh URL | CMP-SHEET-03 | SCREEN-009 |
| CMP-027 | Campaign row | Domain | Poster, name, meta (segments, duration, date), status badge, row actions | History, draft | Phone: 44 px poster, actions on a second line | Default, hover, focus, deleting | `--card`, `--border` | Whole name is the one link; actions are separate buttons | CMP-SHEET-03 | SCREEN-005 |
| CMP-028 | Metric tile and inline bar | Domain | Label, value (tabular), optional unit and delta text, bar | Counts, estimated cost (labelled "estimated") | 4 up on desktop, 2 up on tablet, 1 up on phone | Loading, value, no data | `--chart-*` | Value in text; bar has a numeric label | CMP-SHEET-03 | SCREEN-015 |
| CMP-030 | Operator shell | Layout | Header, sidebar/rail/tab bar, main, skip link, key badge, toast region | Role `user`, role `admin` (shows the switch) | See §3 | Nav item states (§3), menu open | `--sidebar*`, `--card` | Landmarks `header`, `nav aria-label="Main"`, `main` | Every SCREEN-005..010 frame | SCREEN-005..010 |
| CMP-031 | Admin shell | Layout | As CMP-030 plus portal tag and top rule | Alert count badge | See §3 | As CMP-030 | `[data-portal="admin"]` | As CMP-030 | SCREEN-011..015 frames | SCREEN-011..015 |
| CMP-032 | Auth shell | Layout | Brand panel, card, provider slot (`idp-slot`), mobile lockup | Sign-in, message, MFA | See §3 | Provider loading, error | `--surface-inverse*` | `main` landmark; one `h1` | SCREEN-001..004 frames | SCREEN-001..004 |
| CMP-033 | Page header | Layout | Title, description, actions | With breadcrumb and stage tabs in campaigns | n/a | n/a | type roles | One `h1` per page | Every frame | All |
| CMP-034 | Page grid | Layout | 12-column grid, `col-3/4/6/8/12` spans | Collapses to one column under 768 px | See §4 | n/a | `--space-*` | n/a | Frames using it | SCREEN-007..009, 013, 015 |

A screen that needs something not in this table is a design change: the component is added here, with its frame, first.

## 7. Screen inventory and matrix

Frame names are `<SCREEN>--<state>--<width>` (PNG in `design/mockups/png/`, HTML in `frames/`, `?state=<state>`). **Frames** lists the widths rendered; every state in the "Key states framed" column is rendered at each listed width (292 PNGs, including component sheets). Tickets are filled when the delivery plan is cut (AIU-19).

| Screen ID | Route (proposed) | Portal/role | REQ IDs | FLOW IDs | Pattern | Frames (widths) | Key states framed | API IDs | CMP IDs | Ticket |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SCREEN-001 | `/sign-in` | Auth, anonymous | REQ-002, 003, 004 | FLOW-05 | Auth, provider slot | 390, 1440 | default, loading, error, session-expired, invalid | none (provider-hosted) | CMP-001, 032, 003, 011, 008 | (filled at planning) |
| SCREEN-002 | `/access` | Auth, signed in but not linked, suspended or removed | REQ-003, 026 | FLOW-12 | Auth message | 390, 1440 | not-linked, request-pending, suspended, removed, invite-invalid | API-001, API-002 | CMP-032, 010, 004, 003, 011 | |
| SCREEN-003 | `/mfa` | Auth | REQ-004 | FLOW-05 | Auth, provider slot | 390, 1440 | default (enrol), error, challenge | none (provider-hosted) | CMP-032, 011, 003 | |
| SCREEN-004 | `*` (not found), unavailable record | Auth shell (any visitor) | REQ-029, 001 | FLOW-10 | Message | 390, 1440 | route-404, unavailable | none | CMP-032, 003, 019 | |
| SCREEN-005 | `/campaigns` (`?tab=history\|drafts&q=&status=&page=`) | Operator | REQ-012, 013 | FLOW-06, 07, 10 | List with search, filters and paging | 390, 1440 | default, loading, empty, no-results, error, delete-confirm, deleted, drafts, key-missing, menu-open | API-040, 020, 042, 025 | CMP-030, 033, 014, 017, 027, 007, 013, 012, 019, 011, 020 | |
| SCREEN-006 | `/campaigns/new` (`?draft=<id>`) | Operator | REQ-005, 006, 007, 019 (cap), 014 (key) | FLOW-01, 02 | Form wizard | 390, 1440 | default, step-1, step-3, step-4, validation-error, uploading, upload-rejected, saving, generating, conflict, key-missing, cap-reached, session-expired | API-021, 022, 023, 024, 025, 030, 031, 035, 036 | CMP-030, 015, 010, 004, 005, 006, 021, 011, 013, 003 | |
| SCREEN-007 | `/campaigns/[id]/brief` | Operator | REQ-007, 008, 030, 014 | FLOW-02 | Detail and editor | 390, 1440 | default, loading, failed, accept-blocked, clear-reason, accepted, regenerate-confirm, key-missing | API-041, 050, 051, 052, 053, 054 | CMP-030, 033, 014, 024, 023, 011, 013, 003 | |
| SCREEN-008 | `/campaigns/[id]/clips` | Operator | REQ-009, 010, 019 (caps), 014, 018 | FLOW-03 | Job list | 390, 1440 | default, loading, blocked, failures, qc-review, out-of-date, key-disabled, cap-reached | API-041, 060, 061, 062, 063, 064 | CMP-030, 014, 022, 011, 007, 003 | |
| SCREEN-009 | `/campaigns/[id]/final` | Operator | REQ-010 (confirm), 011, 022 | FLOW-04 | Detail and job | 390, 1440 | default, loading, no-clips, selecting, qc-confirm, assembling, failed, out-of-date | API-061, 070, 071, 075, 076, 032 | CMP-030, 014, 026, 006, 013, 011, 003 | |
| SCREEN-010 | `/settings/provider-keys` | Operator and admin | REQ-014..019 | FLOW-11 | Settings | 390, 1440 | default, loading, empty, add-dialog, testing, validation-error, rate-limited, step-up, saved, untested, replace-warning, delete-confirm, disabled | API-010, 011, 012, 013, 001 | CMP-030, 025, 004, 013, 011, 012, 007 | |
| SCREEN-011 | `/admin/accounts` | Administrator | REQ-003, 026, 013 | FLOW-12 | Data table with row actions | 390, 768, 1440 | default, loading, error, only-you, invite-dialog, suspend-confirm, remove-confirm, last-admin, erasures, menu-open | API-100..105 | CMP-031, 016, 017, 007, 013, 020, 011 | |
| SCREEN-012 | `/admin/invitations` | Administrator | REQ-003 | FLOW-12 | Tabbed data tables | 390, 768, 1440 | default, requests, requests-off, empty, loading, invite-error, resent | API-110..113, 115..117, 002 | CMP-031, 014, 016, 013, 012, 019, 007 | |
| SCREEN-013 | `/admin/settings` | Administrator | REQ-003, 004 | FLOW-12 | Settings | 390, 768, 1440 | default, open-refused, saved, loading | API-120, 121 | CMP-031, 006, 011, 012, 003, 007 | |
| SCREEN-014 | `/admin/alerts` | Administrator | REQ-013, 019, 026 | none (cross-cutting admin monitoring; REQ-013 deletion stalls, REQ-019 abuse alerts and REQ-026 admin changes raise the items it lists) | List with acknowledge | 390, 768, 1440 | default, empty, loading, acknowledged | API-125, 126 | CMP-031, 018, 007, 019, 003 | |
| SCREEN-015 | `/admin/usage` (`?from=&to=`) | Administrator | REQ-021 | FLOW-13 | Dashboard with tables | 390, 768, 1440 | default, loading, empty, error, window-too-large | API-130, 131 | CMP-031, 028, 016, 010, 019, 011 | |
| BRAND-social-preview | n/a (meta image) | n/a | n/a | n/a | Static image | 1200×630 | default | none | CMP-001 | |

PRD screen coverage check: sign-in, access states, MFA, 404/unavailable, campaign history and drafts, wizard, brief, clips and QC, final, provider keys, admin accounts, invitations and requests, settings, alerts, usage report: every screen named in PRD §4 appears. The PRD's FLOW-08 (profile) is excluded and FLOW-09 (console) is replaced by FLOW-13, so neither has a screen. Account and security (password, MFA devices) is the identity provider's own page, opened from the account menu, and is not designed here.

### Flows

| FLOW ID | Journey (PRD) | Actor | Ordered screens and transitions | Data carried between screens | Back, cancel, error and permission paths | End-to-end test |
| --- | --- | --- | --- | --- | --- | --- |
| FLOW-01 | Enter campaign inputs and resume (J-01) | Operator | SCREEN-005 → SCREEN-006 (steps 1 to 4, autosave draft) → SCREEN-007 | Draft ID in the URL, product image media ID | Save failure keeps values (validation-error, conflict); session expiry returns to the same step (session-expired); back to the list keeps the draft | TEST IDs assigned by QA (AIU-15) |
| FLOW-02 | Brief generation, edit, accept (J-02) | Operator | SCREEN-006 step 4 → SCREEN-007 → (accept) → SCREEN-008 | Campaign ID | Failed generation shows retry; open high-risk issue blocks acceptance; missing key goes to SCREEN-010 | |
| FLOW-03 | Generate clips, QC, retry (J-03) | Operator | SCREEN-007 (accepted) → SCREEN-008 → SCREEN-009 | Campaign ID, job IDs | Failed job shows its cause class and Retry; outcome-unknown never auto-retries; caps and key-disabled show blocked states | |
| FLOW-04 | Assemble and download the final (J-04) | Operator | SCREEN-008 → SCREEN-009 (select, order, QC confirm, assemble, download) | Selected clip order | Failed or skipped QC needs confirmation; out-of-date final shows rebuild; failed assembly retry | |
| FLOW-05 | Sign in and MFA | Any user | SCREEN-001 → SCREEN-003 → SCREEN-005 (or SCREEN-002 if not linked) | Requested URL preserved (PROPOSED) | Session expiry returns to SCREEN-001 with a safe return path; invalid state message | |
| FLOW-06 | History, drafts, search (J-05) | Operator | SCREEN-005 → SCREEN-007/008/009 | Query string state | Empty and no-results states differ; unavailable link goes to SCREEN-004 | |
| FLOW-07 | Delete a draft or campaign | Operator | SCREEN-005 (delete-confirm) → deleted toast | none | Cancel keeps the record; deleted record opens SCREEN-004 unavailable | |
| FLOW-10 | Not found / home route | Anyone | any unknown URL → SCREEN-004 → Go Home | none | Anonymous Go Home goes to sign-in | |
| FLOW-11 | Manage provider keys (J-06) | Operator, admin | SCREEN-010 (add, test, replace warning, delete) | Provider, key event trail | Failed test keeps the old key; repeated failures disable the key; step-up re-authentication; rate limit state | |
| FLOW-12 | Provision and remove accounts (J-07) | Admin | SCREEN-011 ⇄ SCREEN-012 (invite, approve, resend, revoke) → SCREEN-013 (signup mode); invitee: SCREEN-002 (invite state) → SCREEN-001 | User ID (never email outside the admin screens), invitation ID | Last-admin and self-removal refused; typed confirmation for remove; open mode refused until prerequisites | |
| FLOW-13 | Admin usage report (J-08) | Admin | SCREEN-015 | Time window | Window above 366 days refused with the limit; non-admin gets 403 and the unavailable state | |

Every screen belongs to a flow except SCREEN-014 (cross-cutting admin monitoring, reason in its row). FLOW-08 and FLOW-09 are not designed (PRD §6).

## 8. Per-screen specification

Common to every authenticated screen: it sits in its shell; server responsibility is authorisation, data and validation; client responsibility is form state and optimistic status display. Route indexability: **all routes are private and non-indexable** (`noindex`), including the 404 page (REQ-029). Metadata owner: Frontend (document title "Page · ShrooMap"). No analytics events are approved; none are designed.

**SCREEN-001 Sign in.** Goal: authenticate. Primary action: provider's sign-in. Provider-hosted component in `idp-slot`, themed (card, `--primary`, Inter). States: session-expired message above the form ("Your session ended. Sign in to continue."), invalid, error, loading. Accessible name: one `h1` "AI UGC Ad Director". Password managers and paste must work (provider requirement). Acceptance: anonymous visitor to any app route lands here (REQ-002); an expired session returns to the same URL after sign-in.

**SCREEN-002 Access unavailable.** Goal: explain why access is not granted and offer the next step. Variants: not linked (request-access form, API-002, same message whether or not the email exists), request pending, suspended ("Contact your administrator"), removed, invite invalid or expired. No account existence is revealed. Acceptance: a not-linked token reaches only API-001 and API-002 (shared boundaries); the same invite message shows for registered and new addresses (REQ-003).

**SCREEN-003 Two-step verification.** Provider-hosted enrol and challenge themed to match; copy states that recovery re-proves a second factor. Acceptance: MFA required for all accounts by default (REQ-004).

**SCREEN-004 Not found or unavailable.** One message for missing, deleted or not-yours records (BR-22) with "Go Home"; no data, no hint. Acceptance per REQ-029 and REQ-001.

**SCREEN-005 Campaigns.** Goal: find and reopen work. Primary action: New brief. Hierarchy: header, History/Drafts tabs with counts, search, status chips (All, Processing, Completed, Failed), list. Data: name, segments, duration, date, status; sorted newest first; paged (API-040 cursor/page per OpenAPI). Search by product name or description. URL state `?tab&q&status&page`; changing a filter resets the page; chips show count and "Clear filters". Delete: confirm dialog stating the media removal (API-042 for campaigns, API-025 for drafts), success toast. Key-missing banner links to SCREEN-010. Responsive: rows collapse to poster + text, actions on a second line. Acceptance: REQ-012 (empty vs no-match states differ, no repeat or skip across pages), REQ-013.

**SCREEN-006 New brief wizard.** Goal: enter inputs and generate the brief. Steps: 1 Style and intake mode, 2 Product (name, description, image upload with processing, analysis), 3 Audience and direction (segment count 1 to 4 shows duration segments × 15 s), 4 Review and generate. Autosave draft (API-023) with visible "Saved" feedback; failed save keeps values and shows an error with retry; conflict state offers the latest version; "Start over" is a confirm dialog. Submit (API-024) disables, shows "in progress"; key-missing and cap-reached block submit with an explanation. Upload states per CMP-021 (10 MB, JPEG/PNG/WebP/GIF, rejected reason). Focus: on validation failure, focus moves to the first invalid field and an error summary lists them. Responsive: one column; stepper shows the current label only. Acceptance: REQ-005, 006, 007.

**SCREEN-007 Brief.** Goal: review, edit and accept copy. Primary action: Accept brief (disabled with reason while claim issues are open). Segment editors with word counters (target 32 to 42, hard maximum 45), claim issues list: high-risk class has no clear action (edit until the re-check passes), other classes can be cleared with a reason (API-054). Secondary: Regenerate (confirm dialog), Copy prompts (only on an Accepted brief, REQ-030). Acceptance: REQ-007, 008, 030.

**SCREEN-008 Clips.** Goal: generate clips, watch status, retry. Job cards per segment, per-clip QC status with reason, "Generate" and "Retry" per segment (API-060/063), "Re-run check" (API-064). States show failure cause classes (temporary, configuration or credit, outcome unknown with "check your provider account"; never auto-retried). Out-of-date marks clips whose brief changed. Blocked when the brief is not accepted, the key is missing or disabled, or the cap is reached. Polling or refresh keeps existing content (no blanking). Acceptance: REQ-009, 010, 019, 014, 018.

**SCREEN-009 Final ad.** Goal: choose clips and order, confirm QC exceptions, assemble, download. Selection list with Move up and Move down buttons (no drag), failed or skipped QC clips require an explicit confirm dialog (API-070), assembly progress by state (pending, queued, fetching, rendering, saving, done, failed), download button re-requests a 5-minute link (API-032), out-of-date notice when a clip changed, optional thumbstopper (API-075/076). Acceptance: REQ-010, 011, 022.

**SCREEN-010 Provider keys.** Goal: manage own WaveSpeed and OpenAI keys. Per-provider card (CMP-025). Add or Replace dialog: masked field, no autofill, format check plus a non-billing test (testing state), result shows hint and fingerprint and the "cannot be shown again" reminder; replace shows the in-flight-jobs warning before entry; delete is a confirm dialog; a provider without a non-billing test stores the key as `untested`. Step-up state requires recent sign-in/MFA. Rate-limited state states the wait. Key-event trail (API-013). A disabled key shows its notice here and at the next job attempt. Content security: no third-party scripts on this page (REQ-019). Acceptance: REQ-014..019.

**SCREEN-011 Accounts.** Goal: administer accounts. Table (account with email and user ID, role, state, two-step, last active) with filter and paging, row menu: Suspend, Reinstate, Remove (typed confirmation), Grant or Revoke admin; header action Invite (dialog). Email appears only here (PRD §3.1). Last-admin and self-removal refused with an explanation (states `only-you`, `last-admin`). Erasures panel shows removal progress (API-105). Phone: stacked labelled rows. Acceptance: REQ-003, 026, 013.

**SCREEN-012 Invitations and requests.** Tabs: Invitations (status, expiry, Resend, Revoke) and Access requests (Approve, Decline); when sign-up mode is `open` the requests tab explains requests are off (`requests-off`). Invite to an existing address shows the same success message. Acceptance: REQ-003.

**SCREEN-013 Settings.** Sign-up mode switch (invited only or open) with prerequisites; a refusal explains what is missing (`open-refused`); read-only security configuration (MFA scope, invite expiry) shown as values. Acceptance: REQ-003, 004.

**SCREEN-014 Alerts.** List of unacknowledged and acknowledged alerts (stuck deletion, abuse, admin changes) with Acknowledge. Sidebar badge shows the count. Contains no emails, only user IDs. Acceptance: REQ-013, 019, 026.

**SCREEN-015 Usage report.** Window selector (default 30 days, maximum 366; larger refused with the limit stated), "as of" time, metric tiles, per-account and per-provider tables (calls, successes, failures, estimated cost labelled estimate, latency, job states), claim-check counts, optional CSV (API-131). By user ID; no content, no key material. Acceptance: REQ-021.

## 9. Screen state matrix

Every screen has its own states in the frames (§7 "Key states framed"). The table below fixes the shared behaviour; a row is N/A only with the reason shown.

| State | What the user sees | Available action | Verification | Frame |
| --- | --- | --- | --- | --- |
| Initial loading | Skeleton blocks in the final layout with `aria-busy` and a visible status text | Safe navigation | Layout does not jump | `<SCREEN>--loading--*` for SCREEN-001, 005, 007..015 (SCREEN-006 shows `saving` and `generating`; 002..004 are static messages: N/A) |
| No data yet | Honest explanation and first action | New brief, Add key, Invite | No fake data | SCREEN-005, 010, 012, 014, 015 `empty`; SCREEN-009 `no-clips` |
| No filter matches | Current filters and specific text | Clear filters | Differs from the empty state | SCREEN-005 `no-results` |
| Background refresh | Existing data stays; subtle indicator | Keep working | Content not blanked | N/A as a frame: a design rule for polling on SCREEN-008/009 |
| Submission pending | Pending button, duplicate prevention, "in progress" | None | Width stable | `saving`, `generating`, `assembling`, `testing` |
| Field validation failure | Field error plus summary; focus to first invalid | Correct and resubmit | Input kept | SCREEN-006, 010 `validation-error`, SCREEN-012 `invite-error` |
| Conflict/stale | Latest version offered | Refresh | No silent overwrite | SCREEN-006 `conflict`, SCREEN-008/009 `out-of-date` |
| Permission denied | Unavailable state, no existence hint | Go Home | API still denies | SCREEN-004 `unavailable`, SCREEN-002 |
| Session expired | Banner and sign-in with safe return | Re-authenticate | Values saved are kept | SCREEN-001 and 006 `session-expired` |
| Offline/provider failure | Safe failure, retry, cause class | Retry when safe; "outcome unknown" never auto-retried | No false success | SCREEN-008 `failures`, SCREEN-009 `failed`, SCREEN-007 `failed` |
| Removed/not found | Unavailable page | Go Home | No retries | SCREEN-004 |

## 10. Journeys

Operator, first use: sign in (SCREEN-001) → MFA enrol (SCREEN-003) → Campaigns empty (SCREEN-005 `empty`/`key-missing`) → Provider keys (SCREEN-010 add, test, saved) → New brief (SCREEN-006 steps 1 to 4, generating) → Brief (SCREEN-007 edit, clear or fix issues, accept) → Clips (SCREEN-008 generate, QC review, retry) → Final (SCREEN-009 select, confirm QC, assemble, download) → back to Campaigns. Recovery: expired session returns to the same step; failed clip retries; key replaced mid-job is explained. Admin: sign in → Accounts (SCREEN-011) → Invite (dialog) → Invitations (SCREEN-012) → Settings (SCREEN-013) → Usage (SCREEN-015) and Alerts (SCREEN-014).

## 11. Filters, bulk actions and context switching

Filters on SCREEN-005 and SCREEN-011 are URL state (`q`, `status`, `page`); a filter change resets the page; chips show count and "Clear filters". There are no bulk actions in this release (SCREEN-009 selection is not a bulk action; it picks clips). Role switching (workspace ⇄ administration) is a link between portals; no tenant data is held client-side across the switch.

## 12. Accessibility plan

Per journey the checks are the keyboard path (Tab order follows reading order; skip link first; dialogs trap and return focus), announcements (toasts and alerts as live regions, form errors via summary and `aria-describedby`), 320 px reflow, 200% zoom and text-spacing captures, and reduced-motion emulation. Owners: Frontend implements; QA runs the manual checks (AIU-15 cases); UI/UX records visual and accessibility findings during build review. Status: automated axe on the mockup frames only (BRAND-BRIEF.md §8); everything on the running application is NOT RUN.

## 13. Open questions and decisions

1. Routes and the `SCREEN-` numbering are proposed; the Architect confirms them against the Next.js route plan (owner: Solution Architect).
2. Whether generated videos need captions (WCAG 1.2) is not stated in the PRD (owner: Product Manager; default: not required, audio QC is the only text check).
3. Identity-provider screens (SCREEN-001, 003) can only be themed within the provider's capabilities; the frames are the target and the Frontend records deviations (owner: Frontend, UI/UX review).
4. Dark theme: not included; adding it needs its own contrast table (owner: Product Owner, default none).
5. Placeholder content in frames (names, IDs, numbers) is invented for design and is not data.

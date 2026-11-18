# Brand brief — ShrooMap AI UGC Ad Director

- Requirements revision: PRD rev 2 (AIU-11 `prd`, `c3220ab0`); shared boundaries v5 (AIU-12, `96738dd7`); OpenAPI `1.0.0-design.2` (AIU-13, `24f91d86`)
- Existing identity: **owner-supplied**, three files attached to AIU-14 and kept in `design/brand/source/`: `shroomap-icon.png` (64×64), `shroomap-logo-light-background.png`, `shroomap-logo-dark-background.png` (1000×250). Owner decision "brand assets": **answered with these files**. No logo is invented.
- Scope: extend an existing identity into a complete system (tokens, type, icons, components)
- Brief revision: 1 (this document). Mockup frame manifest: `design/mockups/png/manifest.json`, repository commit `94f30b1` on `feature/AIU-14-sdlc-ux-design-design-brand-responsive-screens-and-mockups`
- Status: **REVIEWED and APPROVED at G2**. Reviewed revision: brief rev 1 (`bc352148`, commit `48ebc1a`, AIU-14). Independent reviews, all PASS on 2026-11-14: UI/UX visual and accessibility (Frontend Reviewer), contract feasibility (Solution Architect), journey coverage (Product Manager). Approving gate: G2, AIU-20 (completed 2026-11-15), which carries this brief as its `brand-brief` document. Later edits to `design/` follow the normal ticket review.

## 1. Product understanding

| Input | Evidence/source | Fact or assumption | Design implication |
| --- | --- | --- | --- |
| Purpose and main user outcome | PRD §2, REQ-005..011 | Fact: operators brief, generate and assemble brand-checked UGC video ads (15 to 60 s, 1 to 4 segments) | The campaign workspace (Brief, Clips, Final) is the core; a three-stage tab model keeps progress visible |
| Users, familiarity, frequency | PRD §3.1 | Fact: invited staff (operators) and administrators; no public users. Frequency of use is an assumption (daily to weekly, no research) | Compact, scannable, but with plain-language guidance at each stage; no onboarding tour |
| Critical journeys and error consequences | PRD §6, REQ-009, 014, 017, 018 | Fact: every clip and key action costs real money on the user's own provider accounts; a replaced or deleted key fails jobs in flight | Warnings before replace/delete, pending states that prevent duplicate submits, honest "outcome unknown" copy, no automatic retry |
| Data density | PRD REQ-012, 021 | Fact: lists of campaigns, accounts, usage tables; admin tables are the densest | 14 px table text, 768 px frames for admin, stacked rows on phones |
| Devices, locales, accessibility | PRD NFR section | Assumption: desktop first, phone supported; English only (no locale requirement found); WCAG 2.2 AA is the target | Frames at 390, 768 (admin) and 1440; Inter latin and latin-ext only |
| Existing identity | AIU-14 attachments | Fact: mushroom mark (cap green, stem beige in a light disc), navy "SHROO", brown "MAP" (light) or cream "SHROO", rust "MAP" (dark) | Palette is built around the sampled colours; the product stays light, warm and calm |

Open questions that change the design: none block G2. Items for the owner, all with a default applied (autonomous mode): (1) whether a dark theme is wanted (default: light only, see §4); (2) who may approve the brand voice (PRD POR-14, brand approver); the voice section is proposed review guidance, not an acceptance test.

## 2. Direction and rationale

Required direction: clean, minimal, professional, light, compact and readable, plain sans-serif.

| Product/user evidence | Design choice | Expected benefit (hypothesis) | How it is checked |
| --- | --- | --- | --- |
| Owner mark is a soft green, beige and navy mushroom on a light disc | Warm off-white page (`--background`), white cards, one muted forest-green action colour derived from the cap, navy text | Calm, trustworthy surface that matches the owner's identity | Owner preview (AIU-24); UXV review against frames |
| Money is spent per action | Single primary action per region, destructive actions in a distinct token with text, confirm dialogs that state consequences | Fewer accidental spends | Visual review of confirm states; QA cases for REQ-017/018 |
| Admin tables hold many rows | 14 px data text, 40 px rows, tabular figures, labelled stacked rows under 768 px | Faster comparison without clutter | 768 and 390 frames; text-spacing check |
| Pastel brand colours fail contrast as text | Cap green is graphic-only; a darker `--primary` (#4A6F47) carries text and buttons (5.74:1 with white) | AA everywhere without leaving the palette family | §4 measurements |
| Admins work in a different place from operators | Admin portal keeps the same tokens but swaps `--primary` to navy and adds a 3 px top rule and a portal tag | Hard to act in the wrong portal by mistake | Frames SCREEN-011..015 |

Exclusions: no gradients, glow, glass or ornamental illustration; no dark mode in this release; no colour-psychology claims. No conflict with the owner's identity: the owner files are used unchanged as the logo; only their derivative palette is proposed.

## 3. Identity

- **Product name as approved:** "ShrooMap" (wordmark "SHROO" + "MAP"). The product is titled "ShrooMap AI UGC Ad Director" in titles and the manifest; the wordmark itself is never changed.
- **Wordmark:** two-tone caps, "SHROO" in `--brand-ink` #232D38 and "MAP" in `--brand-brown` #6A503C on light; "SHROO" in `--brand-cream` #F5F1E6 and "MAP" in `--brand-rust` #9E6240 on dark. Traced from the owner's PNGs into clean SVG paths (geometry in `design/brand/geometry.json`, built by `design/brand/build-brand-assets.mjs`). SVG sources: `design/brand/svg/shroomap-wordmark-light.svg`, `…-dark.svg`.
- **Mark:** the owner's mushroom (cap `--brand-cap` #5C8658, stem `--brand-stem` #D5BFA8) in a sage ring (`--brand-sage` #B9C5B7) on a disc (`--brand-disc` #EFF3EB). SVG: `shroomap-mark.svg` (light), `shroomap-mark-on-dark.svg`, `shroomap-icon.svg` (full disc), `shroomap-icon-maskable.svg`.
- **Lockups:** `shroomap-logo-light.svg` (default, on `--background`, `--card`, `--muted`); `shroomap-logo-dark.svg` (only on `--surface-inverse` #161C23 or darker: the auth brand panel, social preview); monochrome `…-mono-ink.svg` and `…-mono-cream.svg` for single-colour contexts (print, stamps, email text-only clients).
- **When used:** light lockup in the app header and on auth cards; dark lockup on the auth brand panel (1024 px and up) and the social preview image; mark alone where the lockup would fall under its minimum width; monochrome only where a single colour is forced.
- **Clear space:** 25% of the lockup height on every side. **Minimum sizes:** lockup 120 px wide, mark 24 px; below that, use the 16/32 px favicon cut. App header renders the lockup at 30 px height (26 px on phone).
- **Do not:** stretch, rotate, recolour, outline, add effects, place the light lockup on a dark or busy background, or place the dark lockup on navy #232D38 (MAP rust is 2.84:1 there; on #161C23 it is 3.49:1, accepted for a logo, which is exempt from WCAG 1.4.3, and the name is also given as text).
- **Favicon and app icons** (`design/brand/icons/`): `favicon.svg`; `favicon.ico` (16, 32, 48); `favicon-16/32/48.png`; `apple-touch-icon.png` (180); `icon-192.png`, `icon-512.png`; `icon-maskable-512.png` (artwork inside the central 80% safe zone); `site.webmanifest` (name, short name "ShrooMap", `theme_color` #4A6F47, `background_color` #FBF9F4); `social-preview.png` (1200×630, from `frames/BRAND-social-preview.html`). All are CMP-001.
- **Licences and ownership:** logo files and the mark are supplied by and owned by the product owner; the traced SVGs are derivative reproductions of them for the owner's own use. Inter is SIL OFL 1.1 (`assets/fonts/INTER-LICENSE-OFL-1.1.txt`); Lucide is ISC (`assets/icons/LUCIDE-LICENSE-ISC.txt`).
- **Fidelity of the traced SVG to the PNG:** a visual comparison was done while building; a recorded pixel-difference measurement is **NOT RUN** and is listed for the UI/UX Reviewer.

## 4. Palette and semantic tokens

Source of truth: `design/mockups/tokens.css` (the only file with raw colour values). Values marked [owner] were sampled from the owner's files; all others are PROPOSED derivations. Contrast was computed from the token values with the WCAG relative-luminance formula (script run this session; values below are those results).

| Token | Value (light) | Paired with | Used by | Contrast measured | Status |
| --- | --- | --- | --- | --- | --- |
| `--background` / `--foreground` | #FBF9F4 / #232D38 [owner navy] | each other | Page, body text | 13.27:1 | PROPOSED |
| `--card` / `--card-foreground` | #FFFFFF / #232D38 | each other | Cards, inputs, header, sidebar | 13.96:1 | PROPOSED |
| `--popover` / `-foreground` | #FFFFFF / #232D38 | each other | Menus, dialogs | 13.96:1 | PROPOSED |
| `--muted` / `--muted-foreground` | #F5F1E6 [owner cream] / #566170 | `--muted-foreground` on background 5.98, card 6.29, muted 5.57 | Help text, captions, placeholders, table headers | ≥ 5.57:1 | PROPOSED |
| `--primary` / `-foreground` | #4A6F47 / #FFFFFF | each other; `--primary` text on card 5.74, on background 5.46 | Primary button, links, selected states | 5.74:1; hover #3C5A3A 7.73; active #314A31 9.75 | PROPOSED |
| `--primary-subtle` | #E8F0E4 | `--primary` text on it 4.93; sidebar-accent-fg #263B27 10.37 | Selected nav, badges, avatar | ≥ 4.93:1 | PROPOSED |
| `--secondary` / `--accent` (+ -foreground) | #F5F1E6 / #F0ECE0, foreground #232D38 | foreground | Secondary button, hover rows | ≥ 12:1 | PROPOSED |
| `--border` | #DDD6C6 | background | Decorative card, divider lines only | 1.38:1 (decorative, no meaning carried) | PROPOSED |
| `--border-strong` | #CFC6B2 | background | Chips, avatar button outline (the control also has a label) | decorative | PROPOSED |
| `--input` | #7C8590 | card 3.74, background 3.55 | Input, select, checkbox, radio borders | ≥ 3:1 (1.4.11) | PROPOSED |
| `--ring` | #232D38 | background 13.27, card 13.96; on inverse use cream 15.2 | Focus ring, 2 px with 2 px offset | ≥ 13:1 | PROPOSED |
| `--destructive` (+ -foreground, -subtle, -border) | #B42318 / #FFFFFF; subtle #FDECEA; border #E8A39C | solid 6.57; text on subtle 5.75; on card 6.57 | Destructive button, error text, invalid field | ≥ 5.75:1 | PROPOSED |
| `--warning` | #7A4B00 / #FFFFFF; subtle #FFF4D6; border #D9A93A | solid 7.41; text on subtle 6.76 | Key missing, attention | ≥ 6.76:1 | PROPOSED |
| `--success` | #2C6B3A / #FFFFFF; subtle #E4F2E3; border #8FC08F | solid 6.42; on subtle 5.54 | Completed, saved | ≥ 5.54:1 | PROPOSED |
| `--info` | #2A5B8C / #FFFFFF; subtle #E6EEF6; border #8FB0D3 | solid 7.06; on subtle 6.03 | Neutral notices | ≥ 6.03:1 | PROPOSED |
| `--overlay` | rgb(22 28 35 / 0.56) | n/a | Dialog scrim | n/a | PROPOSED |
| Disabled | `--disabled` #EAE6DB, `--disabled-foreground` #6F7782 | 3.63:1 | Disabled controls (exempt from 1.4.3; never the only cue, a "Not in this release" or helper label accompanies) | 3.63:1 | PROPOSED |
| `--surface-inverse` (+ foreground, muted) | #161C23 [proposed deepest navy] / #F5F1E6 / #B9C5B7 | 15.2 / 9.58 | Auth brand panel, video player surround, social preview | ≥ 9.58:1 | PROPOSED |
| `--sidebar*` | #FFFFFF; fg #232D38; muted #566170; accent #E8F0E4; border #DDD6C6 | see above | Sidebar, tab bar | ≥ 6.29:1 | PROPOSED |
| `--chart-1..5` | #4A6F47, #9E6240, #2A5B8C, #8A6D4B, #566170 | on card 5.74, 4.91, 7.06, 4.81, 6.29 | Usage report bars; always with a value label | ≥ 4.81:1 | PROPOSED |
| Raw brand (graphic only) | `--brand-cap` #5C8658 (3.99 on background, 4.19 on card: graphics, not text), `--brand-stem` #D5BFA8, `--brand-brown` #6A503C (7.06), `--brand-rust` #9E6240, `--brand-cream`, `--brand-ink`, `--brand-sage`, `--brand-disc`, `--brand-midnight` | n/a | Logo and illustration only, never component code | n/a | owner values |
| Portal override `[data-portal="admin"]` | `--primary` #232D38 (13.96 with white), hover #34414F, active #161C23, subtle #E9ECEF; `--sidebar-accent` #E9ECEF | white | Admin buttons, active nav, 3 px header rule | ≥ 13.96:1 | PROPOSED |

Where the owner's colour is too light for text, a darker same-hue token is used for text and controls and the exact owner colour stays in the logo (cap green on white is 4.19:1, below 4.5:1 for text).

**Dark theme:** N/A in this release (light is the starting theme; the owner did not ask for one; the dark logo exists only for dark panels). Adding it later is a design change with its own contrast table. **Mapping to the stack:** these are shadcn-compatible variables; with Tailwind 4 they go in the global stylesheet `:root` and are exposed by `@theme inline` (`--color-primary: var(--primary)` and so on). Components use `bg-primary text-primary-foreground`; no palette or hex values outside the token file. Non-shadcn names added here: `--primary-hover/-active/-subtle`, `--*-subtle`, `--*-border`, `--surface-inverse*`, `--border-strong`, `--media-placeholder`.

## 5. Typography and density

- **Font:** Inter variable (wght 100 to 900), self-hosted, SIL OFL 1.1. Files: `inter-latin-wght-normal.woff2`, `inter-latin-ext-wght-normal.woff2` in `design/mockups/assets/fonts/` (to be vendored in the app, for example with `next/font/local`). No runtime request to a font CDN. `font-display: swap`. Weights used: 400, 500, 600. Fallback: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`. Coverage: Latin and Latin Extended (English; no RTL or CJK requirement exists). Monospace (`--font-mono`, system) only for user IDs, fingerprints and key hints.
- **Roles:** page heading 24/32, 600 (`--text-page`); section heading 18/28, 600; body 16/24, 400; UI/table 14/20, 400 and 500; caption 12/16, 500 (auxiliary only: tags, counts). All in rem.
- **Numbers:** tabular numerals (`font-variant-numeric: tabular-nums`) in tables and metrics. Dates `14 Nov 2026`, times 24 h with zone abbreviation, durations `45 s`, currency `US$1,284.60` labelled "estimated"; locale en-US/en-GB number grouping (comma).
- **Spacing:** 4, 8, 12, 16, 24, 32, 48 px (`--space-*`, `--spacing` 4 px). **Radius:** `--radius` 8 px (sm 4, md 6, xl 12, full for avatars and badges). **Elevation:** `--shadow-sm/md/lg`, used only on menus, dialogs and toasts; cards use a border.
- **Controls:** height 40 px desktop (`--control-h`), 32 px small, 44 px under 768 px (`--control-h-touch`); header 56 px; tab bar 64 px; table rows about 44 px with a 14 px text; hit regions ≥ 40 px (≥ 44 px on phones).
- **Long content and zoom:** no fixed heights on text containers, long names truncate with a title only where an action label is also present, 320 px reflow and 200% zoom are acceptance checks (§8, NOT RUN).

## 6. Icons, imagery and motion

- **Icons:** Lucide 1.73.0 (ISC), 16, 20, 24 px, 2 px stroke; individual SVGs in `assets/icons/`, imported one by one in the app. Decorative icons are `aria-hidden`; icon-only buttons have an accessible name (for example "Delete key").
- **Imagery:** no stock photography or illustration. Media is user content (product images, generated clips, thumbstopper) shown in stable aspect ratios (9:16 for clips) on `--media-placeholder` while loading; user media gets alt text from the product name. The mockups use placeholder tiles, not images.
- **Motion:** `--duration-fast` 120 ms, `--duration-base` 180 ms, `--ease-standard`. Used for hover, dialogs, progress. `prefers-reduced-motion: reduce` sets durations to 0 and stops skeleton and spinner animation.

## 7. Voice and copy

- **Tone:** calm, modest, plain; second person for actions ("Add your provider keys"); no hype, no urgency, no emoji. Product copy that touches regulated claims follows the PRD rules (no treatment, cure, dosing or psychedelic language in generated or UI text, no em dash, adults 21+ framing). Brand voice review (PRD POR-14) is guidance for the brand approver.
- **Terminology (one word per concept):** Campaign, Brief, Clip (a generated video for one Segment), Final ad, Provider key, Invitation, Access request, Suspend (reversible) versus Remove (erases), Estimated cost.
- **Patterns:** error = what happened + what to do ("Could not save. Try again."); empty = what it is + first useful action ("No campaigns yet. Create a brief."); success = short toast ("Campaign deleted."); permission = one "unavailable" state that does not reveal whether a record exists (BR-22). Email addresses appear only on the admin account screens and the invite message; everywhere else the user ID shows (PRD §3.1).
- **Locale:** en; dates and numbers as in §5.

## 8. Accessibility evidence and plan (WCAG 2.2 AA)

| Area | Criteria/acceptance | Procedure/environment | Result/evidence | Owner |
| --- | --- | --- | --- | --- |
| Text/non-text contrast, non-colour cues | 1.4.3, 1.4.11, 1.4.1 | Computed from token values (§4) | Token pairs measured, all ≥ thresholds (disabled and decorative borders noted). Rendered-page measurement **NOT RUN** | UI/UX; Frontend |
| Automated axe (wcag2a/aa, 21a/aa, 22aa) on every frame, state and width | No violations | `design/mockups/axe-check.mjs` over `frames.json`; report `png/axe-report.json` | 248 frame/state/width combinations, 0 violations in the report committed with the frames; not re-run in this session. Automated only, not a conformance claim | UI/UX |
| Keyboard, focus visible/not obscured, dialogs | 2.1.1, 2.4.7, 2.4.11 | Manual tab-through of the running app | **NOT RUN** (no running app yet) | QA; UI/UX review |
| Target size, pointer/drag alternatives | 2.5.8, 2.5.7 | Bounding boxes; no drag-only action is designed (clip order uses "Move up" and "Move down" buttons) | Design rule in place; measurement **NOT RUN** | QA |
| Reflow (320 px), 200% zoom, text spacing | 1.4.10, 1.4.4, 1.4.12 | 320 px viewport; 200% zoom at 1280 px; spacing CSS injection | **NOT RUN** | QA |
| Labels, errors, announcements, authentication | 3.3.1, 3.3.2, 3.3.7, 4.1.3 | Screen-reader names, `aria-describedby`; password manager and paste on the identity-provider sign-in | **NOT RUN**; sign-in and MFA screens are provider-hosted and themed (see UI-UX.md SCREEN-001/003) | QA; Frontend |
| Reduced motion, timing, media | 2.3.3, 2.2.1, 1.2 | Emulate `prefers-reduced-motion`; session-expiry flow | **NOT RUN**; generated video has no captions requirement recorded (open item for the PM) | QA |

No conformance claim until verification on the running application is complete.

## 9. Handoff to the design-system (component) tickets

- **Token file:** `design/mockups/tokens.css` maps one-to-one to the app's global stylesheet (§4). Layout constants (`--sidebar-width` 240, `--rail-width` 64, `--header-h` 56, `--tabbar-h` 64, `--content-narrow` 720, `--content-max` 1120, `--content-wide` 1200, control heights) are tokens.
- **Fonts and icons:** font files and loading as in §5; Lucide as in §6; the icon list used by the mockups is the contents of `design/mockups/assets/icons/`.
- **Brand component CMP-001:** SVG sources, favicon/app icons and manifest, social preview image, with frame `CMP-SHEET-01`.
- **Shared components:** CMP-002 to CMP-034 as listed in UI-UX.md §6, each with states, taken from `components.css` class names.
- **Order:** tokens and fonts → brand assets and shells (CMP-001, 030..034) → shared components with all states → feature screens by SCREEN ID → rendered visual and accessibility verification.

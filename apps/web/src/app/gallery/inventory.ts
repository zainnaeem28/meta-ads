/**
 * The component inventory of UI-UX §6 as the gallery must show it (TASK-081, NFR-07).
 * Every live CMP ID lists the states the spec names and a Playwright selector that must resolve on the gallery page;
 * the registry check (inventory.test.ts and e2e/gallery-complete.spec.ts) fails when a component or a state has no entry.
 * CMP-009 is reserved and CMP-029 was never assigned: neither exists.
 */

export type Sheet = 'CMP-SHEET-01' | 'CMP-SHEET-02' | 'CMP-SHEET-03' | 'CMP-SHEET-04' | 'SCREENS';

/** A state reached by interaction (hover, focus, pressed, a click sequence) rather than shown at rest. */
export type Action =
  | { kind: 'hover' | 'focus' | 'press'; on: string }
  | { kind: 'click'; on: string[] };

export interface StateEntry {
  state: string;
  /** Playwright selector that must match at least one visible element once the action (if any) is done. */
  selector: string;
  action?: Action;
  /** `hidden` when the state is the absence of an element (a dismissed toast). */
  expect?: 'visible' | 'hidden';
}

export interface InventoryEntry {
  id: string;
  name: string;
  /** Gallery frame the component sits on (UI-UX §6, column "Gallery frame"); layout components sit on the screen frames. */
  sheet: Sheet;
  states: StateEntry[];
  /** Selector of the element the component's baseline screenshot is taken of. */
  anchor: string;
  /** Listed states that do not exist for this component, each with the reason. */
  notApplicable?: Record<string, string>;
}

const cell = (id: string) => `[data-cell="${id}"]`;
const s = (state: string, selector: string, extra: Partial<StateEntry> = {}): StateEntry => ({ state, selector, ...extra });
const hover = (on: string) => ({ action: { kind: 'hover', on } as const });
const focus = (on: string) => ({ action: { kind: 'focus', on } as const });
const press = (on: string) => ({ action: { kind: 'press', on } as const });

const BUTTON_VARIANTS = ['primary', 'secondary', 'outline', 'ghost', 'destructive', 'destructive-outline'] as const;
const buttonStates = (variant: string): StateEntry[] =>
  ['default', 'disabled', 'pending'].map((st) => s(`${variant} ${st}`, cell(`CMP-003/${variant}/${st}`)));

const TEXT_STATES = ['empty', 'filled', 'invalid', 'disabled', 'read-only'] as const;
const field = (kind: string, states: readonly string[]) => states.map((st) => s(`${kind} ${st}`, cell(`CMP-004/${kind}/${st}`)));

const PROVIDERS = ['openai', 'wavespeed'] as const;
const KEY_STATES = ['active', 'untested', 'disabled', 'none', 'testing', 'delete-confirm'] as const;

export const INVENTORY: InventoryEntry[] = [
  {
    id: 'CMP-001',
    name: 'Brand: lockup, mark, favicon and app icons',
    sheet: 'CMP-SHEET-04',
    anchor: '[data-testid=brand-gallery]',
    states: ['light', 'dark', 'mono-ink', 'mono-cream'].flatMap((v) => [
      s(`${v} lockup`, `[data-case="${v}-lockup-120"]`),
      s(`${v} mark`, `[data-case="${v}-mark-24"]`),
    ]),
  },
  {
    id: 'CMP-002',
    name: 'Icon set',
    sheet: 'CMP-SHEET-01',
    anchor: '[data-testid=icon-grid]',
    states: [s('16 px', '[data-testid=icon-grid] [data-icon-cell]'), s('decorative, aria-hidden', '[data-testid=icon-grid] svg[aria-hidden=true]')],
  },
  {
    id: 'CMP-003',
    name: 'Button',
    sheet: 'CMP-SHEET-01',
    anchor: cell('CMP-003/primary/default'),
    states: [
      ...BUTTON_VARIANTS.flatMap(buttonStates),
      s('hover', cell('CMP-003/primary/default'), hover(`${cell('CMP-003/primary/default')} button`)),
      s('focus', cell('CMP-003/primary/default'), focus(`${cell('CMP-003/primary/default')} button`)),
      s('active', cell('CMP-003/primary/default'), press(`${cell('CMP-003/primary/default')} button`)),
      s('small', cell('CMP-003/small/default')),
      s('with icon', cell('CMP-003/with-icon/default')),
      s('icon-only default', cell('CMP-003/icon-only/default')),
      s('icon-only disabled', cell('CMP-003/icon-only/disabled')),
      s('icon-only pending', cell('CMP-003/icon-only/pending')),
      s('anchor', cell('CMP-003/anchor/default')),
    ],
  },
  {
    id: 'CMP-004',
    name: 'Input and textarea',
    sheet: 'CMP-SHEET-01',
    anchor: cell('CMP-004/text/empty'),
    states: [
      ...field('text', TEXT_STATES),
      ...field('textarea', TEXT_STATES),
      ...field('key', ['empty', 'filled', 'invalid', 'disabled']),
      s('focus', cell('CMP-004/text/empty'), focus(`${cell('CMP-004/text/empty')} input`)),
    ],
  },
  {
    id: 'CMP-005',
    name: 'Select',
    sheet: 'CMP-SHEET-01',
    anchor: cell('CMP-005/single/empty'),
    states: [
      ...['empty', 'filled', 'invalid', 'disabled'].map((st) => s(`single ${st}`, cell(`CMP-005/single/${st}`))),
      s('focus', cell('CMP-005/single/empty'), focus(`${cell('CMP-005/single/empty')} select`)),
    ],
    notApplicable: { 'read-only': 'a native select has no read-only state' },
  },
  {
    id: 'CMP-006',
    name: 'Choice controls',
    sheet: 'CMP-SHEET-01',
    anchor: cell('CMP-006/radio-card/default'),
    states: [
      ...['radio-card', 'checkbox', 'switch'].flatMap((k) =>
        ['default', 'checked', 'disabled'].map((st) => s(`${k} ${st}`, cell(`CMP-006/${k}/${st}`))),
      ),
      s('checkbox not in this release', cell('CMP-006/checkbox/unavailable')),
      s('switch not in this release', cell('CMP-006/switch/unavailable')),
      s('segmented control', cell('CMP-006/segmented/default')),
      s('hover', cell('CMP-006/radio-card/default'), hover(`${cell('CMP-006/radio-card/default')} label > span`)),
      s('focus', cell('CMP-006/checkbox/default'), focus(`${cell('CMP-006/checkbox/default')} input`)),
    ],
  },
  {
    id: 'CMP-007',
    name: 'Badge / status',
    sheet: 'CMP-SHEET-01',
    anchor: '[data-testid=badge-variants]',
    states: [
      ...['neutral', 'primary', 'success', 'info', 'warning', 'destructive'].map((v) => s(v, `[data-testid=badge-variants] [data-variant=${v}]`)),
      s('with icon', '[data-testid=badge-icons] [data-icon]'),
    ],
  },
  {
    id: 'CMP-008',
    name: 'Loading: spinner, progress, skeleton',
    sheet: 'CMP-SHEET-01',
    anchor: '[data-testid=prim-b]',
    states: [
      s('spinner', '[data-testid=spinner] [data-spinner]'),
      s('progress determinate', '[data-testid=progress] [role=progressbar][data-state=determinate]'),
      s('progress indeterminate', '[data-testid=progress] [role=progressbar][data-state=indeterminate]'),
      s('skeleton region', '[data-testid=skeleton] [aria-busy=true]'),
    ],
  },
  {
    id: 'CMP-010',
    name: 'Form field',
    sheet: 'CMP-SHEET-01',
    anchor: '[data-testid=form-demo]',
    states: [
      s('valid', '[data-testid=form-demo] [data-state=valid]'),
      s('disabled', '[data-testid=form-demo] [data-state=disabled]'),
      s('invalid with error summary', '[data-testid=form-demo] [aria-invalid=true]', {
        action: { kind: 'click', on: ['[data-testid=form-demo] button[type=submit]'] },
      }),
    ],
  },
  {
    id: 'CMP-011',
    name: 'Alert',
    sheet: 'CMP-SHEET-02',
    anchor: '[data-testid=alerts]',
    states: ['info', 'success', 'warning', 'destructive'].map((v) => s(v, `[data-testid=alerts] [data-variant=${v}]`)),
  },
  {
    id: 'CMP-012',
    name: 'Toast',
    sheet: 'CMP-SHEET-02',
    anchor: '[data-testid=toast-static]',
    states: [
      s('success', '[data-testid=toast-static] [data-variant=success]'),
      s('info', '[data-testid=toast-static] [data-variant=info]'),
      s('error', '[data-testid=toast-static] [data-variant=error]'),
      s('appearing', '[data-testid=toast-appearing]'),
      s('visible', '[data-testid=toast-static] [data-state=visible]'),
      s('dismissed', 'text=Live success toast.', {
        expect: 'hidden',
        action: {
          kind: 'click',
          on: ['role=button[name="Show success toast"]', 'xpath=//p[text()="Live success toast."]/ancestor::*[.//button[@aria-label="Close notification"]][1]//button[@aria-label="Close notification"]'],
        },
      }),
    ],
  },
  {
    id: 'CMP-013',
    name: 'Dialog',
    sheet: 'CMP-SHEET-03',
    anchor: cell('dialog-states'),
    states: [
      s('open, confirm', `${cell('dialog-states')} [data-variant=confirm][data-state=open]`),
      s('typed confirm', `${cell('dialog-states')} [data-variant=typed-confirm]`),
      s('form dialog', `${cell('dialog-states')} [data-variant=form][data-state=open]`),
      s('pending', `${cell('dialog-states')} [data-state=pending][aria-busy=true]`),
      s('error', `${cell('dialog-states')} [data-state=error] [role=alert]`),
      s('dirty-discard', `${cell('dialog-states')} [data-state=dirty-discard]`),
    ],
  },
  {
    id: 'CMP-014',
    name: 'Tabs',
    sheet: 'CMP-SHEET-02',
    anchor: cell('tabs-selected'),
    states: [
      s('selected', `${cell('tabs-selected')} [role=tab][data-state=selected]`),
      s('default', `${cell('tabs-selected')} [role=tab][data-state=default]`),
      s('disabled', `${cell('tabs-selected')} [role=tab][data-state=disabled]`),
      s('count badges', `${cell('tabs-selected')} [role=tab] span`),
      s('hover', cell('tabs-first'), hover(`${cell('tabs-first')} [role=tab][data-state=default] >> nth=0`)),
      s('focus', cell('tabs-first'), focus(`${cell('tabs-first')} [role=tab] >> nth=0`)),
    ],
  },
  {
    id: 'CMP-015',
    name: 'Stepper',
    sheet: 'CMP-SHEET-02',
    anchor: cell('stepper-1'),
    states: [
      s('done', `${cell('stepper-1')} [data-state=done]`),
      s('current', `${cell('stepper-1')} [aria-current=step]`),
      s('upcoming', `${cell('stepper-1')} [data-state=upcoming]`),
      s('last step current', `${cell('stepper-3')} [aria-current=step]`),
    ],
  },
  {
    id: 'CMP-016',
    name: 'Table / list',
    sheet: 'CMP-SHEET-02',
    anchor: cell('table-content'),
    states: [
      s('content', cell('table-content')),
      s('loading skeleton', `${cell('table-loading')} [aria-busy=true]`),
      s('no results', cell('table-empty')),
      s('no matches', cell('table-nomatches')),
      s('error', cell('table-error')),
      s('row selected', cell('table-selected')),
      s('row action pending', `${cell('table-pending')} [aria-busy=true]`),
    ],
  },
  {
    id: 'CMP-017',
    name: 'Filter bar and pagination',
    sheet: 'CMP-SHEET-02',
    anchor: cell('filter-default'),
    states: [
      s('default', cell('filter-default')),
      s('selected', `${cell('filter-selected')} [aria-pressed=true]`),
      s('no matches', cell('filter-nomatches')),
    ],
  },
  {
    id: 'CMP-018',
    name: 'Card',
    sheet: 'CMP-SHEET-02',
    anchor: cell('card-plain'),
    states: [
      s('plain', cell('card-plain')),
      s('section', cell('card-section')),
      s('loading', `${cell('card-loading')} [aria-busy=true]`),
      s('content', cell('card-link')),
      s('empty', cell('card-empty')),
      s('unavailable', cell('card-unavailable')),
    ],
  },
  {
    id: 'CMP-019',
    name: 'Empty and error state',
    sheet: 'CMP-SHEET-02',
    anchor: cell('empty-empty'),
    states: [s('empty', cell('empty-empty')), s('no matches', cell('empty-nomatches')), s('load error', `${cell('empty-error')} [role=alert]`)],
  },
  {
    id: 'CMP-020',
    name: 'Menu',
    sheet: 'CMP-SHEET-03',
    anchor: cell('menu-account'),
    states: [
      s('account menu open', `${cell('menu-account')} [role=menu]`),
      s('row action menu open', `${cell('menu-row')} [role=menu]`),
      s('item disabled', `${cell('menu-row')} [role=menuitem][aria-disabled=true]`),
      s('item hover', cell('menu-hover')),
      s('item focus', `${cell('menu-focus')} [role=menu]`),
      s('closed', `${cell('menu-closed')} [aria-haspopup=menu]`),
    ],
  },
  {
    id: 'CMP-021',
    name: 'File upload',
    sheet: 'CMP-SHEET-03',
    anchor: cell('upload-idle'),
    states: [
      s('idle', cell('upload-idle')),
      s('drag-over', cell('upload-drag-over')),
      s('uploading', `${cell('upload-rows')} [role=progressbar]`),
      s('processing', `${cell('upload-rows')} >> text=/processing/i`),
      s('ready', `${cell('upload-rows')} >> text=/ready/i`),
      s('rejected with reason', `${cell('upload-rows')} >> text=/rejected|not accepted|too large|unsupported/i`),
    ],
  },
  {
    id: 'CMP-022',
    name: 'Job card (clip)',
    sheet: 'CMP-SHEET-03',
    anchor: '[data-testid=job-cards]',
    states: [
      ...['pending', 'created', 'processing', 'completed', 'failed'].map((st) => s(st, `[data-testid=job-cards] [data-state=${st}]`)),
      ...['temporary', 'configuration', 'unknown'].map((c) => s(`failed, ${c}`, `[data-testid=job-cards] [data-cause=${c}]`)),
      ...['passed', 'failed', 'skipped'].map((q) => s(`QC ${q}`, `[data-testid=job-cards] [data-qc=${q}]`)),
    ],
  },
  {
    id: 'CMP-023',
    name: 'Claim issue',
    sheet: 'CMP-SHEET-03',
    anchor: '[data-testid=claim-issues]',
    states: [
      s('high risk', '[data-testid=claim-issues] [data-class=high-risk]'),
      s('other', '[data-testid=claim-issues] [data-class=other]'),
      s('open', '[data-testid=claim-issues] [data-state=open]'),
      s('closed', '[data-testid=claim-issues] [data-state=closed]'),
    ],
  },
  {
    id: 'CMP-024',
    name: 'Segment editor',
    sheet: 'CMP-SHEET-01',
    anchor: '[data-testid=segment-editors]',
    states: [
      s('within target', '[data-testid=segment-editors] [data-case=within]'),
      s('short', '[data-testid=segment-editors] [data-case=short]'),
      s('over 45, blocked', '[data-testid=segment-editors] [data-case=over]'),
      s('saving', '[data-testid=segment-editors] [data-case=saving]'),
      s('saved', '[data-testid=segment-editors] [data-case=saved]'),
    ],
  },
  {
    id: 'CMP-025',
    name: 'Provider key card',
    sheet: 'CMP-SHEET-03',
    anchor: '[data-testid=key-cards]',
    states: PROVIDERS.flatMap((p) => KEY_STATES.map((st) => s(`${p} ${st}`, cell(`key-${p}-${st}`)))),
  },
  {
    id: 'CMP-026',
    name: 'Final preview',
    sheet: 'CMP-SHEET-03',
    anchor: '[data-testid=final-previews]',
    states: ['assembling', 'done', 'failed', 'out-of-date'].map((st) => s(st, cell(`preview-${st}`))),
  },
  {
    id: 'CMP-027',
    name: 'Campaign row',
    sheet: 'CMP-SHEET-03',
    anchor: '[data-testid=campaign-rows]',
    states: [
      s('history', '[data-testid=campaign-rows] [data-variant=history]'),
      s('draft', '[data-testid=campaign-rows] [data-variant=draft]'),
      s('default', '[data-testid=campaign-rows] [data-state=default]'),
      s('deleting', '[data-testid=campaign-rows] [data-state=deleting]'),
      s('hover', '[data-testid=campaign-rows]', hover('[data-testid=campaign-rows] [data-state=default] >> nth=0')),
      s('focus', '[data-testid=campaign-rows]', focus('[data-testid=campaign-rows] [data-state=default] a >> nth=0')),
    ],
  },
  {
    id: 'CMP-028',
    name: 'Metric tile and inline bar',
    sheet: 'CMP-SHEET-03',
    anchor: '[data-testid=metric-tiles]',
    states: [
      s('counts value', '[data-testid=metric-tiles] [data-variant=counts][data-state=value]'),
      s('estimated cost value', '[data-testid=metric-tiles] [data-variant=cost][data-state=value]'),
      s('loading', '[data-testid=metric-tiles] [data-state=loading]'),
      s('no data', '[data-testid=metric-tiles] [data-state=no-data]'),
      s('inline bar', '[data-testid=inline-bar] [role=meter], [data-testid=inline-bar] [role=progressbar]'),
    ],
  },
  {
    id: 'CMP-030',
    name: 'Operator shell',
    sheet: 'SCREENS',
    anchor: cell('shell-user-sidebar'),
    states: [
      'shell-user-sidebar', 'shell-nav-states', 'shell-rail', 'shell-tabbar', 'shell-menu-user', 'shell-admin',
      'shell-key-missing', 'shell-key-disabled', 'shell-toast', 'shell-nav-disabled', 'shell-nav-focus', 'shell-key-focus', 'shell-auto',
    ].map((c) => s(c, cell(c))),
  },
  {
    id: 'CMP-031',
    name: 'Admin shell',
    sheet: 'SCREENS',
    anchor: cell('admin-sidebar'),
    states: [
      'admin-sidebar', 'admin-nav-states', 'admin-no-alerts', 'admin-many-alerts', 'admin-rail', 'admin-tabbar', 'admin-menu',
      'admin-toast', 'admin-nav-disabled', 'admin-nav-focus', 'admin-unavailable', 'admin-auto',
    ].map((c) => s(c, cell(c))),
  },
  {
    id: 'CMP-032',
    name: 'Auth shell',
    sheet: 'SCREENS',
    anchor: cell('auth-signin'),
    states: ['auth-signin', 'auth-message', 'auth-mfa', 'auth-loading', 'auth-error'].map((c) => s(c, cell(c))),
  },
  {
    id: 'CMP-033',
    name: 'Page header',
    sheet: 'SCREENS',
    anchor: cell('header-default'),
    states: [s('default', cell('header-default')), s('breadcrumb and stage tabs', cell('header-campaign'))],
  },
  {
    id: 'CMP-034',
    name: 'Page grid',
    sheet: 'SCREENS',
    anchor: cell('grid'),
    states: [s('12 columns', cell('grid'))],
  },
];

/** The 32 live IDs of UI-UX §6: CMP-001..008, 010..028 and 030..034 (009 reserved, 029 unassigned). */
export const LIVE_IDS: string[] = [
  ...Array.from({ length: 8 }, (_, i) => i + 1),
  ...Array.from({ length: 19 }, (_, i) => i + 10),
  ...Array.from({ length: 5 }, (_, i) => i + 30),
].map((n) => `CMP-${String(n).padStart(3, '0')}`);

export const SHEETS: Sheet[] = ['CMP-SHEET-01', 'CMP-SHEET-02', 'CMP-SHEET-03', 'CMP-SHEET-04', 'SCREENS'];

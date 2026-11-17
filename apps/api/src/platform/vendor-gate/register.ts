import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The vendor compliance register (`docs/compliance/vendor-register.json`, T-14): which vendors touch personal data and
// whether their contract is recorded. Loading fails closed: a missing or malformed file records nothing.

export type ContractStatus = 'not-recorded' | 'recorded' | 'off';

export interface ContractRecord {
  readonly reference: string;
  readonly recordedOn: string;
}

export interface VendorEntry {
  readonly id: string;
  readonly name: string;
  readonly service: string;
  readonly receives: string;
  readonly classification: string;
  readonly contractNeeded: string;
  /** The environment key that selects the adapter's data mode; null for a vendor with no adapter mode. */
  readonly dataModeKey: string | null;
  readonly contractStatus: ContractStatus;
  readonly contractRecord: ContractRecord | null;
}

export interface VendorRegister {
  readonly vendors: readonly VendorEntry[];
  readonly absentAdapters: readonly string[];
}

export const EMPTY_REGISTER: VendorRegister = { vendors: [], absentAdapters: [] };

const STATUSES: readonly string[] = ['not-recorded', 'recorded', 'off'];
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

function entryOf(raw: unknown): VendorEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const e = raw as Record<string, unknown>;
  const text = ['id', 'name', 'service', 'receives', 'classification', 'contractNeeded'] as const;
  if (!text.every((k) => isText(e[k]))) return undefined;
  if (!(e['dataModeKey'] === null || isText(e['dataModeKey']))) return undefined;
  if (typeof e['contractStatus'] !== 'string' || !STATUSES.includes(e['contractStatus'])) return undefined;
  const rec = e['contractRecord'];
  let contractRecord: ContractRecord | null = null;
  if (rec !== null) {
    if (typeof rec !== 'object' || rec === undefined) return undefined;
    const r = rec as Record<string, unknown>;
    if (!isText(r['reference']) || !isText(r['recordedOn'])) return undefined;
    contractRecord = { reference: r['reference'], recordedOn: r['recordedOn'] };
  }
  return {
    id: e['id'] as string,
    name: e['name'] as string,
    service: e['service'] as string,
    receives: e['receives'] as string,
    classification: e['classification'] as string,
    contractNeeded: e['contractNeeded'] as string,
    dataModeKey: e['dataModeKey'] as string | null,
    contractStatus: e['contractStatus'] as ContractStatus,
    contractRecord,
  };
}

/** Parses the register text; any structural fault yields the empty register (nothing recorded). */
export function parseRegister(text: string): VendorRegister {
  try {
    const raw = JSON.parse(text) as { vendors?: unknown; absentAdapters?: unknown };
    if (!Array.isArray(raw.vendors) || !Array.isArray(raw.absentAdapters)) return EMPTY_REGISTER;
    const vendors = raw.vendors.map(entryOf);
    if (vendors.some((v) => v === undefined)) return EMPTY_REGISTER;
    if (!raw.absentAdapters.every(isText)) return EMPTY_REGISTER;
    return { vendors: vendors as VendorEntry[], absentAdapters: raw.absentAdapters as string[] };
  } catch {
    return EMPTY_REGISTER;
  }
}

/** True only for an entry that is marked recorded and carries a record. */
export function hasRecordedContract(entry: VendorEntry): boolean {
  return entry.contractStatus === 'recorded' && entry.contractRecord !== null;
}

export const REGISTER_RELATIVE_PATH = join('docs', 'compliance', 'vendor-register.json');

/** Finds the register by walking up from this file (works from `src` and from `dist`); undefined when absent. */
export function locateRegister(from: string = dirname(fileURLToPath(import.meta.url))): string | undefined {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, REGISTER_RELATIVE_PATH);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function loadRegister(path: string | undefined = locateRegister()): VendorRegister {
  if (path === undefined || !existsSync(path)) return EMPTY_REGISTER;
  return parseRegister(readFileSync(path, 'utf8'));
}

/** The vendors ARCHITECTURE §12 and the stack list name; the diff below proves the register covers all of them. */
export const REQUIRED_VENDOR_IDS: readonly string[] = [
  'clerk',
  'cloudflare-r2',
  'openai',
  'wavespeed',
  'render',
  'sentry',
  'uptime-monitor',
  'shotstack',
];

export interface RegisterDiff {
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
  readonly duplicates: readonly string[];
}

export function diffRegister(register: VendorRegister, required: readonly string[] = REQUIRED_VENDOR_IDS): RegisterDiff {
  const ids = register.vendors.map((v) => v.id);
  return {
    missing: required.filter((id) => !ids.includes(id)),
    unexpected: ids.filter((id) => !required.includes(id)),
    duplicates: ids.filter((id, i) => ids.indexOf(id) !== i),
  };
}

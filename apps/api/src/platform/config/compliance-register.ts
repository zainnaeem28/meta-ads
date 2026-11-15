// The vendor data contracts recorded in the compliance register (CREG, T-14).
// A vendor is listed here only when its contract is recorded; until then PROVIDER_DATA_MODE_<VENDOR> stays
// `synthetic` and `real` is refused at startup. Recording a contract is a reviewed change to this list.

export const PROVIDER_VENDORS = ['OPENAI', 'WAVESPEED', 'SHOTSTACK'] as const;
export type ProviderVendor = (typeof PROVIDER_VENDORS)[number];

export interface ComplianceRegister {
  hasRecordedContract(vendor: ProviderVendor): boolean;
}

const RECORDED_CONTRACTS: ReadonlySet<ProviderVendor> = new Set<ProviderVendor>();

export const complianceRegister: ComplianceRegister = {
  hasRecordedContract: (vendor) => RECORDED_CONTRACTS.has(vendor),
};

import { brandRulesSeedStep } from '../../modules/brief/index.js';
import { priceTableSeedStep } from '../../modules/usage/index.js';
import type { SeedStep } from '../index.js';
import { developmentCampaignsStep, developmentKeysStep, developmentUsersStep } from './development.js';
import { platformSettingsStep } from './reference.js';

export { SeedRefusedError } from './errors.js';
export { DEV_CAMPAIGNS, DEV_IDENTITY_USERS, DEV_STUB_KEYS } from './fixtures.js';

/**
 * Every step `db:seed` runs, in dependency order: the reference rows first, then the development users, their keys and
 * campaigns. The dataset of each step decides whether it runs (the price table, the brand rules and the settings row are
 * reference data and run in all three).
 */
export function buildSeedSteps(env: Readonly<Record<string, string | undefined>> = process.env): SeedStep[] {
  return [
    priceTableSeedStep(),
    brandRulesSeedStep(),
    platformSettingsStep,
    developmentUsersStep,
    developmentKeysStep(env),
    developmentCampaignsStep,
  ];
}

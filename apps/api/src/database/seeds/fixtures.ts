// Synthetic identifiers of the development dataset (OD-15): fixed UUIDv7 values, reserved `.invalid` addresses, no real person.

export const DEV_ADMIN_ID = '0197a1b2-0000-7000-8000-00000000d001';
export const DEV_MEMBER_ID = '0197a1b2-0000-7000-8000-00000000d002';

/** The users the local identity fake is given with `addUser(sub, email)` so a local sign-in reaches these rows. */
export const DEV_IDENTITY_USERS = [
  {
    id: DEV_ADMIN_ID,
    sub: 'user_seed_admin',
    email: 'seed.admin@example.invalid',
    role: 'admin',
    linkedVia: 'first_admin',
  },
  {
    id: DEV_MEMBER_ID,
    sub: 'user_seed_member',
    email: 'seed.member@example.invalid',
    role: 'user',
    linkedVia: 'invitation',
  },
] as const;

export const DEV_CAMPAIGNS = [
  {
    id: '0197a1b2-0000-7000-8000-00000000c001',
    state: 'active',
    productName: 'Seed Active Product',
    segmentCount: 2,
  },
  {
    id: '0197a1b2-0000-7000-8000-00000000c002',
    state: 'deleting',
    productName: 'Seed Deleting Product',
    segmentCount: 1,
  },
] as const;

/** Stub provider keys: well-formed for the format check, valid at no provider. */
export const DEV_STUB_KEYS = [
  {
    id: '0197a1b2-0000-7000-8000-00000000a001',
    provider: 'openai',
    plaintext: 'sk-seedstubnotarealkey0001',
  },
  {
    id: '0197a1b2-0000-7000-8000-00000000a002',
    provider: 'wavespeed',
    plaintext: 'seedstubnotarealkey0002xx',
  },
] as const;

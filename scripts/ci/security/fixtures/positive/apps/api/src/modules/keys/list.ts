// expect: shroomap.key-custody.no-unprojected-provider-keys-select
import { providerKeys } from './schema';

export function listAll(db: { select: () => { from: (t: unknown) => unknown } }): unknown {
  return db.select().from(providerKeys);
}

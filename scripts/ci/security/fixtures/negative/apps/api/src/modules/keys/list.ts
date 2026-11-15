// expect: none
import { providerKeys } from './schema';

export function listMeta(db: {
  select: (cols: unknown) => { from: (t: unknown) => unknown };
}): unknown {
  return db
    .select({ id: providerKeys.id, label: providerKeys.label, state: providerKeys.state })
    .from(providerKeys);
}

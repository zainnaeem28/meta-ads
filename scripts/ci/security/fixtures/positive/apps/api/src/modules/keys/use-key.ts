// expect: shroomap.key-custody.no-withdecryptedkey-outside-worker
import { withDecryptedKey } from '../provider-keys/infrastructure/key-unsealer';

export async function handler(id: string): Promise<void> {
  await withDecryptedKey(id, async (key) => key.length);
}

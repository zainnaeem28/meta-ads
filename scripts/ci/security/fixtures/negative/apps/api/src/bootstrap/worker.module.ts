// expect: none
import { withDecryptedKey } from '../modules/provider-keys/infrastructure/key-unsealer';

export async function render(id: string): Promise<number> {
  return withDecryptedKey(id, async (key) => key.length);
}

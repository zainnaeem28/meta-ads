/** A seed the environment, the database or the inputs do not allow: exit code 2, never a partial write. */
export class SeedRefusedError extends Error {
  constructor(reason: string) {
    super(`seed refused: ${reason}`);
    this.name = 'SeedRefusedError';
  }
}

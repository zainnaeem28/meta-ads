// expect: none
export async function byName(
  db: { query: (s: string, p: unknown[]) => Promise<unknown> },
  name: string,
): Promise<unknown> {
  return db.query('select id, name from shrooms where name = $1', [name]);
}

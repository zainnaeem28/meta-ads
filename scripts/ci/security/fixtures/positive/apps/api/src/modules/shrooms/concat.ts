// expect: shroomap.sql.no-interpolated-identifiers
export async function byName(
  db: { query: (s: string) => Promise<unknown> },
  name: string,
): Promise<unknown> {
  return db.query("select * from shrooms where name = '" + name + "'");
}

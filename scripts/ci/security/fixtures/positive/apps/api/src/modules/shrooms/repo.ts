// expect: shroomap.sql.no-interpolated-identifiers
export async function byColumn(
  db: { query: (s: string) => Promise<unknown> },
  column: string,
): Promise<unknown> {
  return db.query(`select ${column} from shrooms`);
}

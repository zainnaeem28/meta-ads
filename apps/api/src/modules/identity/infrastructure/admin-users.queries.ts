import { and, desc, eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { users } from '../../../database/schema/identity.js';
import type { AdminUserListed, AdminUserQueries, AdminUserQuery } from '../application/admin.ports.js';
import type { Db } from '../application/ports.js';

/** Read side of the admin account list (API-100); served by `users_created_idx`. */
export class AdminUserListQueries implements AdminUserQueries {
  async list(db: Db, query: AdminUserQuery): Promise<AdminUserListed[]> {
    const conditions: SQL[] = [];
    if (query.status !== undefined) conditions.push(eq(users.status, query.status));
    if (query.after !== undefined) {
      conditions.push(
        sql`(${users.createdAt}, ${users.id}) < (${query.after.createdAt}::timestamptz, ${query.after.id}::uuid)`,
      );
    }
    const rows = await db
      .select({
        id: users.id,
        idpSubject: users.idpSubject,
        email: users.email,
        role: users.role,
        status: users.status,
        version: users.version,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
        createdAtKey: sql<string>`${users.createdAt}::text`,
      })
      .from(users)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(query.limit);
    return rows;
  }
}

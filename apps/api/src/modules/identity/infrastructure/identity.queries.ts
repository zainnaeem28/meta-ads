import { desc, eq } from 'drizzle-orm';
import { accessRequests } from '../../../database/schema/identity.js';
import type { AccessRequestLookup, AccessRequestView, Db } from '../application/ports.js';

/** Read side of the access requests for API-001 (the write side is `AccessRequestRepository`). */
export class AccessRequestQueries implements AccessRequestLookup {
  async stateOfSubject(db: Db, idpSubject: string): Promise<AccessRequestView> {
    const rows = await db
      .select({ state: accessRequests.state })
      .from(accessRequests)
      .where(eq(accessRequests.idpSubject, idpSubject))
      .orderBy(desc(accessRequests.createdAt))
      .limit(1);
    const state = rows[0]?.state;
    return state === 'pending' || state === 'declined' ? state : 'none';
  }
}

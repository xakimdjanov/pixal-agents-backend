import { q, type Db } from '../db.js';
import type { Actor } from '../auth.js';

// meta must never contain secrets (passwords, tokens)
export async function audit(db: Db, actor: Actor | null, action: string, entity: string, entityId: string | null, meta: object = {}) {
  await q(
    'insert into audit_log (actor_type, actor_id, action, entity, entity_id, meta) values ($1,$2,$3,$4,$5,$6)',
    [actor ? actor.kind : 'system', actor ? (actor.kind === 'agent' ? actor.agentId : actor.userId) : null, action, entity, entityId, JSON.stringify(meta)],
    db,
  );
}

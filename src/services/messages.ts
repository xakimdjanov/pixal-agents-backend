import { q, q1, type Db } from '../db.js';
import { config } from '../config.js';
import { emitMessage } from '../events.js';

export const MESSAGE_TYPES = ['TASK_ASSIGNMENT', 'TASK_ACCEPTED', 'STATUS_UPDATE', 'QUESTION', 'ANSWER', 'BLOCKER',
  'TASK_REPORT', 'REVIEW_REQUEST', 'APPROVAL', 'REJECTION', 'SYSTEM_ALERT'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export interface NewMessage {
  type: MessageType;
  sender: string;
  recipient: string;
  task_id?: string | null;
  conversation_id?: string | null;
  payload?: object;
  idempotency_key?: string | null;
}

export const defaultConversation = (taskId: string | null | undefined, a: string, b: string) =>
  taskId ? `task:${taskId}` : `dm:${[a, b].sort().join(':')}`;

// Persists first (and enqueues a push job in the same transaction). A duplicate idempotency key returns the original.
export async function insertMessage(db: Db, m: NewMessage): Promise<{ msg: any; created: boolean }> {
  const key = m.idempotency_key ? `${m.sender}:${m.idempotency_key}` : null; // scoped per sender
  const conv = m.conversation_id || defaultConversation(m.task_id, m.sender, m.recipient);
  const row = await q1(
    `insert into messages (conversation_id, task_id, type, sender_agent_id, recipient_agent_id, payload, idempotency_key)
     values ($1,$2,$3,$4,$5,$6,$7) on conflict (idempotency_key) do nothing returning *`,
    [conv, m.task_id ?? null, m.type, m.sender, m.recipient, JSON.stringify(m.payload ?? {}), key],
    db,
  );
  if (!row) return { msg: await q1('select * from messages where idempotency_key = $1', [key], db), created: false };
  // The immediate socket push happens after commit; this job is only the retry, so it starts 10s later,
  // and only when the recipient has a recently-seen worker (offline agents pick the message up via inbox polling).
  await q(
    `insert into jobs (kind, payload, run_at)
     select 'push_message', $1, now() + interval '10 seconds'
     where exists (select 1 from agents where id = $2 and last_seen_at >= now() - make_interval(secs => $3))`,
    [JSON.stringify({ message_id: row.message_id }), m.recipient, config.offlineAfterSec],
    db,
  );
  return { msg: row, created: true };
}

export const publish = (msgs: any[]) => msgs.forEach(emitMessage);

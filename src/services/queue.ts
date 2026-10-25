import { q } from '../db.js';
import { config } from '../config.js';
import { emitAgent, emitMessage } from '../events.js';
import { log } from '../log.js';

const MAX_PUSH_ATTEMPTS = 8;

// Claim due jobs with FOR UPDATE SKIP LOCKED; the claim pushes run_at forward (visibility timeout)
// so a crashed consumer's jobs simply reappear later.
async function claim(limit = 20) {
  return q(
    `with c as (
       select id from jobs where done_at is null and run_at <= now()
       order by run_at limit $1 for update skip locked
     )
     update jobs j set attempts = j.attempts + 1, run_at = now() + interval '15 seconds'
     from c where j.id = c.id returning j.*`,
    [limit],
  );
}

async function handle(job: any) {
  if (job.kind === 'push_message') {
    const [m] = await q('select * from messages where message_id = $1', [job.payload.message_id]);
    if (m && !m.delivered_at && job.attempts <= MAX_PUSH_ATTEMPTS) {
      emitMessage(m); // retried until acked; inbox polling is the fallback
      return false;
    }
  }
  return true;
}

async function tick() {
  for (const job of await claim()) {
    try {
      if (await handle(job)) await q('update jobs set done_at = now() where id = $1', [job.id]);
    } catch (e: any) {
      log('error', `job ${job.id} failed: ${e?.message}`);
    }
  }
  const stale = await q(
    `update agents set status = 'OFFLINE' where status <> 'OFFLINE' and (last_seen_at is null or last_seen_at < now() - make_interval(secs => $1))
     returning id, name, role, user_id, status, last_seen_at, current_task_id, execution_mode`,
    [config.offlineAfterSec],
  );
  stale.forEach(emitAgent);
  await q(`delete from jobs where done_at < now() - interval '1 day'`);
}

export function startQueue(intervalMs = 1000) {
  let running = false;
  const t = setInterval(() => {
    if (running) return;
    running = true;
    tick().catch((e) => log('error', `queue tick: ${e?.message}`)).finally(() => { running = false; });
  }, intervalMs);
  return () => clearInterval(t);
}

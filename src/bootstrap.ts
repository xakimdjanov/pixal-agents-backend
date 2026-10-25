import bcrypt from 'bcryptjs';
import { newAgentToken, sha256 } from './auth.js';
import { config } from './config.js';
import { q1, tx } from './db.js';
import { log } from './log.js';

export const DEFAULT_FOUNDER_LOGIN = 'visitca@founder';

// Idempotent: creates the default founder (and its agent) only when no founder exists.
export async function ensureFounder() {
  const hash = await bcrypt.hash(config.defaultFounderPassword, 12);
  await tx(async (c) => {
    await c.query('select pg_advisory_xact_lock(727002)');
    if (await q1(`select 1 from users where role = 'founder' limit 1`, [], c)) return;
    const u = await q1(
      `insert into users (name, email, password_hash, role, must_change_password) values ('Visitca', $1, $2, 'founder', true) returning id`,
      [DEFAULT_FOUNDER_LOGIN, hash], c,
    );
    await c.query('insert into agents (name, role, user_id, token_hash) values ($1,$2,$3,$4)', ['Visitca Agent', 'founder', u!.id, sha256(newAgentToken())]);
    log('info', `created default founder ${DEFAULT_FOUNDER_LOGIN}`);
  });
  const d = await q1('select password_hash from users where email = $1 and must_change_password', [DEFAULT_FOUNDER_LOGIN]);
  if (d && (await bcrypt.compare(config.defaultFounderPassword, d.password_hash))) {
    log('warn', `default founder password for ${DEFAULT_FOUNDER_LOGIN} is still in use; change it in Profile`);
  }
}

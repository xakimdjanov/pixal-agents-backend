import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';
import { log } from './log.js';

export async function migrate() {
  const dir = fileURLToPath(new URL('../migrations', import.meta.url));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const c = await pool.connect();
  try {
    await c.query('select pg_advisory_lock(727001)');
    await c.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await c.query('select name from schema_migrations')).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      await c.query('begin');
      try {
        await c.query(fs.readFileSync(`${dir}/${f}`, 'utf8'));
        await c.query('insert into schema_migrations(name) values ($1)', [f]);
        await c.query('commit');
        log('info', `migrated ${f}`);
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
    }
  } finally {
    await c.query('select pg_advisory_unlock(727001)').catch(() => {});
    c.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  migrate().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}

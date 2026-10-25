import pg from 'pg';
import { config } from './config.js';

export type Row = Record<string, any>;
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
export type Db = pg.Pool | pg.PoolClient;

export async function q(text: string, params: any[] = [], db: Db = pool): Promise<Row[]> {
  return (await db.query(text, params)).rows;
}
export async function q1(text: string, params: any[] = [], db: Db = pool): Promise<Row | undefined> {
  return (await q(text, params, db))[0];
}

// Runs fn in a transaction; callbacks registered via after() run only once it commits.
export async function tx<T>(fn: (c: pg.PoolClient, after: (cb: () => void) => void) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  const callbacks: (() => void)[] = [];
  try {
    await c.query('begin');
    const out = await fn(c, (cb) => callbacks.push(cb));
    await c.query('commit');
    for (const cb of callbacks) {
      try { cb(); } catch { /* push is best-effort; DB is the source of truth */ }
    }
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { after, before, describe, it } from 'node:test';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://studio@127.0.0.1:55432/studio_test';
const PORT = 3913;
const BASE = `http://127.0.0.1:${PORT}/api`;
let proc: ChildProcess | null = null;

const api = async (method: string, path: string, token?: string, body?: unknown) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
};
const start = async () => {
  proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { env: { ...process.env, DATABASE_URL: DB, PORT: String(PORT), LOGIN_RATE_MAX: '1000' }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
};
const stop = async () => { const p = proc!; proc = null; p.kill('SIGKILL'); await new Promise((r) => p.once('exit', r)); };

before(async () => {
  process.env.DATABASE_URL = DB;
  const { pool } = await import('../src/db.js');
  await pool.query('drop schema public cascade; create schema public;');
  await (await import('../src/migrate.js')).migrate();
  await start();
});
after(async () => { if (proc) await stop(); await (await import('../src/db.js')).pool.end(); });

describe('default founder bootstrap + profile', () => {
  let token = '';
  it('creates visitca@founder with a non-email login, one agent, must_change_password', async () => {
    const r = await api('POST', '/auth/login', undefined, { email: 'visitca@founder', password: 'visitca' });
    assert.equal(r.status, 200);
    token = r.body.token;
    const me = await api('GET', '/auth/me', token);
    assert.deepEqual({ ...me.body, id: undefined }, { id: undefined, name: 'Visitca', email: 'visitca@founder', role: 'founder', must_change_password: true });
    const agents = await api('GET', '/agents', token);
    assert.equal(agents.body.length, 1);
    assert.equal((await api('GET', '/projects', token)).body.length, 0);
  });

  it('bootstrap is idempotent across restarts', async () => {
    await stop();
    await start();
    const { pool } = await import('../src/db.js');
    const n = async (t: string) => Number((await pool.query(`select count(*) from ${t}`)).rows[0].count);
    assert.equal(await n('users'), 1);
    assert.equal(await n('agents'), 1);
    assert.equal((await api('POST', '/auth/login', undefined, { email: 'VISITCA@founder', password: 'visitca' })).status, 200);
  });

  it('validates profile updates', async () => {
    assert.equal((await api('PATCH', '/auth/me', undefined, { name: 'x' })).status, 401);
    assert.equal((await api('PATCH', '/auth/me', token, { new_password: 'abcdef' })).status, 403, 'needs current_password');
    assert.equal((await api('PATCH', '/auth/me', token, { new_password: 'abcdef', current_password: 'nope' })).status, 403);
    assert.equal((await api('PATCH', '/auth/me', token, { new_password: 'abc', current_password: 'visitca' })).status, 400, 'min 6');
    assert.equal((await api('PATCH', '/auth/me', token, { email: 'has space' })).status, 400);
  });

  it('enforces login uniqueness', async () => {
    const inv = await api('POST', '/invites', token, { role: 'pm' });
    const reg = await api('POST', '/auth/register', undefined, { inviteCode: inv.body.code, name: 'Pat', email: 'pat', password: 'Passw0rd!' });
    assert.equal(reg.status, 201, 'non-email login can register');
    assert.equal((await api('PATCH', '/auth/me', token, { email: 'PAT' })).status, 409);
  });

  it('updates name/login and password, clears the flag, audits without secrets', async () => {
    const r = await api('PATCH', '/auth/me', token, { name: 'Vee', email: 'vee@founder', current_password: 'visitca', new_password: 'newpass1' });
    assert.equal(r.status, 200);
    assert.equal(r.body.name, 'Vee');
    assert.equal(r.body.email, 'vee@founder');
    assert.equal(r.body.must_change_password, false);
    assert.equal((await api('GET', '/auth/me', token)).body.must_change_password, false);
    assert.equal((await api('POST', '/auth/login', undefined, { email: 'visitca@founder', password: 'visitca' })).status, 401);
    assert.equal((await api('POST', '/auth/login', undefined, { email: 'vee@founder', password: 'newpass1' })).status, 200);
    const { pool } = await import('../src/db.js');
    const rows = (await pool.query(`select meta from audit_log where action = 'user.profile_update'`)).rows;
    assert.ok(rows.length >= 1);
    assert.ok(!JSON.stringify(rows).includes('newpass1'));
  });
});

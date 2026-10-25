import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://studio@127.0.0.1:55432/studio_test';
const PORT = 3915;
const BASE = `http://127.0.0.1:${PORT}`;
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-agents-manage-'));
let proc: ChildProcess | null = null;
let projectId = '';
const T: Record<string, string> = {};
const AG: Record<string, string> = {};
const AID: Record<string, string> = {};
let pool: any;

async function api(method: string, p: string, token: string, body?: unknown) {
  const r = await fetch(`${BASE}/api${p}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
const login = async (email: string) => (await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Passw0rd!' }),
})).json()).token as string;

// An extra developer (user + agent, worker mode so no in-process runner) with its own claude/work dirs.
async function extraDev(n: string) {
  const bcrypt = (await import('bcryptjs')).default;
  const { newAgentToken, sha256 } = await import('../src/auth.js');
  const u = (await pool.query(`insert into users (name, email, password_hash, role) values ($1,$2,$3,'developer') returning id`, [`Dev ${n}`, `dev${n}@studio.local`, await bcrypt.hash('Passw0rd!', 4)])).rows[0];
  await pool.query('insert into project_members (project_id, user_id) values ($1,$2)', [projectId, u.id]);
  const token = newAgentToken();
  const a = (await pool.query(`insert into agents (name, role, user_id, token_hash, execution_mode) values ($1,'developer',$2,$3,'worker') returning id`, [`Extra ${n}`, u.id, sha256(token)])).rows[0];
  for (const d of ['claude', 'work']) fs.mkdirSync(path.join(WORKDIR, d, a.id), { recursive: true });
  return { userId: u.id as string, agentId: a.id as string, token, jwt: await login(`dev${n}@studio.local`) };
}

before(async () => {
  process.env.DATABASE_URL = DB;
  ({ pool } = await import('../src/db.js'));
  await pool.query('drop schema public cascade; create schema public;');
  await (await import('../src/migrate.js')).migrate();
  const s = await (await import('./fixtures.js')).seed();
  projectId = s.projectId;
  Object.assign(AG, s.tokens);
  await pool.query("update agents set execution_mode = 'worker'");
  proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: { ...process.env, DATABASE_URL: DB, PORT: String(PORT), LOGIN_RATE_MAX: '1000', DATA_DIR: WORKDIR }, stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  T.founder = await login('founder@studio.local'); T.pm = await login('pm@studio.local'); T.developer = await login('dev@studio.local');
  for (const a of (await api('GET', '/agents', T.founder)).body) AID[a.role] = a.id;
});
after(async () => { proc?.kill('SIGKILL'); await pool?.end(); fs.rmSync(WORKDIR, { recursive: true, force: true }); });

describe('agent rename', () => {
  it('owner and founder may rename; others get 404; validation applies', async () => {
    const r = await api('PATCH', `/agents/${AID.developer}`, T.developer, { name: '  Devvy  ' });
    assert.equal(r.status, 200);
    assert.equal(r.body.name, 'Devvy');
    assert.equal((await api('PATCH', `/agents/${AID.developer}`, T.founder, { name: 'Dev Prime' })).body.name, 'Dev Prime');
    assert.equal((await api('PATCH', `/agents/${AID.developer}`, T.pm, { name: 'x' })).status, 404);
    assert.equal((await api('PATCH', `/agents/${AID.pm}`, T.developer, { name: 'x' })).status, 404);
    assert.equal((await api('PATCH', `/agents/${AID.developer}`, T.developer, { name: '   ' })).status, 400);
    assert.equal((await api('PATCH', `/agents/${AID.developer}`, T.developer, { name: 'x'.repeat(61) })).status, 400);
    assert.equal((await api('PATCH', `/agents/${AID.developer}`, T.developer, {})).status, 400);
    assert.equal((await api('PATCH', `/agents/${AID.developer}`, AG.developer, { name: 'x' })).status, 403);
    const log = (await pool.query(`select meta from audit_log where action = 'agent.rename' and entity_id = $1 order by id`, [AID.developer])).rows;
    assert.deepEqual(log.map((l: any) => l.meta), [{ old: 'Developer Agent', new: 'Devvy' }, { old: 'Devvy', new: 'Dev Prime' }]);
  });
  it('execution_mode stays founder-only', async () => {
    assert.equal((await api('PATCH', `/agents/${AID.developer}`, T.developer, { execution_mode: 'server' })).status, 403);
    assert.equal((await api('PATCH', `/agents/${AID.developer}`, T.founder, { execution_mode: 'worker' })).status, 200);
  });
});

describe('agent delete', () => {
  it('hard-deletes an agent without history (owner may delete their own)', async () => {
    const d = await extraDev('hard');
    assert.equal((await api('DELETE', `/agents/${d.agentId}`, T.pm)).status, 404);
    assert.equal((await api('DELETE', `/agents/${d.agentId}`, d.token)).status, 403);
    assert.equal((await api('DELETE', `/agents/${d.agentId}`, d.jwt)).status, 204);
    assert.equal((await pool.query('select 1 from agents where id = $1', [d.agentId])).rowCount, 0);
    assert.equal(fs.existsSync(path.join(WORKDIR, 'claude', d.agentId)), false);
  });

  it('refuses the founder\'s own agent and the last founder agent', async () => {
    assert.equal((await api('DELETE', `/agents/${AID.founder}?force=1`, T.founder)).status, 400);
    assert.equal((await api('DELETE', `/agents/${AID.founder}?force=1`, T.pm)).status, 404);
  });

  it('with history: 409 with counts, then ?force=1 soft-deletes and keeps history', async () => {
    const d = await extraDev('soft');
    const other = await extraDev('other');
    const t = await api('POST', '/tasks', T.pm, { project_id: projectId, title: 'Old work', description: 'x', assignee_agent_id: d.agentId });
    assert.equal(t.status, 201);
    await api('POST', `/agent/tasks/${t.body.id}/status`, d.token, { status: 'ACCEPTED' });
    const done = await api('POST', '/tasks', T.pm, { project_id: projectId, title: 'Finished', description: 'x', assignee_agent_id: d.agentId });
    await pool.query("update tasks set status = 'COMPLETED' where id = $1", [done.body.id]);

    const no = await api('DELETE', `/agents/${d.agentId}`, T.founder);
    assert.equal(no.status, 409);
    assert.match(no.body.error, /2 task\(s\), \d+ message\(s\)/);
    assert.equal((await api('DELETE', `/agents/${d.agentId}?force=1`, other.jwt)).status, 404);

    const ok = await api('DELETE', `/agents/${d.agentId}?force=1`, T.founder);
    assert.equal(ok.status, 200);
    assert.deepEqual({ ...ok.body }, { id: d.agentId, removed: true, soft: true, cancelled_tasks: 1 });

    const row = (await pool.query('select deleted_at, token_hash from agents where id = $1', [d.agentId])).rows[0];
    assert.ok(row.deleted_at);
    assert.ok(row.token_hash.startsWith('revoked:'));
    assert.equal((await api('GET', '/agent/me', d.token)).status, 401);
    assert.equal(fs.existsSync(path.join(WORKDIR, 'claude', d.agentId)), false);
    assert.equal(fs.existsSync(path.join(WORKDIR, 'work', d.agentId)), false);
    assert.equal(fs.existsSync(path.join(WORKDIR, 'claude', other.agentId)), true, 'only that agent\'s dirs are removed');

    const tasks = (await pool.query('select id, status from tasks where assignee_agent_id = $1 order by title', [d.agentId])).rows;
    assert.deepEqual(tasks.map((x: any) => x.status).sort(), ['CANCELLED', 'COMPLETED']);
    const aud = (await pool.query(`select meta from audit_log where action = 'task.status' and entity_id = $1 order by id desc limit 1`, [t.body.id])).rows[0];
    assert.equal(aud.meta.note, 'Agent removed');
    assert.equal((await api('GET', `/tasks/${t.body.id}`, T.pm)).status, 200, 'old task still renders');

    const list = (await api('GET', '/agents', T.founder)).body;
    assert.equal(list.some((a: any) => a.id === d.agentId), false);
    const withRemoved = (await api('GET', '/agents?include_removed=1', T.pm)).body.find((a: any) => a.id === d.agentId);
    assert.equal(withRemoved.name, 'Extra soft (removed)');
    assert.equal(withRemoved.removed, true);
    assert.equal((await api('POST', '/tasks', T.pm, { project_id: projectId, title: 'x', description: 'x', assignee_agent_id: d.agentId })).status, 404);
    assert.equal((await api('PATCH', `/agents/${d.agentId}`, T.founder, { name: 'x' })).status, 404);
    assert.equal((await api('DELETE', `/agents/${d.agentId}?force=1`, T.founder)).status, 404);

    // The user can get a replacement agent (unique(user_id) only applies to active agents).
    const rep = await api('POST', '/agents', T.founder, { name: 'Replacement', role: 'developer', user_id: d.userId });
    assert.equal(rep.status, 201);
    assert.notEqual(rep.body.agent.id, d.agentId);
    assert.equal((await api('POST', '/agents', T.founder, { name: 'Dup', role: 'developer', user_id: d.userId })).status, 409);
    const me = await api('GET', '/agent/me', rep.body.token);
    assert.equal(me.body.id, rep.body.agent.id);
  });
});

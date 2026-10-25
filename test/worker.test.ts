import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://studio@127.0.0.1:55432/studio_test';
const PORT = 3913;
const BASE = `http://127.0.0.1:${PORT}`;
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-agents-'));
const procs: ChildProcess[] = [];
let pmToken = '';
let projectId = '';
let devTokenAgent = '';
let ids: Record<string, string> = {};
let pmAgentToken = '';

async function api(method: string, p: string, token: string, body?: unknown) {
  const r = await fetch(`${BASE}/api${p}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const until = async <T>(fn: () => Promise<T | false | undefined>, ms = 20_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 200));
  }
};
const spawnTs = (file: string, cwd: string, env: Record<string, string>) => {
  const p = spawn(process.execPath, ['--import', 'tsx', file], { cwd, env: { ...process.env, ...env }, stdio: 'ignore', detached: true });
  procs.push(p);
  return p;
};
before(async () => {
  process.env.DATABASE_URL = DB;
  const { pool } = await import('../src/db.js');
  await pool.query('drop schema public cascade; create schema public;');
  const { migrate } = await import('../src/migrate.js');
  await migrate();
  const s = await (await import('./fixtures.js')).seed();
  projectId = s.projectId;
  devTokenAgent = s.tokens.developer;
  pmAgentToken = s.tokens.pm;
  await pool.end();
  spawnTs('src/index.ts', process.cwd(), { DATABASE_URL: DB, PORT: String(PORT), LOGIN_RATE_MAX: '1000', MOCK_CLAUDE: '1', MOCK_DELAY_MS: '200', DATA_DIR: WORKDIR, HEARTBEAT_MS: '1000', POLL_MS: '500' });
  await until(async () => (await fetch(`${BASE}/api/health`).catch(() => null))?.ok);
  pmToken = (await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'pm@studio.local', password: 'Passw0rd!' }) })).json()).token;
  for (const a of (await api('GET', '/agents', pmToken)).body) ids[a.role] = a.id;
});
const killGroup = (p: ChildProcess) => { try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* already gone */ } };
after(() => { procs.forEach(killGroup); fs.rmSync(WORKDIR, { recursive: true, force: true }); });

describe('in-process agent runners (MOCK_CLAUDE=1)', () => {
  it('runs an assigned task end to end and reports to the PM', async () => {
    const t = await api('POST', '/tasks', pmToken, { project_id: projectId, title: 'Add health page', description: 'x', assignee_agent_id: ids.developer });
    assert.equal(t.status, 201);
    await until(async () => (await api('GET', `/tasks/${t.body.id}`, pmToken)).body.task.status === 'REVIEW');
    const pmInbox = (await api('GET', '/messages?limit=500', pmToken)).body;
    const rep = pmInbox.find((m: any) => m.type === 'TASK_REPORT' && m.task_id === t.body.id);
    assert.ok(rep, 'PM got the report');
    assert.match(rep.payload.git_commit, /^[0-9a-f]{40}$/);
    assert.ok(rep.payload.files_changed.includes('MOCK_OUTPUT.md'));
    assert.match(rep.payload.git_branch, /^task\//);
    assert.ok(fs.existsSync(path.join(WORKDIR, 'work', ids.developer, 'worktrees', projectId, t.body.id, 'MOCK_OUTPUT.md')), 'per-task worktree exists');
    const dev = (await api('GET', '/agents', pmToken)).body.find((a: any) => a.role === 'developer');
    assert.notEqual(dev.status, 'OFFLINE');
    assert.equal(dev.claude.logged_in, true);
  });

  it('answers a QUESTION from project-status data without inventing', async () => {
    const q = await api('POST', '/messages', pmToken, { type: 'QUESTION', recipient_agent_id: ids.developer, payload: { text: 'Status?', project_id: projectId } });
    assert.equal(q.status, 201);
    const ans = await until(async () => (await api('GET', '/messages?limit=500', pmToken)).body.find((m: any) => m.type === 'ANSWER'));
    assert.match(ans.payload.text, /Active tasks \(1\): Add health page \[REVIEW\]/);
    assert.equal(ans.payload.stale, false);
    const none = await api('POST', '/projects', (await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'founder@studio.local', password: 'Passw0rd!' }) })).json()).token, { name: 'Empty' });
    assert.equal(none.status, 201); // neither asker nor answerer belongs to it: the server refuses the question outright
    const denied = await api('POST', '/messages', pmToken, { type: 'QUESTION', recipient_agent_id: ids.developer, payload: { text: 'Status?', project_id: none.body.id }, idempotency_key: 'q-empty' });
    assert.equal(denied.status, 404);
  });

  it('answers a project-less QUESTION (web Chat) using the agent\'s own project', async () => {
    const q = await api('POST', '/messages', pmToken, { type: 'QUESTION', recipient_agent_id: ids.developer, payload: { text: 'How are things?' }, idempotency_key: 'q-projectless' });
    assert.equal(q.status, 201);
    const ans = await until(async () => (await api('GET', '/messages?limit=500', pmToken)).body.find((m: any) => m.type === 'ANSWER' && m.payload.answers_message_id === (q.body.message_id ?? q.body.id)));
    assert.match(ans.payload.text, /Active tasks \(\d+\): .*Add health page/);
    assert.doesNotMatch(ans.payload.text, /No project status data/);
  });

  it('peer QUESTIONs get full access: every project is visible to any asker', async () => {
    const pg = (await import('pg')).default;
    const { insertMessage } = await import('../src/services/messages.js');
    const db = new pg.Pool({ connectionString: DB });
    try {
      const sender = (await api('GET', '/agents', pmToken)).body;
      const ask = async (role: string, key: string, payload: object) => {
        const { msg } = await insertMessage(db as any, { type: 'QUESTION', sender: sender.find((a: any) => a.role === role).id, recipient: ids.developer, task_id: null, payload, idempotency_key: key });
        const id = msg.message_id ?? (msg as any).id;
        return until(async () => (await api('GET', '/messages?limit=500', pmToken)).body.find((m: any) => m.type === 'ANSWER' && m.payload.answers_message_id === id)
          ?? (await db.query("select payload from messages where type='ANSWER' and payload->>'answers_message_id' = $1", [id])).rows[0]);
      };
      await db.query("insert into projects (name) values ('Hidden Moonshot')");
      for (const role of ['founder', 'pm']) {
        const a = await ask(role, `peer-${role}`, { text: 'Which connectors do you have?' });
        assert.match(a.payload.text, /Project Visitca/);
        assert.match(a.payload.text, /Hidden Moonshot/);
        assert.match(a.payload.text, /My connectors:/);
        assert.doesNotMatch(a.payload.text, /can't share|not a member/);
      }
    } finally { await db.end(); }
  });

  it('answers a QUESTION to the caller\'s OWN agent exactly once, without looping, visible in /messages', async () => {
    const body = { type: 'QUESTION', recipient_agent_id: ids.pm, payload: { text: 'How are things?' }, idempotency_key: 'q-self' };
    const q = await api('POST', '/messages', pmToken, body);
    assert.equal(q.status, 201);
    const qid = q.body.message_id ?? q.body.id;
    const answers = async () => (await api('GET', '/messages?limit=500', pmToken)).body.filter((m: any) => m.type === 'ANSWER' && m.payload.answers_message_id === qid);
    const ans = await until(async () => (await answers())[0]);
    assert.equal(ans.sender_agent_id, ids.pm);
    assert.equal(ans.recipient_agent_id, ids.pm);
    assert.match(ans.payload.text, /Add health page/);
    assert.equal((await api('POST', '/messages', pmToken, body)).status, 200); // idempotent re-post
    await new Promise((r) => setTimeout(r, 2500)); // several poll cycles: nothing may answer the ANSWER or the QUESTION again
    assert.equal((await answers()).length, 1);
    const all = (await api('GET', '/messages?limit=500', pmToken)).body.filter((m: any) => m.sender_agent_id === ids.pm && m.recipient_agent_id === ids.pm);
    assert.deepEqual(all.map((m: any) => m.type).sort(), ['ANSWER', 'QUESTION']);
    assert.ok(all.every((m: any) => m.delivered_at), 'both acked');
  });

  it('agent memory: owner reads/writes CLAUDE.md in its own config dir, 20KB cap, others get 404, reset drops sessions', async () => {
    const empty = await api('GET', `/agents/${ids.pm}/memory`, pmToken);
    assert.equal(empty.status, 200);
    assert.equal(empty.body.content, '');
    const put = await api('PUT', `/agents/${ids.pm}/memory`, pmToken, { content: 'Favourite colour: teal\n' });
    assert.equal(put.status, 200);
    assert.equal((await api('GET', `/agents/${ids.pm}/memory`, pmToken)).body.content, 'Favourite colour: teal\n');
    assert.equal(fs.readFileSync(path.join(WORKDIR, 'claude', ids.pm, 'CLAUDE.md'), 'utf8'), 'Favourite colour: teal\n');
    assert.equal((await api('PUT', `/agents/${ids.pm}/memory`, pmToken, { content: 'x'.repeat(20 * 1024 + 1) })).status, 413);
    assert.equal((await api('GET', `/agents/${ids.developer}/memory`, pmToken)).status, 404);
    assert.equal((await api('PUT', `/agents/${ids.developer}/memory`, pmToken, { content: 'no' })).status, 404);
    const sess = path.join(WORKDIR, 'claude', ids.pm, 'chat-sessions.json');
    fs.writeFileSync(sess, '{"dm:x":"abc"}');
    assert.equal((await api('POST', `/agents/${ids.pm}/chat/reset`, pmToken)).status, 204);
    assert.equal(fs.existsSync(sess), false);
    assert.equal((await api('POST', `/agents/${ids.developer}/chat/reset`, pmToken)).status, 404);
  });

  it('isolates each agent: own 0700 Claude config dir and workdir, no secrets in the child env', async () => {
    const code = `import { childEnv } from './src/agents/env.ts'; console.log(JSON.stringify(childEnv(process.argv[1])))`;
    const run = (id: string) => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, id], {
      env: { ...process.env, DATA_DIR: WORKDIR, JWT_SECRET: 'x'.repeat(40), CONNECTOR_KEY: 'ab'.repeat(32), POSTGRES_PASSWORD: 'pw' }, cwd: process.cwd(),
    }).toString());
    const e = run(ids.developer);
    assert.equal(e.CLAUDE_CONFIG_DIR, path.join(WORKDIR, 'claude', ids.developer));
    assert.notEqual(e.CLAUDE_CONFIG_DIR, run(ids.pm).CLAUDE_CONFIG_DIR);
    for (const k of ['JWT_SECRET', 'CONNECTOR_KEY', 'DATABASE_URL', 'POSTGRES_PASSWORD']) assert.equal(e[k], undefined);
    assert.equal(fs.statSync(path.join(WORKDIR, 'claude', ids.developer)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(WORKDIR, 'work', ids.developer)).mode & 0o777, 0o700);
  });

  it('reports FAILED when the CLI fails, and a task waits for an external worker until the runner is back', async () => {
    const t = await api('POST', '/tasks', pmToken, { project_id: projectId, title: 'Doomed [mock:fail]', assignee_agent_id: ids.developer });
    await until(async () => (await api('GET', `/tasks/${t.body.id}`, pmToken)).body.task.status === 'FAILED');
    const founderToken = (await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'founder@studio.local', password: 'Passw0rd!' }) })).json()).token;
    assert.equal((await api('PATCH', `/agents/${ids.developer}`, founderToken, { execution_mode: 'worker' })).status, 200); // runner stops
    await new Promise((r) => setTimeout(r, 500));
    const t2 = await api('POST', '/tasks', pmToken, { project_id: projectId, title: 'While runner is off', assignee_agent_id: ids.developer });
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await api('GET', `/tasks/${t2.body.id}`, pmToken)).body.task.status, 'PENDING');
    assert.equal((await api('PATCH', `/agents/${ids.developer}`, founderToken, { execution_mode: 'server' })).status, 200);
    await until(async () => (await api('GET', `/tasks/${t2.body.id}`, pmToken)).body.task.status === 'REVIEW', 30_000);
  });
});

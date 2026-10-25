import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { io as connect } from 'socket.io-client';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://studio@127.0.0.1:55432/studio_test';
const PORT = 3911;
const BASE = `http://127.0.0.1:${PORT}`;
process.env.DATABASE_URL = DB;

let proc: ChildProcess | null = null;
const T: Record<string, string> = {}; // JWTs by role
const AG: Record<string, string> = {}; // agent tokens by role
const AID: Record<string, string> = {}; // agent ids by role
let projectId = '';

async function api(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

async function startServer() {
  proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: { ...process.env, DATABASE_URL: DB, PORT: String(PORT), LOGIN_RATE_MAX: '1000' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}
async function stopServer() {
  const p = proc!;
  p.kill('SIGKILL'); // simulate a crash, not a graceful shutdown
  await new Promise((r) => p.once('exit', r));
}

before(async () => {
  const { pool } = await import('../src/db.js');
  await pool.query('drop schema public cascade; create schema public;');
  const { migrate } = await import('../src/migrate.js');
  await migrate();
  const { seed } = await import('./fixtures.js');
  const s = await seed();
  projectId = s.projectId;
  Object.assign(AG, s.tokens);
  // These tests drive the external-worker protocol (/api/agent/*) by hand, so no in-process runner may consume the inboxes.
  await pool.query("update agents set execution_mode = 'worker'");
  await pool.end();
  await startServer();
});
after(async () => { if (proc) await stopServer(); });

describe('studio server', () => {
  it('logs in all three roles and rejects a bad password', async () => {
    for (const [role, email] of [['founder', 'founder@studio.local'], ['pm', 'pm@studio.local'], ['developer', 'dev@studio.local']]) {
      const r = await api('POST', '/auth/login', undefined, { email, password: 'Passw0rd!' });
      assert.equal(r.status, 200);
      assert.equal(r.body.user.role, role);
      T[role] = r.body.token;
      const me = await api('GET', '/auth/me', r.body.token);
      assert.equal(me.body.email, email);
    }
    assert.equal((await api('POST', '/auth/login', undefined, { email: 'pm@studio.local', password: 'wrong' })).status, 401);
    assert.equal((await api('GET', '/projects')).status, 401);
    const agents = await api('GET', '/agents', T.founder);
    for (const a of agents.body) AID[a.role] = a.id;
    assert.equal(agents.body.length, 3);
  });

  let taskId = '';
  it('routes a PM task to the developer inbox; duplicate idempotency key is not duplicated', async () => {
    const body = { project_id: projectId, title: 'Build login page', description: 'd', acceptance_criteria: 'works', priority: 'HIGH', assignee_agent_id: AID.developer };
    const a = await api('POST', '/tasks', T.pm, body, { 'Idempotency-Key': 'k-1' });
    const b = await api('POST', '/tasks', T.pm, body, { 'Idempotency-Key': 'k-1' });
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(a.body.id, b.body.id);
    assert.equal(a.body.reply_to_agent_id, AID.pm);
    taskId = a.body.id;
    const tasks = await api('GET', `/tasks?project_id=${projectId}`, T.pm);
    assert.equal(tasks.body.length, 1);
    const inbox = await api('GET', '/agent/inbox', AG.developer);
    assert.equal(inbox.body.length, 1);
    assert.equal(inbox.body[0].type, 'TASK_ASSIGNMENT');
    assert.equal(inbox.body[0].task_id, taskId);
  });

  it('dedupes messages by idempotency key', async () => {
    const m = { type: 'QUESTION', recipient_agent_id: AID.developer, task_id: taskId, payload: { text: 'ETA?' }, idempotency_key: 'q-1' };
    const a = await api('POST', '/messages', T.pm, m);
    const b = await api('POST', '/messages', T.pm, m);
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(a.body.message_id, b.body.message_id);
    const inbox = await api('GET', '/agent/inbox', AG.developer);
    assert.equal(inbox.body.filter((x: any) => x.type === 'QUESTION').length, 1);
    for (const x of inbox.body) assert.equal((await api('POST', `/agent/messages/${x.message_id}/ack`, AG.developer)).status, 200);
    assert.equal((await api('GET', '/agent/inbox', AG.developer)).body.length, 0);
  });

  it('enforces the status state machine and RBAC', async () => {
    assert.equal((await api('POST', `/agent/tasks/${taskId}/status`, AG.developer, { status: 'COMPLETED' })).status, 409);
    assert.equal((await api('POST', `/agent/tasks/${taskId}/status`, AG.developer, { status: 'REVIEW' })).status, 409);
    assert.equal((await api('POST', `/agent/tasks/${taskId}/status`, AG.developer, { status: 'ACCEPTED' })).status, 200);
    assert.equal((await api('POST', `/agent/tasks/${taskId}/status`, AG.developer, { status: 'IN_PROGRESS' })).status, 200);
    const accepted = await api('GET', '/agent/inbox', AG.pm);
    assert.ok(accepted.body.some((m: any) => m.type === 'TASK_ACCEPTED'));
    assert.equal((await api('POST', '/tasks', T.developer, {})).status, 403);
    assert.equal((await api('PATCH', `/tasks/${taskId}/status`, T.developer, { status: 'CANCELLED' })).status, 403);
  });

  it('delivers a developer report to the PM (reply_to), and PM approval reaches the founder', async () => {
    const rep = await api('POST', `/tasks/${taskId}/report`, AG.developer, {
      summary: 'Login page done', work_done: ['form'], files_changed: ['a.ts'], test_results: '3 passed',
      git_branch: 'task/x', git_commit: 'abc123', unmet_requirements: [], issues: [], next_steps: [],
    });
    assert.equal(rep.status, 201);
    assert.equal(rep.body.task.status, 'REVIEW');
    const pmInbox = await api('GET', '/agent/inbox', AG.pm);
    const report = pmInbox.body.find((m: any) => m.type === 'TASK_REPORT');
    assert.ok(report, 'PM receives TASK_REPORT');
    assert.equal(report.payload.summary, 'Login page done');
    assert.equal((await api('GET', '/agent/inbox', AG.founder)).body.filter((m: any) => m.type === 'TASK_REPORT').length, 0);

    assert.equal((await api('PATCH', `/tasks/${taskId}/status`, T.developer, { status: 'COMPLETED' })).status, 403);
    const ok = await api('PATCH', `/tasks/${taskId}/status`, T.pm, { status: 'COMPLETED', note: 'lgtm' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, 'COMPLETED');
    const fInbox = await api('GET', '/agent/inbox', AG.founder);
    const fr = fInbox.body.find((m: any) => m.type === 'TASK_REPORT');
    assert.ok(fr, 'founder receives TASK_REPORT after PM approval');
    assert.equal(fr.payload.report.git_commit, 'abc123');
    assert.ok((await api('GET', '/agent/inbox', AG.developer)).body.some((m: any) => m.type === 'APPROVAL'));
    assert.equal((await api('PATCH', `/tasks/${taskId}/status`, T.pm, { status: 'IN_PROGRESS' })).status, 409);

    const detail = await api('GET', `/tasks/${taskId}`, T.pm);
    assert.equal(detail.body.reports.length, 1);
    const ps = await api('GET', `/agent/project-status/${projectId}`, AG.developer);
    assert.equal(ps.body.completed_tasks.length, 1);
    assert.equal(ps.body.latest_test_results[0].test_results, '3 passed');
  });

  it('pushes new messages over Socket.IO to the recipient agent room', async () => {
    const sock = connect(BASE, { auth: { token: AG.developer }, transports: ['websocket'] });
    await new Promise<void>((res, rej) => { sock.on('connect', () => res()); sock.on('connect_error', rej); });
    const got = new Promise<any>((res) => sock.on('message:new', res));
    await api('POST', '/tasks', T.pm, { project_id: projectId, title: 'Socket task', assignee_agent_id: AID.developer }, { 'Idempotency-Key': 'k-sock' });
    const m = await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('no push')), 3000))]);
    assert.equal((m as any).type, 'TASK_ASSIGNMENT');
    sock.close();
    const bad = connect(BASE, { auth: { token: 'nope' }, transports: ['websocket'], reconnection: false });
    await new Promise<void>((res) => bad.on('connect_error', () => res()));
    bad.close();
  });

  it('blocks a user outside the project from reading it', async () => {
    const inv = await api('POST', '/invites', T.founder, { role: 'developer' });
    assert.equal(inv.status, 201);
    const reg = await api('POST', '/auth/register', undefined, { inviteCode: inv.body.code, name: 'Outsider', email: 'out@studio.local', password: 'Passw0rd!' });
    assert.equal(reg.status, 201);
    assert.equal((await api('POST', '/auth/register', undefined, { inviteCode: inv.body.code, name: 'X', email: 'x@studio.local', password: 'Passw0rd!' })).status, 400, 'invite is single use');
    const out = reg.body.token;
    assert.equal((await api('GET', `/projects/${projectId}`, out)).status, 404);
    assert.equal((await api('GET', `/projects/${projectId}/members`, out)).status, 404);
    assert.deepEqual((await api('GET', '/projects', out)).body, []);
    assert.deepEqual((await api('GET', `/tasks?project_id=${projectId}`, out)).body, []);
    assert.equal((await api('GET', `/tasks/${taskId}`, out)).status, 404);
    assert.deepEqual((await api('GET', '/messages', out)).body, []);
    assert.equal((await api('GET', '/audit', out)).status, 403);
    assert.equal((await api('GET', '/audit', T.pm)).status, 403);
    assert.ok((await api('GET', '/audit', T.founder)).body.length > 5);
  });

  it('rejects agent tokens on admin/user routes but allows the worker endpoints', async () => {
    const tok = AG.developer;
    assert.equal((await api('POST', '/invites', tok, { role: 'developer' })).status, 403);
    assert.equal((await api('POST', '/agents', tok, { name: 'x', role: 'developer', user_id: '00000000-0000-0000-0000-000000000000' })).status, 403);
    assert.equal((await api('GET', '/audit', AG.founder)).status, 403);
    assert.equal((await api('POST', '/projects', AG.founder, { name: 'evil' })).status, 403);
    assert.equal((await api('POST', `/projects/${projectId}/members`, AG.founder, { user_id: '00000000-0000-0000-0000-000000000000' })).status, 403);
    assert.equal((await api('GET', '/users', AG.pm)).status, 403);
    assert.equal((await api('POST', '/tasks', AG.pm, {})).status, 403);
    assert.equal((await api('GET', `/tasks/${taskId}`, tok)).status, 200);
    assert.equal((await api('GET', '/messages', tok)).status, 200);
    assert.equal((await api('GET', '/agent/me', tok)).status, 200);
  });

  it('only the task reviewer or the founder can send APPROVAL/REJECTION', async () => {
    const t = await api('POST', '/tasks', T.founder, { project_id: projectId, title: 'Founder task', assignee_agent_id: AID.developer }, { 'Idempotency-Key': 'k-appr' });
    assert.equal(t.status, 201);
    const m = (type: string) => ({ type, recipient_agent_id: AID.developer, task_id: t.body.id, payload: { note: 'x' } });
    assert.equal((await api('POST', '/messages', T.pm, m('APPROVAL'))).status, 403, 'pm is not the reviewer');
    assert.equal((await api('POST', '/messages', AG.developer, m('REJECTION'))).status, 403);
    assert.equal((await api('POST', '/messages', T.pm, { type: 'APPROVAL', recipient_agent_id: AID.developer })).status, 403, 'no task: founder only');
    assert.equal((await api('POST', '/messages', T.founder, m('REJECTION'))).status, 201);
    // PM-created task: its reply_to (the PM) may approve
    assert.equal((await api('POST', '/messages', T.pm, { type: 'APPROVAL', recipient_agent_id: AID.developer, task_id: taskId })).status, 201);
  });

  it('attaches the asker project ids to QUESTION messages and validates project_id', async () => {
    const q = await api('POST', '/messages', T.pm, { type: 'QUESTION', recipient_agent_id: AID.developer, payload: { text: 'status?', asker_project_ids: ['spoofed'] } });
    assert.equal(q.status, 201);
    assert.deepEqual(q.body.payload.asker_project_ids, [projectId]);
    assert.equal((await api('POST', '/messages', T.pm, { type: 'QUESTION', recipient_agent_id: AID.developer, payload: { project_id: 'nope' } })).status, 400);
  });

  it('a repeated report on a task already in REVIEW returns the existing report', async () => {
    const t = await api('POST', '/tasks', T.pm, { project_id: projectId, title: 'Report twice', assignee_agent_id: AID.developer }, { 'Idempotency-Key': 'k-rep' });
    await api('POST', `/agent/tasks/${t.body.id}/status`, AG.developer, { status: 'ACCEPTED' });
    await api('POST', `/agent/tasks/${t.body.id}/status`, AG.developer, { status: 'IN_PROGRESS' });
    const body = { summary: 's', work_done: [], files_changed: [], git_branch: 'b', git_commit: 'c' };
    const a = await api('POST', `/tasks/${t.body.id}/report`, AG.developer, body);
    const b = await api('POST', `/tasks/${t.body.id}/report`, AG.developer, body);
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(b.body.report.id, a.body.report.id);
    assert.equal((await api('GET', `/tasks/${t.body.id}/reports`, T.pm)).body.length, 1);
  });

  it('does not lose tasks or undelivered messages across a server crash/restart', async () => {
    const t = await api('POST', '/tasks', T.pm, { project_id: projectId, title: 'Survives restart', assignee_agent_id: AID.developer }, { 'Idempotency-Key': 'k-restart' });
    assert.equal(t.status, 201);
    await stopServer();
    await startServer();
    const found = await api('GET', `/tasks?project_id=${projectId}&status=PENDING`, T.pm);
    assert.ok(found.body.some((x: any) => x.id === t.body.id));
    const inbox = await api('GET', '/agent/inbox', AG.developer);
    assert.ok(inbox.body.some((m: any) => m.task_id === t.body.id && m.type === 'TASK_ASSIGNMENT'));
    const again = await api('POST', '/tasks', T.pm, { project_id: projectId, title: 'Survives restart', assignee_agent_id: AID.developer }, { 'Idempotency-Key': 'k-restart' });
    assert.equal(again.body.id, t.body.id, 'idempotency survives restart');
  });
});

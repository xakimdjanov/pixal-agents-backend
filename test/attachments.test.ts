import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://studio@127.0.0.1:55432/studio_test';
const PORT = 3915;
const BASE = `http://127.0.0.1:${PORT}`;
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-att-'));
const procs: ChildProcess[] = [];
const T: Record<string, string> = {};
const AG: Record<string, string> = {};
const AID: Record<string, string> = {};
let projectId = '';

// Smallest valid-looking headers; only the magic bytes matter to the server.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest-of-png')]);

async function api(method: string, p: string, token: string, body?: unknown) {
  const r = await fetch(`${BASE}/api${p}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
async function upload(token: string, data: Buffer, name = 'pic.png', type = 'image/png', field = 'file') {
  const f = new FormData();
  f.append(field, new Blob([new Uint8Array(data)], { type }), name);
  const r = await fetch(`${BASE}/api/messages/attachments`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: f });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const get = (id: string, token: string) => fetch(`${BASE}/api/attachments/${id}`, { headers: { authorization: `Bearer ${token}` } });
const until = async <T>(fn: () => Promise<T | false | undefined>, ms = 20_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 50));
  }
};

before(async () => {
  process.env.DATABASE_URL = DB;
  const { pool } = await import('../src/db.js');
  await pool.query('drop schema public cascade; create schema public;');
  await (await import('../src/migrate.js')).migrate();
  const s = await (await import('./fixtures.js')).seed();
  projectId = s.projectId;
  Object.assign(AG, s.tokens);
  await pool.end();
  const p = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: process.cwd(), stdio: 'ignore', detached: true,
    env: { ...process.env, DATABASE_URL: DB, PORT: String(PORT), LOGIN_RATE_MAX: '1000', MOCK_CLAUDE: '1', DATA_DIR: WORKDIR, MOCK_DELAY_MS: '1200', HEARTBEAT_MS: '1000', POLL_MS: '300' },
  });
  procs.push(p);
  await until(async () => (await fetch(`${BASE}/api/health`).catch(() => null))?.ok);
  for (const [role, email] of [['founder', 'founder@studio.local'], ['pm', 'pm@studio.local'], ['developer', 'dev@studio.local']]) {
    T[role] = (await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Passw0rd!' }) })).json()).token;
  }
  for (const a of (await api('GET', '/agents', T.founder)).body) AID[a.role] = a.id;
});
after(() => {
  for (const p of procs) try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* gone */ }
  fs.rmSync(WORKDIR, { recursive: true, force: true });
});

describe('chat image attachments', () => {
  let pmImage = '';
  it('stores a png and returns its metadata', async () => {
    const r = await upload(T.pm, PNG, '../../evil name.png');
    assert.equal(r.status, 201);
    assert.deepEqual(Object.keys(r.body).sort(), ['attachment_id', 'mime', 'name', 'size']);
    assert.equal(r.body.mime, 'image/png');
    assert.equal(r.body.size, PNG.length);
    assert.doesNotMatch(r.body.name, /[\/\\]/);
    pmImage = r.body.attachment_id;
    assert.ok(fs.existsSync(path.join(WORKDIR, 'uploads', pmImage)));
  });
  it('validates by magic bytes, size and field name', async () => {
    assert.equal((await upload(T.pm, Buffer.from('<script>alert(1)</script>'), 'x.png', 'image/png')).status, 415);
    assert.equal((await upload(T.pm, Buffer.from('GIF89a-ok'), 'x.txt', 'text/plain')).body.mime, 'image/gif'); // type comes from the bytes
    assert.equal((await upload(T.pm, Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]))).status, 413);
    assert.equal((await upload(T.pm, PNG, 'a.png', 'image/png', 'other')).status, 400);
    assert.equal((await upload(AG.pm, PNG)).status, 403);
    assert.equal((await upload('', PNG)).status, 401);
  });
  it('serves the image only to the owner, a recipient and founders', async () => {
    const r = await get(pmImage, T.pm);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG);
    assert.equal((await get(pmImage, T.founder)).status, 200);
    assert.equal((await get(pmImage, T.developer)).status, 404); // not yet sent to anyone
    assert.equal((await get('not-a-uuid', T.pm)).status, 404);
    const q = await api('POST', '/messages', T.pm, { type: 'QUESTION', recipient_agent_id: AID.developer, payload: { text: 'What is in this picture?', project_id: projectId, attachments: [pmImage] } });
    assert.equal(q.status, 201);
    assert.deepEqual(q.body.payload.attachments, [pmImage]);
    assert.equal((await get(pmImage, T.developer)).status, 200); // recipient's user
  });
  it('rejects foreign, malformed, too many and misplaced attachments', async () => {
    const foreign = (await upload(T.developer, PNG)).body.attachment_id;
    const ask = (attachments: unknown, type = 'QUESTION') => api('POST', '/messages', T.pm, { type, recipient_agent_id: AID.developer, payload: { text: 'q', attachments } });
    assert.equal((await ask([foreign])).status, 404);
    assert.equal((await ask(['nope'])).status, 400);
    assert.equal((await ask([pmImage, pmImage, pmImage, pmImage, pmImage])).status, 400);
    assert.equal((await ask([pmImage], 'STATUS_UPDATE')).status, 400);
  });
  it('answers a self QUESTION with the image staged for Claude, BUSY meanwhile, and cleans up afterwards', async () => {
    const img = (await upload(T.founder, PNG)).body.attachment_id;
    const q = await api('POST', '/messages', T.founder, { type: 'QUESTION', recipient_agent_id: AID.founder, payload: { text: 'Describe the image', attachments: [img] } });
    assert.equal(q.status, 201);
    const busy = await until(async () => (await api('GET', '/agents', T.founder)).body.find((a: any) => a.id === AID.founder && a.status === 'BUSY'));
    assert.equal(busy.current_activity, 'Answering a question');
    assert.equal(busy.current_task_id, null);
    const ans = await until(async () => (await api('GET', '/messages?limit=500', T.founder)).body.find((m: any) => m.type === 'ANSWER' && m.payload.answers_message_id === q.body.message_id));
    assert.match(ans.payload.text, new RegExp(`Attachments: image-1\\.png=${PNG.length}`));
    const after = await until(async () => { const a = (await api('GET', '/agents', T.founder)).body.find((x: any) => x.id === AID.founder); return a.status !== 'BUSY' && a; });
    assert.equal(after.current_activity, null);
    assert.equal(fs.existsSync(path.join(WORKDIR, 'work', AID.founder, 'uploads')), false, 'staged copies removed');
  });
  it('goes back to ONLINE even when the run fails', async () => {
    const t = await api('POST', '/tasks', T.pm, { project_id: projectId, title: 'x [mock:fail]', description: 'd [mock:fail]', acceptance_criteria: 'ac', priority: 'LOW', assignee_agent_id: AID.developer });
    assert.equal(t.status, 201);
    const busy = await until(async () => (await api('GET', '/agents', T.pm)).body.find((a: any) => a.id === AID.developer && a.status === 'BUSY'));
    assert.equal(busy.current_task_id, t.body.id);
    assert.equal(busy.current_activity, null);
    await until(async () => (await api('GET', '/agents', T.pm)).body.find((a: any) => a.id === AID.developer && a.status === 'ONLINE'));
  });
});

describe('Claude logout', () => {
  it('is limited to the agent owner or a founder and never touches other agents', async () => {
    assert.equal((await api('POST', `/agents/${AID.developer}/claude-logout`, T.pm)).status, 404);
    assert.equal((await api('POST', `/agents/${AID.developer}/claude-logout`, AG.developer)).status, 403);
    const claudeOf = async (role: string) => (await api('GET', '/agents', T.founder)).body.find((a: any) => a.id === AID[role]).claude;
    await until(async () => (await claudeOf('developer'))?.logged_in === true);
    const r = await api('POST', `/agents/${AID.developer}/claude-logout`, T.developer);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.equal((await claudeOf('developer')).logged_in, false);
    assert.equal((await claudeOf('pm')).logged_in, true);
    assert.equal((await claudeOf('founder')).logged_in, true);
    assert.equal((await api('POST', `/agents/${AID.pm}/claude-logout`, T.founder)).status, 200); // founder may log out any agent
    assert.match(JSON.stringify((await api('GET', '/audit?limit=1000', T.founder)).body), /claude_logout/);
  });
});

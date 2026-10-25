import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://studio@127.0.0.1:55432/studio_test';
const PORT = 3914;
const BASE = `http://127.0.0.1:${PORT}`;
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cc-'));
const procs: ChildProcess[] = [];
const T: Record<string, string> = {}; // JWTs
const AG: Record<string, string> = {}; // agent tokens
const AID: Record<string, string> = {}; // agent ids
let projectId = '';
let outsiderProject = '';

async function api(method: string, p: string, token: string, body?: unknown) {
  const r = await fetch(`${BASE}/api${p}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
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
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });
const makeRepo = (dir: string, subject: string) => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), subject);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', subject);
};
const dbq = async (sql: string) => {
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  try { return (await c.query(sql)).rows; } finally { await c.end(); }
};
const KEY = 'a'.repeat(64);
const JIRA = { site_url: 'https://acme.atlassian.net', email: 'bot@acme.com', api_token: 'jira-secret-token-WXYZ' };

before(async () => {
  process.env.DATABASE_URL = DB;
  const { pool } = await import('../src/db.js');
  await pool.query('drop schema public cascade; create schema public;');
  await (await import('../src/migrate.js')).migrate();
  const s = await (await import('./fixtures.js')).seed();
  projectId = s.projectId;
  Object.assign(AG, s.tokens);
  await pool.end();
  spawnTs('src/index.ts', process.cwd(), { DATABASE_URL: DB, PORT: String(PORT), LOGIN_RATE_MAX: '1000', MOCK_CLAUDE: '1', CONNECTOR_KEY: KEY, DATA_DIR: WORKDIR, MOCK_DELAY_MS: '100', HEARTBEAT_MS: '1000', POLL_MS: '500' });
  await until(async () => (await fetch(`${BASE}/api/health`).catch(() => null))?.ok);
  for (const [role, email] of [['founder', 'founder@studio.local'], ['pm', 'pm@studio.local'], ['developer', 'dev@studio.local']]) {
    T[role] = (await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Passw0rd!' }) })).json()).token;
  }
  for (const a of (await api('GET', '/agents', T.founder)).body) AID[a.role] = a.id;
  outsiderProject = (await api('POST', '/projects', T.founder, { name: 'Outsider' })).body.id; // dev/pm are not members
});
after(() => {
  for (const p of procs) try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* gone */ }
  fs.rmSync(WORKDIR, { recursive: true, force: true });
});

describe('Login with Claude', () => {
  const CODE = 'super-secret-oauth-code-123';
  let loginId = '';
  it('only the agent owner or a founder may start a login', async () => {
    assert.equal((await api('POST', `/agents/${AID.developer}/claude-login`, T.pm)).status, 404);
    assert.equal((await api('GET', `/agents/${AID.developer}/claude-login`, T.pm)).status, 404);
    const none = await api('GET', `/agents/${AID.developer}/claude-login`, T.developer);
    assert.equal(none.status, 200);
    assert.deepEqual(none.body, { login_id: null, status: 'NONE' });
    const r = await api('POST', `/agents/${AID.developer}/claude-login`, T.developer);
    assert.equal(r.status, 201);
    assert.equal(r.body.status, 'PENDING');
    loginId = r.body.login_id;
  });
  it('in-process runner publishes the URL, code is relayed once, status reaches SUCCESS', async () => {
    const l = await until(async () => { const g = (await api('GET', `/agents/${AID.developer}/claude-login`, T.developer)).body; return g.status === 'URL_READY' && g; });
    assert.equal(l.login_id, loginId);
    assert.match(l.url, /^https:\/\//);
    assert.equal((await api('POST', `/agents/${AID.developer}/claude-login/code`, T.developer, { login_id: '00000000-0000-4000-8000-000000000000', code: CODE })).status, 409);
    const c = await api('POST', `/agents/${AID.developer}/claude-login/code`, T.developer, { login_id: loginId, code: CODE });
    assert.equal(c.status, 200);
    assert.equal(c.body.status, 'CODE_SUBMITTED');
    assert.equal(JSON.stringify(c.body).includes(CODE), false);
    await until(async () => (await api('GET', `/agents/${AID.developer}/claude-login`, T.developer)).body.status === 'SUCCESS');
    // the code can be forwarded only once
    assert.equal((await api('POST', `/agents/${AID.developer}/claude-login/code`, T.developer, { login_id: loginId, code: CODE })).status, 409);
  });
  it('never persists the code (messages blanked after delivery, audit clean)', async () => {
    const msgs = (await api('GET', '/messages?limit=500', T.founder)).body;
    const m = msgs.filter((x: any) => x.payload?.command === 'CLAUDE_LOGIN_CODE');
    assert.equal(m.length, 1);
    assert.equal(m[0].payload.code, '');
    const raw = (await dbq(`select payload from messages where payload->>'command' = 'CLAUDE_LOGIN_CODE'`))[0].payload;
    assert.equal(raw.code, '', 'blanked in the database, not only in the API');
    const audit = JSON.stringify((await api('GET', '/audit?limit=1000', T.founder)).body);
    assert.equal(audit.includes(CODE), false);
    assert.match(audit, /claude_login\.code_submitted/);
  });
});

describe('connectors', () => {
  let globalId = '';
  let scopedId = '';
  let otherId = '';
  it('is founder-only for users and unreachable with agent tokens', async () => {
    for (const role of ['pm', 'developer']) {
      assert.equal((await api('GET', '/connectors', T[role])).status, 403);
      assert.equal((await api('POST', '/connectors', T[role], { name: 'x', type: 'github', config: { token: 't' } })).status, 403);
    }
    assert.equal((await api('GET', '/connectors', AG.founder)).status, 403); // agent tokens cannot use /api/connectors
    assert.equal((await api('GET', '/connectors', '')).status, 401);
  });
  it('creates, validates and masks secrets', async () => {
    assert.equal((await api('POST', '/connectors', T.founder, { name: 'bad', type: 'jira', config: { site_url: 'http://insecure', email: 'a@b.c', api_token: 'x' } })).status, 400);
    assert.equal((await api('POST', '/connectors', T.founder, { name: 'bad2', type: 'mcp', config: { url: 'https://a.b/mcp', command: 'x' } })).status, 400);
    const j = await api('POST', '/connectors', T.founder, { name: 'Jira', type: 'jira', config: JIRA, allow_write: true });
    assert.equal(j.status, 201);
    globalId = j.body.id;
    assert.equal(j.body.config.api_token, '••••WXYZ');
    assert.equal(j.body.config.site_url, JIRA.site_url);
    const s = await api('POST', '/connectors', T.founder, { name: 'Repo GitHub', type: 'github', project_id: projectId, config: { token: 'ghp_scopedtoken1234' } });
    scopedId = s.body.id;
    const o = await api('POST', '/connectors', T.founder, { name: 'Other MCP', type: 'mcp', project_id: outsiderProject, config: { url: 'https://mcp.example.com/x', headers: { 'X-Key': 'outsider-secret-9876' } } });
    otherId = o.body.id;
    const list = await api('GET', '/connectors', T.founder);
    const text = JSON.stringify(list.body);
    for (const secret of [JIRA.api_token, 'ghp_scopedtoken1234', 'outsider-secret-9876']) assert.equal(text.includes(secret), false, 'no cleartext secret in GET');
    assert.equal(list.body.find((c: any) => c.id === otherId).config.headers['X-Key'], '••••9876');
    const raw = (await dbq('select config_encrypted from connectors')).map((r) => r.config_encrypted).join('|');
    assert.equal(raw.includes('jira-secret'), false, 'encrypted at rest');
    assert.match(raw, /^v1:/);
  });
  it('PATCH keeps a secret when the masked value is echoed back; test endpoint works in mock mode', async () => {
    const p = await api('PATCH', `/connectors/${globalId}`, T.founder, { config: { api_token: '••••WXYZ', email: 'new@acme.com' }, name: 'Jira' });
    assert.equal(p.status, 200);
    assert.equal(p.body.config.email, 'new@acme.com');
    const mine = (await api('GET', '/agent/connectors', AG.developer)).body.find((c: any) => c.id === globalId);
    assert.equal(mine.server.env.JIRA_API_TOKEN, JIRA.api_token);
    assert.equal(mine.server.env.JIRA_USERNAME, 'new@acme.com');
    assert.equal(mine.server.env.READ_ONLY_MODE, undefined, 'allow_write=true');
    const t = await api('POST', `/connectors/${globalId}/test`, T.founder);
    assert.equal(t.body.ok, true);
    assert.equal((await api('POST', `/connectors/${globalId}/test`, T.pm)).status, 403);
  });
  it('agent fetch is scoped by project membership and audited', async () => {
    const names = async (token: string) => (await api('GET', '/agent/connectors', token)).body.map((c: any) => c.id);
    const dev = await names(AG.developer);
    assert.ok(dev.includes(globalId) && dev.includes(scopedId), 'global + own project');
    assert.equal(dev.includes(otherId), false, 'connector of a project the agent is not in is hidden');
    assert.equal((await api('GET', `/agent/connectors?project_id=${outsiderProject}`, AG.developer)).status, 404);
    assert.ok((await names(AG.founder)).includes(otherId), 'founder agent sees every project');
    assert.equal((await api('GET', '/agent/connectors', T.developer)).status, 403); // user JWT is not an agent
    const gh = (await api('GET', '/agent/connectors', AG.developer)).body.find((c: any) => c.id === scopedId);
    assert.equal(gh.allow_write, false);
    assert.equal(gh.server.headers['X-MCP-Readonly'], 'true');
    assert.equal(gh.name, 'repo-github');
    // disabled connectors are not served; deleting removes them
    await api('PATCH', `/connectors/${scopedId}`, T.founder, { enabled: false });
    assert.equal((await names(AG.developer)).includes(scopedId), false);
    await api('PATCH', `/connectors/${scopedId}`, T.founder, { enabled: true });
    const audit = JSON.stringify((await api('GET', '/audit?limit=1000', T.founder)).body);
    for (const a of ['connector.create', 'connector.update', 'connector.test', 'connector.agent_fetch']) assert.match(audit, new RegExp(a));
    for (const secret of [JIRA.api_token, 'ghp_scopedtoken1234', 'outsider-secret-9876']) assert.equal(audit.includes(secret), false, 'audit holds no secrets');
    assert.equal((await api('DELETE', `/connectors/${otherId}`, T.founder)).status, 200);
    assert.equal((await api('GET', '/connectors', T.founder)).body.some((c: any) => c.id === otherId), false);
  });
  it('connectors-available lists studio connectors without secrets; owner or founder only', async () => {
    const r = await api('GET', `/agents/${AID.developer}/connectors-available`, T.developer);
    assert.equal(r.status, 200);
    const list = r.body.connectors;
    assert.ok(list.some((c: any) => c.type === 'studio' && c.name === 'Repo GitHub'));
    assert.equal(list.some((c: any) => c.name === 'Other MCP' || c.type === 'claude.ai'), false, 'mock mode has no account connectors; other projects hidden');
    const text = JSON.stringify(r.body);
    for (const secret of [JIRA.api_token, 'ghp_scopedtoken1234']) assert.equal(text.includes(secret), false);
    assert.equal((await api('GET', `/agents/${AID.developer}/connectors-available`, T.pm)).status, 404);
    assert.equal((await api('GET', `/agents/${AID.developer}/connectors-available`, T.founder)).status, 200);
  });
});

describe('project repos + chat questions that use git', () => {
  it('only founders edit repos; invalid repo URLs are rejected', async () => {
    assert.equal((await api('PATCH', `/projects/${projectId}`, T.pm, { repos: [] })).status, 403);
    assert.equal((await api('PATCH', `/projects/${projectId}`, T.founder, { repos: [{ name: 'git-mobile', url: 'file:///etc' }] })).status, 400);
    const ok = await api('PATCH', `/projects/${projectId}`, T.founder, { repos: [{ name: 'git-mobile', url: 'https://127.0.0.1:1/git-mobile.git' }] });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.repos, [{ name: 'git-mobile', url: 'https://127.0.0.1:1/git-mobile.git' }]);
  });
  it('answers "what changed in git-mobile?" from the real checkout (temp repo) and says when fetch failed', async () => {
    makeRepo(path.join(WORKDIR, 'work', AID.developer, 'repos', projectId), 'feat: web login screen');
    const mobile = path.join(WORKDIR, 'work', AID.developer, 'repos', `${projectId}__git-mobile`);
    makeRepo(mobile, 'fix: mobile crash on launch');
    git(mobile, 'remote', 'add', 'origin', 'https://127.0.0.1:1/git-mobile.git'); // unreachable: fetch must fail gracefully
    const q = await api('POST', '/messages', T.pm, { type: 'QUESTION', recipient_agent_id: AID.developer, payload: { text: 'what changed in git-mobile?', project_id: projectId }, idempotency_key: 'q-git' });
    assert.equal(q.status, 201);
    const pmInbox = async () => (await api('GET', '/messages?limit=500', T.pm)).body;
    const ans = await until(async () => (await pmInbox()).find((m: any) => m.type === 'ANSWER' && m.payload.answers_message_id === q.body.message_id));
    assert.match(ans.payload.text, /fix: mobile crash on launch/);
    assert.match(ans.payload.text, /git-mobile: could not fetch/);
    assert.match(ans.payload.text, /Connectors: .*jira \(write\)/);
    assert.match(ans.payload.text, /repo-github \(read-only\)/);
  });
  it('keeps plain status questions on the snapshot path', async () => {
    const q = await api('POST', '/messages', T.pm, { type: 'QUESTION', recipient_agent_id: AID.developer, payload: { text: 'Status?', project_id: projectId }, idempotency_key: 'q-status' });
    const ans = await until(async () => (await api('GET', '/messages?limit=500', T.pm)).body.find((m: any) => m.type === 'ANSWER' && m.payload.answers_message_id === q.body.message_id));
    assert.match(ans.payload.text, /Active tasks/);
  });
});

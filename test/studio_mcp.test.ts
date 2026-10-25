import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import express from 'express';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://studio@127.0.0.1:55432/studio_test';
let mod: typeof import('../src/agents/studioMcp.js');
let actors: Record<string, any> = {};
let agentIds: Record<string, string> = {};
let projectId = '';
let server: http.Server;
let base = '';
let db: typeof import('../src/db.js');

before(async () => {
  process.env.DATABASE_URL = DB;
  db = await import('../src/db.js');
  await db.pool.query('drop schema public cascade; create schema public;');
  await (await import('../src/migrate.js')).migrate();
  projectId = (await (await import('./fixtures.js')).seed()).projectId;
  mod = await import('../src/agents/studioMcp.js');
  for (const r of await db.q('select a.id, a.role, a.user_id, u.name from agents a join users u on u.id = a.user_id')) {
    actors[r.role] = { kind: 'agent', userId: r.user_id, name: r.name, role: r.role, agentId: r.id };
    agentIds[r.role] = r.id;
  }
  const app = express();
  app.use(express.json());
  app.use(mod.studioMcpRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => { server.close(); await db.pool.end(); });

const rpc = async (token: string, method: string, params?: unknown) => {
  const r = await fetch(`${base}/internal/mcp/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return { status: r.status, body: r.status === 200 ? await r.json() : null };
};
const call = async (token: string, name: string, args: object) => {
  const r = await rpc(token, 'tools/call', { name, arguments: args });
  const res = r.body.result;
  return { isError: !!res.isError, data: res.isError ? res.content[0].text : JSON.parse(res.content[0].text) };
};

describe('studio MCP', () => {
  it('lists tools and creates a task as the founder agent (audit actor = agent, sender = agent)', async () => {
    const t = mod.issueRunToken(actors.founder);
    assert.equal((await rpc(t, 'initialize', {})).body.result.serverInfo.name, 'studio');
    assert.equal((await rpc(t, 'tools/list')).body.result.tools.length, 5);
    assert.equal((await call(t, 'studio_list_projects', {})).data.length, 1);
    assert.equal((await call(t, 'studio_list_agents', {})).data.length, 3);
    const c = await call(t, 'studio_create_task', { project_id: projectId, title: 'Via MCP', assignee_agent_id: agentIds.developer, idempotency_key: 'k1', priority: 'HIGH' });
    assert.equal(c.isError, false);
    assert.equal(c.data.created, true);
    const again = await call(t, 'studio_create_task', { project_id: projectId, title: 'Via MCP', assignee_agent_id: agentIds.developer, idempotency_key: 'k1' });
    assert.equal(again.data.id, c.data.id);
    assert.equal(again.data.created, false);
    const row = await db.q1('select * from tasks where id = $1', [c.data.id]);
    assert.equal(row!.sender_agent_id, agentIds.founder);
    assert.equal(row!.reply_to_agent_id, agentIds.founder);
    const au = await db.q1(`select actor_type, actor_id from audit_log where action = 'task.create' and entity_id = $1`, [c.data.id]);
    assert.deepEqual([au!.actor_type, au!.actor_id], ['agent', agentIds.founder]);
    assert.equal((await call(t, 'studio_list_tasks', { status: 'PENDING' })).data.some((x: any) => x.id === c.data.id), true);
    assert.equal((await call(t, 'studio_project_status', { project_id: projectId })).data.active_tasks.length >= 1, true);
  });

  it('enforces RBAC: PM may assign only developers; developers get no token; bad args are tool errors', async () => {
    const t = mod.issueRunToken(actors.pm);
    const bad = await call(t, 'studio_create_task', { project_id: projectId, title: 'x', assignee_agent_id: agentIds.founder, idempotency_key: 'k2' });
    assert.equal(bad.isError, true);
    assert.match(bad.data, /cannot assign/);
    assert.equal((await call(t, 'studio_create_task', { project_id: projectId, title: 'x', assignee_agent_id: agentIds.developer, idempotency_key: 'k3' })).isError, false);
    assert.equal((await call(t, 'studio_create_task', { title: 'no project' })).isError, true);
    assert.throws(() => mod.issueRunToken(actors.developer));
    await assert.rejects(mod.callTool(actors.developer, 'studio_list_projects', {}));
  });

  it('enforces project membership', async () => {
    const other = await db.q1(`insert into projects (name) values ('Other') returning id`);
    const t = mod.issueRunToken(actors.pm);
    const r = await call(t, 'studio_create_task', { project_id: other!.id, title: 'x', assignee_agent_id: agentIds.developer, idempotency_key: 'k4' });
    assert.equal(r.isError, true);
    assert.equal((await call(t, 'studio_project_status', { project_id: other!.id })).isError, true);
  });

  it('tokens expire, are revoked after the run, and unknown tokens are 404', async () => {
    const short = mod.issueRunToken(actors.founder, 30);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal((await rpc(short, 'tools/list')).status, 404);
    const t = mod.issueRunToken(actors.founder);
    mod.revokeRunToken(t);
    assert.equal((await rpc(t, 'tools/list')).status, 404);
    assert.equal((await rpc('run_nope', 'tools/list')).status, 404);
  });

  it('prepareStudioMcp writes a 0600 config with the loopback URL and cleanup revokes the token', async () => {
    const fs = await import('node:fs');
    const run = mod.prepareStudioMcp(actors.founder);
    const cfg = JSON.parse(fs.readFileSync(run.file, 'utf8'));
    assert.match(cfg.mcpServers.studio.url, /^http:\/\/127\.0\.0\.1:\d+\/internal\/mcp\/run_[0-9a-f]+$/);
    assert.equal(fs.statSync(run.file).mode & 0o777, 0o600);
    assert.deepEqual(run.allowed, ['mcp__studio__*']);
    const token = cfg.mcpServers.studio.url.split('/').pop();
    assert.equal((await rpc(token, 'tools/list')).status, 200);
    run.cleanup();
    assert.equal(fs.existsSync(run.file), false);
    assert.equal((await rpc(token, 'tools/list')).status, 404);
  });

  it('refuses proxied requests', async () => {
    const t = mod.issueRunToken(actors.founder);
    const r = await fetch(`${base}/internal/mcp/${t}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' }, body: '{}' });
    assert.equal(r.status, 404);
  });
});

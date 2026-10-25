import { Router } from 'express';
import { z } from 'zod';
import { assertProject, authenticate, newAgentToken, requireAgent, requireRole, sha256 } from '../auth.js';
import { config } from '../config.js';
import { pool, q, q1, tx } from '../db.js';
import { HttpError } from '../errors.js';
import { audit } from '../services/audit.js';
import { changeStatus } from '../services/tasks.js';
import { projectStatus } from '../services/status.js';
import { emitAgent, emitAgentRemoved, emitAgentUpdated, emitClaudeLogin, emitTask, forRole } from '../events.js';
import { agentConnectors } from '../services/connectors.js';
import { agentSelect, removedAgentSelect } from '../services/agentView.js';
import { reportClaudeLogin, saveClaudeStatus } from '../services/claudeLogin.js';
import rateLimit from 'express-rate-limit';
import { checkClaude, claudeLogout, listAccountConnectors } from '../agents/claude.js';
import { MEMORY_MAX_BYTES, readMemory, resetSessions, writeMemory } from '../agents/memory.js';
import { removeAgent, startAgent, stopAgent } from '../agents/manager.js';
import { insertMessage, publish } from '../services/messages.js';
import { postMessage } from './messages.js';
import { statusBody } from './tasks.js';

export const agentsRouter = Router();
agentsRouter.use(authenticate);

agentsRouter.get('/agents', async (req, res) => {
  const rows = await q(`${agentSelect} order by a.created_at`, [config.offlineAfterSec]);
  // ?include_removed=1 appends soft-deleted agents (name "<name> (removed)", removed: true) so old tasks/messages can resolve their names.
  const removed = ['1', 'true'].includes(String(req.query.include_removed ?? '')) ? await q(`${removedAgentSelect} order by a.created_at`) : [];
  res.json([...rows, ...removed].map((r) => forRole(r, req.actor.role)));
});

agentsRouter.patch('/agents/:id', async (req, res) => {
  const b = z.object({
    name: z.string().trim().min(1).max(60).optional(),
    execution_mode: z.enum(['server', 'worker']).optional(),
  }).refine((v) => v.name !== undefined || v.execution_mode !== undefined, 'nothing to update').parse(req.body);
  const agent = await manageableAgent(req);
  if (req.actor.kind !== 'user') throw new HttpError(403, 'agent tokens cannot use this endpoint');
  if (b.execution_mode !== undefined && req.actor.role !== 'founder') throw new HttpError(403, 'forbidden');
  if (b.execution_mode !== undefined) {
    await q('update agents set execution_mode = $2 where id = $1', [agent.id, b.execution_mode]);
    await audit(pool, req.actor, 'agent.update', 'agent', agent.id, { execution_mode: b.execution_mode });
  }
  if (b.name !== undefined && b.name !== agent.name) {
    await q('update agents set name = $2 where id = $1', [agent.id, b.name]);
    await audit(pool, req.actor, 'agent.rename', 'agent', agent.id, { old: agent.name, new: b.name });
  }
  const view = await q1(`${agentSelect} where a.id = $2`, [config.offlineAfterSec, agent.id]);
  emitAgentUpdated(view);
  if (b.execution_mode === 'server') await startAgent(agent.id); else if (b.execution_mode === 'worker') stopAgent(agent.id);
  res.json(view);
});

agentsRouter.post('/agents', requireRole('founder'), async (req, res) => {
  const b = z.object({
    name: z.string().min(1).max(100),
    role: z.enum(['founder', 'pm', 'developer']),
    user_id: z.string().uuid(),
  }).parse(req.body);
  const user = await q1('select id, role from users where id = $1', [b.user_id]);
  if (!user) throw new HttpError(404, 'user not found');
  if (user.role !== b.role) throw new HttpError(400, 'agent role must match the user role');
  const token = newAgentToken();
  const row = await q1('insert into agents (name, role, user_id, token_hash) values ($1,$2,$3,$4) returning id', [b.name, b.role, b.user_id, sha256(token)]);
  await audit(pool, req.actor, 'agent.create', 'agent', row!.id, { role: b.role, user_id: b.user_id });
  const agent = await q1(`${agentSelect} where a.id = $2`, [config.offlineAfterSec, row!.id]);
  await startAgent(row!.id);
  res.status(201).json({ agent, token }); // token is shown once (for external workers); only its hash is stored
});

// Founder: any agent; owner: their own. Never your own founder agent, never the last founder agent.
// No history -> hard delete. History -> needs ?force=1 and the agent is soft-deleted (history rows stay intact).
agentsRouter.delete('/agents/:id', async (req, res) => {
  const force = ['1', 'true'].includes(String(req.query.force ?? ''));
  const a = await manageableAgent(req);
  if (req.actor.kind !== 'user') throw new HttpError(403, 'agent tokens cannot use this endpoint');
  if (a.role === 'founder') {
    if (a.user_id === req.actor.userId) throw new HttpError(400, "the founder's own agent cannot be deleted");
    const others = await q1(`select count(*)::int as n from agents where role = 'founder' and deleted_at is null and id <> $1`, [a.id]);
    if (!others!.n) throw new HttpError(400, 'the last founder agent cannot be deleted');
  }
  const h = await q1(
    `select (select count(*)::int from tasks where $1 in (sender_agent_id, assignee_agent_id, reply_to_agent_id)) as tasks,
            (select count(*)::int from messages where $1 in (sender_agent_id, recipient_agent_id)) as messages,
            (select count(*)::int from reports where agent_id = $1) as reports`, [a.id]);
  if (!h!.tasks && !h!.messages && !h!.reports) {
    stopAgent(a.id);
    await pool.query('delete from agents where id = $1', [a.id]);
    await removeAgent(a.id);
    await audit(pool, req.actor, 'agent.delete', 'agent', a.id, { name: a.name });
    emitAgentRemoved(a.id);
    return void res.status(204).end();
  }
  if (!force) {
    throw new HttpError(409, `agent has history (${h!.tasks} task(s), ${h!.messages} message(s)); pass ?force=1 to remove it (history is kept, open tasks are cancelled)`);
  }
  stopAgent(a.id);
  const cancelled = await tx(async (c, after) => {
    await q(`update agents set deleted_at = now(), token_hash = 'revoked:' || id::text, status = 'OFFLINE', current_task_id = null, current_activity = null
             where id = $1`, [a.id], c);
    const open = await q(`select id, status from tasks where assignee_agent_id = $1 and status not in ('COMPLETED','CANCELLED','FAILED') for update`, [a.id], c);
    const rows: any[] = [];
    for (const t of open) {
      rows.push(await q1(`update tasks set status = 'CANCELLED', updated_at = now(), completed_at = null where id = $1 returning *`, [t.id], c));
      await audit(c, req.actor, 'task.status', 'task', t.id, { from: t.status, to: 'CANCELLED', note: 'Agent removed' });
    }
    await audit(c, req.actor, 'agent.delete', 'agent', a.id, { name: a.name, soft: true, tasks: h!.tasks, messages: h!.messages, cancelled_tasks: rows.length });
    after(() => rows.forEach((t) => emitTask('task:updated', t)));
    return rows.length;
  });
  await removeAgent(a.id);
  emitAgentRemoved(a.id);
  res.json({ id: a.id, removed: true, soft: true, cancelled_tasks: cancelled });
});

// ---- "Login with Claude" (per agent; the worker drives the CLI, the server only relays URL/code/status) ----
const loginView = (r: any) => r && ({ login_id: r.login_id, status: r.status, url: r.url ?? undefined, error: r.error ?? undefined, updated_at: r.updated_at });

async function manageableAgent(req: any) {
  const agent = await q1('select id, user_id, name, role from agents where id = $1 and deleted_at is null', [req.params.id]);
  if (!agent || (req.actor.role !== 'founder' && agent.user_id !== req.actor.userId)) throw new HttpError(404, 'agent not found'); // 404: do not reveal other agents
  return agent;
}
const systemAlert = (c: any, sender: string, agentId: string, payload: object) =>
  insertMessage(c, { type: 'SYSTEM_ALERT', sender, recipient: agentId, conversation_id: `claude-login:${agentId}`, payload });

// Connectors this agent can use: the human's claude.ai account connectors (from the real CLI) + Studio-stored ones. No secrets.
agentsRouter.get('/agents/:id/connectors-available', async (req, res) => {
  const agent = await manageableAgent(req);
  const full = await q1('select role from agents where id = $1', [agent.id]);
  const rows = await q(
    `select name, project_id is null as global, allow_write from connectors
     where enabled and (project_id is null or $2 or project_id in (select project_id from project_members where user_id = $1)) order by created_at`,
    [agent.user_id, full?.role === 'founder'],
  );
  const account = await listAccountConnectors(agent.id);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    connectors: [
      ...account.map((c) => ({ name: c.name, type: 'claude.ai', status: c.status })),
      ...rows.map((r) => ({ name: r.name, type: 'studio', status: 'configured', allow_write: r.allow_write })),
    ],
  });
});

agentsRouter.post('/agents/:id/claude-login', async (req, res) => {
  const agent = await manageableAgent(req);
  const row = await tx(async (c, after) => {
    await q(`update claude_logins set status = 'FAILED', error = 'superseded by a newer login', updated_at = now()
             where agent_id = $1 and status in ('PENDING','URL_READY','CODE_SUBMITTED')`, [agent.id], c);
    const l = await q1('insert into claude_logins (agent_id, created_by) values ($1,$2) returning *', [agent.id, req.actor.userId], c);
    const { msg } = await systemAlert(c, req.actor.agentId ?? agent.id, agent.id, { command: 'CLAUDE_LOGIN_START', login_id: l!.login_id });
    await audit(c, req.actor, 'claude_login.start', 'agent', agent.id, { login_id: l!.login_id });
    after(() => publish([msg]));
    return l!;
  });
  res.status(201).json({ login_id: row.login_id, status: row.status });
});

agentsRouter.get('/agents/:id/claude-login', async (req, res) => {
  const agent = await manageableAgent(req);
  const row = await q1('select * from claude_logins where agent_id = $1 order by created_at desc limit 1', [agent.id]);
  res.json(row ? loginView(row) : { login_id: null, status: 'NONE' });
});

agentsRouter.post('/agents/:id/claude-login/code', async (req, res) => {
  const agent = await manageableAgent(req);
  const b = z.object({ login_id: z.string().uuid(), code: z.string().trim().min(1).max(2000) }).parse(req.body);
  await tx(async (c, after) => {
    // Atomic: the code can be forwarded only once, and only after the worker published the URL.
    const l = await q1(
      `update claude_logins set status = 'CODE_SUBMITTED', updated_at = now()
       where login_id = $1 and agent_id = $2 and status = 'URL_READY' returning *`, [b.login_id, agent.id], c);
    if (!l) throw new HttpError(409, 'login is not waiting for a code');
    const { msg } = await systemAlert(c, req.actor.agentId ?? agent.id, agent.id, { command: 'CLAUDE_LOGIN_CODE', login_id: b.login_id, code: b.code });
    await audit(c, req.actor, 'claude_login.code_submitted', 'agent', agent.id, { login_id: b.login_id }); // never the code
    after(() => { publish([msg]); emitClaudeLogin(agent.user_id, { agent_id: agent.id, login_id: b.login_id, status: 'CODE_SUBMITTED' }); });
  });
  res.json({ login_id: b.login_id, status: 'CODE_SUBMITTED' });
});

// Signs this agent out of Claude (its own CLAUDE_CONFIG_DIR only), then refreshes and broadcasts its status.
const logoutLimiter = rateLimit({
  windowMs: 60_000, limit: 5, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req: any) => req.actor?.userId ?? 'anon',
  message: { error: 'too many attempts, try again later' },
});
agentsRouter.post('/agents/:id/claude-logout', logoutLimiter, async (req, res) => {
  const agent = await manageableAgent(req);
  if (req.actor.kind !== 'user') throw new HttpError(403, 'agent tokens cannot use this endpoint');
  const ok = await claudeLogout(agent.id);
  const { available: _a, ...s } = await checkClaude(agent.id);
  await saveClaudeStatus({ ...req.actor, userId: agent.user_id, agentId: agent.id }, s);
  await audit(pool, req.actor, 'claude_logout', 'agent', agent.id, { ok, logged_in: s.logged_in });
  const view = await q1(`${agentSelect} where a.id = $2`, [config.offlineAfterSec, agent.id]);
  if (view) emitAgent(view);
  if (!ok || s.logged_in) throw new HttpError(502, 'claude logout failed');
  res.json({ ok: true });
});

// ---- Agent API (agent token only) ----
export const agentApi = Router();
agentApi.use('/agent', authenticate, requireAgent);

agentApi.get('/agent/me', async (req, res) => {
  const agent = await q1(`${agentSelect} where a.id = $2`, [config.offlineAfterSec, req.actor.agentId]);
  res.json({ id: req.actor.agentId, role: req.actor.role, user_id: req.actor.userId, project_ids: agent?.project_ids ?? [] });
});

agentApi.post('/agent/heartbeat', async (req, res) => {
  const b = z.object({
    status: z.enum(['ONLINE', 'BUSY', 'IDLE', 'OFFLINE', 'ERROR']),
    current_task_id: z.string().uuid().nullish(),
    current_activity: z.string().max(200).nullish(),
  }).parse(req.body);
  await q('update agents set status = $2, current_task_id = $3, current_activity = $4, last_seen_at = now() where id = $1', [req.actor.agentId, b.status, b.current_task_id ?? null, b.current_activity ?? null]);
  const agent = await q1(`${agentSelect} where a.id = $2`, [config.offlineAfterSec, req.actor.agentId]);
  emitAgent(agent);
  const pending = await q1('select count(*)::int as n from messages where recipient_agent_id = $1 and delivered_at is null', [req.actor.agentId]);
  res.json({ ok: true, server_time: new Date().toISOString(), inbox_pending: pending!.n });
});

agentApi.get('/agent/peers/:id', async (req, res) => {
  const p = await q1('select id, role from agents where id = $1 and deleted_at is null', [req.params.id]);
  if (!p) throw new HttpError(404, 'agent not found');
  res.json(p);
});

agentApi.get('/agent/inbox', async (req, res) => {
  const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
  res.json(await q(
    'select * from messages where recipient_agent_id = $1 and delivered_at is null order by created_at limit $2',
    [req.actor.agentId, limit],
  ));
});

agentApi.post('/agent/messages/:id/ack', async (req, res) => {
  const m = await q1('select recipient_agent_id from messages where message_id = $1', [req.params.id]);
  if (!m || m.recipient_agent_id !== req.actor.agentId) throw new HttpError(404, 'message not found');
  // A login code lives in the DB only until the worker has it.
  await q(`update messages set delivered_at = coalesce(delivered_at, now()),
             payload = case when payload ? 'code' then payload || '{"code":""}'::jsonb else payload end where message_id = $1`, [req.params.id]);
  res.json({ ok: true });
});

agentApi.post('/agent/tasks/:id/status', async (req, res) => {
  const b = statusBody.parse(req.body);
  res.json(await tx((c, after) => changeStatus(c, after, req.params.id, req.actor, b.status, b.note)));
});

agentApi.post('/agent/messages', postMessage);

agentApi.post('/agent/claude-status', async (req, res) => {
  const b = z.object({
    logged_in: z.boolean(),
    auth_method: z.string().max(50).default(''),
    limit_reached: z.boolean().default(false),
    detail: z.string().max(500).default(''),
  }).parse(req.body);
  await saveClaudeStatus(req.actor, b);
  res.json({ ok: true });
});

agentApi.post('/agent/claude-login/:loginId', async (req, res) => {
  const b = z.object({
    status: z.enum(['URL_READY', 'SUCCESS', 'FAILED']),
    url: z.string().url().max(2000).refine((u) => u.startsWith('https://'), 'url must be https').optional(),
    error: z.string().max(300).optional(),
  }).parse(req.body);
  await reportClaudeLogin(req.actor, req.params.loginId, b);
  res.json({ ok: true });
});

agentApi.get('/agent/connectors', async (req, res) => {
  const { project_id } = z.object({ project_id: z.string().uuid().optional() }).parse(req.query);
  res.setHeader('Cache-Control', 'no-store');
  res.json(await agentConnectors(req.actor, project_id));
});

agentApi.get('/agent/project-status/:projectId', async (req, res) => {
  await assertProject(req.actor, req.params.projectId);
  res.json(await projectStatus(req.params.projectId));
});

export const auditRouter = Router();
auditRouter.get('/audit', authenticate, requireRole('founder'), async (req, res) => {
  const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(100) }).parse(req.query);
  res.json(await q('select * from audit_log order by id desc limit $1', [limit]));
});


// ---- Agent memory (owner or founder): CLAUDE.md in the agent's own Claude config dir + per-conversation session ids ----
agentsRouter.get('/agents/:id/memory', async (req, res) => {
  const agent = await manageableAgent(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json(readMemory(agent.id));
});

agentsRouter.put('/agents/:id/memory', async (req, res) => {
  const agent = await manageableAgent(req);
  const b = z.object({ content: z.string() }).parse(req.body);
  const bytes = Buffer.byteLength(b.content, 'utf8');
  if (bytes > MEMORY_MAX_BYTES) throw new HttpError(413, `memory is limited to ${MEMORY_MAX_BYTES} bytes`);
  writeMemory(agent.id, b.content);
  await audit(pool, req.actor, 'agent.memory.update', 'agent', agent.id, { bytes }); // never the content
  res.json(readMemory(agent.id));
});

agentsRouter.post('/agents/:id/chat/reset', async (req, res) => {
  const agent = await manageableAgent(req);
  resetSessions(agent.id);
  await audit(pool, req.actor, 'agent.chat.reset', 'agent', agent.id, {});
  res.status(204).end();
});

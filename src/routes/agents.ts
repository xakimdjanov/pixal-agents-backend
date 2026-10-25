import { Router } from 'express';
import { z } from 'zod';
import { assertProject, authenticate, newAgentToken, requireAgent, requireRole, sha256 } from '../auth.js';
import { config } from '../config.js';
import { pool, q, q1, tx } from '../db.js';
import { HttpError } from '../errors.js';
import { audit } from '../services/audit.js';
import { changeStatus } from '../services/tasks.js';
import { projectStatus } from '../services/status.js';
import { emitAgent, emitClaudeLogin, forRole } from '../events.js';
import { agentConnectors } from '../services/connectors.js';
import { agentSelect } from '../services/agentView.js';
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
  res.json(rows.map((r) => forRole(r, req.actor.role)));
});

agentsRouter.patch('/agents/:id', requireRole('founder'), async (req, res) => {
  const b = z.object({ execution_mode: z.enum(['server', 'worker']) }).parse(req.body);
  const row = await q1('update agents set execution_mode = $2 where id = $1 returning id', [req.params.id, b.execution_mode]);
  if (!row) throw new HttpError(404, 'agent not found');
  await audit(pool, req.actor, 'agent.update', 'agent', row.id, { execution_mode: b.execution_mode });
  const agent = await q1(`${agentSelect} where a.id = $2`, [config.offlineAfterSec, row.id]);
  emitAgent(agent);
  if (b.execution_mode === 'server') await startAgent(row.id); else stopAgent(row.id);
  res.json(agent);
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

agentsRouter.delete('/agents/:id', requireRole('founder'), async (req, res) => {
  const a = await q1('select id from agents where id = $1', [req.params.id]);
  if (!a) throw new HttpError(404, 'agent not found');
  stopAgent(a.id);
  try {
    await pool.query('delete from agents where id = $1', [a.id]);
  } catch (e: any) {
    if (e?.code === '23503') { await startAgent(a.id); throw new HttpError(409, 'agent has tasks or messages and cannot be deleted'); }
    throw e;
  }
  await removeAgent(a.id);
  await audit(pool, req.actor, 'agent.delete', 'agent', a.id, {});
  res.status(204).end();
});

// ---- "Login with Claude" (per agent; the worker drives the CLI, the server only relays URL/code/status) ----
const loginView = (r: any) => r && ({ login_id: r.login_id, status: r.status, url: r.url ?? undefined, error: r.error ?? undefined, updated_at: r.updated_at });

async function manageableAgent(req: any) {
  const agent = await q1('select id, user_id from agents where id = $1', [req.params.id]);
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
  const p = await q1('select id, role from agents where id = $1', [req.params.id]);
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

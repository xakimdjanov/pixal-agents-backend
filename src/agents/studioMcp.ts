import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import type { Actor } from '../auth.js';
import { config } from '../config.js';
import { q } from '../db.js';
import { HttpError } from '../errors.js';
import { createBody, createTask, STATUSES } from '../services/tasks.js';
import { projectStatus } from '../services/status.js';
import { assertProject } from '../auth.js';

// In-process MCP endpoint (/internal/mcp/<run-token>) for founder/pm agents chatting with their own user.
// A token is minted per `claude -p` run, bound to one agent+user, valid only until revoke() / its TTL, and is never logged.
export const STUDIO_SERVER = 'studio';
export const STUDIO_ALLOWED = `mcp__${STUDIO_SERVER}__*`;
const TTL_MS = 35 * 60_000;
const runs = new Map<string, { actor: Actor; expires: number }>();

export const studioEligible = (role: string) => role === 'founder' || role === 'pm';

export function issueRunToken(actor: Actor, ttlMs = TTL_MS): string {
  if (!studioEligible(actor.role) || !actor.agentId) throw new Error('studio tools are for founder/pm agents only');
  for (const [t, r] of runs) if (r.expires < Date.now()) runs.delete(t);
  const token = 'run_' + crypto.randomBytes(24).toString('hex');
  runs.set(token, { actor, expires: Date.now() + ttlMs });
  return token;
}
export const revokeRunToken = (token: string) => { runs.delete(token); };
function actorFor(token: string): Actor | null {
  const r = runs.get(token);
  if (!r) return null;
  if (r.expires < Date.now()) { runs.delete(token); return null; }
  return r.actor;
}

export interface StudioMcpRun { file: string; args: string[]; allowed: string[]; cleanup: () => void }

// 0600 mcp-config pointing at the loopback endpoint with this run's token; cleanup() revokes the token and removes the file.
export function prepareStudioMcp(actor: Actor): StudioMcpRun {
  const token = issueRunToken(actor);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mcp-'));
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { [STUDIO_SERVER]: { type: 'http', url: `http://127.0.0.1:${config.port}/internal/mcp/${token}` } } }), { mode: 0o600 });
  return { file, args: ['--mcp-config', file], allowed: [STUDIO_ALLOWED], cleanup: () => { revokeRunToken(token); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const uuid = z.string().uuid();
const toolInput = {
  studio_list_projects: z.object({}),
  studio_list_agents: z.object({}),
  studio_list_tasks: z.object({ project_id: uuid.optional(), status: z.enum(STATUSES).optional() }),
  studio_project_status: z.object({ project_id: uuid }),
  studio_create_task: createBody.omit({ parent_task_id: true }),
};

const TOOLS = [
  { name: 'studio_list_projects', description: 'List the projects you can access (id, name, description).', inputSchema: { type: 'object', properties: {} } },
  { name: 'studio_list_agents', description: 'List agents (id, name, role, status). Use the id as assignee_agent_id.', inputSchema: { type: 'object', properties: {} } },
  { name: 'studio_list_tasks', description: 'List tasks you can see, optionally filtered by project_id and/or status.', inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, status: { type: 'string', enum: [...STATUSES] } } } },
  { name: 'studio_project_status', description: 'Status snapshot of one project (active tasks, completed, blockers, latest test results).', inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] } },
  {
    name: 'studio_create_task',
    description: 'Create a task in the studio for another agent. ONLY call after the user explicitly confirmed the plan in a previous message. Always pass a stable idempotency_key per planned task.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, acceptance_criteria: { type: 'string' },
        priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] }, assignee_agent_id: { type: 'string' }, idempotency_key: { type: 'string' },
      },
      required: ['project_id', 'title', 'assignee_agent_id', 'idempotency_key'],
    },
  },
];

// Handlers run through the same services and RBAC as the HTTP API, as the agent acting for its user.
export async function callTool(actor: Actor, name: string, args: unknown): Promise<unknown> {
  if (!studioEligible(actor.role)) throw new HttpError(403, 'forbidden');
  switch (name) {
    case 'studio_list_projects': {
      toolInput.studio_list_projects.parse(args ?? {});
      return actor.role === 'founder'
        ? q('select id, name, description from projects order by created_at')
        : q('select p.id, p.name, p.description from projects p join project_members m on m.project_id = p.id where m.user_id = $1 order by p.created_at', [actor.userId]);
    }
    case 'studio_list_agents':
      return q(`select a.id, a.name, a.role, case when a.last_seen_at is null or a.last_seen_at < now() - make_interval(secs => $1) then 'OFFLINE' else a.status end as status
        from agents a order by a.created_at`, [config.offlineAfterSec]);
    case 'studio_list_tasks': {
      const f = toolInput.studio_list_tasks.parse(args ?? {});
      const params: any[] = [actor.userId, actor.role];
      let where = `($2 = 'founder' or t.project_id in (select project_id from project_members where user_id = $1))`;
      for (const [col, v] of Object.entries(f)) if (v) { params.push(v); where += ` and t.${col} = $${params.length}`; }
      return q(`select t.id, t.project_id, t.title, t.status, t.priority, t.assignee_agent_id, t.created_at from tasks t where ${where} order by t.created_at desc limit 200`, params);
    }
    case 'studio_project_status': {
      const { project_id } = toolInput.studio_project_status.parse(args ?? {});
      await assertProject(actor, project_id);
      return projectStatus(project_id);
    }
    case 'studio_create_task': {
      const b = toolInput.studio_create_task.parse(args ?? {});
      const { task: t, created } = await createTask(actor, b, b.idempotency_key ?? null);
      const task = t!;
      return { id: task.id, project_id: task.project_id, title: task.title, status: task.status, priority: task.priority, assignee_agent_id: task.assignee_agent_id, created };
    }
    default: throw new HttpError(404, `unknown tool ${name}`);
  }
}

const loopback = (a?: string) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
const rpcErr = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

// Minimal stateless MCP (streamable HTTP, JSON responses): initialize, tools/list, tools/call.
export async function handleRpc(actor: Actor, msg: any): Promise<object | null> {
  const { id, method, params } = msg ?? {};
  if (id === undefined) return null; // notification
  switch (method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: STUDIO_SERVER, version: '1.0.0' } } };
    case 'ping': return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list': return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call':
      try {
        const out = await callTool(actor, String(params?.name), params?.arguments);
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } };
      } catch (e: any) {
        const text = e instanceof z.ZodError ? `invalid arguments: ${e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` : e instanceof HttpError ? e.message : 'tool failed';
        return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text }] } };
      }
    default: return rpcErr(id, -32601, 'method not found');
  }
}

export const studioMcpRouter = Router();
studioMcpRouter.post('/internal/mcp/:token', async (req, res) => {
  // Loopback only (the claude child runs in the same container); anything that went through a proxy is refused.
  if (!loopback(req.socket.remoteAddress) || req.headers['x-forwarded-for']) return void res.status(404).end();
  const actor = actorFor(String(req.params.token));
  if (!actor) return void res.status(404).end();
  const body = req.body;
  const out = Array.isArray(body) ? (await Promise.all(body.map((m) => handleRpc(actor, m)))).filter(Boolean) : await handleRpc(actor, body);
  if (!out || (Array.isArray(out) && !out.length)) return void res.status(202).end();
  res.json(out);
});
studioMcpRouter.all('/internal/mcp/:token', (_req, res) => void res.status(405).set('allow', 'POST').end());

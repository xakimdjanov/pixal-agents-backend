import { z } from 'zod';
import { config } from '../config.js';
import type { Actor } from '../auth.js';
import { pool, q, q1 } from '../db.js';
import { HttpError } from '../errors.js';
import { audit } from './audit.js';
import { decryptJson } from './crypto.js';

const https = z.string().url().max(500).refine((u) => u.startsWith('https://'), 'must be an https URL');
const strMap = z.record(z.string().max(2000)).default({});

export const configSchemas = {
  jira: z.object({ site_url: https, email: z.string().email().max(200), api_token: z.string().min(1).max(2000), mcp_url: https.optional() }),
  github: z.object({ token: z.string().min(1).max(2000), git_token: z.string().min(1).max(2000).optional() }),
  mcp: z.object({
    url: z.string().url().max(1000).optional(),
    command: z.string().min(1).max(500).optional(),
    args: z.array(z.string().max(1000)).max(50).default([]),
    headers: strMap,
    env: strMap,
  }).refine((c) => !!c.url !== !!c.command, 'provide exactly one of url or command'),
} as const;

export type ConnectorType = keyof typeof configSchemas;

export const parseConfig = (type: ConnectorType, cfg: unknown) => configSchemas[type].parse(cfg) as Record<string, any>;

const MASK = '••••';
export const isMasked = (v: unknown) => typeof v === 'string' && v.startsWith(MASK);
const mask = (v: string) => MASK + (v.length > 8 ? v.slice(-4) : '');
const maskUrl = (u: string) => { try { const x = new URL(u); return x.search || x.username || x.password ? `${x.origin}${x.pathname}?${MASK}` : u; } catch { return MASK; } };
const maskMap = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, mask(String(v))]));

// Secrets never leave the server in cleartext after creation.
export function maskConfig(type: ConnectorType, c: Record<string, any>) {
  if (type === 'jira') return { ...c, api_token: mask(c.api_token), ...(c.mcp_url ? { mcp_url: maskUrl(c.mcp_url) } : {}) };
  if (type === 'github') return { ...c, token: mask(c.token), ...(c.git_token ? { git_token: mask(c.git_token) } : {}) };
  return { ...c, ...(c.url ? { url: maskUrl(c.url) } : {}), headers: maskMap(c.headers ?? {}), env: maskMap(c.env ?? {}) };
}

// PATCH merge: masked placeholders keep the stored secret; maps are merged per key.
export function mergeConfig(old: Record<string, any>, patch: Record<string, any>) {
  const out: Record<string, any> = { ...old };
  for (const [k, v] of Object.entries(patch)) {
    if (isMasked(v)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && old[k] && typeof old[k] === 'object') {
      out[k] = { ...old[k] };
      for (const [mk, mv] of Object.entries(v as Record<string, any>)) if (!isMasked(mv)) out[k][mk] = mv;
    } else if (v !== undefined) out[k] = v;
  }
  return out;
}

export const mcpKey = (name: string, taken: Set<string>) => {
  const base = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'connector';
  let k = base;
  for (let i = 2; taken.has(k); i++) k = `${base}-${i}`;
  taken.add(k);
  return k;
};

// The MCP server entry (claude --mcp-config format) for a connector.
export function toMcpServer(type: ConnectorType, c: Record<string, any>, allowWrite: boolean) {
  if (type === 'jira') {
    if (c.mcp_url) {
      const auth = 'Basic ' + Buffer.from(`${c.email}:${c.api_token}`).toString('base64');
      return { type: 'http', url: c.mcp_url, headers: { Authorization: auth } };
    }
    return {
      command: 'uvx', args: ['mcp-atlassian'],
      env: { JIRA_URL: c.site_url, JIRA_USERNAME: c.email, JIRA_API_TOKEN: c.api_token, ...(allowWrite ? {} : { READ_ONLY_MODE: 'true' }) },
    };
  }
  if (type === 'github') {
    return { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: `Bearer ${c.token}`, ...(allowWrite ? {} : { 'X-MCP-Readonly': 'true' }) } };
  }
  if (c.url) return { type: 'http', url: c.url, headers: c.headers ?? {} };
  return { command: c.command, args: c.args ?? [], env: c.env ?? {} };
}

export const decryptConfig = (row: Record<string, any>) => decryptJson<Record<string, any>>(String(row.config_encrypted));

// Connectivity check. Mock mode never touches the network.
export async function testConnector(type: ConnectorType, c: Record<string, any>): Promise<{ ok: boolean; detail: string }> {
  if (config.mockClaude) return { ok: true, detail: 'mock mode: connection not actually tested' };
  const get = async (url: string, headers: Record<string, string>) => {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(10_000), redirect: 'manual' });
      return r.ok ? { ok: true, detail: `HTTP ${r.status}` } : { ok: false, detail: `HTTP ${r.status}` };
    } catch (e: any) { return { ok: false, detail: `request failed: ${e?.cause?.code ?? e?.name ?? 'error'}` }; }
  };
  if (type === 'jira') {
    return get(`${c.site_url.replace(/\/+$/, '')}/rest/api/3/myself`, { Authorization: 'Basic ' + Buffer.from(`${c.email}:${c.api_token}`).toString('base64'), Accept: 'application/json' });
  }
  if (type === 'github') return get('https://api.github.com/user', { Authorization: `Bearer ${c.token}`, 'User-Agent': 'studio-server', Accept: 'application/vnd.github+json' });
  if (c.url) {
    const r = await get(c.url, c.headers ?? {});
    // MCP endpoints often answer GET with 4xx (method/accept); any non-5xx answer proves reachability.
    const code = Number(/HTTP (\d+)/.exec(r.detail)?.[1] ?? 0);
    return code && code < 500 ? { ok: true, detail: `reachable (${r.detail})` } : r;
  }
  throw new HttpError(400, 'stdio MCP connectors cannot be tested from the server; they run on the agent machine');
}

// Decrypted MCP config for connectors this agent may use: global ones plus those of projects it belongs to (audited, never logged).
export async function agentConnectors(actor: Actor, projectId?: string) {
  const mine = (await q(
    actor.role === 'founder' ? 'select id from projects' : 'select project_id as id from project_members where user_id = $1',
    actor.role === 'founder' ? [] : [actor.userId],
  )).map((r) => r.id);
  if (projectId && !mine.includes(projectId)) throw new HttpError(404, 'project not found');
  const rows = await q(
    `select * from connectors where enabled and (project_id is null or project_id = any($1::uuid[])) order by created_at`,
    [projectId ? [projectId] : mine],
  );
  const taken = new Set<string>();
  const out = rows.map((r) => ({
    id: r.id, name: mcpKey(r.name, taken), type: r.type, project_id: r.project_id, allow_write: r.allow_write,
    server: toMcpServer(r.type as ConnectorType, decryptConfig(r), r.allow_write),
  }));
  await audit(pool, actor, 'connector.agent_fetch', 'agent', actor.agentId, { count: out.length, project_id: projectId ?? null });
  return out;
}

// Token for git clone/fetch over https: `git_token` if set, else `token`, from an enabled github connector of the project
// (preferred) or a global one. Decrypted server-side only, audited via agentConnectors' scope rules, never logged.
export async function gitTokenFor(actor: Actor, projectId: string): Promise<string | null> {
  const mine = actor.role === 'founder' || await q1('select 1 from project_members where project_id = $1 and user_id = $2', [projectId, actor.userId]);
  if (!mine) return null;
  const rows = await q(
    `select * from connectors where enabled and type = 'github' and (project_id is null or project_id = $1) order by (project_id is null), created_at`,
    [projectId],
  );
  for (const r of rows) {
    const c = decryptConfig(r);
    const t = c.git_token || c.token;
    if (t) { await audit(pool, actor, 'connector.git_token_fetch', 'agent', actor.agentId, { project_id: projectId }); return String(t); }
  }
  return null;
}

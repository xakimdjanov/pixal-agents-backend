import type { Actor } from '../auth.js';
import { pool, q, q1 } from '../db.js';
import { HttpError } from '../errors.js';
import { emitClaudeLogin, emitClaudeStatus } from '../events.js';
import { audit } from './audit.js';

export interface ClaudeStatusInput { logged_in: boolean; auth_method: string; limit_reached: boolean; detail: string }

// Shared by POST /agent/claude-status (external workers) and the in-process runners.
export async function saveClaudeStatus(actor: Actor, s: ClaudeStatusInput) {
  await q(
    `insert into claude_status (agent_id, logged_in, auth_method, limit_reached, detail) values ($1,$2,$3,$4,$5)
     on conflict (agent_id) do update set logged_in = $2, auth_method = $3, limit_reached = $4, detail = $5, updated_at = now()`,
    [actor.agentId, s.logged_in, s.auth_method, s.limit_reached, s.detail],
  );
  emitClaudeStatus(actor.userId, { agent_id: actor.agentId!, logged_in: s.logged_in, limit_reached: s.limit_reached });
}

export interface LoginReport { status: 'URL_READY' | 'SUCCESS' | 'FAILED'; url?: string; error?: string }

// Shared by POST /agent/claude-login/:id (external workers) and the in-process runners.
export async function reportClaudeLogin(actor: Actor, loginId: string, b: LoginReport) {
  if (b.status === 'URL_READY' && !b.url) throw new HttpError(400, 'url is required for URL_READY');
  const l = await q1(
    `update claude_logins set status = $3, url = case when $3 = 'URL_READY' then $4 else url end, error = $5, updated_at = now()
     where login_id = $1 and agent_id = $2 and status not in ('SUCCESS','FAILED') returning *`,
    [loginId, actor.agentId, b.status, b.url ?? null, b.status === 'FAILED' ? (b.error ?? 'login failed') : null],
  );
  if (!l) throw new HttpError(404, 'login not found or already finished');
  await audit(pool, actor, `claude_login.${b.status.toLowerCase()}`, 'agent', l.agent_id, { login_id: l.login_id });
  emitClaudeLogin(actor.userId, { agent_id: l.agent_id, login_id: l.login_id, status: l.status });
}

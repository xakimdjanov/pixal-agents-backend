import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { RequestHandler } from 'express';
import { config } from './config.js';
import { q1 } from './db.js';
import { HttpError } from './errors.js';

export type Role = 'founder' | 'pm' | 'developer';
export interface Actor {
  kind: 'user' | 'agent';
  userId: string;
  name: string;
  role: Role;
  agentId: string | null; // the acting agent (agent tokens) or the user's own agent
}

declare global {
  namespace Express {
    interface Request { actor: Actor }
  }
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const newAgentToken = () => 'agt_' + crypto.randomBytes(32).toString('hex');
export const signJwt = (userId: string) => jwt.sign({ sub: userId }, config.jwtSecret, { algorithm: 'HS256', expiresIn: config.jwtTtl as any });

export async function resolveActor(token: string): Promise<Actor | null> {
  if (token.startsWith('agt_')) {
    const a = await q1(
      'select a.id, a.role, a.user_id, u.name from agents a join users u on u.id = a.user_id where a.token_hash = $1',
      [sha256(token)],
    );
    return a ? { kind: 'agent', userId: a.user_id, name: a.name, role: a.role, agentId: a.id } : null;
  }
  let sub: string;
  try {
    const p = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as { sub?: string };
    if (!p.sub) return null;
    sub = p.sub;
  } catch {
    return null;
  }
  const u = await q1(
    'select u.id, u.name, u.role, (select id from agents where user_id = u.id order by created_at limit 1) as agent_id from users u where u.id = $1',
    [sub],
  );
  return u ? { kind: 'user', userId: u.id, name: u.name, role: u.role, agentId: u.agent_id } : null;
}

// Agent tokens (worker machines) may only reach these endpoints; everything else is for human users.
const AGENT_ALLOWED: [string | null, RegExp][] = [
  [null, /^\/api\/agent\//],
  ['GET', /^\/api\/tasks\/[^/]+$/],
  ['POST', /^\/api\/tasks\/[^/]+\/report$/],
  ['GET', /^\/api\/messages$/],
  ['POST', /^\/api\/messages$/],
];
const agentMayCall = (method: string, url: string) => {
  const p = url.split('?')[0].replace(/\/+$/, '');
  return AGENT_ALLOWED.some(([m, re]) => (m === null || m === method) && re.test(p));
};

export const authenticate: RequestHandler = async (req, _res, next) => {
  const h = req.headers.authorization ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const actor = token ? await resolveActor(token) : null;
  if (!actor) throw new HttpError(401, 'unauthorized');
  if (actor.kind === 'agent' && !agentMayCall(req.method, req.originalUrl)) throw new HttpError(403, 'agent tokens cannot use this endpoint');
  req.actor = actor;
  next();
};

export const requireRole = (...roles: Role[]): RequestHandler => (req, _res, next) => {
  if (!roles.includes(req.actor.role)) throw new HttpError(403, 'forbidden');
  next();
};

export const requireAgent: RequestHandler = (req, _res, next) => {
  if (req.actor.kind !== 'agent') throw new HttpError(403, 'agent token required');
  next();
};

export async function canAccessProject(actor: Actor, projectId: string): Promise<boolean> {
  if (actor.role === 'founder') return !!(await q1('select 1 from projects where id = $1', [projectId]));
  return !!(await q1('select 1 from project_members where project_id = $1 and user_id = $2', [projectId, actor.userId]));
}

export async function assertProject(actor: Actor, projectId: string) {
  // 404 (not 403) so non-members cannot probe which projects exist
  if (!(await canAccessProject(actor, projectId))) throw new HttpError(404, 'project not found');
}

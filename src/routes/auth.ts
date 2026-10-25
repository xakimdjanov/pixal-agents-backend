import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticate, requireRole, signJwt } from '../auth.js';
import { config } from '../config.js';
import { pool, q, q1, tx } from '../db.js';
import { HttpError } from '../errors.js';
import { audit } from '../services/audit.js';

export const authRouter = Router();
const role = z.enum(['founder', 'pm', 'developer']);
const publicUser = (u: any) => ({ id: u.id, name: u.name, email: u.email, role: u.role, must_change_password: !!u.must_change_password });
// The login identifier is not required to be an RFC email (e.g. "visitca@founder").
const loginId = z.string().trim().min(1).max(200).regex(/^\S+$/, 'must not contain spaces');
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const loginLimiter = rateLimit({
  windowMs: 60_000, limit: config.loginRateMax, standardHeaders: true, legacyHeaders: false,
  message: { error: 'too many attempts, try again later' },
});

authRouter.post('/auth/login', loginLimiter, async (req, res) => {
  const b = z.object({ email: loginId, password: z.string().min(1).max(200) }).parse(req.body);
  const u = await q1('select * from users where email = $1', [b.email.toLowerCase()]);
  const ok = await bcrypt.compare(b.password, u?.password_hash ?? DUMMY_HASH);
  if (!u || !ok) {
    await audit(pool, null, 'auth.login_failed', 'user', null, {});
    throw new HttpError(401, 'invalid credentials');
  }
  res.json({ token: signJwt(u.id), user: publicUser(u) });
});

authRouter.post('/auth/register', loginLimiter, async (req, res) => {
  const b = z.object({
    inviteCode: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    email: loginId,
    password: z.string().min(8).max(200),
  }).parse(req.body);
  const email = b.email.toLowerCase();
  const hash = await bcrypt.hash(b.password, 10);
  const user = await tx(async (c) => {
    const inv = await q1('select * from invites where code = $1 for update', [b.inviteCode], c);
    if (!inv || inv.used_at || new Date(inv.expires_at) < new Date()) throw new HttpError(400, 'invalid or expired invite');
    if (inv.email && inv.email.toLowerCase() !== email) throw new HttpError(400, 'invite is for a different email');
    const u = await q1('insert into users (name, email, password_hash, role) values ($1,$2,$3,$4) returning *', [b.name, email, hash, inv.role], c);
    await q('update invites set used_at = now(), used_by = $2 where code = $1', [b.inviteCode, u!.id], c);
    await audit(c, { kind: 'user', userId: u!.id, name: u!.name, role: u!.role, agentId: null }, 'auth.register', 'user', u!.id, { role: u!.role });
    return u!;
  });
  res.status(201).json({ token: signJwt(user.id), user: publicUser(user) });
});

authRouter.get('/auth/me', authenticate, async (req, res) => {
  res.json(publicUser(await q1('select * from users where id = $1', [req.actor.userId])));
});

// Profile update. New passwords need current_password and at least 6 chars (the default founder password is 7).
const profileLimiter = rateLimit({
  windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'too many attempts, try again later' },
});
authRouter.patch('/auth/me', profileLimiter, authenticate, async (req, res) => {
  if (req.actor.kind !== 'user') throw new HttpError(403, 'agent tokens cannot use this endpoint');
  const b = z.object({
    name: z.string().trim().min(1).max(100).optional(),
    email: loginId.optional(),
    current_password: z.string().min(1).max(200).optional(),
    new_password: z.string().min(6).max(200).optional(),
  }).strict().parse(req.body);
  const user = await tx(async (c) => {
    const u = await q1('select * from users where id = $1 for update', [req.actor.userId], c);
    if (!u) throw new HttpError(401, 'unauthorized');
    const sets: string[] = [];
    const vals: any[] = [u.id];
    const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    const changed: string[] = [];
    if (b.new_password !== undefined) {
      if (!b.current_password || !(await bcrypt.compare(b.current_password, u.password_hash))) throw new HttpError(403, 'current password is incorrect');
      set('password_hash', await bcrypt.hash(b.new_password, 12));
      sets.push('must_change_password = false');
      changed.push('password');
    }
    if (b.name !== undefined && b.name !== u.name) { set('name', b.name); changed.push('name'); }
    const email = b.email?.toLowerCase();
    if (email !== undefined && email !== u.email) {
      if (await q1('select 1 from users where email = $1 and id <> $2', [email, u.id], c)) throw new HttpError(409, 'login already in use');
      set('email', email);
      changed.push('email');
    }
    const out = sets.length ? await q1(`update users set ${sets.join(', ')} where id = $1 returning *`, vals, c) : u;
    if (changed.length) await audit(c, req.actor, 'user.profile_update', 'user', u.id, { fields: changed });
    return out!;
  });
  res.json(publicUser(user));
});

authRouter.post('/invites', authenticate, requireRole('founder'), async (req, res) => {
  const b = z.object({ role, email: loginId.optional() }).parse(req.body);
  const code = crypto.randomBytes(18).toString('base64url');
  const inv = await q1(
    `insert into invites (code, role, email, created_by, expires_at) values ($1,$2,$3,$4, now() + interval '7 days') returning code, role, expires_at`,
    [code, b.role, b.email?.toLowerCase() ?? null, req.actor.userId],
  );
  await audit(pool, req.actor, 'invite.create', 'invite', null, { role: b.role });
  res.status(201).json(inv);
});

authRouter.get('/users', authenticate, requireRole('founder', 'pm'), async (_req, res) => {
  res.json(await q('select id, name, email, role, created_at from users order by created_at'));
});

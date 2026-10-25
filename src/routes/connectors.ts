import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../auth.js';
import { pool, q, q1 } from '../db.js';
import { HttpError } from '../errors.js';
import { audit } from '../services/audit.js';
import { decryptConfig, maskConfig, mergeConfig, parseConfig, testConnector, type ConnectorType } from '../services/connectors.js';
import { encryptJson } from '../services/crypto.js';

export const connectorsRouter = Router();
connectorsRouter.use('/connectors', authenticate, requireRole('founder'));

const TYPES = ['jira', 'github', 'mcp'] as const;
const view = (r: any) => ({
  id: r.id, name: r.name, type: r.type, project_id: r.project_id, allow_write: r.allow_write, enabled: r.enabled,
  created_by: r.created_by, created_at: r.created_at, config: maskConfig(r.type, decryptConfig(r)),
});
const get = async (id: string) => {
  const r = await q1('select * from connectors where id = $1', [id]);
  if (!r) throw new HttpError(404, 'connector not found');
  return r;
};
const assertProjectExists = async (id: string | null | undefined) => {
  if (id && !(await q1('select 1 from projects where id = $1', [id]))) throw new HttpError(404, 'project not found');
};

connectorsRouter.get('/connectors', async (_req, res) => {
  res.json((await q('select * from connectors order by created_at')).map(view));
});

connectorsRouter.post('/connectors', async (req, res) => {
  const b = z.object({
    name: z.string().min(1).max(100), type: z.enum(TYPES), project_id: z.string().uuid().nullish(),
    config: z.record(z.any()), allow_write: z.boolean().default(false),
  }).parse(req.body);
  await assertProjectExists(b.project_id);
  const cfg = parseConfig(b.type, b.config);
  const row = await q1(
    'insert into connectors (name, type, project_id, config_encrypted, allow_write, created_by) values ($1,$2,$3,$4,$5,$6) returning *',
    [b.name, b.type, b.project_id ?? null, encryptJson(cfg), b.allow_write, req.actor.userId],
  );
  await audit(pool, req.actor, 'connector.create', 'connector', row!.id, { name: b.name, type: b.type, project_id: b.project_id ?? null, allow_write: b.allow_write });
  res.status(201).json(view(row));
});

connectorsRouter.patch('/connectors/:id', async (req, res) => {
  const b = z.object({
    name: z.string().min(1).max(100), project_id: z.string().uuid().nullable(),
    config: z.record(z.any()), allow_write: z.boolean(), enabled: z.boolean(),
  }).partial().parse(req.body);
  const cur = await get(String(req.params.id));
  if (b.project_id !== undefined) await assertProjectExists(b.project_id);
  const cfg = b.config ? parseConfig(cur.type as ConnectorType, mergeConfig(decryptConfig(cur), b.config)) : null;
  const row = await q1(
    `update connectors set name = coalesce($2, name), project_id = case when $3 then $4 else project_id end,
       config_encrypted = coalesce($5, config_encrypted), allow_write = coalesce($6, allow_write), enabled = coalesce($7, enabled)
     where id = $1 returning *`,
    [cur.id, b.name ?? null, b.project_id !== undefined, b.project_id ?? null, cfg ? encryptJson(cfg) : null, b.allow_write ?? null, b.enabled ?? null],
  );
  const { config: _c, ...rest } = b; // audit field names only, never secret values
  await audit(pool, req.actor, 'connector.update', 'connector', cur.id, { ...rest, config_changed: !!b.config });
  res.json(view(row));
});

connectorsRouter.delete('/connectors/:id', async (req, res) => {
  const cur = await get(String(req.params.id));
  await q('delete from connectors where id = $1', [cur.id]);
  await audit(pool, req.actor, 'connector.delete', 'connector', cur.id, { name: cur.name, type: cur.type });
  res.json({ ok: true });
});

connectorsRouter.post('/connectors/:id/test', async (req, res) => {
  const cur = await get(String(req.params.id));
  const result = await testConnector(cur.type as ConnectorType, decryptConfig(cur));
  await audit(pool, req.actor, 'connector.test', 'connector', cur.id, { ok: result.ok });
  res.json(result);
});

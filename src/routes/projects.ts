import { Router } from 'express';
import { z } from 'zod';
import { assertProject, authenticate, requireRole } from '../auth.js';
import { pool, q, q1 } from '../db.js';
import { HttpError } from '../errors.js';
import { joinProject } from '../events.js';
import { audit } from '../services/audit.js';

export const projectsRouter = Router();

// '' (no remote) or an https:// / ssh:// / scp-style git@host:path URL; blocks file:, ext::, -option injection.
const repoUrl = z.string().max(500).default('').refine(
  (u) => u === '' || /^(https:\/\/|ssh:\/\/)[A-Za-z0-9._~%@:\/+-]+$/.test(u) || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~\/+-]+$/.test(u),
  'repo_url must be an https or ssh git URL',
);
const repos = z.array(z.object({
  name: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/, 'repo name: letters, digits, . _ - only'),
  url: repoUrl.refine((u) => u !== '', 'url is required'),
})).max(20).refine((r) => new Set(r.map((x) => x.name.toLowerCase())).size === r.length, 'repo names must be unique');
projectsRouter.use(authenticate);

projectsRouter.get('/projects', async (req, res) => {
  const a = req.actor;
  res.json(a.role === 'founder'
    ? await q('select * from projects order by created_at')
    : await q('select p.* from projects p join project_members m on m.project_id = p.id where m.user_id = $1 order by p.created_at', [a.userId]));
});

projectsRouter.post('/projects', requireRole('founder'), async (req, res) => {
  const b = z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(5000).default(''),
    repo_url: repoUrl,
    default_branch: z.string().min(1).max(200).default('main'),
    repos: repos.default([]),
  }).parse(req.body);
  const p = await q1(
    'insert into projects (name, description, repo_url, default_branch, repos, created_by) values ($1,$2,$3,$4,$5,$6) returning *',
    [b.name, b.description, b.repo_url, b.default_branch, JSON.stringify(b.repos), req.actor.userId],
  );
  await audit(pool, req.actor, 'project.create', 'project', p!.id, { name: b.name, repos: b.repos.length });
  res.status(201).json(p);
});

projectsRouter.patch('/projects/:id', requireRole('founder'), async (req, res) => {
  const b = z.object({
    name: z.string().min(1).max(200), description: z.string().max(5000), repo_url: repoUrl,
    default_branch: z.string().min(1).max(200), repos,
  }).partial().parse(req.body);
  const p = await q1(
    `update projects set name = coalesce($2, name), description = coalesce($3, description), repo_url = coalesce($4, repo_url),
       default_branch = coalesce($5, default_branch), repos = coalesce($6, repos) where id = $1 returning *`,
    [req.params.id, b.name ?? null, b.description ?? null, b.repo_url ?? null, b.default_branch ?? null, b.repos ? JSON.stringify(b.repos) : null],
  );
  if (!p) throw new HttpError(404, 'project not found');
  await audit(pool, req.actor, 'project.update', 'project', p.id, { fields: Object.keys(b) });
  res.json(p);
});

projectsRouter.get('/projects/:id', async (req, res) => {
  await assertProject(req.actor, req.params.id);
  res.json(await q1('select * from projects where id = $1', [req.params.id]));
});

projectsRouter.post('/projects/:id/members', requireRole('founder'), async (req, res) => {
  const id = String(req.params.id);
  const b = z.object({ user_id: z.string().uuid() }).parse(req.body);
  await assertProject(req.actor, id);
  if (!(await q1('select 1 from users where id = $1', [b.user_id]))) throw new HttpError(404, 'user not found');
  await q('insert into project_members (project_id, user_id) values ($1,$2) on conflict do nothing', [id, b.user_id]);
  await audit(pool, req.actor, 'project.member_add', 'project', id, { user_id: b.user_id });
  joinProject(b.user_id, id);
  res.status(201).json({ project_id: id, user_id: b.user_id });
});

projectsRouter.get('/projects/:id/members', async (req, res) => {
  await assertProject(req.actor, req.params.id);
  res.json(await q(
    'select u.id, u.name, u.email, u.role from project_members m join users u on u.id = m.user_id where m.project_id = $1 order by u.name',
    [req.params.id],
  ));
});

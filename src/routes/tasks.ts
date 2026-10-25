import { Router } from 'express';
import { z } from 'zod';
import { assertProject, authenticate, requireRole, type Actor } from '../auth.js';
import { q, q1, tx } from '../db.js';
import { HttpError } from '../errors.js';
import { emitTask } from '../events.js';
import { audit } from '../services/audit.js';
import { insertMessage, publish } from '../services/messages.js';
import { changeStatus, createBody, createTask, STATUSES, submitReport } from '../services/tasks.js';
import { VISIBLE, visibleParams } from './messages.js';

export const tasksRouter = Router();
tasksRouter.use(authenticate);


tasksRouter.post('/tasks', requireRole('founder', 'pm'), async (req, res) => {
  const b = createBody.parse(req.body);
  const { task, created } = await createTask(req.actor, b, b.idempotency_key ?? (req.get('Idempotency-Key') || null));
  res.status(created ? 201 : 200).json(task);
});

tasksRouter.get('/tasks', async (req, res) => {
  const f = z.object({
    project_id: z.string().uuid().optional(),
    status: z.enum(STATUSES).optional(),
    assignee_agent_id: z.string().uuid().optional(),
  }).parse(req.query);
  const a = req.actor;
  const params: any[] = [a.userId, a.role];
  let where = `($2 = 'founder' or t.project_id in (select project_id from project_members where user_id = $1))`;
  for (const [col, v] of Object.entries(f)) {
    if (v) { params.push(v); where += ` and t.${col} = $${params.length}`; }
  }
  res.json(await q(`select t.* from tasks t where ${where} order by t.created_at desc`, params));
});

async function loadTask(a: Actor, id: string) {
  const t = await q1('select * from tasks where id = $1', [id]);
  if (!t) throw new HttpError(404, 'task not found');
  await assertProject(a, t.project_id);
  return t;
}

tasksRouter.get('/tasks/:id', async (req, res) => {
  const task = await loadTask(req.actor, req.params.id);
  const messages = await q(
    `select m.* from messages m where ${VISIBLE} and m.task_id = $4 order by m.created_at`,
    [...visibleParams(req.actor), task.id],
  );
  const reports = await q('select * from reports where task_id = $1 order by created_at', [task.id]);
  res.json({ task, messages, reports });
});

tasksRouter.get('/tasks/:id/reports', async (req, res) => {
  const task = await loadTask(req.actor, req.params.id);
  res.json(await q('select * from reports where task_id = $1 order by created_at', [task.id]));
});

export const statusBody = z.object({ status: z.enum(STATUSES), note: z.string().max(5000).optional() });

tasksRouter.patch('/tasks/:id/status', async (req, res) => {
  const b = statusBody.parse(req.body);
  await loadTask(req.actor, req.params.id);
  res.json(await tx((c, after) => changeStatus(c, after, req.params.id, req.actor, b.status, b.note)));
});

const list = z.array(z.string().max(2000)).max(200).default([]);
const reportBody = z.object({
  summary: z.string().min(1).max(20000),
  work_done: list,
  files_changed: list,
  test_results: z.union([z.string().max(50000), z.record(z.any())]).nullish(),
  git_branch: z.string().max(300).default(''),
  git_commit: z.string().max(100).default(''),
  unmet_requirements: list,
  issues: list,
  next_steps: list,
});

tasksRouter.post('/tasks/:id/report', async (req, res) => {
  const a = req.actor;
  const b = reportBody.parse(req.body);
  await loadTask(a, req.params.id);
  const out = await tx((c, after) => submitReport(c, after, req.params.id, a, b));
  const { existing, ...body } = out;
  res.status(existing ? 200 : 201).json(body);
});


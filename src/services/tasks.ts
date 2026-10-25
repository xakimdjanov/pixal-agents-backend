import type { PoolClient } from 'pg';
import { z } from 'zod';
import { q1, tx } from '../db.js';
import { assertProject, type Actor } from '../auth.js';
import { HttpError } from '../errors.js';
import { emitTask } from '../events.js';
import { audit } from './audit.js';
import { insertMessage, publish, type MessageType } from './messages.js';

export const STATUSES = ['PENDING', 'ACCEPTED', 'IN_PROGRESS', 'REVIEW', 'COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED'] as const;
export type Status = (typeof STATUSES)[number];

// Manual moves (board drag & drop): the reviewer (founder, reply_to agent, creator PM, project PM) may move a task to any status;
// the assignee only among ASSIGNEE_MOVES. Agent-token assignees (the server-hosted runner) may also report FAILED.
const ASSIGNEE_MOVES: Status[] = ['ACCEPTED', 'IN_PROGRESS', 'REVIEW', 'BLOCKED'];

async function isReviewer(c: PoolClient, task: any, actor: Actor): Promise<boolean> {
  if (actor.role === 'founder' || (actor.agentId && actor.agentId === task.reply_to_agent_id)) return true;
  if (actor.role !== 'pm') return false;
  if (task.created_by_user_id === actor.userId) return true;
  return !!(await q1('select 1 from project_members where project_id = $1 and user_id = $2', [task.project_id, actor.userId], c));
}

// The founder agent that started this chain of work: walk up parent_task_id to the root task and use its
// creator's agent if that is a founder; otherwise fall back to the oldest founder agent.
export async function founderAgentId(c: PoolClient, task?: any): Promise<string | null> {
  if (task) {
    const root = await q1(
      `with recursive up as (
         select id, parent_task_id, sender_agent_id, 0 as depth from tasks where id = $1
         union all
         select t.id, t.parent_task_id, t.sender_agent_id, up.depth + 1 from tasks t join up on t.id = up.parent_task_id where up.depth < 20
       ) select a.id from up join agents a on a.id = up.sender_agent_id
         where up.parent_task_id is null and a.role = 'founder'`,
      [task.id], c);
    if (root) return root.id;
  }
  return (await q1(`select id from agents where role = 'founder' order by created_at limit 1`, [], c))?.id ?? null;
}

// Full TASK_ASSIGNMENT payload (what the runner needs to start work), shared by task creation and manual re-queues.
async function assignmentPayload(c: PoolClient, row: any) {
  const proj = await q1('select name, repo_url, default_branch, repos from projects where id = $1', [row.project_id], c);
  return {
    title: row.title, description: row.description, acceptance_criteria: row.acceptance_criteria, priority: row.priority,
    project_id: row.project_id, project_name: proj?.name, repo_url: proj?.repo_url, default_branch: proj?.default_branch, repos: proj?.repos ?? [],
    parent_task_id: row.parent_task_id,
  };
}

export async function changeStatus(c: PoolClient, after: (cb: () => void) => void, taskId: string, actor: Actor, to: Status, note?: string) {
  const task = await q1('select * from tasks where id = $1 for update', [taskId], c);
  if (!task) throw new HttpError(404, 'task not found');
  const reviewer = await isReviewer(c, task, actor);
  const assignee = !!actor.agentId && actor.agentId === task.assignee_agent_id;
  if (!reviewer && !(assignee && (ASSIGNEE_MOVES.includes(to) || (to === 'FAILED' && actor.kind === 'agent')))) {
    throw new HttpError(403, 'not allowed to make this transition');
  }
  const from = task.status as Status;
  if (from === to) return task;
  const updated = await q1(
    `update tasks set status = $2, updated_at = now(),
       started_at = case when $2 = 'IN_PROGRESS' then coalesce(started_at, now()) else started_at end,
       completed_at = case when $2 = 'COMPLETED' then now() else null end
     where id = $1 returning *`,
    [taskId, to],
    c,
  );
  await audit(c, actor, 'task.status', 'task', taskId, { from, to, note: note ?? null });

  const me = actor.agentId ?? task.reply_to_agent_id;
  const other = me === task.assignee_agent_id ? task.reply_to_agent_id : task.assignee_agent_id;
  const base = { task_id: taskId, payload: { status: to, from, note: note ?? null, title: task.title } };
  const out: { type: MessageType; to: string; extra?: object; key?: string }[] = [];
  // Re-queue for the assignee, deduped by task + attempt (attempt = TASK_ASSIGNMENTs already sent; the row lock serialises this).
  const requeue = async () => {
    const n = Number((await q1(`select count(*)::int as n from messages where task_id = $1 and type = 'TASK_ASSIGNMENT'`, [taskId], c))!.n);
    out.push({ type: 'TASK_ASSIGNMENT', to: task.assignee_agent_id, extra: await assignmentPayload(c, task), key: `task-assign:${taskId}:${n}` });
  };
  if (to === 'ACCEPTED') {
    out.push({ type: 'TASK_ACCEPTED', to: task.reply_to_agent_id });
    if (!assignee) await requeue(); // a reviewer/founder moved it: the assignee's runner must pick it up
  }
  else if (to === 'BLOCKED') out.push({ type: 'BLOCKER', to: task.reply_to_agent_id });
  else if (to === 'IN_PROGRESS' && from === 'REVIEW' && reviewer) out.push({ type: 'REJECTION', to: task.assignee_agent_id });
  else if (to === 'PENDING') await requeue();
  else if (to === 'COMPLETED') {
    out.push({ type: 'APPROVAL', to: task.assignee_agent_id });
    // A non-founder reviewer's approval is escalated to the founder as a report, once, and only if a report exists
    const fid = actor.role !== 'founder' ? await founderAgentId(c, task) : null;
    if (fid && fid !== me) {
      const report = await q1('select * from reports where task_id = $1 order by created_at desc limit 1', [taskId], c);
      const sent = await q1(`select 1 from messages where task_id = $1 and type = 'TASK_REPORT' and recipient_agent_id = $2 and payload ? 'approved_by'`, [taskId, fid], c);
      if (report && !sent) out.push({ type: 'TASK_REPORT', to: fid, extra: { approved_by: me, report } });
    }
  } else out.push({ type: 'STATUS_UPDATE', to: other });

  const msgs: any[] = [];
  for (const o of out) {
    if (o.to === me && o.type !== 'TASK_REPORT') continue;
    const { msg } = await insertMessage(c, { ...base, type: o.type, sender: me, recipient: o.to, idempotency_key: o.key, payload: { ...base.payload, ...o.extra } });
    msgs.push(msg);
  }
  after(() => { emitTask('task:updated', updated); publish(msgs); });
  return updated;
}

export interface ReportInput {
  summary: string; work_done: string[]; files_changed: string[]; test_results?: string | Record<string, any> | null;
  git_branch: string; git_commit: string; unmet_requirements: string[]; issues: string[]; next_steps: string[];
}

// Stores the report, moves the task to REVIEW and notifies reply_to. Idempotent: a repeat on a task already in REVIEW
// returns the stored report. Shared by POST /tasks/:id/report and the server-hosted runner.
export async function submitReport(c: PoolClient, after: (cb: () => void) => void, taskId: string, a: Actor, b: ReportInput) {
  const t = await q1('select * from tasks where id = $1 for update', [taskId], c);
  if (!t || t.assignee_agent_id !== a.agentId) throw new HttpError(403, 'only the assignee can report');
  if (t.status === 'REVIEW') {
    const prev = await q1('select * from reports where task_id = $1 order by created_at desc limit 1', [t.id], c);
    if (prev && prev.agent_id === a.agentId) return { report: prev, task: t, existing: true };
  }
  if (!['ACCEPTED', 'IN_PROGRESS'].includes(t.status)) throw new HttpError(409, `cannot report on a ${t.status} task`);
  const report = await q1(
    `insert into reports (task_id, agent_id, summary, work_done, files_changed, test_results, git_branch, git_commit, unmet_requirements, issues, next_steps)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [t.id, a.agentId, b.summary, JSON.stringify(b.work_done), JSON.stringify(b.files_changed),
      b.test_results == null ? null : JSON.stringify(b.test_results), b.git_branch, b.git_commit,
      JSON.stringify(b.unmet_requirements), JSON.stringify(b.issues), JSON.stringify(b.next_steps)],
    c,
  );
  const task = await q1(
    `update tasks set status = 'REVIEW', updated_at = now(), started_at = coalesce(started_at, now()) where id = $1 returning *`,
    [t.id], c,
  );
  const { msg } = await insertMessage(c, {
    type: 'TASK_REPORT', sender: a.agentId!, recipient: t.reply_to_agent_id, task_id: t.id,
    payload: { report_id: report!.id, title: t.title, ...b },
  });
  await audit(c, a, 'task.report', 'task', t.id, { report_id: report!.id, from: t.status });
  after(() => { emitTask('task:updated', task); publish([msg]); });
  return { report, task, existing: false };
}

export const createBody = z.object({
  project_id: z.string().uuid(),
  title: z.string().min(1).max(300),
  description: z.string().max(20000).default(''),
  acceptance_criteria: z.string().max(20000).default(''),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  assignee_agent_id: z.string().uuid(),
  parent_task_id: z.string().uuid().nullish(),
  idempotency_key: z.string().min(1).max(200).nullish(),
});
export type CreateTaskInput = z.infer<typeof createBody>;

// Shared by POST /tasks and the studio MCP tools: same RBAC (founder -> pm/developer, pm -> developer), membership checks, audit and events.
export async function createTask(a: Actor, b: CreateTaskInput, key: string | null) {
  if (!['founder', 'pm'].includes(a.role)) throw new HttpError(403, 'forbidden');
  if (!a.agentId) throw new HttpError(400, 'no agent bound to this user');
  await assertProject(a, b.project_id);

  const assignee = await q1('select id, role, user_id from agents where id = $1', [b.assignee_agent_id]);
  if (!assignee) throw new HttpError(404, 'assignee agent not found');
  const allowed = a.role === 'founder' ? ['pm', 'developer'] : ['developer'];
  if (!allowed.includes(assignee.role)) throw new HttpError(403, `a ${a.role} cannot assign tasks to a ${assignee.role}`);
  if (!(await q1('select 1 from project_members where project_id = $1 and user_id = $2', [b.project_id, assignee.user_id]))) {
    throw new HttpError(400, 'assignee is not a member of the project');
  }
  if (b.parent_task_id && !(await q1('select 1 from tasks where id = $1 and project_id = $2', [b.parent_task_id, b.project_id]))) {
    throw new HttpError(400, 'parent task not found in this project');
  }

  return tx(async (c, after) => {
    const row = await q1(
      `insert into tasks (project_id, created_by_user_id, sender_agent_id, assignee_agent_id, reply_to_agent_id, parent_task_id,
         title, description, acceptance_criteria, priority, idempotency_key)
       values ($1,$2,$3,$4,$3,$5,$6,$7,$8,$9,$10) on conflict (created_by_user_id, idempotency_key) where idempotency_key is not null do nothing returning *`,
      [b.project_id, a.userId, a.agentId, b.assignee_agent_id, b.parent_task_id ?? null, b.title, b.description, b.acceptance_criteria, b.priority, key],
      c,
    );
    if (!row) return { task: await q1('select * from tasks where created_by_user_id = $1 and idempotency_key = $2', [a.userId, key], c), created: false };
    const { msg } = await insertMessage(c, {
      type: 'TASK_ASSIGNMENT', sender: a.agentId!, recipient: b.assignee_agent_id, task_id: row.id,
      idempotency_key: `task-assign:${row.id}`,
      payload: await assignmentPayload(c, row),
    });
    await audit(c, a, 'task.create', 'task', row.id, { assignee: b.assignee_agent_id, title: b.title });
    after(() => { emitTask('task:created', row); publish([msg]); });
    return { task: row, created: true };
  });
}

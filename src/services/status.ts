import { q, q1 } from '../db.js';

// DB-derived status snapshot for a project (also feeds the server-hosted Q&A).
export async function projectStatus(pid: string) {
  const project = await q1('select id, name, repo_url, default_branch, repos from projects where id = $1', [pid]);
  const cols = 'id, title, status, priority, assignee_agent_id, updated_at';
  const active = await q(`select ${cols} from tasks where project_id = $1 and status not in ('COMPLETED','CANCELLED','FAILED') order by updated_at desc`, [pid]);
  const completed = await q(`select ${cols}, completed_at from tasks where project_id = $1 and status = 'COMPLETED' order by completed_at desc limit 10`, [pid]);
  const tests = await q(
    `select r.task_id, t.title, r.test_results, r.git_branch, r.git_commit, r.created_at from reports r join tasks t on t.id = r.task_id
     where t.project_id = $1 and r.test_results is not null order by r.created_at desc limit 5`, [pid]);
  const blockers = await q(
    `select t.id as task_id, t.title, (select m.payload->>'note' from messages m where m.task_id = t.id and m.type = 'BLOCKER' order by m.created_at desc limit 1) as note
     from tasks t where t.project_id = $1 and t.status = 'BLOCKED'`, [pid]);
  const upd = await q1(
    `select greatest((select max(updated_at) from tasks where project_id = $1), (select max(r.created_at) from reports r join tasks t on t.id = r.task_id where t.project_id = $1)) as at`, [pid]);
  return {
    project, generated_at: new Date().toISOString(), updated_at: upd?.at ?? null,
    active_tasks: active, completed_tasks: completed, latest_test_results: tests, blockers,
  };
}

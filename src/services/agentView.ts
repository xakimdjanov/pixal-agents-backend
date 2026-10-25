// Shared SELECT for the agent list/detail views (status is OFFLINE when the agent has not been seen recently). $1 = offline-after seconds.
export const agentSelect = `
  select a.id, a.name, a.role, a.user_id, u.name as user_name,
    case when a.last_seen_at is null or a.last_seen_at < now() - make_interval(secs => $1) then 'OFFLINE' else a.status end as status,
    a.last_seen_at, a.current_task_id, a.execution_mode,
    case when a.last_seen_at is null or a.last_seen_at < now() - make_interval(secs => $1) or a.status <> 'BUSY' then null else a.current_activity end as current_activity,
    case when u.role = 'founder' then (select coalesce(json_agg(p.id), '[]') from projects p)
         else (select coalesce(json_agg(m.project_id), '[]') from project_members m where m.user_id = a.user_id) end as project_ids,
    (select row_to_json(cs) from (select logged_in, auth_method, limit_reached, detail, updated_at from claude_status where agent_id = a.id) cs) as claude
  from agents a join users u on u.id = a.user_id`;

create table users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  password_hash text not null,
  role text not null check (role in ('founder','pm','developer')),
  created_at timestamptz not null default now()
);

create table invites (
  code text primary key,
  role text not null check (role in ('founder','pm','developer')),
  email text,
  created_by uuid not null references users(id),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid references users(id)
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  repo_url text not null default '',
  default_branch text not null default 'main',
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table project_members (
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create table agents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role text not null check (role in ('founder','pm','developer')),
  user_id uuid not null references users(id),
  token_hash text not null unique,
  status text not null default 'OFFLINE' check (status in ('ONLINE','BUSY','IDLE','OFFLINE','ERROR')),
  last_seen_at timestamptz,
  current_task_id uuid,
  created_at timestamptz not null default now()
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  created_by_user_id uuid not null references users(id),
  sender_agent_id uuid not null references agents(id),
  assignee_agent_id uuid not null references agents(id),
  reply_to_agent_id uuid not null references agents(id),
  parent_task_id uuid references tasks(id),
  title text not null,
  description text not null default '',
  acceptance_criteria text not null default '',
  priority text not null default 'MEDIUM' check (priority in ('LOW','MEDIUM','HIGH','URGENT')),
  status text not null default 'PENDING'
    check (status in ('PENDING','ACCEPTED','IN_PROGRESS','REVIEW','COMPLETED','BLOCKED','FAILED','CANCELLED')),
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);
create unique index tasks_idem on tasks (created_by_user_id, idempotency_key) where idempotency_key is not null;
create index tasks_project on tasks (project_id, status);
create index tasks_assignee on tasks (assignee_agent_id, status);

create table messages (
  message_id uuid primary key default gen_random_uuid(),
  conversation_id text not null,
  task_id uuid references tasks(id) on delete cascade,
  type text not null check (type in ('TASK_ASSIGNMENT','TASK_ACCEPTED','STATUS_UPDATE','QUESTION','ANSWER',
    'BLOCKER','TASK_REPORT','REVIEW_REQUEST','APPROVAL','REJECTION','SYSTEM_ALERT')),
  sender_agent_id uuid not null references agents(id),
  recipient_agent_id uuid not null references agents(id),
  payload jsonb not null default '{}',
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
create index messages_inbox on messages (recipient_agent_id, created_at) where delivered_at is null;
create index messages_conv on messages (conversation_id, created_at);
create index messages_task on messages (task_id, created_at);

create table reports (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  agent_id uuid not null references agents(id),
  summary text not null,
  work_done jsonb not null default '[]',
  files_changed jsonb not null default '[]',
  test_results jsonb,
  git_branch text not null default '',
  git_commit text not null default '',
  unmet_requirements jsonb not null default '[]',
  issues jsonb not null default '[]',
  next_steps jsonb not null default '[]',
  created_at timestamptz not null default now()
);
create index reports_task on reports (task_id, created_at);

create table audit_log (
  id bigserial primary key,
  actor_type text not null,
  actor_id uuid,
  action text not null,
  entity text,
  entity_id text,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table claude_status (
  agent_id uuid primary key references agents(id) on delete cascade,
  logged_in boolean not null default false,
  auth_method text not null default '',
  limit_reached boolean not null default false,
  detail text not null default '',
  updated_at timestamptz not null default now()
);

-- Postgres-backed work queue (claimed with FOR UPDATE SKIP LOCKED)
create table jobs (
  id bigserial primary key,
  kind text not null,
  payload jsonb not null default '{}',
  run_at timestamptz not null default now(),
  attempts int not null default 0,
  done_at timestamptz
);
create index jobs_due on jobs (run_at) where done_at is null;

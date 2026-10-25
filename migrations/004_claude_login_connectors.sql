-- Per-agent "Login with Claude" flow state (never holds codes or tokens).
create table claude_logins (
  login_id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  status text not null default 'PENDING' check (status in ('PENDING','URL_READY','CODE_SUBMITTED','SUCCESS','FAILED')),
  url text,
  error text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index claude_logins_agent on claude_logins (agent_id, created_at desc);

-- Founder-configured integrations; config is AES-256-GCM encrypted (CONNECTOR_KEY).
create table connectors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null check (type in ('jira','github','mcp')),
  project_id uuid references projects(id) on delete cascade, -- null = all projects
  config_encrypted text not null,
  allow_write boolean not null default false,
  enabled boolean not null default true,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create unique index connectors_name on connectors (lower(name));

-- Extra git repos per project, e.g. [{"name":"git-mobile","url":"https://..."}]
alter table projects add column repos jsonb not null default '[]';

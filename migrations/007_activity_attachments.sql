-- What a BUSY agent is doing when it has no task (e.g. "Answering a question"); null when idle or on a task.
alter table agents add column current_activity text;

-- Chat image uploads; bytes live on the agentdata volume at <DATA_DIR>/uploads/<id>.
create table attachments (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  name text not null,
  mime text not null check (mime in ('image/png','image/jpeg','image/gif','image/webp')),
  size integer not null,
  created_at timestamptz not null default now()
);
create index attachments_owner on attachments (owner_user_id, created_at desc);

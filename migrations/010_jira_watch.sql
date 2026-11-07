-- Jira change notifications to linked Telegram chats.
alter table telegram_links add column notify_jira boolean not null default true;
-- Per Jira connector: events up to this time were already announced.
create table jira_watch (
  connector_id uuid primary key references connectors(id) on delete cascade,
  cursor_at timestamptz not null
);

-- Telegram bot: one linked chat per user; selected_agent_id = who plain-text questions go to (null = own agent).
create table telegram_links (
  user_id uuid primary key references users(id) on delete cascade,
  chat_id bigint not null unique,
  username text not null default '',
  selected_agent_id uuid references agents(id) on delete set null,
  created_at timestamptz not null default now()
);

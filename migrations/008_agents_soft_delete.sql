-- Soft delete: agents with history are kept (so old tasks/messages still resolve) but hidden and revoked.
-- One *active* agent per user: the unique constraint becomes a partial index so a replacement can be created.
alter table agents add column deleted_at timestamptz;
alter table agents drop constraint agents_user_id_key;
create unique index agents_user_id_active on agents (user_id) where deleted_at is null;

-- 'server': tasks are run by the server's in-process Claude runner; 'worker': by an external Agent Bridge.
alter table agents add column execution_mode text not null default 'worker' check (execution_mode in ('server','worker'));

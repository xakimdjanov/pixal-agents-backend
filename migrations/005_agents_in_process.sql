-- Agents now run inside the backend process by default; 'worker' stays available for external workers (/api/agent/*).
alter table agents alter column execution_mode set default 'server';
update agents set execution_mode = 'server' where execution_mode = 'worker';

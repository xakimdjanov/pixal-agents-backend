-- One agent per user. Existing duplicates are merged into the oldest agent of each user
-- (all references are re-pointed first, so no history is lost), then the constraint is added.
create temp table agent_merge on commit drop as
  select id as dupe, first_value(id) over (partition by user_id order by created_at, id) as keep
  from agents;
delete from agent_merge where dupe = keep;

update tasks set sender_agent_id = m.keep from agent_merge m where tasks.sender_agent_id = m.dupe;
update tasks set assignee_agent_id = m.keep from agent_merge m where tasks.assignee_agent_id = m.dupe;
update tasks set reply_to_agent_id = m.keep from agent_merge m where tasks.reply_to_agent_id = m.dupe;
update messages set sender_agent_id = m.keep from agent_merge m where messages.sender_agent_id = m.dupe;
update messages set recipient_agent_id = m.keep from agent_merge m where messages.recipient_agent_id = m.dupe;
update reports set agent_id = m.keep from agent_merge m where reports.agent_id = m.dupe;
delete from claude_status where agent_id in (select dupe from agent_merge);
delete from agents where id in (select dupe from agent_merge);

alter table agents add constraint agents_user_id_key unique (user_id);

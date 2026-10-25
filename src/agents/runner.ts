import fs from 'node:fs';
import path from 'node:path';
import type { Actor } from '../auth.js';
import { config } from '../config.js';
import { pool, q, q1, tx } from '../db.js';
import { emitAgent } from '../events.js';
import { log } from '../log.js';
import { audit } from '../services/audit.js';
import { agentSelect } from '../services/agentView.js';
import { saveClaudeStatus } from '../services/claudeLogin.js';
import { agentConnectors, gitTokenFor } from '../services/connectors.js';
import { insertMessage, publish } from '../services/messages.js';
import { projectStatus } from '../services/status.js';
import { changeStatus, submitReport } from '../services/tasks.js';
import { describeStatus, needsDeepAnswer } from './answer.js';
import { memoryFile } from './memory.js';
import { allowedToolsFor, checkClaude, listAccountConnectors, runClaude } from './claude.js';
import type { Connector } from './connectors.js';
import { uploadPath } from '../services/attachments.js';
import { ensureDirs, workDir } from './env.js';
import { collectNotices, commitAll, prepareReadRepos, prepareWorktree, RepoAccessError, type RepoRef } from './git.js';
import { LoginFlow } from './login.js';
import { studioEligible } from './studioMcp.js';
import { NO_ATLASSIAN_PROMPT, STYLE_PROMPT } from './prompts.js';
import { STUDIO_PROMPT } from './studioPrompt.js';

// One in-process "Agent Bridge" per agent: reads its inbox straight from the DB, does the work with the
// agent's own isolated Claude config/workdir, and writes results through the same services as the HTTP API.
export class AgentRunner {
  private actor!: Actor;
  private timers: NodeJS.Timeout[] = [];
  private queue: any[] = [];
  private queued = new Set<string>();
  private working = false;
  private polling = false;
  private stopped = false;
  private status: 'ONLINE' | 'BUSY' = 'ONLINE';
  private currentTask: string | null = null;
  private activity: string | null = null;
  private seen: string[] = [];
  private abort = new AbortController();
  private login!: LoginFlow;

  constructor(readonly agentId: string) {}

  private get stateFile() { return path.join(workDir(this.agentId), 'state.json'); }
  private tag() { return `[agent ${this.agentId.slice(0, 8)}]`; }

  async start() {
    const a = await q1('select a.id, a.role, a.user_id, u.name from agents a join users u on u.id = a.user_id where a.id = $1 and a.deleted_at is null', [this.agentId]);
    if (!a) throw new Error('agent not found');
    this.actor = { kind: 'agent', userId: a.user_id, name: a.name, role: a.role, agentId: a.id };
    ensureDirs(this.agentId);
    try { this.seen = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')).seen ?? []; } catch { /* first run: the inbox re-delivers anything unacked */ }
    this.login = new LoginFlow(this.actor, () => this.reportClaudeStatus());
    await this.heartbeat();
    void this.reportClaudeStatus();
    this.timers.push(
      setInterval(() => void this.heartbeat(), config.heartbeatMs),
      setInterval(() => void this.reportClaudeStatus(), config.claudeStatusMs),
      setInterval(() => void this.pollInbox(), config.pollMs),
    );
    void this.pollInbox();
    log('info', `${this.tag()} runner started (role=${a.role}, mock=${config.mockClaude})`);
  }

  // Read fresh so a rename takes effect on the next prompt without restarting the runner.
  private async agentName() {
    return (await q1('select name from agents where id = $1', [this.agentId]))?.name ?? 'the agent';
  }

  async stop() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.abort.abort();
    this.login?.stop();
    await q("update agents set status = 'OFFLINE', current_task_id = null where id = $1", [this.agentId]).catch(() => {});
    log('info', `${this.tag()} runner stopped`);
  }

  // Called when a message for this agent was just published; the periodic poll is the fallback.
  notify() { if (!this.stopped) void this.pollInbox(); }

  private async heartbeat() {
    if (this.stopped) return;
    try {
      await q('update agents set status = $2, current_task_id = $3, current_activity = $4, last_seen_at = now() where id = $1', [this.agentId, this.status, this.currentTask, this.activity]);
      const agent = await q1(`${agentSelect} where a.id = $2`, [config.offlineAfterSec, this.agentId]);
      if (agent) emitAgent(agent);
    } catch (e: any) { log('warn', `${this.tag()} heartbeat failed: ${e.message}`); }
  }

  private async reportClaudeStatus() {
    if (this.stopped) return;
    try {
      const { available: _a, ...s } = await checkClaude(this.agentId);
      await saveClaudeStatus(this.actor, s);
    } catch (e: any) { log('warn', `${this.tag()} claude-status failed: ${e.message}`); }
  }

  private async pollInbox() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const rows = await q('select * from messages where recipient_agent_id = $1 and delivered_at is null order by created_at limit 50', [this.agentId]);
      for (const m of rows) this.enqueue(m);
    } catch (e: any) { log('warn', `${this.tag()} inbox poll failed: ${e.message}`); }
    finally { this.polling = false; }
  }

  // A login code lives in the DB only until this runner has it.
  private ack = (id: string) => q(
    `update messages set delivered_at = coalesce(delivered_at, now()),
       payload = case when payload ? 'code' then payload || '{"code":""}'::jsonb else payload end where message_id = $1`, [id],
  ).catch((e) => log('warn', `${this.tag()} ack failed: ${e.message}`));

  private markSeen(id: string) {
    this.seen = [...this.seen.filter((x) => x !== id), id].slice(-2000);
    try { fs.writeFileSync(`${this.stateFile}.tmp`, JSON.stringify({ seen: this.seen })); fs.renameSync(`${this.stateFile}.tmp`, this.stateFile); } catch { /* best effort */ }
  }

  private enqueue(msg: any) {
    if (this.queued.has(msg.message_id)) return;
    if (this.seen.includes(msg.message_id)) { void this.ack(msg.message_id); return; } // already handled: just confirm delivery
    this.queued.add(msg.message_id);
    this.queue.push(msg);
    void this.drain();
  }

  private async drain() {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length && !this.stopped) {
        const msg = this.queue.shift()!;
        try {
          await this.handle(msg);
          this.markSeen(msg.message_id);
          await this.ack(msg.message_id);
        } catch (e: any) {
          log('warn', `${this.tag()} message ${msg.message_id} (${msg.type}) failed: ${e.message}; will retry via inbox`);
        } finally {
          this.queued.delete(msg.message_id);
        }
      }
    } finally {
      this.working = false;
      this.status = 'ONLINE';
      this.currentTask = null;
      this.activity = null;
      void this.heartbeat();
    }
  }

  // BUSY (with the task id, or a short activity text) for the whole duration of `fn`, whatever its outcome.
  private async busy<T>(taskId: string | null, activity: string | null, fn: () => Promise<T>): Promise<T> {
    this.status = 'BUSY';
    this.currentTask = taskId;
    this.activity = taskId ? null : activity;
    await this.heartbeat();
    try { return await fn(); }
    finally {
      this.status = 'ONLINE';
      this.currentTask = null;
      this.activity = null;
      void this.heartbeat();
    }
  }

  private async handle(msg: any) {
    switch (msg.type) {
      case 'TASK_ASSIGNMENT': return this.runTask(msg, null);
      case 'REJECTION':
        if (!(await this.senderIsReviewer(msg))) { log('warn', `${this.tag()} ignoring REJECTION ${msg.message_id}: sender is not the task reviewer or founder`); return; }
        return this.runTask(msg, String(msg.payload?.note ?? 'Reviewer asked for changes.'));
      case 'QUESTION': return this.busy(null, 'Answering a question', () => this.answerQuestion(msg));
      case 'SYSTEM_ALERT': return this.systemAlert(msg);
      default: log('info', `${this.tag()} received ${msg.type} for task ${msg.task_id ?? '-'}`); // informational
    }
  }

  // Claude login relay (the code is never logged).
  private async systemAlert(msg: any) {
    const p = msg.payload ?? {};
    if (p.command === 'CLAUDE_LOGIN_START' && p.login_id) {
      return this.login.start(String(p.login_id)).catch((e) => {
        log('warn', `${this.tag()} claude login start failed: ${e.message}`);
        return this.login.fail(String(p.login_id), 'could not start the login').catch(() => {});
      });
    }
    if (p.command === 'CLAUDE_LOGIN_CODE' && p.login_id) return this.login.submitCode(String(p.login_id), String(p.code ?? ''));
    log('info', `${this.tag()} received SYSTEM_ALERT ${p.command ?? ''}`);
  }

  // APPROVAL/REJECTION count only from the task's reviewer (reply_to) or a founder.
  private async senderIsReviewer(msg: any): Promise<boolean> {
    if (!msg.task_id || !msg.sender_agent_id) return false;
    const task = await q1('select reply_to_agent_id from tasks where id = $1', [msg.task_id]);
    if (task?.reply_to_agent_id === msg.sender_agent_id) return true;
    return (await q1('select role from agents where id = $1', [msg.sender_agent_id]))?.role === 'founder';
  }

  private async setStatus(taskId: string, status: any, note?: string) {
    return tx((c, after) => changeStatus(c, after, taskId, this.actor, status, note));
  }

  private async runTask(msg: any, rework: string | null) {
    const taskId = msg.task_id as string;
    const task = await q1('select * from tasks where id = $1', [taskId]);
    if (!task) { log('warn', `${this.tag()} task ${taskId} not found`); return; }
    if (this.currentTask === taskId) { log('info', `${this.tag()} task ${taskId} is already running; ignoring duplicate delivery`); return; }
    if (!rework) {
      if (task.status === 'PENDING') await this.setStatus(taskId, 'ACCEPTED');
      if (['PENDING', 'ACCEPTED'].includes(task.status)) await this.setStatus(taskId, 'IN_PROGRESS');
      else if (task.status !== 'IN_PROGRESS') { log('info', `${this.tag()} task ${taskId} is ${task.status}; nothing to do`); return; }
    } else if (task.status !== 'IN_PROGRESS') return;

    return this.busy(taskId, null, () => this.execTask(msg, rework, task, taskId));
  }

  private async execTask(msg: any, rework: string | null, task: any, taskId: string) {
    const p = msg.payload ?? {};
    try {
      const wt = await prepareWorktree(this.agentId, task.project_id, taskId, p.repo_url ?? '', p.default_branch ?? 'main', await this.loadGitToken(task.project_id));
      const prompt = [
        `You are ${await this.agentName()}, the ${this.actor.role} agent on project "${p.project_name ?? task.project_id}". Work only inside this git worktree.`,
        `Task: ${task.title}`,
        `Description:\n${task.description}`,
        `Acceptance criteria:\n${task.acceptance_criteria}`,
        rework ? `Previous submission was rejected. Reviewer feedback:\n${rework}` : '',
        'Implement the task, run the relevant tests, and finish with a short summary including test results. Do not push or touch files outside this directory.',
      ].filter(Boolean).join('\n\n');
      const res = await runClaude(this.agentId, prompt, wt.dir, {
        allowedTools: allowedToolsFor(this.actor.role), connectors: await this.loadConnectors(task.project_id), signal: this.abort.signal,
      });
      if (!res.ok) {
        await this.setStatus(taskId, res.limit ? 'BLOCKED' : 'FAILED', res.text.slice(0, 1000));
        return;
      }
      const { commit, files } = await commitAll(this.agentId, wt, `${task.title}\n\nTask ${taskId}`);
      await tx((c, after) => submitReport(c, after, taskId, this.actor, {
        summary: res.text.slice(0, 5000) || 'Completed.',
        work_done: [task.title],
        files_changed: files,
        test_results: /tests?[: ]/i.test(res.text) ? res.text.slice(-1000) : null,
        git_branch: wt.branch,
        git_commit: commit,
        unmet_requirements: [],
        issues: [],
        next_steps: [],
      })); // idempotent for a repeated report on a task already in REVIEW
    } catch (e: any) {
      // Missing/invalid repo credentials are fixable by the user: BLOCKED (not FAILED) so moving it back to PENDING retries.
      if (e instanceof RepoAccessError) { await this.setStatus(taskId, 'BLOCKED', e.message).catch(() => {}); return; }
      await this.setStatus(taskId, 'FAILED', `agent error: ${String(e.message).slice(0, 500)}`).catch(() => {});
    }
  }

  // Best-effort: a missing/failed connector fetch must not stop a task or answer. The config is never logged.
  private async loadConnectors(projectId?: string): Promise<Connector[]> {
    try { return (await agentConnectors(this.actor, projectId)) as Connector[]; }
    catch (e: any) { log('warn', `${this.tag()} connector fetch failed: ${e.message}`); return []; }
  }

  private async loadGitToken(projectId: string): Promise<string | null> {
    try { return await gitTokenFor(this.actor, projectId); }
    catch (e: any) { log('warn', `${this.tag()} git token lookup failed: ${e.message}`); return null; }
  }

  private async loadAccountConnectors() {
    try { return await listAccountConnectors(this.agentId); }
    catch (e: any) { log('warn', `${this.tag()} account connector list failed: ${e.message}`); return []; }
  }

  // Studio connectors + the human's claude.ai account connectors, with the rule for write actions.
  private connectorPrompt(connectors: Connector[], acct: { name: string; status: string; tool_prefix: string }[], none: string) {
    const ok = acct.filter((c) => c.status === 'connected');
    if (!connectors.length && !ok.length) return `${none}\n${NO_ATLASSIAN_PROMPT}`;
    return [
      connectors.length ? `Studio connector tools (mcp__<name>__*): ${connectors.map((c) => `${c.name} [${c.type}, ${c.allow_write ? 'write allowed' : 'read-only'}]`).join(', ')}. Creating or changing Jira/GitHub items is allowed only for connectors marked write allowed.` : '',
      ok.length ? `Connectors from the user's claude.ai account (tools ${ok.map((c) => `${c.tool_prefix}__*`).join(', ')}): ${ok.map((c) => c.name.replace(/^claude\.ai /, '')).join(', ')}. Use them to answer questions. Perform a write action (create/edit/delete/comment/transition) only when the user clearly asked for that exact action in this message, then say exactly what you did; otherwise only read. Creating a Jira issue additionally needs an explicit yes from the user in a later message.` : '',
      ok.some((c) => /atlassian/i.test(c.name)) ? '' : acct.some((c) => /atlassian/i.test(c.name)) ? `The Atlassian connector is not usable (status: ${acct.find((c) => /atlassian/i.test(c.name))!.status}); for Jira questions say so and name the fix in one line: Claude settings → Connectors → Atlassian.` : NO_ATLASSIAN_PROMPT,
    ].filter(Boolean).join('\n');
  }

  private async reply(msg: any, text: string, extra: object = {}) {
    const { msg: row, created } = await insertMessage(pool, {
      type: 'ANSWER', sender: this.agentId, recipient: msg.sender_agent_id, task_id: msg.task_id ?? null,
      payload: { text, answers_message_id: msg.message_id, data_updated_at: null, stale: false, ...extra },
      idempotency_key: `answer:${msg.message_id}`,
    });
    if (created) { await audit(pool, this.actor, 'message.create', 'message', row.message_id, { type: 'ANSWER', task_id: msg.task_id ?? null }); publish([row]); }
  }

  // Copies the question's images into <workdir>/uploads (0700) for Claude's Read tool; removed again by the caller.
  private async stageAttachments(msg: any): Promise<{ dir: string; files: string[] }> {
    const ids: string[] = Array.isArray(msg.payload?.attachments) ? msg.payload.attachments.filter((x: unknown) => typeof x === 'string').slice(0, 4) : [];
    const dir = path.join(workDir(this.agentId), 'uploads');
    fs.rmSync(dir, { recursive: true, force: true });
    if (!ids.length) return { dir, files: [] };
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const rows = await q('select id, mime from attachments where id = any($1::uuid[])', [ids]);
    const ext: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
    const files: string[] = [];
    for (const r of rows) {
      try {
        const f = path.join(dir, `image-${files.length + 1}.${ext[r.mime] ?? 'bin'}`);
        fs.copyFileSync(uploadPath(r.id), f);
        fs.chmodSync(f, 0o600);
        files.push(f);
      } catch (e: any) { log('warn', `${this.tag()} attachment ${r.id} unavailable: ${e.message}`); }
    }
    return { dir, files };
  }

  private attachmentPrompt(files: string[]) {
    return files.length ? `Attached images (the user sent these with the question; view each with the Read tool):\n${files.map((f) => `- ${f}`).join('\n')}` : '';
  }

  private async answerQuestion(msg: any) {
    const att = await this.stageAttachments(msg);
    try { return await this.answerQuestionWith(msg, att); }
    finally { fs.rmSync(att.dir, { recursive: true, force: true }); }
  }

  private async answerQuestionWith(msg: any, att: { dir: string; files: string[] }) {
    const question = String(msg.payload?.text ?? msg.payload?.question ?? '');
    let projectId = msg.payload?.project_id as string | undefined;
    if (!projectId && msg.task_id) projectId = (await q1('select project_id from tasks where id = $1', [msg.task_id]))?.project_id;
    // Every asker gets full access: all Studio projects, all connectors.
    const all: string[] = (await q('select id from projects')).map((r) => r.id);
    // The owner = this agent itself (self-chat / the user in the UI) or another agent of the same user.
    const asker = await q1('select user_id from agents where id = $1', [msg.sender_agent_id]);
    const self = msg.sender_agent_id === this.agentId || !!(asker?.user_id && asker.user_id === this.actor.userId);
    return this.answerSelf(msg, question, projectId, all, att, !self);
  }

  private async owner() {
    return (await q1('select u.name from agents a join users u on u.id = a.user_id where a.id = $1', [this.agentId]))?.name ?? 'my owner';
  }

  // Facts from the DB only: role, status, the allowed projects and the tasks assigned to this agent inside them.
  private async agentFacts(projectIds: string[], connectors: Connector[], acct: { name: string; status: string }[]) {
    const me = await q1('select name, status from agents where id = $1', [this.agentId]);
    const names = projectIds.length ? (await q('select name from projects where id = any($1::uuid[]) order by name', [projectIds])).map((r) => r.name) : [];
    const tasks = projectIds.length
      ? await q(`select title, status from tasks where assignee_agent_id = $1 and project_id = any($2::uuid[]) and status not in ('COMPLETED','FAILED','CANCELLED') order by created_at desc limit 10`, [this.agentId, projectIds]).catch(() => [])
      : [];
    const conn = [...connectors.map((c) => `${c.name} (${c.type})`), ...acct.filter((c) => c.status === 'connected').map((c) => c.name.replace(/^claude\.ai /, ''))];
    return [
      `I'm ${me?.name ?? 'the agent'}, the ${this.actor.role} agent (status ${me?.status ?? 'unknown'}), working for ${await this.owner()}.`,
      `Projects visible to you: ${names.join(', ') || 'none'}.`,
      `Tasks assigned to me in those projects: ${tasks.map((t: any) => `${t.title} [${t.status}]`).join('; ') || 'none'}.`,
      `My connectors: ${conn.join(', ') || 'none configured'}.`,
    ].join('\n');
  }

  // Friendly status when this agent's Claude cannot run.
  private async claudeDown(cs: { available: boolean; logged_in: boolean }) {
    const owner = await this.owner();
    if (!cs.available) return `Claude isn't installed for me yet — ask ${owner} to check the server setup.`;
    if (!cs.logged_in) return `I'm not logged in to Claude yet — ask ${owner} to open Connect Claude and press 'Login with Claude'.`;
    return `I've hit my Claude usage limit for now — please try again later or ask ${owner}.`;
  }

  // The human chatting with their OWN agent (peer=false), or a peer/founder asking this agent (peer=true): all
  // projects (or the one named), the connectors visible to this agent, and general questions answered by this agent's
  // own Claude login. Read-only. A peer never gets the agent's private memory.
  private async answerSelf(msg: any, question: string, projectId: string | undefined, mine: string[], att: { dir: string; files: string[] }, peer = false) {
    const ids = projectId && mine.includes(projectId) ? [projectId] : mine;
    const snaps = await Promise.all(ids.map((id) => projectStatus(id).catch(() => null)));
    const projects: any[] = snaps.flatMap((s) => (s?.project ? [s.project] : []));
    const status = snaps.map((s) => (s?.project ? `Project ${s.project.name}:\n${describeStatus(s, Date.now(), config.staleAfterMs).text}` : '')).filter(Boolean).join('\n\n');
    const connectors = await this.loadConnectors(ids.length === 1 ? ids[0] : undefined);
    const acct = await this.loadAccountConnectors();
    const facts = async () => [status, await this.agentFacts(ids, connectors, acct)].filter(Boolean).join('\n\n');
    const repoNames = projects.flatMap((p) => (Array.isArray(p.repos) ? p.repos.map((r: any) => String(r.name)) : []));
    if (config.mockClaude && !att.files.length && !(peer && needsDeepAnswer(question, repoNames))) {
      const cs = peer ? await checkClaude(this.agentId) : { available: true, logged_in: true, limit_reached: false };
      const down = peer && (!cs.available || !cs.logged_in || cs.limit_reached) ? `${await this.claudeDown(cs)}\n\n` : '';
      return this.reply(msg, peer ? down + (await facts()) : status || 'You have no projects yet.', { stale: peer ? !!down : !status });
    }
    const cs = await checkClaude(this.agentId);
    if (!cs.available || !cs.logged_in || cs.limit_reached) {
      return this.reply(msg, `${await this.claudeDown(cs)}\n\n${await facts()}`, { stale: true });
    }
    const dirs: { name: string; dir: string }[] = [];
    const notes: string[] = [];
    const refs: { repo: string; ref: RepoRef }[] = [];
    for (const p of projects) {
      const extras: { name: string; url: string }[] = Array.isArray(p.repos) ? p.repos : [];
      const repos = await prepareReadRepos(this.agentId, p.id, { url: p.repo_url ?? '', branch: p.default_branch ?? 'main' }, extras, await this.loadGitToken(p.id)).catch(() => []);
      for (const r of repos) {
        if (fs.existsSync(path.join(r.dir, '.git'))) dirs.push({ name: `${p.name}/${r.name}`, dir: r.dir });
        if (r.note) notes.push(`${p.name}/${r.name}: ${r.note}`);
        refs.push({ repo: `${p.name}/${r.name}`, ref: r });
      }
    }
    const studio = studioEligible(this.actor.role);
    const prompt = [
      peer
        ? `You are ${await this.agentName()}, the ${this.actor.role} agent, answering a question from another user's agent. This is READ-ONLY for files: never modify files, never commit or push.`
        : `You are ${await this.agentName()}, the ${this.actor.role} agent, chatting directly with your own user. This is READ-ONLY for files: never modify files, never commit or push.`,
      studio ? STUDIO_PROMPT : '',
      STYLE_PROMPT,
      `Question: ${question}`,
      this.attachmentPrompt(att.files),
      status ? `Project status snapshot:\n${status}` : 'There are no Studio projects yet.',
      dirs.length ? `Repositories (project/name: directory):\n${dirs.map((r) => `- ${r.name}: ${r.dir}`).join('\n')}\nUse git log/diff/show/status with --all or origin/<branch> refs to see fetched remote work.` : 'No repository could be accessed.',
      notes.length ? `Access problems:\n${notes.map((n) => `- ${n}`).join('\n')}` : '',
      this.connectorPrompt(connectors, acct, 'No connectors are available.'),
      peer ? '' : `You have a persistent memory file: ${memoryFile(this.agentId)} (loaded into every chat). You may remember durable user preferences and facts. Only when the user explicitly asks you to "remember ...", append a short line to that file (Edit/Write on that single file is the only edit allowed), then confirm it. Otherwise never modify it, and never write secrets into it.`,
      'General questions may be answered from your own knowledge. For anything about projects, code or tickets, answer only from what you actually read or fetched with tools; never invent commits, files or tickets.',
    ].filter(Boolean).join('\n\n');
    const r = await runClaude(this.agentId, prompt, dirs[0]?.dir ?? workDir(this.agentId), {
      readOnly: true, memory: !peer, sessionKey: msg.conversation_id, addDirs: [...dirs.slice(1).map((x) => x.dir), ...(att.files.length ? [att.dir] : [])], connectors, accountConnectors: acct, studioActor: studio ? this.actor : undefined, signal: this.abort.signal,
    });
    const text = r.ok && r.text ? r.text : `I could not answer this: ${r.text || 'claude failed'}\n\n${await facts()}`;
    await this.reply(msg, text, { stale: !r.ok, ...collectNotices(refs) });
  }
}

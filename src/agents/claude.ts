import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { type Connector, prepareMcp } from './connectors.js';
import { prepareStudioMcp } from './studioMcp.js';
import type { Actor } from '../auth.js';
import { childEnv, workDir } from './env.js';
import { ensureAutoMemory, getSession, memoryFile, setSession } from './memory.js';

export interface ClaudeStatus { logged_in: boolean; auth_method: string; limit_reached: boolean; detail: string; available: boolean }

const run = (bin: string, args: string[], env: NodeJS.ProcessEnv, timeout = 20_000) =>
  new Promise<{ code: number; out: string }>((resolve) =>
    execFile(bin, args, { timeout, maxBuffer: 1 << 20, env }, (err: any, stdout) => resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout ?? '') })),
  );

const limitReached = new Map<string, number>(); // agent id -> when the limit was hit
const LIMIT_RE = /(usage limit|rate limit|limit reached|quota|overloaded)/i;
const LIMIT_TTL_MS = 30 * 60_000;
const limitActive = (agentId: string) => Date.now() - (limitReached.get(agentId) ?? 0) < LIMIT_TTL_MS;

const connectorCache = new Map<string, { at: number; list: AccountConnector[] }>();
const mockLoggedOut = new Set<string>(); // MOCK_CLAUDE only: agents that "logged out"
export const mockLogin = (agentId: string) => { mockLoggedOut.delete(agentId); };

// `claude auth logout` with this agent's own CLAUDE_CONFIG_DIR/HOME only (childEnv), so no other agent's login is touched.
export async function claudeLogout(agentId: string): Promise<boolean> {
  connectorCache.delete(agentId);
  if (config.mockClaude) { mockLoggedOut.add(agentId); return true; }
  const r = await run(config.claudeBin, ['auth', 'logout'], childEnv(agentId), 30_000);
  return r.code === 0;
}

// Only booleans and a whitelisted auth method leave this function: no emails, org names or tokens.
export async function checkClaude(agentId: string): Promise<ClaudeStatus> {
  if (config.mockClaude) return { available: true, logged_in: !mockLoggedOut.has(agentId), auth_method: mockLoggedOut.has(agentId) ? '' : 'mock', limit_reached: false, detail: mockLoggedOut.has(agentId) ? 'claude CLI is not logged in' : 'MOCK_CLAUDE=1 (simulated CLI)' };
  const env = childEnv(agentId);
  const v = await run(config.claudeBin, ['--version'], env);
  if (v.code !== 0) return { available: false, logged_in: false, auth_method: '', limit_reached: false, detail: 'claude CLI not found' };
  const s = await run(config.claudeBin, ['auth', 'status', '--json'], env);
  let logged = false;
  let method = '';
  try {
    const j = JSON.parse(s.out);
    logged = j.loggedIn === true;
    method = ['claude.ai', 'api_key', 'console', 'oauth'].includes(j.authMethod) ? j.authMethod : logged ? 'other' : '';
  } catch { /* unparseable: treat as not logged in */ }
  const lim = logged && limitActive(agentId);
  return { available: true, logged_in: logged, auth_method: method, limit_reached: lim, detail: !logged ? 'claude CLI is not logged in' : lim ? 'usage limit reached' : 'ok' };
}

export interface AccountConnector { name: string; type: 'claude.ai'; status: 'connected' | 'needs-auth' | 'failed'; tool_prefix: string }

// MCP tool-name segment the CLI derives from a server name (runs of other characters collapse to one "_").
export const mcpToolPrefix = (name: string) => `mcp__${name.replace(/[^A-Za-z0-9_-]+/g, '_')}`;

// Connectors of the human's claude.ai account, as the real CLI sees them for this agent's login (`claude mcp list`).
// Only name + status leave this function (never URLs or tokens). Cached 60s per agent.
export async function listAccountConnectors(agentId: string): Promise<AccountConnector[]> {
  if (config.mockClaude) return [];
  const hit = connectorCache.get(agentId);
  if (hit && Date.now() - hit.at < 60_000) return hit.list;
  const r = await run(config.claudeBin, ['mcp', 'list'], childEnv(agentId), 60_000);
  const list: AccountConnector[] = [];
  for (const line of r.out.split('\n')) {
    const m = /^(claude\.ai [^:]+): .* - (?:✔|✓|!|✗|✘|x)?\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const st = m[2].toLowerCase();
    const status = st.includes('connected') && !st.includes('not') ? 'connected' : st.includes('auth') ? 'needs-auth' : 'failed';
    list.push({ name: m[1], type: 'claude.ai', status, tool_prefix: mcpToolPrefix(m[1]) });
  }
  if (r.code === 0 || list.length) connectorCache.set(agentId, { at: Date.now(), list });
  return list;
}

export interface ClaudeResult { ok: boolean; limit: boolean; text: string }

export interface RunOpts {
  noTools?: boolean; // pure text answer (Q&A): all tools disabled, plan mode, throwaway empty directory
  readOnly?: boolean; // repo questions: read + git inspection tools only, no edits
  addDirs?: string[]; // extra repo directories (readOnly)
  accountConnectors?: AccountConnector[]; // claude.ai account connectors (already logged in; allowed by server-level rules)
  connectors?: Connector[]; // exposed to the CLI as MCP servers for this run only
  allowedTools?: string; // task runs
  sessionKey?: string; // conversation id: resume the stored Claude session and store the new session id
  memory?: boolean; // allow Edit/Write on this agent's single memory file (readOnly runs only)
  studioActor?: Actor; // founder/pm self-chat: expose the in-process studio MCP (mcp__studio__*) for this run only
  signal?: AbortSignal; // kill the child (agent stopped/deleted)
}

export const allowedToolsFor = (role: string) =>
  process.env.ALLOWED_TOOLS ??
  (role === 'developer'
    ? 'Read,Glob,Grep,Edit,Write,Bash(git status:*),Bash(git diff:*),Bash(git add:*),Bash(git log:*),Bash(npm test:*),Bash(npm run:*)'
    : 'Read,Glob,Grep');

export const READ_ONLY_TOOLS = 'Read,Glob,Grep,Bash(git log:*),Bash(git diff:*),Bash(git show:*),Bash(git status:*),Bash(git branch:*),Bash(git ls-files:*),Bash(git blame:*),Bash(git shortlog:*)';

export async function runClaude(agentId: string, prompt: string, cwd: string, opts: RunOpts = {}): Promise<ClaudeResult> {
  if (config.mockClaude) return mockClaude(agentId, prompt, cwd, opts);
  ensureAutoMemory(agentId);
  // Claude keeps sessions per working directory, so a resumable Q&A run needs a stable (empty) directory.
  const stable = opts.noTools && opts.sessionKey ? path.join(workDir(agentId), '.qa') : null;
  if (stable) fs.mkdirSync(stable, { recursive: true, mode: 0o700 });
  const scratch = opts.noTools && !stable ? fs.mkdtempSync(path.join(os.tmpdir(), 'qa-')) : null;
  const mcp = prepareMcp(opts.connectors ?? []);
  const studio = opts.studioActor ? prepareStudioMcp(opts.studioActor) : null;
  const mcpAllowed = [...(mcp?.allowed ?? []), ...(studio?.allowed ?? []), ...(opts.accountConnectors ?? []).filter((c) => c.status === 'connected').map((c) => c.tool_prefix)];
  const mcpDenied = mcp?.denied ?? [];
  const args = ['-p', prompt, '--output-format', 'json'];
  if (opts.noTools) args.push('--tools', '', '--permission-mode', 'plan');
  else if (opts.readOnly) {
    const mem = opts.memory ? [`Edit(/${memoryFile(agentId)})`, `Write(/${memoryFile(agentId)})`] : []; // "//abs/path" = absolute path rule
    args.push('--allowedTools', [READ_ONLY_TOOLS, ...mem, ...mcpAllowed].join(','), '--permission-mode', 'default');
    args.push('--disallowedTools', [...(opts.memory ? [] : ['Edit', 'Write']), 'NotebookEdit', ...mcpDenied].join(','));
    for (const d of opts.addDirs ?? []) args.push('--add-dir', d);
  } else {
    args.push('--allowedTools', [opts.allowedTools ?? 'Read,Glob,Grep', ...mcpAllowed].join(','), '--permission-mode', 'acceptEdits');
    if (mcpDenied.length) args.push('--disallowedTools', mcpDenied.join(','));
  }
  if (mcp) args.push(...mcp.args);
  if (studio) args.push(...studio.args);
  const resumeId = opts.sessionKey ? getSession(agentId, opts.sessionKey) : undefined;
  const attempt = (resume?: string) => new Promise<ClaudeResult & { session?: string }>((resolve) => {
    const done = (r: ClaudeResult & { session?: string }) => resolve(r);
    const child = spawn(config.claudeBin, resume ? [...args, '--resume', resume] : args, { cwd: stable ?? scratch ?? cwd, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(agentId), signal: opts.signal });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), config.taskTimeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      let text = out.trim();
      let isErr = code !== 0;
      let session: string | undefined;
      try {
        const j = JSON.parse(out);
        text = String(j.result ?? '');
        isErr = isErr || j.is_error === true;
        if (typeof j.session_id === 'string') session = j.session_id;
      } catch { /* plain text output */ }
      const limit = LIMIT_RE.test(text) || LIMIT_RE.test(err);
      if (limit) limitReached.set(agentId, Date.now());
      done({ ok: !isErr && !limit, limit, text: text || err.trim().slice(0, 1000), session });
    });
    child.on('error', (e) => { clearTimeout(timer); done({ ok: false, limit: false, text: `failed to start claude: ${e.message}` }); });
  });
  try {
    let r = await attempt(resumeId);
    if (resumeId && !r.ok && !r.limit && !opts.signal?.aborted) r = await attempt(); // resume failed (e.g. session gone): start fresh
    if (opts.sessionKey && r.ok && r.session) setSession(agentId, opts.sessionKey, r.session);
    return { ok: r.ok, limit: r.limit, text: r.text };
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    mcp?.cleanup();
    studio?.cleanup();
  }
}

// Simulates the CLI: writes a file in the worktree so the commit/report path is exercised.
async function mockClaude(agentId: string, prompt: string, cwd: string, opts: RunOpts): Promise<ClaudeResult> {
  await new Promise((r) => setTimeout(r, Number(process.env.MOCK_DELAY_MS ?? 300)));
  if (opts.sessionKey) setSession(agentId, opts.sessionKey, `mock-${Date.now()}`);
  if (opts.noTools) return { ok: true, limit: false, text: 'Mock answer from project data.' };
  if (opts.readOnly) {
    // Simulated repo Q&A: real `git log` of every checked-out repo, so the git path is exercised.
    const dirs = [cwd, ...(opts.addDirs ?? [])];
    const logs = await Promise.all(dirs.map((d) => new Promise<string>((res) =>
      execFile('git', ['log', '--all', '--oneline', '-n', '5'], { cwd: d, env: childEnv(agentId) }, (e, out) => res(e ? '(no git history)' : String(out).trim() || '(no commits)')))));
    const conns = (opts.connectors ?? []).map((c) => `${c.name}${c.allow_write ? ' (write)' : ' (read-only)'}`);
    const att = /^Attached images \(.*\):\n((?:- .*\n?)+)/m.exec(prompt)?.[1].trim().split('\n').map((l) => l.slice(2)) ?? [];
    const attText = att.length ? `\nAttachments: ${att.map((f) => `${path.basename(f)}=${fs.existsSync(f) ? fs.statSync(f).size : 'missing'}`).join(', ')}` : '';
    return { ok: true, limit: false, text: `[mock] ${dirs.map((d, i) => `${path.basename(d)}:\n${logs[i]}`).join('\n')}\nConnectors: ${conns.join(', ') || 'none'}${attText}` };
  }
  if (/\[mock:fail\]/.test(prompt)) return { ok: false, limit: false, text: 'mock failure requested' };
  if (/\[mock:limit\]/.test(prompt)) return { ok: false, limit: true, text: 'usage limit reached (mock)' };
  const title = /^Task: (.*)$/m.exec(prompt)?.[1] ?? 'task';
  fs.writeFileSync(path.join(cwd, 'MOCK_OUTPUT.md'), `# ${title}\n\nGenerated by MOCK_CLAUDE.\n`);
  return { ok: true, limit: false, text: `Mock run completed: ${title}. Tests: 1 passed (simulated).` };
}

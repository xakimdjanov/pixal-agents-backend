import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { childEnv, workDir } from './env.js';

// https or ssh only (scp-style git@host:path included); no file:, ext::, or option-looking values.
export const REPO_URL_RE = /^(https:\/\/|ssh:\/\/)[A-Za-z0-9._~%@:\/+-]+$|^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~\/+-]+$/;

// Thrown when a remote refuses us for lack of (valid) credentials; the runner turns it into a BLOCKED task.
export class RepoAccessError extends Error {
  constructor(readonly url: string, readonly hadToken: boolean) {
    super(hadToken
      ? `Cannot access repository ${url}: the configured GitHub token was rejected or lacks access. Fix the GitHub connector (Connectors → GitHub token) for this project, then move the task back to PENDING.`
      : `Cannot access repository ${url}: it needs credentials. Add a GitHub connector (Connectors → GitHub token) for this project, then move the task back to PENDING.`);
  }
}

const AUTH_FAIL_RE = /could not read (Username|Password)|terminal prompts disabled|Authentication failed|Repository not found|HTTP Basic: Access denied|returned error: (401|403)/i;

// Credentials for one git call: the token lives only in the child's environment (STUDIO_GIT_TOKEN); the GIT_ASKPASS helper
// is a static 0700 script in a private temp dir that is removed afterwards. Nothing goes into the URL, argv or .git/config.
export interface GitAuth { token: string }

export const canAuth = (repoUrl: string) => { try { const u = new URL(repoUrl); return u.protocol === 'https:' && /(^|\.)github\.com$/i.test(u.hostname); } catch { return false; } };

export async function withAskpass<T>(agentId: string, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-askpass-'));
  fs.chmodSync(dir, 0o700);
  const script = path.join(dir, 'askpass.sh');
  fs.writeFileSync(script, '#!/bin/sh\ncase "$1" in\n  Username*) printf \'%s\\n\' x-access-token ;;\n  *) printf \'%s\\n\' "$STUDIO_GIT_TOKEN" ;;\nesac\n', { mode: 0o700 });
  fs.chmodSync(script, 0o700);
  try { return await fn({ GIT_ASKPASS: script }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const git = (agentId: string, cwd: string, args: string[], auth?: GitAuth | null) => {
  const run = (extra: Record<string, string>) => new Promise<string>((resolve, reject) =>
    execFile('git', ['-c', 'user.name=studio-agent', '-c', 'user.email=agent@studio.local', ...args], { cwd, timeout: 120_000, maxBuffer: 8 << 20, env: childEnv(agentId, extra) }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout).trim());
      let msg = String(stderr).trim();
      if (auth?.token) msg = msg.split(auth.token).join('***');
      reject(new Error(`git ${args[0]} failed: ${msg.slice(0, 300)}`));
    }),
  );
  return auth?.token ? withAskpass(agentId, (env) => run({ ...env, STUDIO_GIT_TOKEN: auth.token })) : run({});
};

// Clone/fetch wrapper: ssh URLs and auth-less private repos fail clearly.
const remote = async (agentId: string, cwd: string, args: string[], repoUrl: string, token: string | null | undefined) => {
  const auth = token && canAuth(repoUrl) ? { token } : null;
  try { return await git(agentId, cwd, args, auth); }
  catch (e: any) {
    if (/^https:\/\//.test(repoUrl) && AUTH_FAIL_RE.test(String(e.message))) throw new RepoAccessError(repoUrl, !!auth);
    throw e;
  }
};

export interface Worktree { dir: string; branch: string; base: string }

// One shared clone per project, one worktree + branch per task, all under WORKDIR.
export async function prepareWorktree(agentId: string, projectId: string, taskId: string, repoUrl: string, defaultBranch: string, token?: string | null): Promise<Worktree> {
  const repo = path.join(workDir(agentId), 'repos', projectId);
  const dir = path.join(workDir(agentId), 'worktrees', projectId, taskId);
  const branch = `task/${taskId.slice(0, 8)}`;
  if (!fs.existsSync(path.join(repo, '.git'))) {
    fs.mkdirSync(repo, { recursive: true });
    if (repoUrl) {
      if (!REPO_URL_RE.test(repoUrl)) throw new Error('repo_url must be an https or ssh git URL');
      await remote(agentId, workDir(agentId), ['clone', '--', repoUrl, repo], repoUrl, token);
    } else {
      await git(agentId, repo, ['init', '-b', defaultBranch || 'main']);
      await git(agentId, repo, ['commit', '--allow-empty', '-m', 'init']);
    }
  } else if (repoUrl) {
    await remote(agentId, repo, ['fetch', '--all', '--prune'], repoUrl, token).catch(() => {});
  }
  const base = await git(agentId, repo, ['rev-parse', 'HEAD']).catch(() => '');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const exists = await git(agentId, repo, ['rev-parse', '--verify', branch]).then(() => true, () => false);
    await git(agentId, repo, exists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir]);
  }
  return { dir, branch, base };
}

export async function commitAll(agentId: string, wt: Worktree, message: string): Promise<{ commit: string; files: string[] }> {
  await git(agentId, wt.dir, ['add', '-A']);
  if ((await git(agentId, wt.dir, ['status', '--porcelain'])) !== '') await git(agentId, wt.dir, ['commit', '-m', message]);
  const commit = await git(agentId, wt.dir, ['rev-parse', 'HEAD']);
  const diff = wt.base ? await git(agentId, wt.dir, ['diff', '--name-only', `${wt.base}..HEAD`]).catch(() => '') : '';
  return { commit, files: diff ? diff.split('\n') : [] };
}

const SAFE_NAME = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;
export interface RepoRef { name: string; dir: string; note?: string }

// Question mode: shared clone(s) (main repo + the project's extra repos), fetched first, never edited.
// An unreachable remote is not fatal: the answer is based on the last fetched state and says so.
export async function prepareReadRepos(
  agentId: string, projectId: string, main: { url: string; branch: string }, extras: { name: string; url: string }[], token?: string | null,
): Promise<RepoRef[]> {
  const wanted = [
    { name: 'main', dir: path.join(workDir(agentId), 'repos', projectId), url: main.url, branch: main.branch },
    ...extras.filter((r) => SAFE_NAME.test(r.name)).map((r) => ({ name: r.name, dir: path.join(workDir(agentId), 'repos', `${projectId}__${r.name}`), url: r.url, branch: main.branch })),
  ];
  const out: RepoRef[] = [];
  for (const r of wanted) {
    const ref: RepoRef = { name: r.name, dir: r.dir };
    try {
      if (!fs.existsSync(path.join(r.dir, '.git'))) {
        if (!r.url) { if (r.name !== 'main') continue; fs.mkdirSync(r.dir, { recursive: true }); await git(agentId, r.dir, ['init', '-b', r.branch || 'main']); }
        else {
          if (!REPO_URL_RE.test(r.url)) throw new Error('repo url must be an https or ssh git URL');
          fs.mkdirSync(path.dirname(r.dir), { recursive: true });
          await remote(agentId, workDir(agentId), ['clone', '--', r.url, r.dir], r.url, token);
        }
      } else if (r.url) {
        await remote(agentId, r.dir, ['fetch', '--all', '--prune'], r.url, token);
      }
    } catch (e: any) {
      ref.note = fs.existsSync(path.join(r.dir, '.git')) ? `could not fetch (${String(e.message).slice(0, 120)}); showing the last fetched state` : `could not be cloned (${String(e.message).slice(0, 120)})`;
      if (!fs.existsSync(path.join(r.dir, '.git'))) { out.push(ref); continue; }
    }
    out.push(ref);
  }
  return out;
}

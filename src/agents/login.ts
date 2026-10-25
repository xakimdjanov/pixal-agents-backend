import { type ChildProcess, spawn } from 'node:child_process';
import type { Actor } from '../auth.js';
import { config } from '../config.js';
import { reportClaudeLogin } from '../services/claudeLogin.js';
import { log } from '../log.js';
import { checkClaude, mockLogin } from './claude.js';
import { childEnv } from './env.js';

const URL_RE = /https:\/\/[^\s"'<>]+/;
const SESSION_TTL_MS = 10 * 60_000;

interface Session { child: ChildProcess | null; exited: Promise<number> | null; timer: NodeJS.Timeout }

// One `claude auth login` at a time per agent, running with that agent's own CLAUDE_CONFIG_DIR.
// CLI output and the pasted code are never logged or forwarded; only the OAuth URL and fixed messages are.
export class LoginFlow {
  private sessions = new Map<string, Session>();
  constructor(private actor: Actor, private refreshStatus: () => Promise<void>) {}

  private get agentId() { return this.actor.agentId!; }
  private report = (loginId: string, body: Parameters<typeof reportClaudeLogin>[2]) => reportClaudeLogin(this.actor, loginId, body);

  private end(loginId: string) {
    const s = this.sessions.get(loginId);
    if (!s) return;
    clearTimeout(s.timer);
    this.sessions.delete(loginId);
    try { s.child?.kill('SIGKILL'); } catch { /* already gone */ }
  }

  fail(loginId: string, error: string) { return this.report(loginId, { status: 'FAILED', error }); }

  stop() { for (const id of [...this.sessions.keys()]) this.end(id); }

  async start(loginId: string) {
    this.stop();
    const timer = setTimeout(() => this.end(loginId), SESSION_TTL_MS);
    timer.unref();
    if (config.mockClaude) {
      this.sessions.set(loginId, { child: null, exited: null, timer });
      await this.report(loginId, { status: 'URL_READY', url: `https://claude.ai/oauth/authorize?mock=1&state=${loginId}` });
      return;
    }
    // `claude auth login` prints the URL on stdout and reads the pasted code from stdin: no pty needed.
    const child = spawn(config.claudeBin, ['auth', 'login'], { env: childEnv(this.agentId), stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise<number>((resolve) => {
      child.on('close', (c) => resolve(c ?? 1));
      child.on('error', () => resolve(1));
    });
    child.stdin!.on('error', () => {});
    this.sessions.set(loginId, { child, exited, timer });
    const url = await new Promise<string | null>((resolve) => {
      let buf = '';
      const t = setTimeout(() => resolve(null), 20_000);
      const onData = (d: Buffer) => {
        buf += d.toString();
        const m = URL_RE.exec(buf);
        if (m) { clearTimeout(t); resolve(m[0]); }
      };
      child.stdout!.on('data', onData);
      child.stderr!.on('data', onData);
      void exited.then(() => { clearTimeout(t); resolve(null); });
    });
    if (!url) {
      this.end(loginId);
      await this.report(loginId, { status: 'FAILED', error: 'could not get a login link from claude' });
      return;
    }
    await this.report(loginId, { status: 'URL_READY', url });
  }

  async submitCode(loginId: string, code: string) {
    const s = this.sessions.get(loginId);
    if (!s) { await this.report(loginId, { status: 'FAILED', error: 'login session expired; start again' }); return; }
    try {
      if (config.mockClaude) {
        // Simulated CLI: any non-empty code is accepted.
        if (code) mockLogin(this.agentId);
        await this.report(loginId, code ? { status: 'SUCCESS' } : { status: 'FAILED', error: 'empty code' });
      } else {
        s.child!.stdin!.write(code.trim() + '\n');
        s.child!.stdin!.end();
        const exit = await Promise.race([s.exited!, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 60_000))]);
        if (exit === 'timeout') { await this.report(loginId, { status: 'FAILED', error: 'claude did not finish signing in; try again' }); return; }
        const st = await checkClaude(this.agentId);
        await this.report(loginId, st.logged_in ? { status: 'SUCCESS' } : { status: 'FAILED', error: 'sign-in failed: the code was not accepted' });
        if (st.logged_in) log('info', `claude login completed for agent ${this.agentId}`);
      }
    } finally {
      this.end(loginId);
      await this.refreshStatus();
    }
  }
}

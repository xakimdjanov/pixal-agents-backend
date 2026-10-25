import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

// Per-agent isolation: Claude config (OAuth login), working copies and HOME live in separate 0700 directories.
export const claudeDir = (agentId: string) => path.join(config.dataDir, 'claude', agentId);
export const workDir = (agentId: string) => path.join(config.dataDir, 'work', agentId);

const mk = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
};

export function ensureDirs(agentId: string) {
  mk(path.join(config.dataDir, 'claude'));
  mk(path.join(config.dataDir, 'work'));
  mk(claudeDir(agentId));
  mk(workDir(agentId));
  mk(path.join(workDir(agentId), '.home'));
}

// Allowlisted environment for child processes (claude, git, uv): never DATABASE_URL, JWT_SECRET, CONNECTOR_KEY, POSTGRES_*.
export function childEnv(agentId: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  ensureDirs(agentId);
  const e: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'USE_BUILTIN_RIPGREP']) {
    if (process.env[k]) e[k] = process.env[k];
  }
  e.HOME = path.join(workDir(agentId), '.home');
  e.CLAUDE_CONFIG_DIR = claudeDir(agentId);
  e.GIT_ALLOW_PROTOCOL = 'https:ssh';
  e.GIT_TERMINAL_PROMPT = '0';
  e.DISABLE_AUTOUPDATER = '1';
  return { ...e, ...extra };
}

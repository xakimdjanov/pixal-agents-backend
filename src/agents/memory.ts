import fs from 'node:fs';
import path from 'node:path';
import { claudeDir, ensureDirs } from './env.js';

export const MEMORY_MAX_BYTES = 20 * 1024;

// Claude Code reads CLAUDE.md in CLAUDE_CONFIG_DIR as user memory, so this one file is the agent's persistent memory.
export const memoryFile = (agentId: string) => path.join(claudeDir(agentId), 'CLAUDE.md');
const sessionsFile = (agentId: string) => path.join(claudeDir(agentId), 'chat-sessions.json');

export function readMemory(agentId: string): { content: string; updated_at: string | null } {
  try {
    const f = memoryFile(agentId);
    return { content: fs.readFileSync(f, 'utf8'), updated_at: fs.statSync(f).mtime.toISOString() };
  } catch { return { content: '', updated_at: null }; }
}

export function writeMemory(agentId: string, content: string) {
  ensureDirs(agentId);
  const f = memoryFile(agentId);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, f);
}

// Claude Code's own auto memory (kept inside this agent's config dir) on by default; an existing setting is never overwritten.
export function ensureAutoMemory(agentId: string) {
  const f = path.join(claudeDir(agentId), 'settings.json');
  try {
    const cur = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    if (cur.autoMemoryEnabled !== undefined) return;
    fs.writeFileSync(f, JSON.stringify({ ...cur, autoMemoryEnabled: true }, null, 2), { mode: 0o600 });
  } catch { /* unparseable settings: leave untouched */ }
}

// Claude session id per conversation, so follow-up messages continue the same Claude session (`--resume`).
function readSessions(agentId: string): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(sessionsFile(agentId), 'utf8')); } catch { return {}; }
}
export const getSession = (agentId: string, conv: string): string | undefined => readSessions(agentId)[conv];
export function setSession(agentId: string, conv: string, sessionId: string | null) {
  ensureDirs(agentId);
  const s = readSessions(agentId);
  if (sessionId) s[conv] = sessionId; else delete s[conv];
  fs.writeFileSync(sessionsFile(agentId), JSON.stringify(s), { mode: 0o600 });
}
export const resetSessions = (agentId: string) => fs.rmSync(sessionsFile(agentId), { force: true });

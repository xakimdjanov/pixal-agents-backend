import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Connector { id: string; name: string; type: string; project_id: string | null; allow_write: boolean; server: Record<string, unknown> }

// Verbs that mean "changes something": denied (defense in depth) for connectors without allow_write.
const WRITE_VERBS = ['create', 'update', 'delete', 'edit', 'add', 'remove', 'transition', 'comment', 'assign', 'merge', 'push', 'write', 'link'];

export interface McpRun { file: string; args: string[]; allowed: string[]; denied: string[]; cleanup: () => void }

// Writes a 0600 mcp-config in a 0700 temp dir; the caller must call cleanup() after the run.
export function prepareMcp(list: Connector[]): McpRun | null {
  if (!list.length) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-'));
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: Object.fromEntries(list.map((c) => [c.name, c.server])) }), { mode: 0o600 });
  const allowed = list.map((c) => `mcp__${c.name}__*`);
  const denied = list.filter((c) => !c.allow_write).flatMap((c) => WRITE_VERBS.map((v) => `mcp__${c.name}__*${v}*`));
  return {
    file, allowed, denied,
    args: ['--mcp-config', file], // no --strict-mcp-config: claude.ai account connectors must still load
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

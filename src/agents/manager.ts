import fs from 'node:fs';
import { config } from '../config.js';
import { q } from '../db.js';
import { onMessage } from '../events.js';
import { log } from '../log.js';
import { claudeDir, workDir } from './env.js';
import { AgentRunner } from './runner.js';

const runners = new Map<string, AgentRunner>();
const starting = new Set<string>();
let reconciler: NodeJS.Timeout | null = null;

export async function startAgent(agentId: string) {
  if (runners.has(agentId) || starting.has(agentId)) return;
  starting.add(agentId);
  try {
    const r = new AgentRunner(agentId);
    await r.start();
    runners.set(agentId, r);
  } catch (e: any) {
    log('error', `could not start runner for agent ${agentId}: ${e.message}`);
  } finally { starting.delete(agentId); }
}

export function stopAgent(agentId: string) {
  const r = runners.get(agentId);
  if (!r) return;
  runners.delete(agentId);
  void r.stop();
}

// After an agent is deleted: drop its Claude login and working copies.
export async function removeAgent(agentId: string) {
  stopAgent(agentId);
  fs.rmSync(claudeDir(agentId), { recursive: true, force: true });
  fs.rmSync(workDir(agentId), { recursive: true, force: true });
}

// Every agent with execution_mode 'server' gets a runner; agents created elsewhere (seed, SQL) are picked up here too.
async function reconcile() {
  const rows = await q("select id, execution_mode from agents");
  const want = new Set(rows.filter((r) => r.execution_mode === 'server').map((r) => r.id as string));
  for (const id of want) await startAgent(id);
  for (const id of [...runners.keys()]) if (!want.has(id)) stopAgent(id);
}

export async function startAgents() {
  onMessage((m) => runners.get(m.recipient_agent_id)?.notify());
  await reconcile();
  reconciler = setInterval(() => void reconcile().catch((e) => log('warn', `agent reconcile failed: ${e.message}`)), 10_000);
  log('info', `agent runners started: ${runners.size} (data dir ${config.dataDir})`);
  return stopAgents;
}

export async function stopAgents() {
  if (reconciler) clearInterval(reconciler);
  reconciler = null;
  await Promise.all([...runners.values()].map((r) => r.stop()));
  runners.clear();
}

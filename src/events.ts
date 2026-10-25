import type { Server } from 'socket.io';
import { resolveActor } from './auth.js';
import { q } from './db.js';

let io: Server | null = null;

export function attachSockets(server: Server) {
  io = server;
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    const actor = typeof token === 'string' ? await resolveActor(token).catch(() => null) : null;
    if (!actor) return next(new Error('unauthorized'));
    socket.data.actor = actor;
    next();
  });
  io.on('connection', async (socket) => {
    const a = socket.data.actor;
    socket.join(`user:${a.userId}`);
    if (a.agentId) socket.join(`agent:${a.agentId}`);
    if (a.kind === 'user') { socket.join('users'); socket.join(`role:${a.role}`); }
    if (a.role === 'founder') {
      socket.join('founders');
      socket.join('projects:all');
    }
    const rows = await q('select project_id from project_members where user_id = $1', [a.userId]).catch(() => []);
    for (const r of rows) socket.join(`project:${r.project_id}`);
  });
}

export const joinProject = (userId: string, projectId: string) => {
  io?.in(`user:${userId}`).socketsJoin(`project:${projectId}`);
};

export const leaveProject = (userId: string, projectId: string) => {
  io?.in(`user:${userId}`).socketsLeave(`project:${projectId}`);
};

// Membership changed: notify members, founders and (via agent:status listeners) refresh agent lists.
export const emitProjectUpdated = (projectId: string) => {
  io?.to(`project:${projectId}`).to('projects:all').emit('project:updated', { project_id: projectId });
};

export const emitTask = (event: 'task:created' | 'task:updated', task: any) => {
  io?.to(`project:${task.project_id}`).to('projects:all').emit(event, task);
};

// Developers must not see which projects other agents belong to, nor Claude status details.
export const forRole = (agent: any, role: string) => {
  if (role !== 'developer' || !agent) return agent;
  const { project_ids: _p, ...rest } = agent;
  return { ...rest, claude: agent.claude ? { ...agent.claude, detail: '' } : agent.claude };
};

export const emitAgent = (agent: any) => {
  io?.to('role:founder').to('role:pm').emit('agent:status', agent);
  io?.to('role:developer').emit('agent:status', forRole(agent, 'developer'));
};

// Rename etc.: same payload as agent:status plus agent:updated, so lists refresh either way.
export const emitAgentUpdated = (agent: any) => {
  emitAgent(agent);
  io?.to('role:founder').to('role:pm').emit('agent:updated', agent);
  io?.to('role:developer').emit('agent:updated', forRole(agent, 'developer'));
};

export const emitAgentRemoved = (id: string) => {
  io?.to('role:founder').to('role:pm').to('role:developer').emit('agent:removed', { id });
};

export const emitClaudeStatus = (userId: string, s: { agent_id: string; logged_in: boolean; limit_reached: boolean }) => {
  io?.to(`user:${userId}`).to('founders').emit('claude:status', s);
};

export const emitClaudeLogin = (userId: string, s: { agent_id: string; login_id: string; status: string }) => {
  io?.to(`user:${userId}`).to('founders').emit('claude:login', s);
};

// Login codes go only to the recipient agent; everyone else sees a redacted copy.
const redact = (m: any) => (m.payload?.code ? { ...m, payload: { ...m.payload, code: '' } } : m);

// Sockets only push; the message is already durable in the DB and in the recipient's inbox.
let messageListener: ((m: any) => void) | null = null;
// In-process agent runners subscribe here so they react immediately; they also poll their inbox as a fallback.
export const onMessage = (fn: (m: any) => void) => { messageListener = fn; };

export function emitMessage(msg: any) {
  try { messageListener?.(msg); } catch { /* runner errors never break delivery */ }
  io?.to(`agent:${msg.recipient_agent_id}`).emit('message:new', msg);
  io?.to(`agent:${msg.sender_agent_id}`).to('founders').except(`agent:${msg.recipient_agent_id}`).emit('message:new', redact(msg));
}

export const closeSockets = () => { io?.close(); io = null; };
export const socketsUp = () => !!io;

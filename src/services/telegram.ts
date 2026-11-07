// Telegram bot (long polling, no extra deps). A user links their chat from Profile → "Connect Telegram",
// then plain text messages become QUESTIONs (from the user's own agent) to the selected agent, and the
// agent's ANSWER is sent back to the chat. Same permission rules as the web chat.
import crypto from 'node:crypto';
import type { Actor } from '../auth.js';
import { config } from '../config.js';
import { pool, q, q1, tx } from '../db.js';
import { onMessage } from '../events.js';
import { log } from '../log.js';
import { audit } from './audit.js';
import { insertMessage, publish } from './messages.js';

const LINK_TTL_MS = 10 * 60_000;
const linkCodes = new Map<string, { userId: string; expires: number }>(); // one-time codes, memory only
let botUsername = '';

const api = async (method: string, body: object = {}) => {
  const r = await fetch(`https://api.telegram.org/bot${config.telegramToken}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`telegram ${method} failed: ${j.description ?? r.status}`); // never includes the token
  return j.result;
};

// Persistent bottom keyboard: users tap buttons instead of typing commands.
const BTN_AGENTS = '🤖 Agentni tanlash';
const BTN_WHO = 'ℹ️ Holat';
const BTN_UNLINK = '🔌 Uzish';
const MENU = { keyboard: [[{ text: BTN_AGENTS }], [{ text: BTN_WHO }, { text: BTN_UNLINK }]], resize_keyboard: true, is_persistent: true };

const send = (chatId: number | string, text: string, reply_markup: object = MENU) =>
  api('sendMessage', { chat_id: chatId, text: text.slice(0, 4000), reply_markup }).catch((e) => log('warn', e.message));

const agentButtons = (agents: any[], selected: string | null) => ({
  inline_keyboard: agents.map((g) => [{
    text: `${g.id === selected ? '✅ ' : ''}${g.name} · ${g.role}${g.status === 'OFFLINE' ? ' · offline' : ''}`,
    callback_data: `sel:${g.id}`,
  }]),
});

export const telegramEnabled = () => !!config.telegramToken;

export function createLinkCode(userId: string) {
  for (const [k, v] of linkCodes) if (v.expires < Date.now() || v.userId === userId) linkCodes.delete(k);
  const code = crypto.randomBytes(16).toString('hex');
  linkCodes.set(code, { userId, expires: Date.now() + LINK_TTL_MS });
  return { code, url: botUsername ? `https://t.me/${botUsername}?start=${code}` : '', bot: botUsername, expires_in_sec: LINK_TTL_MS / 1000 };
}

async function actorFor(chatId: number): Promise<(Actor & { selected: string | null }) | null> {
  const u = await q1(
    `select u.id, u.name, u.role, l.selected_agent_id,
            (select id from agents where user_id = u.id and deleted_at is null order by created_at limit 1) as agent_id
     from telegram_links l join users u on u.id = l.user_id where l.chat_id = $1`, [chatId]);
  return u ? { kind: 'user', userId: u.id, name: u.name, role: u.role, agentId: u.agent_id, selected: u.selected_agent_id } : null;
}

// Agents this user may DM (same rule as POST /messages without a task).
async function reachableAgents(a: Actor) {
  return q(
    `select g.id, g.name, g.role, g.status from agents g
     where g.deleted_at is null and ($2 = 'founder' or g.role = 'founder' or g.user_id = $1 or exists (
       select 1 from project_members x join project_members y using (project_id) where x.user_id = $1 and y.user_id = g.user_id))
     order by g.created_at`, [a.userId, a.role]);
}

async function ask(a: Actor, recipient: string, text: string, updateId: number) {
  const asker_project_ids = (a.role === 'founder'
    ? await q('select id from projects')
    : await q('select project_id as id from project_members where user_id = $1', [a.userId])).map((r) => r.id);
  await tx(async (c, after) => {
    const r = await insertMessage(c, {
      type: 'QUESTION', sender: a.agentId!, recipient,
      payload: { text, source: 'telegram', asker_project_ids }, idempotency_key: `tg:${updateId}`,
    });
    if (r.created) {
      await audit(c, a, 'message.create', 'message', r.msg.message_id, { type: 'QUESTION', task_id: null, via: 'telegram' });
      after(() => publish([r.msg]));
    }
  });
}

const HELP = `Pastdagi "${BTN_AGENTS}" tugmasini bosib, kimdan so'rashni tanlang. Keyin savolingizni oddiy matn qilib yozing — javob shu yerga keladi.`;

// Inline button tap: choose which agent questions go to.
async function handleCallback(cb: any) {
  const chatId: number | undefined = cb.message?.chat?.id;
  const done = (text = '') => api('answerCallbackQuery', { callback_query_id: cb.id, text }).catch(() => {});
  const a = chatId ? await actorFor(chatId) : null;
  const id = String(cb.data ?? '').startsWith('sel:') ? String(cb.data).slice(4) : '';
  if (!a || !id) return done();
  const agents = await reachableAgents(a);
  const g = agents.find((x) => x.id === id);
  if (!g) return done('Bu agentga ruxsat yo\'q');
  await q('update telegram_links set selected_agent_id = $2 where chat_id = $1', [chatId, g.id]);
  await done(`${g.name} tanlandi`);
  await api('editMessageText', {
    chat_id: chatId, message_id: cb.message.message_id,
    text: `Endi savollar "${g.name}" ga boradi. Savolingizni yozing 👇`, reply_markup: agentButtons(agents, g.id),
  }).catch(() => {});
}

async function handle(upd: any) {
  const m = upd.message;
  if (!m?.text || m.chat?.type !== 'private') return;
  const chatId: number = m.chat.id;
  const text: string = m.text.trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ');

  if (cmd === '/start' && arg) {
    const l = linkCodes.get(arg);
    linkCodes.delete(arg);
    if (!l || l.expires < Date.now()) return send(chatId, 'Kod eskirgan yoki noto\'g\'ri. Profile → "Connect Telegram" dan yangisini oling.');
    await q('delete from telegram_links where chat_id = $1 and user_id <> $2', [chatId, l.userId]);
    await q(`insert into telegram_links (user_id, chat_id, username) values ($1, $2, $3)
             on conflict (user_id) do update set chat_id = excluded.chat_id, username = excluded.username`,
      [l.userId, chatId, String(m.from?.username ?? '')]);
    const a = await actorFor(chatId);
    if (a) await audit(pool, a, 'telegram.link', 'user', a.userId, {});
    return send(chatId, `Ulandi ✅ ${a?.name ?? ''}\n\n${HELP}`);
  }

  const a = await actorFor(chatId);
  if (!a) return send(chatId, 'Bu chat hali ulanmagan. Studio → Profile → "Connect Telegram" tugmasini bosing.');
  if (cmd === '/start' || cmd === '/help') return send(chatId, HELP);
  if (cmd === '/unlink' || text === BTN_UNLINK) {
    await q('delete from telegram_links where chat_id = $1', [chatId]);
    await audit(pool, a, 'telegram.unlink', 'user', a.userId, {});
    return send(chatId, 'Uzildi. Qayta ulash uchun Studio → Profile → "Connect Telegram".', { remove_keyboard: true });
  }
  const agents = await reachableAgents(a);
  if (cmd === '/agents' || text === BTN_AGENTS) {
    if (!agents.length) return send(chatId, 'Agent yo\'q.');
    return send(chatId, 'Kimdan so\'raysiz?', agentButtons(agents, a.selected ?? a.agentId));
  }
  if (cmd === '/to') {
    const g = agents[Number(arg) - 1] ?? agents.find((x) => x.name.toLowerCase() === arg.toLowerCase());
    if (!g) return send(chatId, 'Topilmadi. /agents dan raqamini yozing, masalan: /to 2');
    await q('update telegram_links set selected_agent_id = $2 where chat_id = $1', [chatId, g.id]);
    return send(chatId, `Endi savollar "${g.name}" ga boradi.`);
  }
  if (cmd === '/whoami' || text === BTN_WHO) {
    const sel = agents.find((g) => g.id === (a.selected ?? a.agentId));
    return send(chatId, `👤 ${a.name} (${a.role})\n💬 Savollar: ${sel?.name ?? '—'}`);
  }
  if (cmd.startsWith('/')) return send(chatId, HELP);

  if (!a.agentId) return send(chatId, 'Sizga agent biriktirilmagan.');
  const target = agents.find((g) => g.id === (a.selected ?? a.agentId));
  if (!target) return send(chatId, 'Tanlangan agentga ruxsat yo\'q. Qayta tanlang:', agentButtons(agents, null));
  await ask(a, target.id, text, upd.update_id);
  void api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
}

// Forward ANSWERs to questions that came from Telegram.
async function forwardAnswer(msg: any) {
  if (msg.type !== 'ANSWER' || !msg.payload?.answers_message_id) return;
  const row = await q1(
    `select l.chat_id, g.name as from_name from messages qm
     join agents me on me.id = qm.sender_agent_id
     join telegram_links l on l.user_id = me.user_id
     join agents g on g.id = $2
     where qm.message_id = $1 and qm.payload->>'source' = 'telegram'`,
    [msg.payload.answers_message_id, msg.sender_agent_id]);
  if (row) await send(row.chat_id, `${row.from_name}:\n${String(msg.payload.text ?? '')}${msg.payload.stale ? '\n\n⚠️ Ma\'lumot eskirgan bo\'lishi mumkin.' : ''}`);
}

export function startTelegram(): () => void {
  if (!telegramEnabled()) return () => {};
  let stopped = false;
  const unsubscribe = onMessage((m) => void forwardAnswer(m).catch((e) => log('warn', `telegram forward failed: ${e.message}`)));
  void (async () => {
    try {
      botUsername = (await api('getMe')).username ?? '';
      await api('deleteWebhook');
      log('info', `telegram bot @${botUsername} started`);
    } catch (e: any) { log('error', e.message); return; }
    let offset = 0;
    while (!stopped) {
      try {
        const updates: any[] = await api('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
        for (const u of updates) {
          offset = u.update_id + 1;
          await (u.callback_query ? handleCallback(u.callback_query) : handle(u)).catch((e) => log('warn', `telegram update failed: ${e.message}`));
        }
      } catch (e: any) {
        log('warn', e.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();
  return () => { stopped = true; unsubscribe(); };
}

// Polls every enabled Studio Jira connector and announces new comments, field changes (status, assignee, …)
// and new issues to linked Telegram chats that have Jira notifications on and can see the connector's project.
import { config } from '../config.js';
import { q } from '../db.js';
import { log } from '../log.js';
import { decryptConfig } from './connectors.js';

const POLL_MS = Number(process.env.JIRA_POLL_MS ?? 60_000);
const LAG_MS = 30_000; // Jira's search index trails writes; only announce events older than this
const MAX_ISSUES = 50;

type Notify = (chatId: number | string, text: string) => unknown;
interface Ev { at: number; text: string }

const who = (u: any) => {
  if (!u) return "Noma'lum";
  return u.emailAddress ? `${u.displayName} (${u.emailAddress})` : String(u.displayName ?? "Noma'lum");
};
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

async function jira(site: string, auth: string, path: string) {
  const r = await fetch(site + path, { headers: { Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000), redirect: 'manual' });
  if (!r.ok) throw new Error(`jira ${path.split('?')[0]} HTTP ${r.status}`);
  return r.json() as Promise<any>;
}

// Events on one connector in the window (from, to].
async function collect(cfg: Record<string, any>, from: number, to: number): Promise<Ev[]> {
  const site = String(cfg.site_url).replace(/\/+$/, '');
  const auth = 'Basic ' + Buffer.from(`${cfg.email}:${cfg.api_token}`).toString('base64');
  const mins = Math.ceil((Date.now() - from) / 60_000) + 2;
  const jql = encodeURIComponent(`updated >= "-${mins}m" order by updated desc`);
  const res = await jira(site, auth, `/rest/api/3/search/jql?jql=${jql}&maxResults=${MAX_ISSUES}&fields=summary,created,creator,reporter,status`);
  const inWindow = (t: string) => { const x = Date.parse(t); return x > from && x <= to ? x : 0; };
  const out: Ev[] = [];

  for (const issue of res.issues ?? []) {
    const key = issue.key as string;
    const head = `${key} «${clip(String(issue.fields?.summary ?? ''), 120)}»`;
    const link = `${site}/browse/${key}`;

    const created = inWindow(issue.fields?.created ?? '');
    if (created) out.push({ at: created, text: `🆕 ${head}\n👤 ${who(issue.fields?.creator ?? issue.fields?.reporter)} yangi task yaratdi\n📌 Status: ${issue.fields?.status?.name ?? '-'}\n🔗 ${link}` });

    // v2 returns comment bodies as plain text (v3 would be ADF JSON).
    const comments = await jira(site, auth, `/rest/api/2/issue/${key}/comment?orderBy=-created&maxResults=20`);
    for (const c of comments.comments ?? []) {
      const at = inWindow(c.created ?? '');
      if (at) out.push({ at, text: `💬 ${head}\n👤 ${who(c.author)} izoh yozdi:\n«${clip(String(c.body ?? '').trim(), 1500)}»\n🔗 ${link}` });
    }

    const meta = await jira(site, auth, `/rest/api/3/issue/${key}/changelog?maxResults=1`);
    const total = Number(meta.total ?? 0);
    const hist = total > 1 ? await jira(site, auth, `/rest/api/3/issue/${key}/changelog?startAt=${Math.max(0, total - 30)}&maxResults=30`) : meta;
    for (const h of hist.values ?? []) {
      const at = inWindow(h.created ?? '');
      if (!at) continue;
      const items = (h.items ?? []).filter((i: any) => !['Comment', 'Rank'].includes(i.field)); // comments are announced above; Rank is board-reorder noise
      if (!items.length) continue;
      const lines = items.map((i: any) => `• ${i.field}: ${clip(String(i.fromString ?? '—'), 200)} → ${clip(String(i.toString ?? '—'), 200)}`);
      out.push({ at, text: `🔄 ${head}\n👤 ${who(h.author)} o'zgartirdi:\n${lines.join('\n')}\n🔗 ${link}` });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// Chats allowed to see this connector: global connector → everyone linked; project connector → members + founders.
const recipients = (projectId: string | null) => q(
  `select l.chat_id from telegram_links l join users u on u.id = l.user_id
   where l.notify_jira and ($1::uuid is null or u.role = 'founder'
     or exists (select 1 from project_members pm where pm.project_id = $1 and pm.user_id = u.id))`,
  [projectId]);

async function pollOnce(notify: Notify) {
  const conns = await q(`select c.*, w.cursor_at from connectors c left join jira_watch w on w.connector_id = c.id where c.enabled and c.type = 'jira'`);
  for (const c of conns) {
    const to = Date.now() - LAG_MS;
    if (!c.cursor_at) { // first sight: start from now, no backfill
      await q('insert into jira_watch (connector_id, cursor_at) values ($1, $2) on conflict do nothing', [c.id, new Date(to)]);
      continue;
    }
    const from = new Date(c.cursor_at).getTime();
    try {
      const events = await collect(decryptConfig(c), from, to);
      const chats = events.length ? await recipients(c.project_id) : [];
      for (const e of events) for (const r of chats) await notify(r.chat_id, e.text);
      await q('update jira_watch set cursor_at = $2 where connector_id = $1', [c.id, new Date(to)]);
    } catch (e: any) {
      log('warn', `jira watch ${c.name}: ${e.message}`); // cursor kept, so the window is retried next poll
    }
  }
}

export function startJiraWatch(notify: Notify): () => void {
  if (config.mockClaude) return () => {};
  let running = false;
  const t = setInterval(() => {
    if (running) return;
    running = true;
    pollOnce(notify).catch((e) => log('warn', `jira watch: ${e.message}`)).finally(() => { running = false; });
  }, POLL_MS);
  return () => clearInterval(t);
}

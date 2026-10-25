import fs from 'node:fs';
import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticate, assertProject, type Actor } from '../auth.js';
import { pool, q, q1, tx } from '../db.js';
import { HttpError } from '../errors.js';
import { config } from '../config.js';
import { audit } from '../services/audit.js';
import { assertOwnedAttachments, MAX_ATTACHMENT_BYTES, MAX_MESSAGE_ATTACHMENTS, readableAttachment, saveAttachment, uploadPath } from '../services/attachments.js';
import { insertMessage, MESSAGE_TYPES, publish } from '../services/messages.js';

export const messagesRouter = Router();
messagesRouter.use(authenticate);

// SQL predicate (alias m) limiting messages to what the actor may read. $1 = user id, $2 = agent id.
export const VISIBLE = `(
  $3 = 'founder'
  or m.sender_agent_id = $2 or m.recipient_agent_id = $2
  or ($3 = 'pm' and m.task_id in (select t.id from tasks t join project_members pm on pm.project_id = t.project_id and pm.user_id = $1))
)`;
export const visibleParams = (a: Actor) => [a.userId, a.agentId, a.role];

const FORBIDDEN_TYPES = ['TASK_ASSIGNMENT', 'TASK_REPORT', 'SYSTEM_ALERT']; // server-generated only

export const messageBody = z.object({
  type: z.enum(MESSAGE_TYPES),
  recipient_agent_id: z.string().uuid(),
  task_id: z.string().uuid().nullish(),
  conversation_id: z.string().max(200).nullish(),
  payload: z.record(z.any()).default({}).refine((p) => p.attachments == null || z.array(z.string().uuid()).max(MAX_MESSAGE_ATTACHMENTS).safeParse(p.attachments).success, `payload.attachments must be at most ${MAX_MESSAGE_ATTACHMENTS} attachment ids`).refine((p) => p.project_id == null || z.string().uuid().safeParse(p.project_id).success, 'payload.project_id must be a uuid'),
  idempotency_key: z.string().min(1).max(200).nullish(),
});

export async function postMessage(req: any, res: any) {
  const a: Actor = req.actor;
  const b = messageBody.parse(req.body);
  const key = b.idempotency_key ?? (req.get('Idempotency-Key') || null);
  if (!a.agentId) throw new HttpError(400, 'no agent bound to this user');
  if (FORBIDDEN_TYPES.includes(b.type)) throw new HttpError(400, `${b.type} cannot be posted directly`);

  if (['APPROVAL', 'REJECTION'].includes(b.type) && !b.task_id && a.role !== 'founder') {
    throw new HttpError(403, 'only the task reviewer or the founder can approve or reject');
  }
  if (b.payload.attachments != null) {
    if (b.type !== 'QUESTION') throw new HttpError(400, 'attachments are only allowed on QUESTION messages');
    if (a.kind !== 'user') throw new HttpError(403, 'attachments need a user login');
    b.payload.attachments = [...new Set<string>(b.payload.attachments)];
    await assertOwnedAttachments(a.userId, b.payload.attachments);
  }
  if (b.type === 'QUESTION') {
    // The server, not the asker, states which projects the asker belongs to; answerers intersect with their own.
    if (b.payload.project_id) await assertProject(a, b.payload.project_id);
    b.payload.asker_project_ids = (a.role === 'founder'
      ? await q('select id from projects')
      : await q('select project_id as id from project_members where user_id = $1', [a.userId])).map((r: any) => r.id);
  }

  const rcpt = await q1('select id, role, user_id from agents where id = $1 and deleted_at is null', [b.recipient_agent_id]);
  if (!rcpt) throw new HttpError(404, 'recipient not found');

  if (b.task_id) {
    const t = await q1('select * from tasks where id = $1', [b.task_id]);
    if (!t) throw new HttpError(404, 'task not found');
    await assertProject(a, t.project_id);
    if (['APPROVAL', 'REJECTION'].includes(b.type) && a.role !== 'founder' && t.reply_to_agent_id !== a.agentId) {
      throw new HttpError(403, 'only the task reviewer or the founder can approve or reject');
    }
    const participant = [t.assignee_agent_id, t.reply_to_agent_id, t.sender_agent_id].includes(a.agentId);
    if (!participant && a.role === 'developer') throw new HttpError(403, 'not a participant of this task');
    const rcptOk = rcpt.role === 'founder' || !!(await q1('select 1 from project_members where project_id = $1 and user_id = $2', [t.project_id, rcpt.user_id]));
    if (!rcptOk) throw new HttpError(400, 'recipient has no access to this task');
  } else if (a.role !== 'founder' && rcpt.role !== 'founder' && rcpt.user_id !== a.userId) {
    const shared = await q1(
      'select 1 from project_members x join project_members y using (project_id) where x.user_id = $1 and y.user_id = $2 limit 1',
      [a.userId, rcpt.user_id],
    );
    if (!shared) throw new HttpError(403, 'recipient is not reachable');
  }

  const { msg, created } = await tx(async (c, after) => {
    const r = await insertMessage(c, {
      type: b.type, sender: a.agentId!, recipient: b.recipient_agent_id, task_id: b.task_id,
      conversation_id: b.conversation_id, payload: b.payload, idempotency_key: key,
    });
    if (r.created) {
      await audit(c, a, 'message.create', 'message', r.msg.message_id, { type: b.type, task_id: b.task_id ?? null });
      after(() => publish([r.msg]));
    }
    return r;
  });
  res.status(created ? 201 : 200).json(msg);
}

messagesRouter.post('/messages', postMessage);

messagesRouter.get('/conversations', async (req, res) => {
  res.json(await q(
    `select distinct on (m.conversation_id) m.conversation_id, m.task_id, m.created_at as last_message_at,
            m.type as last_type, m.payload as last_payload,
            (select count(*)::int from messages x where x.conversation_id = m.conversation_id) as message_count
     from messages m where ${VISIBLE}
       and (m.task_id is not null or not exists (select 1 from agents ag where ag.deleted_at is not null and ag.id in (m.sender_agent_id, m.recipient_agent_id)))
     order by m.conversation_id, m.created_at desc`,
    visibleParams(req.actor),
  ));
});

messagesRouter.get('/messages', async (req, res) => {
  const f = z.object({
    conversation_id: z.string().max(200).optional(),
    task_id: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }).parse(req.query);
  const params: any[] = visibleParams(req.actor);
  let where = VISIBLE;
  if (f.conversation_id) { params.push(f.conversation_id); where += ` and m.conversation_id = $${params.length}`; }
  if (f.task_id) { params.push(f.task_id); where += ` and m.task_id = $${params.length}`; }
  params.push(f.limit);
  const rows = await q(`select m.* from messages m where ${where} order by m.created_at desc limit $${params.length}`, params);
  res.json(rows.reverse().map((m) => (m.payload?.code ? { ...m, payload: { ...m.payload, code: '' } } : m)));
});


// ---- Chat image attachments ----
const perUser = (limit: number) => rateLimit({
  windowMs: 60_000, limit, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req: any) => req.actor?.userId ?? 'anon',
  message: { error: 'rate limit exceeded' },
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1, fields: 5, parts: 6 } });

messagesRouter.post('/messages/attachments', perUser(config.uploadRateMax), (req, res, next) => {
  if (req.actor.kind !== 'user') throw new HttpError(403, 'agent tokens cannot upload');
  upload.single('file')(req, res, (err: any) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, 'file too large (max 5 MB)'));
    if (err) return next(new HttpError(400, 'invalid upload'));
    if (!req.file) return next(new HttpError(400, 'multipart field "file" is required'));
    saveAttachment(req.actor.userId, req.file.originalname ?? '', req.file.buffer).then(async (r) => {
      await audit(pool, req.actor, 'attachment.create', 'attachment', r.attachment_id, { mime: r.mime, size: r.size });
      res.status(201).json(r);
    }, next);
  });
});

messagesRouter.get('/attachments/:id', perUser(300), async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  const a = id.success ? await readableAttachment(id.data, req.actor) : null;
  if (!a || req.actor.kind !== 'user') throw new HttpError(404, 'attachment not found');
  res.setHeader('Content-Type', a.mime);
  res.setHeader('Content-Length', String(a.size));
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const stream = fs.createReadStream(uploadPath(a.id));
  stream.on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'attachment not found' }); else res.destroy(); });
  stream.pipe(res);
});

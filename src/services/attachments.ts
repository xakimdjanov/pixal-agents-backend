import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { q, q1 } from '../db.js';
import { HttpError } from '../errors.js';

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENTS = 4;
export const uploadsDir = () => path.join(config.dataDir, 'uploads');
export const uploadPath = (id: string) => path.join(uploadsDir(), id);

// The declared mimetype is never trusted: the type comes from the file's leading bytes.
export function sniffImage(b: Buffer): { mime: string; ext: string } | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return { mime: 'image/gif', ext: 'gif' };
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

export async function saveAttachment(ownerUserId: string, originalName: string, data: Buffer) {
  const kind = sniffImage(data);
  if (!kind) throw new HttpError(415, 'only png, jpeg, gif or webp images are allowed');
  const id = crypto.randomUUID();
  const name = (path.basename(originalName.replace(/\\/g, '/')).replace(/[^\w.\- ]+/g, '_').slice(0, 100)) || `image.${kind.ext}`;
  fs.mkdirSync(uploadsDir(), { recursive: true, mode: 0o700 });
  fs.chmodSync(uploadsDir(), 0o700);
  fs.writeFileSync(uploadPath(id), data, { mode: 0o600 });
  try {
    await q('insert into attachments (id, owner_user_id, name, mime, size) values ($1,$2,$3,$4,$5)', [id, ownerUserId, name, kind.mime, data.length]);
  } catch (e) { fs.rmSync(uploadPath(id), { force: true }); throw e; }
  return { attachment_id: id, name, mime: kind.mime, size: data.length };
}

// Every id must exist and belong to the caller (404 otherwise, so other users' ids are not revealed).
export async function assertOwnedAttachments(userId: string, ids: string[]) {
  if (!ids.length) return;
  const rows = await q('select id from attachments where id = any($1::uuid[]) and owner_user_id = $2', [ids, userId]);
  if (rows.length !== new Set(ids).size) throw new HttpError(404, 'attachment not found');
}

// Readable by the uploader, a founder, or the user whose agent received a message that carries it.
export async function readableAttachment(id: string, actor: { userId: string; role: string }) {
  const a = await q1('select * from attachments where id = $1', [id]);
  if (!a) return null;
  if (a.owner_user_id === actor.userId || actor.role === 'founder') return a;
  const recv = await q1(
    `select 1 from messages m join agents ag on ag.id = m.recipient_agent_id
     where ag.user_id = $2 and m.payload->'attachments' ? $1 limit 1`, [id, actor.userId]);
  return recv ? a : null;
}

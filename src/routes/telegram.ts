import { Router } from 'express';
import { authenticate } from '../auth.js';
import { pool, q, q1 } from '../db.js';
import { HttpError } from '../errors.js';
import { audit } from '../services/audit.js';
import { createLinkCode, telegramEnabled } from '../services/telegram.js';

export const telegramRouter = Router();
telegramRouter.use('/telegram', authenticate, (req, _res, next) => {
  if (req.actor.kind !== 'user') throw new HttpError(403, 'agent tokens cannot use this endpoint');
  next();
});

telegramRouter.get('/telegram', async (req, res) => {
  const l = await q1('select username, created_at from telegram_links where user_id = $1', [req.actor.userId]);
  res.json({ enabled: telegramEnabled(), linked: !!l, username: l?.username ?? '', linked_at: l?.created_at ?? null });
});

telegramRouter.post('/telegram/link', async (req, res) => {
  if (!telegramEnabled()) throw new HttpError(503, 'Telegram bot is not configured (TELEGRAM_BOT_TOKEN)');
  res.json(createLinkCode(req.actor.userId));
});

telegramRouter.delete('/telegram', async (req, res) => {
  await q('delete from telegram_links where user_id = $1', [req.actor.userId]);
  await audit(pool, req.actor, 'telegram.unlink', 'user', req.actor.userId, {});
  res.json({ linked: false });
});

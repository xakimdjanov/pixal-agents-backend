import { createServer } from './app.js';
import { pool } from './db.js';
import { log } from './log.js';
import { ensureFounder } from './bootstrap.js';
import { migrate } from './migrate.js';

await migrate();
await ensureFounder();
const s = createServer();
const port = await s.start();
log('info', `server listening on :${port}`);

const shutdown = async () => {
  await s.stop();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

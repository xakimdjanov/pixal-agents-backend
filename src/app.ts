import http from 'node:http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Server } from 'socket.io';
import { config } from './config.js';
import { pool } from './db.js';
import { errorHandler } from './errors.js';
import { attachSockets, closeSockets } from './events.js';
import { log } from './log.js';
import { agentApi, agentsRouter, auditRouter } from './routes/agents.js';
import { authRouter } from './routes/auth.js';
import { connectorsRouter } from './routes/connectors.js';
import { messagesRouter } from './routes/messages.js';
import { projectsRouter } from './routes/projects.js';
import { tasksRouter } from './routes/tasks.js';
import { studioMcpRouter } from './agents/studioMcp.js';
import { startAgents } from './agents/manager.js';
import { startQueue } from './services/queue.js';

const VERCEL_PREVIEW = /^https:\/\/[a-z0-9][a-z0-9-]*\.vercel\.app$/i;
export function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser / same-origin requests carry no Origin
  return config.corsOrigins.includes(origin) || (config.corsAllowVercelPreviews && VERCEL_PREVIEW.test(origin));
}
// Unknown origins just get no CORS headers (the browser blocks them); never an error.
const corsOrigin = (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => cb(null, originAllowed(origin));

export function createServer() {
  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: corsOrigin, credentials: false, methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'], maxAge: 600 }));
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    res.on('finish', () => log('info', `${req.method} ${req.path.startsWith('/internal/') ? '/internal/*' : req.path} ${res.statusCode}`)); // path only: no query, headers or body; internal paths carry run tokens
    next();
  });

  app.get('/api/health', async (_req, res) => {
    try {
      await pool.query('select 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  app.use(studioMcpRouter);

  const api = express.Router();
  api.use(rateLimit({ windowMs: 60_000, limit: config.rateMax, standardHeaders: true, legacyHeaders: false, message: { error: 'rate limit exceeded' } }));
  api.use(authRouter, projectsRouter, agentsRouter, agentApi, tasksRouter, messagesRouter, auditRouter, connectorsRouter);
  api.use((_req, res) => void res.status(404).json({ error: 'not found' }));
  app.use('/api', api);
  app.use(errorHandler);

  const server = http.createServer(app);
  const io = new Server(server, { serveClient: false, cors: { origin: corsOrigin, credentials: false } });
  attachSockets(io);

  let stopQueue = () => {};
  let stopAgents: () => Promise<void> = async () => {};
  return {
    app,
    server,
    start: (port = config.port) =>
      new Promise<number>((resolve) => {
        stopQueue = startQueue();
        server.listen(port, () => {
          resolve((server.address() as any).port);
          void startAgents().then((stop) => { stopAgents = stop; }).catch((e) => log('error', `agents failed to start: ${e.message}`));
        });
      }),
    stop: async () => {
      stopQueue();
      await stopAgents();
      closeSockets();
      await new Promise((r) => server.close(r));
    },
  };
}

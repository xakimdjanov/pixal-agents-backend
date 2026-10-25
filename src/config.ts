import path from 'node:path';

const env = process.env;
const prod = env.NODE_ENV === 'production';

if (prod && (env.JWT_SECRET ?? '').length < 32) {
  throw new Error('JWT_SECRET must be set (>=32 chars) in production');
}

// 32-byte AES key as 64 hex chars or base64. Required in production; dev falls back to a fixed key.
const parseKey = (v: string): Buffer | null => {
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, 'hex');
  const b = Buffer.from(v, 'base64');
  return b.length === 32 ? b : null;
};
const connectorKey = env.CONNECTOR_KEY ? parseKey(env.CONNECTOR_KEY) : null;
if ((prod || env.CONNECTOR_KEY) && !connectorKey) {
  throw new Error('CONNECTOR_KEY must be 32 bytes as 64 hex chars or base64 (e.g. `openssl rand -hex 32`)');
}

export const config = {
  connectorKey: connectorKey ?? Buffer.alloc(32, 'dev-only-connector-key'),
  prod,
  port: Number(env.PORT ?? 3000),
  databaseUrl: env.DATABASE_URL ?? 'postgres://studio:studio@127.0.0.1:5432/studio',
  jwtSecret: env.JWT_SECRET ?? 'dev-only-secret-change-me-dev-only-secret',
  jwtTtl: env.JWT_TTL ?? '12h',
  logDir: env.LOG_DIR ?? '',
  // Browser origins allowed to call the API cross-origin (exact match). Empty = same-origin only.
  corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean),
  corsAllowVercelPreviews: env.CORS_ALLOW_VERCEL_PREVIEWS === '1',
  trustProxy: env.TRUST_PROXY === '1',
  rateMax: Number(env.RATE_LIMIT_MAX ?? 600),
  uploadRateMax: Number(env.UPLOAD_RATE_MAX ?? 20),
  loginRateMax: Number(env.LOGIN_RATE_MAX ?? 20),
  dataDir: path.resolve(env.DATA_DIR ?? './data'),
  claudeBin: env.CLAUDE_BIN ?? 'claude',
  // Test-only simulator of the Claude CLI; can never be enabled in production.
  mockClaude: !prod && env.MOCK_CLAUDE === '1',
  defaultFounderPassword: env.DEFAULT_FOUNDER_PASSWORD || 'visitca',
  heartbeatMs: Number(env.HEARTBEAT_MS ?? 15_000),
  pollMs: Number(env.POLL_MS ?? 5_000),
  claudeStatusMs: Number(env.CLAUDE_STATUS_MS ?? 300_000),
  taskTimeoutMs: Number(env.TASK_TIMEOUT_MS ?? 30 * 60_000),
  staleAfterMs: Number(env.STALE_AFTER_MS ?? 24 * 3_600_000),
  offlineAfterSec: Number(env.AGENT_OFFLINE_AFTER_SEC ?? 45),
};

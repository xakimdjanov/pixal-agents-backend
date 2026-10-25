import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { io as connect } from 'socket.io-client';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://studio@127.0.0.1:55432/studio_test';
const PORT = 3916;
const BASE = `http://127.0.0.1:${PORT}`;
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-cors-'));
const ALLOWED = 'https://pixa-agents-front.vercel.app';
const PREVIEW = 'https://pixa-agents-front-git-x-team.vercel.app';
const procs: ChildProcess[] = [];

before(async () => {
  process.env.DATABASE_URL = DB;
  const { pool } = await import('../src/db.js');
  await pool.query('drop schema public cascade; create schema public;');
  await (await import('../src/migrate.js')).migrate();
  await pool.end();
  const p = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: process.cwd(), stdio: 'ignore', detached: true,
    env: { ...process.env, DATABASE_URL: DB, PORT: String(PORT), MOCK_CLAUDE: '1', DATA_DIR: WORKDIR, CORS_ORIGINS: `${ALLOWED}/, https://app.visitca-trip.uz`, CORS_ALLOW_VERCEL_PREVIEWS: '1' },
  });
  procs.push(p);
  for (let i = 0; i < 400; i++) {
    if ((await fetch(`${BASE}/api/health`).catch(() => null))?.ok) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('server did not start');
});
after(() => {
  for (const p of procs) try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* gone */ }
  fs.rmSync(WORKDIR, { recursive: true, force: true });
});

const preflight = (origin: string) => fetch(`${BASE}/api/messages`, {
  method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'PATCH', 'access-control-request-headers': 'authorization,content-type,idempotency-key' },
});

describe('CORS', () => {
  it('answers preflight for allowed origins', async () => {
    for (const o of [ALLOWED, 'https://app.visitca-trip.uz', PREVIEW]) {
      const r = await preflight(o);
      assert.equal(r.status, 204);
      assert.equal(r.headers.get('access-control-allow-origin'), o);
      assert.match(r.headers.get('access-control-allow-methods')!, /PATCH/);
      assert.match(r.headers.get('access-control-allow-headers')!.toLowerCase(), /idempotency-key/);
      assert.equal(r.headers.get('access-control-max-age'), '600');
      assert.equal(r.headers.get('access-control-allow-credentials'), null);
    }
  });
  it('gives no CORS headers to unknown origins and does not crash', async () => {
    for (const o of ['https://evil.example', 'https://evil.vercel.app.evil.example', 'http://pixa-agents-front.vercel.app']) {
      const r = await preflight(o);
      assert.equal(r.headers.get('access-control-allow-origin'), null);
    }
    assert.equal((await fetch(`${BASE}/api/health`, { headers: { origin: 'https://evil.example' } })).headers.get('access-control-allow-origin'), null);
    assert.equal((await fetch(`${BASE}/api/health`)).status, 200);
  });
  it('allows cross-origin reads (CORP) and CORS on simple requests', async () => {
    const r = await fetch(`${BASE}/api/health`, { headers: { origin: ALLOWED } });
    assert.equal(r.headers.get('access-control-allow-origin'), ALLOWED);
    assert.equal(r.headers.get('cross-origin-resource-policy'), 'cross-origin');
  });
  it('socket.io handshake: allowed origin gets CORS headers, unknown does not', async () => {
    const poll = (o: string) => fetch(`${BASE}/socket.io/?EIO=4&transport=polling`, { headers: { origin: o } });
    assert.equal((await poll(ALLOWED)).headers.get('access-control-allow-origin'), ALLOWED);
    assert.equal((await poll('https://evil.example')).headers.get('access-control-allow-origin'), null);
    const s = connect(BASE, { transports: ['websocket'], extraHeaders: { origin: ALLOWED }, reconnection: false });
    const err = await new Promise<Error | null>((res) => { s.on('connect', () => res(null)); s.on('connect_error', res); });
    s.close();
    assert.ok(err === null || /auth|token|unauthor/i.test(err.message), `unexpected: ${err?.message}`); // reaching the auth layer proves the handshake passed
  });
});

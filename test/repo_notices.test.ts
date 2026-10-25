import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { clearRepoFailures, collectNotices, NOTICE_HINT, prepareReadRepos, RepoAccessError } from '../src/agents/git.js';

test('collectNotices dedupes by repo and adds the hint only for needs_credentials', () => {
  const url = 'https://github.com/o/r';
  const a = collectNotices([
    { repo: 'P/main', ref: { name: 'main', dir: '/x', url, reason: 'needs_credentials', message: 'needs credentials' } },
    { repo: 'P/main', ref: { name: 'main', dir: '/x', url, reason: 'needs_credentials', message: 'needs credentials' } },
    { repo: 'P/api', ref: { name: 'api', dir: '/y', url, reason: 'not_found', message: 'nope' } },
    { repo: 'P/ok', ref: { name: 'ok', dir: '/z' } },
  ]);
  assert.equal(a.notices.length, 2);
  assert.deepEqual(a.notices[0], { kind: 'repo_access', repo: 'P/main', url, reason: 'needs_credentials', message: 'needs credentials' });
  assert.equal(a.notice_hint, NOTICE_HINT);
  const b = collectNotices([{ repo: 'P/api', ref: { name: 'api', dir: '/y', url, reason: 'other', message: 'x' } }]);
  assert.equal(b.notice_hint, undefined);
  assert.deepEqual(collectNotices([]), { notices: [] });
});

test('a failing clone is reported once structurally and not retried within the TTL', async () => {
  clearRepoFailures();
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-'));
  (config as any).dataDir = wd;
  const main = { url: 'https://127.0.0.1:1/o/r.git', branch: 'main' };
  const first = await prepareReadRepos('agent-n', 'proj-n', main, []);
  assert.equal(first[0].reason, 'other');
  assert.equal(first[0].url, main.url);
  // Make a retry observable: if it re-ran git it would recreate the parent dir we remove here.
  const reposDir = path.join(wd, 'work', 'agent-n', 'repos');
  fs.rmSync(reposDir, { recursive: true, force: true });
  const second = await prepareReadRepos('agent-n', 'proj-n', main, []);
  assert.equal(second[0].reason, 'other');
  assert.equal(second[0].message, first[0].message);
  assert.equal(fs.existsSync(reposDir), false, 'cached failure must not retry the clone');
  fs.rmSync(wd, { recursive: true, force: true });
});

test('RepoAccessError carries the git detail', () => {
  assert.equal(new RepoAccessError('https://github.com/o/r', true, 'Repository not found').detail, 'Repository not found');
});

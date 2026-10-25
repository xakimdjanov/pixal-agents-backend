import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { canAuth, RepoAccessError, withAskpass } from '../src/agents/git.js';

const TOKEN = 'ghp_testtoken1234567890';

describe('git askpass auth (no network)', () => {
  it('supplies the token through a 0700 helper that is deleted afterwards; token is not in the script', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-auth-'));
    execFileSync('git', ['init', '-q', repo]);
    let script = '';
    const out = await withAskpass('t', async (env) => {
      script = env.GIT_ASKPASS;
      assert.equal(fs.statSync(script).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.dirname(script)).mode & 0o777, 0o700);
      assert.ok(!fs.readFileSync(script, 'utf8').includes(TOKEN));
      // git itself asks the helper for the credentials, exactly as it would for a clone/fetch
      return execFileSync('git', ['credential', 'fill'], {
        cwd: repo, input: 'protocol=https\nhost=github.com\n\n',
        env: { PATH: process.env.PATH!, HOME: repo, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_ASKPASS: script, STUDIO_GIT_TOKEN: TOKEN },
      }).toString();
    });
    assert.match(out, /username=x-access-token/);
    assert.match(out, new RegExp(`password=${TOKEN}`));
    assert.ok(!fs.existsSync(script) && !fs.existsSync(path.dirname(script)), 'helper removed');
    assert.ok(!fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8').includes(TOKEN));
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('only authenticates https github.com URLs', () => {
    assert.ok(canAuth('https://github.com/o/r'));
    assert.ok(!canAuth('git@github.com:o/r.git'));
    assert.ok(!canAuth('ssh://git@github.com/o/r'));
    assert.ok(!canAuth('https://evil.example.com/o/r'));
  });

  it('BLOCKED note text for a private repo without credentials', () => {
    const url = 'https://github.com/xakimdjanov/pixal-agents-backend';
    assert.equal(new RepoAccessError(url, false).message,
      `Cannot access repository ${url}: it needs credentials. Add a GitHub connector (Connectors → GitHub token) for this project, then move the task back to PENDING.`);
    assert.match(new RepoAccessError(url, true).message, /token was rejected/);
  });
});

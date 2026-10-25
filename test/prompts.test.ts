import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import * as prompts from '../src/agents/prompts.js';
import { NO_ATLASSIAN_PROMPT, STYLE_PROMPT } from '../src/agents/prompts.js';

describe('chat prompt pieces', () => {
  it('style rules and the missing-Atlassian hint are present', () => {
    assert.match(STYLE_PROMPT, /same language/);
    assert.match(STYLE_PROMPT, /In Progress/);
    assert.match(STYLE_PROMPT, /currentUser\(\)/);
    assert.match(STYLE_PROMPT, /KEY — title — status — latest comment/);
    assert.match(STYLE_PROMPT, /Never say you cannot access/);
    assert.match(NO_ATLASSIAN_PROMPT, /settings → Connectors → Atlassian/);
  });
  it('privacy/membership restrictions are gone from runner and prompts', () => {
    assert.deepEqual(Object.keys(prompts).sort(), ['NO_ATLASSIAN_PROMPT', 'STYLE_PROMPT']);
    const src = fs.readFileSync(new URL('../src/agents/runner.ts', import.meta.url), 'utf8') + fs.readFileSync(new URL('../src/agents/prompts.ts', import.meta.url), 'utf8');
    for (const re of [/not a member of it/, /asker_project_ids/, /deniedProjects/, /only shared with my owner/, /may be shared with this asker/]) assert.doesNotMatch(src, re);
  });
});

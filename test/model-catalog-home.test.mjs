import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readModelCatalog } from '../src/model-catalog.ts';

test('the Codex model catalog is found in the home folder on macOS and Linux', { skip: process.platform === 'win32' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'amadeus-catalog-home-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME };
  try {
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'models_cache.json'), JSON.stringify({ fetched_at: 'fixture', models: [
      { slug: 'gpt-frontier', priority: 0, visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }] },
    ] }));
    process.env.HOME = home;
    delete process.env.USERPROFILE;
    delete process.env.CODEX_HOME;
    assert.deepEqual(readModelCatalog().models.map((model) => model.slug), ['gpt-frontier']);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

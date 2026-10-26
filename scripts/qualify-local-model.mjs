#!/usr/bin/env node
// Qualify the owner's local model before Amadeus routes work to it.
// Usage: node scripts/qualify-local-model.mjs --endpoint http://127.0.0.1:18000/v1 --model <id> [--effort xhigh] [--state <Amadeus home>]
import { parseArgs } from 'node:util';
import { mkdirSync } from 'node:fs';
import { qualifyLocalModel } from '../src/local-model.ts';
import { resolveCodexExecutable } from '../src/codex-adapter.ts';
import { dirname } from 'node:path';
import { defaultDatabasePath } from '../src/coordinator-types.ts';

const { values } = parseArgs({ options: { endpoint: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, state: { type: 'string' } } });
if (!values.endpoint || !values.model) throw new Error('--endpoint and --model are required');
const stateRoot = values.state ?? dirname(defaultDatabasePath());
mkdirSync(stateRoot, { recursive: true });
const record = qualifyLocalModel({ setting: { endpoint: values.endpoint, model: values.model, reasoningEffort: values.effort },
  stateRoot, codex: resolveCodexExecutable() });
console.log(JSON.stringify(record, null, 2));
process.exitCode = record.passed ? 0 : 1;

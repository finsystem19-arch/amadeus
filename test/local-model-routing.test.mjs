import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { providersToAvoidForRetryChain, selectWorkRoute } from '../src/work-routing.ts';
import { localModelProviderArguments, loopbackModelEndpoint } from '../src/codex-adapter.ts';
import { qualificationPath, qualifiedLocalModel } from '../src/local-model.ts';

const catalog = { fetchedAt: 'fixture', models: [
  { slug: 'gpt-frontier', priority: 0, supportedEfforts: ['low', 'medium', 'high'] },
  { slug: 'gpt-workhorse', priority: 1, supportedEfforts: ['low', 'medium', 'high'] },
  { slug: 'gpt-efficient', priority: 2, supportedEfforts: ['low', 'medium'] },
] };
const LOCAL = 'local-openai-compatible';
const local = { providerId: LOCAL, model: 'local-27b', endpoint: 'http://127.0.0.1:18000/v1', routable: true, reasoningEffort: 'xhigh' };
const base = { cursorInstalled: false, catalog, localModelPilotGateOpen: true, qualifiedLocalModels: [local] };

test('local model endpoints must be on this computer', () => {
  for (const ok of ['http://127.0.0.1:18000/v1', 'http://localhost:11434/v1/', 'http://[::1]:8000/v1']) {
    assert.doesNotThrow(() => loopbackModelEndpoint(ok), ok);
  }
  for (const bad of ['http://192.168.0.9:8000/v1', 'https://api.example.com/v1', 'http://user:pw@127.0.0.1/v1', 'file:///etc/passwd', 'not a url']) {
    assert.throws(() => loopbackModelEndpoint(bad), /loopback|URL/, bad);
  }
  assert.equal(loopbackModelEndpoint('http://localhost:11434/v1/'), 'http://localhost:11434/v1');
});

test('a local endpoint adds a Responses-API model provider to the Codex worker, and nothing otherwise', () => {
  assert.deepEqual(localModelProviderArguments(undefined), []);
  const args = localModelProviderArguments('http://127.0.0.1:18000/v1').join(' ');
  assert.match(args, /model_provider="amadeus_local"/);
  assert.match(args, /model_providers\.amadeus_local\.base_url="http:\/\/127\.0\.0\.1:18000\/v1"/);
  assert.match(args, /wire_api="responses"/);
  assert.throws(() => localModelProviderArguments('http://10.0.0.5:8000/v1'), /loopback/);
});

test('balanced routing (the default) keeps Max\'s rule: only lightweight steps go to the local model', () => {
  const light = selectWorkRoute({ ...base, objective: 'Summarise the README' });
  assert.equal(light.provider, LOCAL);
  assert.equal(light.reasoningEffort, 'xhigh');
  assert.equal(light.endpoint, local.endpoint);
  assert.equal(selectWorkRoute({ ...base, objective: 'Implement the helper function' }).model, 'gpt-efficient');
});

test('quality-first gives routine implementation to a qualified local model and the hardest work to the top tier', () => {
  const policy = { ...base, routingPolicy: 'quality-first' };
  assert.equal(selectWorkRoute({ ...policy, objective: 'Implement the helper function' }).provider, LOCAL);
  const complex = selectWorkRoute({ ...policy, objective: 'Find the root cause of the race condition' });
  assert.equal(complex.model, 'gpt-frontier');
  assert.equal(complex.reasoningEffort, 'high');
  assert.equal(complex.routingPolicy, 'quality-first');
  const noLocal = selectWorkRoute({ ...policy, localModelPilotGateOpen: false, objective: 'Implement the helper function' });
  assert.equal(noLocal.model, 'gpt-workhorse');
  assert.equal(noLocal.reasoningEffort, 'high');
});

test('a failed local attempt escalates to the strongest subscription tier instead of repeating', () => {
  const retry = selectWorkRoute({ ...base, routingPolicy: 'quality-first', avoidProviders: [LOCAL], objective: 'Implement the helper function' });
  assert.equal(retry.provider, 'codex-chatgpt-signin');
  assert.equal(retry.model, 'gpt-frontier');
  assert.equal(retry.taskClass, 'provider-fallback');
});

test('retry chains steer away from every model provider, including Grok and the local model', () => {
  const history = ['grok-subscription-signin', LOCAL, 'claude-subscription-signin'].map((provider) => ({ jobStatus: 'failed', retryAuthorized: true, provider }));
  assert.deepEqual(providersToAvoidForRetryChain(history).sort(), ['claude-subscription-signin', 'grok-subscription-signin', LOCAL].sort());
});

test('the local model is routable only when enabled, loopback, qualified for this exact model and recently', () => {
  const state = mkdtempSync(join(tmpdir(), 'amadeus-local-qualified-'));
  try {
    const setting = { enabled: true, endpoint: 'http://127.0.0.1:18000/v1', model: 'local-27b', reasoningEffort: 'xhigh' };
    assert.equal(qualifiedLocalModel(setting, state), null, 'no qualification yet');
    const record = { schemaVersion: 1, endpoint: 'http://127.0.0.1:18000/v1', model: 'local-27b', qualifiedAt: '2026-10-21T00:00:00Z', passed: true, tasks: [] };
    writeFileSync(qualificationPath(state), JSON.stringify(record));
    const now = new Date('2026-10-22T00:00:00Z');
    assert.deepEqual(qualifiedLocalModel(setting, state, now), { ...local, endpoint: 'http://127.0.0.1:18000/v1' });
    assert.equal(qualifiedLocalModel({ ...setting, enabled: false }, state, now), null, 'owner switched it off');
    assert.equal(qualifiedLocalModel({ ...setting, model: 'other' }, state, now), null, 'different model');
    assert.equal(qualifiedLocalModel({ ...setting, endpoint: 'http://192.168.0.9:8000/v1' }, state, now), null, 'not loopback');
    assert.equal(qualifiedLocalModel(setting, state, new Date('2026-11-30T00:00:00Z')), null, 'stale qualification');
    writeFileSync(qualificationPath(state), JSON.stringify({ ...record, passed: false }));
    assert.equal(qualifiedLocalModel(setting, state, now), null, 'failed qualification');
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

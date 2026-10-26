import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoveryPreview, runDiscovery, viewInventory, deleteInventory, windowsCollector, WINDOWS_QUERIES } from '../plugins/amadeus/scripts/capability-discovery.mjs';
import { defaultDiscoveryPaths, grantDiscoveryConsent, declineDiscoveryConsent, DISCOVERY_DISCLOSURE_VERSION } from '../plugins/amadeus/scripts/provider-discovery.mjs';
import { portableWorkerConfig } from '../src/portable-runtime.ts';
import { validateAcceptance } from '../src/portable-acceptance.mjs';
import { defaultSensitivePaths } from '../src/portable-runtime.ts';
import { buildCodexSandboxCommand, optionalModelArguments, projectFilesystemPolicy } from '../src/codex-adapter.ts';
import { resolveWorkerWorkspaceRoot } from '../src/worker-workspace-root.ts';
import { inspectCursorCli } from '../src/cursor-adapter.ts';
const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'amadeus-release-')); return { dir, stateRoot: join(dir, 'state') }; };

test('portable task bindings use known dependency fixtures and bundled isolation helpers, Cursor is optional', () => {
  const f = fixture(), source = join(f.dir, 'source'), executable = join(f.dir, 'bin/codex.exe');
  const worker = portableWorkerConfig({ executable: 'codex', assignedProjectRoot: null, readableProjectRoots: [], protectedPaths: [] }, source,
    { resolveExecutable: () => executable, exists: () => true });
  assert.equal(worker.executable, executable); assert.deepEqual(worker.readableProjectRoots, [source]);
  // Credentials, tool logins and personal folders are denied by default, but never the project itself.
  const home = join(f.dir, 'home');
  const sensitive = defaultSensitivePaths(home, join(home, 'Documents', 'work', 'app'), () => true);
  assert.ok(sensitive.includes(join(home, '.codex')) && sensitive.includes(join(home, '.ssh')));
  assert.ok(sensitive.includes(join(home, 'AppData', 'Roaming')));
  assert.equal(sensitive.includes(join(home, 'Documents')), false, 'a folder holding the project stays reachable');
  assert.ok(existsSync(worker.isolationAcceptanceHarness)); assert.ok(existsSync(worker.isolationSecurityStateProbe));
  assert.equal(inspectCursorCli({}).installed, false);
  assert.deepEqual(inspectCursorCli({ enabled: false, executable: 'node' }), {
    installed: false, modelInvoked: false, reason: 'Optional Cursor is disabled',
  });
  const incompleteCursor = inspectCursorCli({ enabled: true, executable: 'node' });
  assert.equal(incompleteCursor.installed, false);
  assert.equal(incompleteCursor.reason, 'Optional Cursor configuration is incomplete');
  assert.throws(() => portableWorkerConfig({}, source, { resolveExecutable: () => executable, exists: () => false }), /supported local Codex/);
  const probes = Object.fromEntries(['workspaceRead', 'sourceRead', 'sourceWriteDenied', 'parentReadDenied', 'evidenceReadDenied', 'protectedReadDenied', 'workspaceMetadataWriteDenied', 'sensitiveReadDenied'].map(key => [key, true]));
  assert.equal(validateAcceptance(probes).outsideWorkspaceReadsDenied, true);
  for (const key of Object.keys(probes)) assert.throws(() => validateAcceptance({ ...probes, [key]: false }), new RegExp(`${key}.*dispatch remains disabled`));
});

test('non-model Codex checks preserve the configured MXC isolation boundary', () => {
  assert.deepEqual(optionalModelArguments(null), []);
  assert.deepEqual(optionalModelArguments(''), []);
  assert.deepEqual(optionalModelArguments('gpt-6-sol'), ['-m', 'gpt-6-sol']);
  const args = buildCodexSandboxCommand(
    { permissionProfile: 'amadeus_task_worker', windowsSandbox: 'mxc' },
    'C:\\worker',
    'permissions.amadeus_task_worker={description="fixture"}',
    'C:\\Program Files\\nodejs\\node.exe',
    ['--version'],
  );
  assert.deepEqual(args.slice(0, 5), ['sandbox', '-C', 'C:\\worker', '-c', 'windows.sandbox="mxc"']);
  assert.throws(() => buildCodexSandboxCommand(
    { permissionProfile: 'amadeus_task_worker', windowsSandbox: 'elevated' },
    'C:\\worker',
    'permissions.amadeus_task_worker={description="fixture"}',
    'C:\\Program Files\\nodejs\\node.exe',
    ['--version'],
  ), /require the MXC Windows sandbox/);
});

test('project-scoped Codex policy satisfies the Windows root-read baseline without exposing protected evidence', { skip: process.platform !== 'win32' && 'Windows path rules' }, () => {
  const policy = projectFilesystemPolicy({
    assignedProjectRoot: 'C:\\Users\\Person\\Projects\\Example',
    readableProjectRoots: ['C:\\Users\\Person\\Projects\\Example'],
    deniedParentPaths: ['C:\\Users\\Person\\Projects'],
    protectedPaths: ['C:\\Users\\Person\\Projects\\Example\\.git'],
  }, 'C:\\Users\\Person\\AppData\\Local\\Amadeus\\workers\\task', ['.'], '"."="write"', true,
  'C:\\Users\\Person\\AppData\\Local\\Amadeus\\patches');
  assert.match(policy, /^":root"="read",":minimal"="read"/);
  assert.doesNotMatch(policy, /":root"="deny"/);
  assert.match(policy, /C:\\\\Users\\\\Person\\\\Projects"="deny"/);
  assert.match(policy, /C:\\\\Users\\\\Person\\\\AppData\\\\Local\\\\Amadeus\\\\patches"="deny"/);
  assert.match(policy, /C:\\\\Users\\\\Person\\\\Projects\\\\Example"="read"/);
  assert.match(policy, /C:\\\\Users\\\\Person\\\\Projects\\\\Example\\\\\.git"="deny"/);
  assert.match(policy, /C:\\\\Users\\\\Person\\\\AppData\\\\Local\\\\Amadeus\\\\workers\\\\task"="write"/);
});

test('Windows MXC workspaces are disposable siblings, not public source or durable private state', () => {
  const root = resolveWorkerWorkspaceRoot('C:\\Users\\Person\\Projects\\Example', 'C:\\Users\\Person\\AppData\\Local\\Amadeus', 'win32');
  assert.match(root.replaceAll('\\', '/'), /^C:\/Users\/Person\/Projects\/\.amadeus-worker-workspaces\/[a-f0-9]{16}$/i);
  assert.equal(root.toLowerCase().startsWith('C:\\Users\\Person\\Projects\\Example'.toLowerCase()), false);
  assert.equal(root.toLowerCase().startsWith('C:\\Users\\Person\\AppData\\Local\\Amadeus'.toLowerCase()), false);
});

test('clean plugin-only install: trusted hook context, setup, real backend status, no probes, no checkout', () => {
  const f = fixture(), pkg = join(f.dir, 'plugin'); cpSync(join(root, 'plugins/amadeus'), pkg, { recursive: true });
  const env = { ...process.env, AMADEUS_WORKER: '', AMADEUS_HOME: f.stateRoot, AMADEUS_CONFIG: join(f.dir, 'config.json'), AMADEUS_SETUP_ROOT: '', PATH: '' };
  const guard = join(f.dir, 'guard.mjs');
  writeFileSync(guard, `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
    for (const k of ['exec','execSync','execFile','execFileSync','spawn','spawnSync']) cp[k]=()=>{throw new Error('Probe forbidden')};
    syncBuiltinESMExports(); globalThis.fetch=()=>{throw new Error('Network forbidden')};`);
  const hook = () => spawnSync(process.execPath, ['--import', pathToFileURL(guard).href, join(pkg, 'hooks/session-start.mjs')], { env, encoding: 'utf8', timeout: 10000 });
  const first = hook(); assert.equal(first.status, 0, first.stderr);
  const context = JSON.parse(first.stdout).hookSpecificOutput;
  assert.equal(context.hookEventName, 'SessionStart');
  assert.match(context.additionalContext, /setup incomplete/);
  assert.match(context.additionalContext, /default coordinator/); assert.match(context.additionalContext, /simple conversation lightweight/); assert.match(context.additionalContext, /bypass/);
  assert.equal(existsSync(f.stateRoot), false);
  const isolated = spawnSync(process.execPath, ['--import', pathToFileURL(guard).href, join(pkg, 'hooks/session-start.mjs')], { env: { ...env, AMADEUS_WORKER: '1' }, encoding: 'utf8', timeout: 10000 });
  assert.match(JSON.parse(isolated.stdout).hookSpecificOutput.additionalContext, /Do not create goals/);
  assert.equal(existsSync(f.stateRoot), false);
  const messages = ['amadeus_setup', 'amadeus_onboarding_status', 'status'].map((name, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name, arguments: {} } }));
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(guard).href, join(pkg, 'scripts/server.mjs')], { env, encoding: 'utf8', input: messages.map(m => JSON.stringify(m)).join('\n') + '\n', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  const replies = child.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(replies[0].result.structuredContent.state, 'ready');
  assert.equal(replies[1].result.structuredContent.discoveryConsent, 'not-granted');
  assert.equal(replies[2].result.isError, undefined, JSON.stringify(replies[2]));
  assert.equal(existsSync(defaultDiscoveryPaths(f.stateRoot).lastScanPath), false);
  const database = readFileSync(join(f.stateRoot, 'coordinator.sqlite'));
  assert.match(JSON.parse(hook().stdout).hookSpecificOutput.additionalContext, /ready/);
  assert.deepEqual(readFileSync(join(f.stateRoot, 'coordinator.sqlite')), database);
  const workerConfig = join(f.stateRoot, 'runtime-config/worker-config.json');
  const prior = readFileSync(workerConfig, 'utf8');
  writeFileSync(workerConfig, '{malformed');
  assert.match(JSON.parse(hook().stdout).hookSpecificOutput.additionalContext, /setup incomplete/);
  writeFileSync(workerConfig, prior);
  rmSync(join(pkg, 'runtime/src/coordinator.ts'));
  assert.match(JSON.parse(hook().stdout).hookSpecificOutput.additionalContext, /unavailable/);
  assert.deepEqual(readFileSync(join(f.stateRoot, 'coordinator.sqlite')), database);
});

test('optional inventory rejects invalid, old, declined and wrong scope consent before collector invocation', async () => {
  const f = fixture(); let calls = 0;
  const collect = async () => { calls++; return {}; };
  assert.equal(discoveryPreview().startsCollection, false);
  await assert.rejects(runDiscovery({}, { stateRoot: f.stateRoot, collect }), /separate/);
  for (const consent of [null, {}, { discovery: true }, { discovery: true, disclosureVersion: DISCOVERY_DISCLOSURE_VERSION - 1 }, { discovery: false }]) {
    assert.equal((await runDiscovery({ requested: true }, { stateRoot: f.stateRoot, collect, readConsent: () => consent })).collected, false);
  }
  grantDiscoveryConsent(defaultDiscoveryPaths(f.stateRoot).consentPath, new Date(), ['local-providers']);
  assert.equal((await runDiscovery({ requested: true, categories: ['hardware'] }, { stateRoot: f.stateRoot, collect })).collected, false);
  assert.equal(calls, 0); assert.equal(viewInventory(f.stateRoot), null);
  assert.throws(() => discoveryPreview({ locations: ['\\\\server\\share'] }), /network/);
});

test('fixture-only inventory persists selected categories, stops on revocation, can be viewed and deleted', async () => {
  const f = fixture(), consentPath = defaultDiscoveryPaths(f.stateRoot).consentPath;
  grantDiscoveryConsent(consentPath);
  assert.equal(viewInventory(f.stateRoot), null);
  const report = await runDiscovery({ requested: true, categories: ['hardware'] }, { stateRoot: f.stateRoot, collect: async () => ({ cpu: 'fixture CPU' }) });
  assert.equal(report.collected, true); assert.equal(viewInventory(f.stateRoot).categories.hardware.cpu, 'fixture CPU');
  deleteInventory(f.stateRoot); assert.equal(viewInventory(f.stateRoot), null);
  let calls = 0;
  const revoked = await runDiscovery({ requested: true }, { stateRoot: f.stateRoot, collect: async () => { calls++; declineDiscoveryConsent(consentPath); return {}; } });
  assert.equal(revoked.collected, false); assert.equal(calls, 1); assert.equal(viewInventory(f.stateRoot), null);
});

test('Windows collectors use selected fixture fields and fixed queries, never run discovered applications', async () => {
  const data = { cpu: [{ Name: 'Fixture CPU', NumberOfCores: 8, SerialNumber: 'excluded' }], gpu: [{ Name: 'Fixture GPU', PNPDeviceID: 'excluded' }], memory: [{ TotalPhysicalMemory: 16000 }], os: [{ Caption: 'Fixture OS', SerialNumber: 'excluded' }] };
  const output = await windowsCollector('hardware', { locations: [], signal: new AbortController().signal }, { platform: 'win32', query: async query => { assert.equal(query, WINDOWS_QUERIES.hardware); return data; } });
  assert.doesNotMatch(JSON.stringify(output), /excluded|SerialNumber|PNPDeviceID/);
  const software = await windowsCollector('development-tools', { locations: [join(tmpdir(), 'fixture-tools')], signal: new AbortController().signal }, { platform: 'win32', localDrive: () => true, query: async () => [{ DisplayName: 'Fixture Python', DisplayVersion: '1.0', InstallLocation: 'excluded' }], exists: () => true });
  assert.doesNotMatch(JSON.stringify(software), /excluded/); assert.equal(software.knownLocations[0].available, true);
  const remote = await windowsCollector('development-tools', { locations: ['Z:\\mapped-share'], signal: new AbortController().signal }, { platform: 'win32', query: async () => ({ software: [], fixedDrives: ['C:'] }), exists: () => { throw new Error('Network path touched'); } });
  assert.equal(remote.skippedNonlocalLocations, 1);
});

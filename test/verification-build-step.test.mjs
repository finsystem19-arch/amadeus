import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeWorkspace } from '../src/worker-isolation.ts';
import { captureWorkerPatch } from '../src/worker-patch.ts';
import { DeterministicVerifier } from '../src/deterministic-verifier.ts';
import { readBuildStep, verificationCheckKind } from '../src/verification-checks.mjs';
import { verificationDepth } from '../plugins/amadeus/scripts/completion-report.mjs';
import { NEEDS_WORKER_WORKSPACE } from './helpers/scratch.mjs';

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

/** An authoritative project declaring a build step, and a worker workspace with one source edit. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-build-step-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'src.txt'), 'one\n');
  writeJson(join(project, 'package.json'), { scripts: { 'build:gen': 'node gen.mjs' } });
  writeJson(join(project, '.amadeus', 'verify.json'), { schemaVersion: 1, build: 'build:gen', checks: [] });
  const bytes = readFileSync(join(project, 'src.txt'));
  const manifest = join(root, 'manifest.json');
  writeJson(manifest, { schemaVersion: 1, source: { projectRoot: project, baseRevision: 'test' },
    files: [{ path: 'src.txt', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] });
  const { workspace } = materializeWorkspace({ manifestPath: manifest, workspaceRoot: join(root, 'ws'), workspaceId: 'w1' });
  writeFileSync(join(workspace, 'src.txt'), 'two\n');
  const artifactRoot = join(root, 'artifacts');
  const patch = captureWorkerPatch(workspace, ['.'], artifactRoot, 'w1');
  const config = join(root, 'worker-config.json');
  writeJson(config, { executable: 'codex', model: null, reasoningEffort: 'low', windowsSandbox: 'mxc',
    permissionProfile: 'amadeus_task_worker', approvalPolicy: 'never', deniedSourceRoot: project, writableWorkspacePaths: ['.'] });
  const verifier = (execute) => new DeterministicVerifier({ config, artifactRoot, runtimeHomeRoot: join(root, 'rt'), projectRoot: project }, execute);
  return { project, workspace, patch, verifier };
}

const context = { jobId: 'job', attempt: 1, objective: 'o', reservedCredits: 0, goalId: null, goalIteration: null,
  signal: new AbortController().signal, heartbeat() {} };
const ok = { exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '' };

test('the declared build step runs first and its generated files join the applied patch', { skip: NEEDS_WORKER_WORKSPACE }, async (t) => {
  const { workspace, patch, verifier } = fixture(t);
  const ran = [];
  const receipt = await verifier(async (_executable, args) => {
    const line = args.join(' ');
    ran.push(line.includes('build:gen') ? 'build' : 'check');
    if (line.includes('build:gen')) writeFileSync(join(workspace, 'generated.txt'), 'two\n');
    return ok;
  }).verify({ outcome: 'done', patch, workspacePath: workspace }, context);
  assert.equal(ran[0], 'build');
  assert.equal(receipt.passed, true);
  assert.deepEqual(receipt.checks.map((check) => check.kind), ['build', 'integrity']);
  assert.equal(receipt.projectTestsRan, false, 'a build alone tests nothing');
  assert.ok(receipt.patch, 'the patch is re-captured after the build');
  assert.deepEqual(receipt.patch.changedPaths, ['generated.txt', 'src.txt']);
  assert.match(readFileSync(receipt.patch.path, 'utf8'), /generated\.txt/);
  assert.match(receipt.summary, /^Integrity check only/);
});

test('a failing build step blocks the patch before any other check', { skip: NEEDS_WORKER_WORKSPACE }, async (t) => {
  const { workspace, patch, verifier } = fixture(t);
  const receipt = await verifier(async (_executable, args) => args.join(' ').includes('build:gen')
    ? { ...ok, exitCode: 1, stderr: 'boom' } : ok).verify({ outcome: 'done', patch, workspacePath: workspace }, context);
  assert.equal(receipt.passed, false);
  assert.deepEqual(receipt.checks.map((check) => [check.kind, check.passed]), [['build', false]]);
  assert.equal(receipt.patch, undefined);
  assert.match(receipt.summary, /npm run build:gen failed/);
});

test('the build step is read from the authoritative project, never the patched copy', { skip: NEEDS_WORKER_WORKSPACE }, (t) => {
  const { project, workspace } = fixture(t);
  writeJson(join(workspace, '.amadeus', 'verify.json'), { schemaVersion: 1, build: 'evil', checks: [] });
  writeJson(join(workspace, 'package.json'), { scripts: { 'build:gen': 'node evil.mjs', evil: 'node evil.mjs' } });
  const step = readBuildStep(project, workspace);
  assert.equal(step.kind, 'build');
  assert.equal(step.command, 'npm run build:gen');
  assert.equal(readBuildStep(workspace, workspace).command, 'npm run evil', 'only when the workspace is the policy root');
  writeJson(join(project, '.amadeus', 'verify.json'), { schemaVersion: 1, build: 'missing', checks: [] });
  assert.throws(() => readBuildStep(project, workspace), /not a script in package\.json/);
  writeJson(join(project, '.amadeus', 'verify.json'), { schemaVersion: 1, build: 'a b', checks: [] });
  assert.throws(() => readBuildStep(project, workspace), /name of an npm script/);
  rmSync(join(project, '.amadeus'), { recursive: true });
  assert.equal(readBuildStep(project, workspace), null);
});

test('a build step never counts as a project test', () => {
  assert.equal(verificationCheckKind({ kind: 'build', command: 'npm run build' }), 'build');
  assert.equal(verificationDepth([{ kind: 'build', command: 'npm run build' }, { kind: 'integrity', command: 'git diff --check' }]).status, 'partial');
});

test('this repository declares its sandboxed package build', () => {
  const step = readBuildStep(process.cwd(), process.cwd());
  assert.equal(step.command, `${process.platform === 'win32' ? 'powershell pipe' : 'node run'} scripts/run-package-build-sandbox.mjs`);
});

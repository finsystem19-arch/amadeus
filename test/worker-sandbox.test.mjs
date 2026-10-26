import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertWorkspaceOutsideProject, developmentFilesystemPolicy, normalizeProjectScope, normalizeWritableWorkspacePaths,
  workspacePermissionEntries, writableParentChain } from '../src/worker-sandbox.ts';
import { PROCESS_PLUMBING_VARIABLES, processPlumbingEnvironment } from '../src/worker-environment.ts';

test('writable paths: the strictest rules apply to every worker', () => {
  assert.deepEqual(normalizeWritableWorkspacePaths(undefined), []);
  assert.throws(() => normalizeWritableWorkspacePaths(undefined, { required: true }), /must be an array/);
  assert.deepEqual(normalizeWritableWorkspacePaths(['.', 'docs/guide']), ['.', 'docs/guide']);
  for (const unsafe of ['.git/hooks', '.amadeus-runtime/x', '.worker-isolation.json', '../outside', 'a/../b', 'C:/x', '/abs', 'back\\slash']) {
    assert.throws(() => normalizeWritableWorkspacePaths([unsafe]), /writable path/, unsafe);
  }
  assert.throws(() => normalizeWritableWorkspacePaths(['Docs', 'docs']), /Duplicate/, 'duplicates differ only by case');
});

test('denied paths have an explicit meaning: folders above the project, or private folders outside it', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projects = join(root, 'Projects');
  const project = join(projects, 'app');
  mkdirSync(join(project, '.git'), { recursive: true });
  const base = { assignedProjectRoot: project, readableProjectRoots: [project], protectedPaths: [join(project, '.git')] };
  assert.ok(normalizeProjectScope({ ...base, deniedParentPaths: [projects] }, { label: 'Test', deniedPaths: 'ancestors' }));
  assert.throws(() => normalizeProjectScope({ ...base, deniedParentPaths: [join(root, '.ssh')] }, { label: 'Test', deniedPaths: 'ancestors' }), /ancestors/);
  assert.ok(normalizeProjectScope({ ...base, deniedParentPaths: [join(root, '.ssh')] }, { label: 'Test', deniedPaths: 'outside-projects' }));
  assert.throws(() => normalizeProjectScope({ ...base, deniedParentPaths: [projects] }, { label: 'Test', deniedPaths: 'outside-projects' }),
    /must not contain readable account roots/, 'a private-folder deny may never hide the project');
  assert.equal(normalizeProjectScope({}, { label: 'Test', deniedPaths: 'ancestors' }), null);
});

test('a workspace may not sit inside the project, in either slash style, nor write outside itself', (t) => {
  assert.throws(() => assertWorkspaceOutsideProject('C:\\Projects\\app\\ws', 'C:\\Projects\\app', 'inside'), /inside/);
  assert.throws(() => assertWorkspaceOutsideProject('C:/Projects/app/ws', 'C:/Projects/app', 'inside'), /inside/);
  assert.doesNotThrow(() => assertWorkspaceOutsideProject('C:\\work\\ws', 'C:\\Projects\\app', 'inside'));
  const root = mkdtempSync(join(tmpdir(), 'amadeus-chain-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs'), { recursive: true });
  assert.deepEqual(writableParentChain(root, ['docs/new.md']).length, 2);
  assert.throws(() => writableParentChain(root, ['missing/deeper/file.md']), /must be materialized/);
});

test('the development policy denies private folders and evidence, and writes only in the workspace', { skip: process.platform !== 'win32' && 'Windows path rules' }, () => {
  const scope = { assignedProjectRoot: 'C:\\P\\app', readableProjectRoots: ['C:\\P\\app'], deniedParentPaths: ['C:\\P'],
    protectedPaths: ['C:\\P\\app\\.git'], deniedSensitivePaths: ['C:\\U\\.ssh'] };
  const policy = developmentFilesystemPolicy({ scope, extraDenies: ['C:\\S\\patches'], workspace: 'C:\\W\\ws', writablePaths: ['.'],
    metadataAccess: 'read', processReadPaths: ['C:\\bin'] });
  assert.match(policy, /^":root"="read",":minimal"="read"/);
  for (const deny of ['C:\\\\P"="deny', 'C:\\\\U\\\\.ssh"="deny', 'C:\\\\S\\\\patches"="deny', 'C:\\\\P\\\\app\\\\.git"="deny']) assert.ok(policy.includes(deny), deny);
  assert.ok(policy.includes('"C:\\\\W\\\\ws"="write"'));
  assert.equal((policy.match(/="write"/g) ?? []).length, 2, 'the workspace itself and its relative root entry only');
  assert.equal(workspacePermissionEntries(['docs'], 'deny'), '"."="read","docs"="write",".git"="deny",".worker-isolation.json"="deny"');
});

test('on macOS and Linux the development policy denies private folders and evidence, and writes only in the workspace', { skip: process.platform === 'win32' && 'POSIX path rules' }, () => {
  const scope = { assignedProjectRoot: '/P/app', readableProjectRoots: ['/P/app'], deniedParentPaths: ['/P'],
    protectedPaths: ['/P/app/.git'], deniedSensitivePaths: ['/U/.ssh'] };
  const policy = developmentFilesystemPolicy({ scope, extraDenies: ['/S/patches'], workspace: '/W/ws', writablePaths: ['.'],
    metadataAccess: 'read', processReadPaths: ['/bin'] });
  assert.match(policy, /^":root"="read",":minimal"="read"/);
  for (const deny of ['"/P"="deny"', '"/U/.ssh"="deny"', '"/S/patches"="deny"', '"/P/app/.git"="deny"']) assert.ok(policy.includes(deny), deny);
  assert.ok(policy.includes('"/W/ws"="write"'));
  assert.equal((policy.match(/="write"/g) ?? []).length, 2, 'the workspace itself and its relative root entry only');
});

test('a worker workspace inside the project is refused with either slash style', () => {
  for (const [workspace, project] of [['/P/app/ws', '/P/app'], ['/P/APP/ws', '/p/app'], ['/P/app', '/P/app']]) {
    assert.throws(() => assertWorkspaceOutsideProject(workspace, project, 'inside'), /inside/);
  }
  assert.doesNotThrow(() => assertWorkspaceOutsideProject('/P/app-copy', '/P/app', 'inside'));
});

test('Claude-style workers inherit only process plumbing from the host', () => {
  const env = processPlumbingEnvironment({ PATH: 'p', SystemRoot: 'r', GITHUB_TOKEN: 'secret', DATABASE_URL: 'postgres://x', HOME: 'h' });
  assert.deepEqual(Object.keys(env).sort(), ['PATH', 'SystemRoot']);
  // No secrets and no personal folders (ALLUSERSPROFILE is the shared system data folder).
  assert.ok(!PROCESS_PLUMBING_VARIABLES.some((name) => /TOKEN|KEY|SECRET|PASSWORD|^HOME|^USERPROFILE$|APPDATA/i.test(name)));
});

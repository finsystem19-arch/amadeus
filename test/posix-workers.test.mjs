import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { terminateWorkerTree, WORKER_PROCESS_GROUP } from '../src/worker-process.ts';
import { npmCliPath } from '../src/verification-checks.mjs';
import { findCodexOnPath } from '../src/portable-runtime.ts';
import { isolationSecurityStateBinding } from '../src/isolation-security-state.ts';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('stopping a worker on macOS or Linux also stops the processes it started', { skip: process.platform === 'win32' && 'taskkill /T covers Windows' }, async () => {
  const child = spawn('/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'], detached: WORKER_PROCESS_GROUP });
  const grandchild = Number(await new Promise((resolve) => child.stdout.once('data', (data) => resolve(String(data).trim()))));
  assert.ok(alive(grandchild));
  terminateWorkerTree(child);
  await new Promise((resolve) => child.once('exit', resolve));
  for (let i = 0; i < 50 && alive(grandchild); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(alive(grandchild), false, 'the background process the worker started must be gone');
});

test('npm is found beside node.exe on Windows and in ../lib/node_modules on macOS and Linux', () => {
  const unix = '/opt/node/lib/node_modules/npm/bin/npm-cli.js';
  assert.equal(npmCliPath('/opt/node/bin/node', (path) => path === unix), unix);
  const beside = join('/opt/node/bin', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  assert.equal(npmCliPath('/opt/node/bin/node', (path) => path === beside), beside);
});

test('Codex is found on PATH through its symlink, next to its code-mode host', { skip: process.platform === 'win32' && 'where.exe covers Windows' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'amadeus-codex-path-'));
  try {
    const release = join(dir, 'release'); const bin = join(dir, 'bin');
    mkdirSync(release); mkdirSync(bin);
    writeFileSync(join(release, 'codex'), ''); writeFileSync(join(release, 'codex-code-mode-host'), '');
    symlinkSync(join(release, 'codex'), join(bin, 'codex'));
    assert.match(findCodexOnPath(`/nonexistent:${bin}`), /release\/codex$/);
    rmSync(join(release, 'codex-code-mode-host'));
    assert.equal(findCodexOnPath(bin), null, 'a codex without its code-mode host is not the supported CLI');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the macOS/Linux security-state binding changes when a boundary folder\'s permissions change', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amadeus-posix-binding-'));
  try {
    const first = isolationSecurityStateBinding(null, 'codex', dir, [dir], [dir], 'darwin');
    assert.match(first.hostSecurityStateFingerprint, /^[A-F0-9]{64}$/);
    assert.equal(isolationSecurityStateBinding(null, 'codex', dir, [dir], [dir], 'darwin').hostSecurityStateFingerprint, first.hostSecurityStateFingerprint);
    chmodSync(dir, 0o777);
    assert.notEqual(isolationSecurityStateBinding(null, 'codex', dir, [dir], [dir], 'darwin').hostSecurityStateFingerprint, first.hostSecurityStateFingerprint);
    assert.throws(() => isolationSecurityStateBinding(null, 'codex', dir, [dir], [join(dir, 'other')], 'darwin'), /not permission-bound/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

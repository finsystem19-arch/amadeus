/**
 * Local milestone checkpoint handoff for sandboxed workers that cannot mutate
 * `.git` (getcwd blocked or index.lock EPERM). Packages exact changed paths and
 * content hashes for the origin host / coordinator to commit; never writes
 * inside `.git` and never pushes.
 */
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  unlinkSync,
  copyFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { excludedDevelopmentPath } from '../src/excluded-development-path.mjs';

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function normalizePath(path) {
  return String(path || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

export function probeGitCheckpointCapability(workspace, run = spawnSync) {
  const root = resolve(workspace);
  const reasons = [];
  const lockPath = join(root, '.git', 'index.lock');
  const probePath = join(root, '.git', `amadeus-checkpoint-probe-${process.pid}.txt`);
  let indexWritable = false;
  try {
    const fd = openSync(probePath, 'wx');
    closeSync(fd);
    unlinkSync(probePath);
    indexWritable = true;
  } catch (error) {
    reasons.push(`git-dir-write:${error && error.code ? error.code : 'denied'}`);
  }
  const status = run('git', ['-c', `safe.directory=${root}`, '-C', root, 'status', '--porcelain=v1'], {
    encoding: 'utf8',
    cwd: root,
    timeout: 15_000,
  });
  const stderr = String(status.stderr || status.error?.message || '');
  const getcwdBlocked = /Unable to read current working directory|unable to get current working directory/i.test(stderr)
    || status.status === 128 && /Permission denied/i.test(stderr);
  if (getcwdBlocked) reasons.push('git-getcwd-blocked');
  else if (status.error) reasons.push(`git-spawn:${status.error.code || status.error.message}`);
  else if (status.status !== 0) reasons.push(`git-status-exit:${status.status}`);
  return {
    workspace: root,
    gitAvailable: status.status === 0 && !getcwdBlocked,
    indexWritable,
    getcwdBlocked,
    canCommitLocally: status.status === 0 && !getcwdBlocked && indexWritable,
    reasons,
  };
}

export function prepareLocalCheckpointHandoff(options = {}) {
  const workspace = resolve(options.workspace ?? process.cwd());
  const summary = String(options.summary || 'verified project progress').replace(/\s+/g, ' ').trim().slice(0, 160);
  const changedPaths = [...new Set((options.changedPaths || []).map(normalizePath))]
    .filter((path) => path
      && !path.startsWith('/')
      && !/^[A-Za-z]:/.test(path)
      && !path.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git')
      && !excludedDevelopmentPath(path));
  if (!changedPaths.length) {
    throw new Error('Local checkpoint handoff requires at least one verified changed path');
  }

  const capability = probeGitCheckpointCapability(workspace, options.runCommand ?? spawnSync);
  const evidenceRoot = resolve(options.evidenceDir
    ?? join(workspace, 'verification', 'checkpoint-handoff'));
  mkdirSync(evidenceRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const handoffDir = join(evidenceRoot, `handoff-${stamp}`);
  mkdirSync(join(handoffDir, 'files'), { recursive: true });

  const files = [];
  for (const relative of changedPaths.sort()) {
    const source = join(workspace, ...relative.split('/'));
    if (!existsSync(source)) throw new Error(`Changed path missing from workspace: ${relative}`);
    const sha256 = hashFile(source);
    const bytes = readFileSync(source).byteLength;
    const destination = join(handoffDir, 'files', ...relative.split('/'));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    if (hashFile(destination) !== sha256) throw new Error(`Handoff copy verification failed: ${relative}`);
    files.push({ path: relative, bytes, sha256 });
  }

  const manifest = {
    schema: 1,
    kind: 'local-checkpoint-handoff',
    createdAt: new Date().toISOString(),
    workspace,
    summary,
    commitMessage: `Milestone: ${summary}`,
    push: false,
    workerCanCommitLocally: capability.canCommitLocally,
    capability,
    files,
    originHostAction: capability.canCommitLocally
      ? 'worker-may-commit-directly'
      : 'origin-host-commit-from-handoff',
    notes: capability.canCommitLocally
      ? 'Git mutation is available in this environment; handoff is informational.'
      : 'Worker cannot write .git or Git getcwd is blocked; apply these exact file bytes on the origin host and create the local milestone commit there. Do not push.',
  };
  const manifestPath = join(handoffDir, 'handoff-manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const latestPath = join(evidenceRoot, 'latest-handoff.json');
  writeFileSync(latestPath, `${JSON.stringify({
    schema: 1,
    handoffDirectory: handoffDir,
    manifestPath,
    createdAt: manifest.createdAt,
    summary,
    fileCount: files.length,
    workerCanCommitLocally: capability.canCommitLocally,
    originHostAction: manifest.originHostAction,
  }, null, 2)}\n`, 'utf8');

  return {
    ...manifest,
    handoffDirectory: handoffDir,
    manifestPath,
    latestPath,
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, all) => {
    if (!value.startsWith('--')) return [];
    const key = value.slice(2);
    const next = all[index + 1];
    if (!next || next.startsWith('--')) return [[key, true]];
    return [[key, next]];
  }));
  if (args.probe) {
    process.stdout.write(`${JSON.stringify(probeGitCheckpointCapability(process.cwd()), null, 2)}\n`);
  } else {
    const paths = String(args.paths || '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    const result = prepareLocalCheckpointHandoff({
      workspace: process.cwd(),
      summary: args.summary || 'sandbox checkpoint handoff',
      changedPaths: paths,
    });
    process.stdout.write(`${JSON.stringify({
      handoffDirectory: result.handoffDirectory,
      manifestPath: result.manifestPath,
      originHostAction: result.originHostAction,
      fileCount: result.files.length,
      workerCanCommitLocally: result.workerCanCommitLocally,
    }, null, 2)}\n`);
  }
}

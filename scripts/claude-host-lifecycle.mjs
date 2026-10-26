/**
 * Claude Code host installation adapter for Amadeus.
 *
 * Installs, updates, rolls back, disables, and removes a staged Claude
 * candidate using the documented local plugin commands when the CLI is
 * available, or a deterministic filesystem mirror for verification.
 *
 * Boundaries:
 * - Never enables a signed-in worker, copies credentials, or activates billing.
 * - Never edits Amadeus durable state or the Codex wrapper.
 * - Preserves existing Claude settings/state outside the Amadeus plugin entry.
 * - Fail-closed when the candidate is missing, drifted, or dual-manifested.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  lstatSync,
} from 'node:fs';
import { basename as pathBasename, dirname, extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  CLAUDE_MARKETPLACE_NAME,
  stageClaudeMarketplace,
  stageClaudePackage,
  verifyClaudePackage,
} from './build-claude-package.mjs';

const PLUGIN_NAME = 'amadeus';
const MARKETPLACE_NAME = CLAUDE_MARKETPLACE_NAME;
const ALLOWED_SCOPES = new Set(['local', 'project', 'user']);

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function listFiles(root, prefix = '') {
  if (!existsSync(root)) return [];
  const stat = lstatSync(root);
  if (stat.isSymbolicLink()) throw new Error(`Linked Claude host path refused: ${root}`);
  if (!stat.isDirectory()) return [[prefix || '.', readFileSync(root)]];
  return readdirSync(root).sort().flatMap((name) => {
    const path = join(root, name);
    const child = lstatSync(path);
    const key = prefix ? `${prefix}/${name}` : name;
    if (child.isSymbolicLink()) throw new Error(`Linked Claude host asset refused: ${key}`);
    if (child.isDirectory()) return listFiles(path, key);
    if (!child.isFile()) throw new Error(`Non-file Claude host asset refused: ${key}`);
    return [[key, readFileSync(path)]];
  });
}

function copyTree(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const [relative, bytes] of listFiles(source)) {
    const target = join(destination, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
}

function whichClaude(environment = process.env, run = spawnSync) {
  const explicit = environment.CLAUDE_EXECUTABLE?.trim();
  const directExecutable = (candidate) => {
    if (process.platform !== 'win32' || extname(candidate).toLowerCase() === '.exe') return candidate;
    // npm's Windows shim is an extensionless file plus a .cmd wrapper. Neither
    // can be launched safely with shell:false, but the official package ships
    // the native executable beside the shim's global node_modules directory.
    const native = join(dirname(candidate), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    return existsSync(native) ? native : candidate;
  };
  if (explicit) return { executable: directExecutable(explicit), source: 'CLAUDE_EXECUTABLE' };
  const probe = run(process.platform === 'win32' ? 'where.exe' : 'which', ['claude'], {
    encoding: 'utf8',
    shell: false,
    env: environment,
    timeout: 10_000,
  });
  if (probe.status === 0) {
    const candidates = String(probe.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const preferred = process.platform === 'win32'
      ? candidates.find((candidate) => extname(candidate).toLowerCase() === '.exe') ?? candidates[0]
      : candidates[0];
    if (preferred) return { executable: directExecutable(preferred), source: 'PATH' };
  }
  return null;
}

/** Dependency and host-capability preflight. Never installs packages or signs in. */
export function preflightClaudeHost(options = {}) {
  const environment = options.env ?? process.env;
  const run = options.runCommand ?? spawnSync;
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const checks = [];
  const ok = (name, detail) => checks.push({ name, ok: true, detail });
  const fail = (name, detail) => checks.push({ name, ok: false, detail });

  if (nodeMajor >= 24) ok('node', `Node ${process.versions.node}`);
  else fail('node', `Amadeus requires Node 24 or later; found ${process.versions.node}`);

  const resolved = whichClaude(environment, run);
  if (!resolved) {
    fail('claude-cli', 'Claude Code CLI not found on PATH or CLAUDE_EXECUTABLE');
    return {
      available: false,
      claudeInstalled: false,
      executable: null,
      version: null,
      pluginCommands: null,
      checks,
      billing: 'subscription-signin-only',
      workerEnabled: false,
    };
  }

  const versionResult = run(resolved.executable, ['--version'], {
    encoding: 'utf8',
    shell: false,
    env: environment,
    timeout: 15_000,
  });
  if (versionResult.error || versionResult.status !== 0) {
    fail('claude-version', versionResult.error?.message || versionResult.stderr || 'version probe failed');
    return {
      available: false,
      claudeInstalled: false,
      executable: resolved.executable,
      version: null,
      pluginCommands: null,
      checks,
      billing: 'subscription-signin-only',
      workerEnabled: false,
    };
  }
  const version = String(versionResult.stdout || versionResult.stderr || '').trim();
  ok('claude-cli', `${resolved.source}: ${resolved.executable}`);
  ok('claude-version', version);

  const help = run(resolved.executable, ['plugin', '--help'], {
    encoding: 'utf8',
    shell: false,
    env: environment,
    timeout: 15_000,
  });
  const helpText = `${help.stdout || ''}\n${help.stderr || ''}`;
  const required = ['install', 'update', 'uninstall', 'enable', 'disable', 'list'];
  const present = required.filter((verb) => new RegExp(`\\b${verb}\\b`, 'i').test(helpText));
  if (help.status === 0 && present.length === required.length) {
    ok('plugin-commands', present.join(','));
  } else {
    fail('plugin-commands', `Missing or unreadable plugin verbs; found=${present.join(',') || 'none'}`);
  }

  return {
    available: checks.every((check) => check.ok),
    claudeInstalled: true,
    executable: resolved.executable,
    version,
    pluginCommands: present,
    checks,
    billing: 'subscription-signin-only',
    workerEnabled: false,
  };
}

function assertScope(scope) {
  if (!ALLOWED_SCOPES.has(scope)) throw new Error(`Unsupported Claude plugin scope: ${scope}`);
  return scope;
}

function assertCandidate(candidateDirectory) {
  const root = resolve(candidateDirectory);
  const manifestPath = join(root, 'amadeus-host-manifest.json');
  const pluginJson = join(root, '.claude-plugin', 'plugin.json');
  if (!existsSync(manifestPath) || !existsSync(pluginJson)) {
    throw new Error('Claude candidate missing amadeus-host-manifest.json or .claude-plugin/plugin.json');
  }
  if (existsSync(join(root, '.codex-plugin', 'plugin.json'))) {
    throw new Error('Ambiguous packaged host identity: Claude candidate must not include .codex-plugin');
  }
  const manifest = readJson(manifestPath);
  verifyClaudePackage(root, manifest);
  if (manifest.host !== 'claude-code-cli' || manifest.status !== 'candidate-unverified') {
    throw new Error('Claude candidate manifest is not an Amadeus Claude candidate');
  }
  return { root, manifest, plugin: readJson(pluginJson) };
}

function settingsPath(claudeHome, scope, projectRoot) {
  if (scope === 'user') return join(claudeHome, 'settings.json');
  if (scope === 'project') return join(projectRoot, '.claude', 'settings.json');
  return join(projectRoot, '.claude', 'settings.local.json');
}

function readSettings(path) {
  if (!existsSync(path)) return {};
  return readJson(path);
}

function preserveForeignSettings(existing) {
  const copy = { ...existing };
  // Never invent provider, credential, or telemetry fields.
  delete copy.apiKey;
  delete copy.anthropicApiKey;
  delete copy.env;
  return copy;
}

function mirrorInstallPaths(claudeHome, candidateRoot, version) {
  const marketplaceRoot = join(claudeHome, 'plugins', 'marketplaces', MARKETPLACE_NAME);
  const cacheRoot = join(claudeHome, 'plugins', 'cache', MARKETPLACE_NAME, PLUGIN_NAME, version);
  const dataRoot = join(claudeHome, 'plugins', 'data', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`);
  return { marketplaceRoot, cacheRoot, dataRoot, candidateRoot };
}

function writeMarketplaceManifest(marketplaceRoot, version, relativePluginPath = './amadeus') {
  writeJson(join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), {
    name: MARKETPLACE_NAME,
    owner: { name: 'Mad Max Systems' },
    plugins: [{
      name: PLUGIN_NAME,
      source: relativePluginPath,
      description: 'Amadeus local coordinator candidate',
      version,
    }],
  });
}

function setPluginEnabled(settings, enabled) {
  const next = preserveForeignSettings(settings);
  next.enabledPlugins = { ...(settings.enabledPlugins || {}) };
  next.enabledPlugins[`${PLUGIN_NAME}@${MARKETPLACE_NAME}`] = enabled;
  return next;
}

function snapshotInstalled(claudeHome, version) {
  const paths = mirrorInstallPaths(claudeHome, null, version);
  if (!existsSync(paths.cacheRoot)) return null;
  const files = Object.fromEntries(listFiles(paths.cacheRoot).map(([key, bytes]) => [key, hashBytes(bytes)]));
  return { version, files, cacheRoot: paths.cacheRoot };
}

/** Stage a fresh candidate under an exclusive destination, then verify it. */
export function stageClaudeHostCandidate(repositoryRoot, destination) {
  const manifest = stageClaudePackage(repositoryRoot, destination);
  verifyClaudePackage(destination, manifest);
  return { destination: resolve(destination), manifest, workerEnabled: false };
}

/** Stage a local marketplace that lists the Amadeus Claude candidate. */
export function stageClaudeHostMarketplace(repositoryRoot, destination, options = {}) {
  const staged = stageClaudeMarketplace(repositoryRoot, destination, options);
  return { ...staged, workerEnabled: false };
}

function parseClaudeJsonLines(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { /* fall through */ }
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // keep scanning for the trailing machine-readable line
    }
  }
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch { /* ignore */ }
  }
  return null;
}

function trustSettingsForMarketplace(marketplaceRoot) {
  return {
    extraKnownMarketplaces: {
      [MARKETPLACE_NAME]: {
        source: { source: 'directory', path: resolve(marketplaceRoot) },
      },
    },
  };
}

function resolveMarketplaceRoot(options, candidate) {
  if (options.marketplaceDirectory) return resolve(options.marketplaceDirectory);
  const marketPath = join(candidate.root, '..', `${basename(candidate.root)}-marketplace`);
  if (existsSync(join(marketPath, '.claude-plugin', 'marketplace.json'))) return resolve(marketPath);
  return null;
}

function basename(path) {
  return pathBasename(String(path || '').replace(/[\\/]+$/, '')) || 'amadeus';
}

/**
 * Install or refresh the Amadeus Claude candidate at an explicit local scope.
 * `mode: 'filesystem-mirror'` is the deterministic verification path.
 * `mode: 'cli'` shells out to documented `claude plugin` commands when available.
 */
export function installClaudeHost(options) {
  const scope = assertScope(options.scope ?? 'local');
  const projectRoot = resolve(options.projectRoot);
  const claudeHome = resolve(options.claudeHome);
  const candidate = assertCandidate(options.candidateDirectory);
  const version = String(candidate.plugin.version);
  const stateRoot = options.stateRoot ? resolve(options.stateRoot) : null;
  if (stateRoot && existsSync(stateRoot)) {
    // Touch-proof: refuse when stateRoot is inside the candidate or Claude home plugin cache.
    const denied = [candidate.root, join(claudeHome, 'plugins')].some((root) => {
      const relative = resolve(stateRoot).toLowerCase().startsWith(resolve(root).toLowerCase() + '\\')
        || resolve(stateRoot).toLowerCase() === resolve(root).toLowerCase();
      return relative;
    });
    if (denied) throw new Error('Claude host install must not target Amadeus durable state paths');
  }

  const rollbackDir = options.rollbackDirectory
    ? resolve(options.rollbackDirectory)
    : join(claudeHome, 'amadeus-host-rollback', version);
  const previous = snapshotInstalled(claudeHome, version);
  if (previous) {
    rmSync(rollbackDir, { recursive: true, force: true });
    copyTree(previous.cacheRoot, rollbackDir);
    writeJson(join(rollbackDir, 'amadeus-rollback-manifest.json'), {
      schema: 1,
      host: 'claude-code-cli',
      version,
      preservedAt: new Date().toISOString(),
      files: previous.files,
    });
  }

  const mode = options.mode ?? 'filesystem-mirror';
  const settingsFile = settingsPath(claudeHome, scope, projectRoot);
  const beforeSettings = readSettings(settingsFile);

  if (mode === 'cli') {
    const preflight = preflightClaudeHost({ env: options.env, runCommand: options.runCommand });
    if (!preflight.available) {
      return {
        ok: false,
        mode,
        action: 'install',
        reason: 'Claude CLI preflight failed',
        preflight,
        workerEnabled: false,
        settingsPreserved: true,
      };
    }
    const run = options.runCommand ?? spawnSync;
    const environment = { ...(options.env ?? process.env) };
    let marketplaceRoot = resolveMarketplaceRoot(options, candidate);
    let stagedMarketplace = null;
    if (!marketplaceRoot) {
      const autoMarket = options.autoMarketplaceDirectory
        ? resolve(options.autoMarketplaceDirectory)
        : join(dirname(candidate.root), `${basename(candidate.root)}-marketplace`);
      if (existsSync(autoMarket)) rmSync(autoMarket, { recursive: true, force: true });
      stagedMarketplace = stageClaudeMarketplace(options.repositoryRoot ?? process.cwd(), autoMarket, {
        candidateDirectory: candidate.root,
      });
      marketplaceRoot = stagedMarketplace.marketplaceRoot;
    }
    const trustPath = options.trustSettingsPath
      ? resolve(options.trustSettingsPath)
      : join(projectRoot, '.claude', 'amadeus-trust-settings.json');
    writeJson(trustPath, trustSettingsForMarketplace(marketplaceRoot));
    const prefixArgs = options.trustSettings === false ? [] : ['--settings', trustPath];
    const market = run(preflight.executable, [
      ...prefixArgs, 'plugin', 'marketplace', 'add', marketplaceRoot, '--scope', scope, '--json',
    ], { encoding: 'utf8', shell: false, env: environment, timeout: 60_000, cwd: projectRoot });
    const install = run(preflight.executable, [
      ...prefixArgs, 'plugin', 'install', PLUGIN_NAME, '--marketplace', marketplaceRoot, '--scope', scope, '-y', '--json',
    ], { encoding: 'utf8', shell: false, env: environment, timeout: 60_000, cwd: projectRoot });
    const enable = options.enable === false
      ? { status: 0, stdout: '', stderr: '' }
      : run(preflight.executable, [
        ...prefixArgs, 'plugin', 'enable', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`, '--scope', scope, '--json',
      ], { encoding: 'utf8', shell: false, env: environment, timeout: 30_000, cwd: projectRoot });
    const list = run(preflight.executable, [
      ...prefixArgs, 'plugin', 'list', '--json',
    ], { encoding: 'utf8', shell: false, env: environment, timeout: 30_000, cwd: projectRoot });
    const listPayload = parseClaudeJsonLines(`${list.stdout || ''}`);
    const installedEntry = Array.isArray(listPayload)
      ? listPayload.find((entry) => entry?.id === `${PLUGIN_NAME}@${MARKETPLACE_NAME}` || entry?.name === PLUGIN_NAME)
      : null;
    const marketOk = market.status === 0;
    const installOk = install.status === 0;
    const enableOk = enable.status === 0;
    return {
      ok: marketOk && installOk && enableOk,
      mode,
      action: 'install',
      scope,
      version,
      executable: preflight.executable,
      claudeVersion: preflight.version,
      marketplaceRoot,
      trustSettingsPath: trustPath,
      marketplaceExitCode: market.status,
      installExitCode: install.status,
      enableExitCode: enable.status,
      listExitCode: list.status,
      listedEnabled: installedEntry?.enabled === true,
      listed: installedEntry || null,
      stdout: `${market.stdout || ''}\n${install.stdout || ''}\n${enable.stdout || ''}\n${list.stdout || ''}`.trim(),
      stderr: `${market.stderr || ''}\n${install.stderr || ''}\n${enable.stderr || ''}\n${list.stderr || ''}`.trim(),
      workerEnabled: false,
      billing: 'subscription-signin-only',
      settingsPath: settingsFile,
      rollbackDirectory: previous ? rollbackDir : null,
      marketParsed: parseClaudeJsonLines(market.stdout),
      installParsed: parseClaudeJsonLines(install.stdout),
    };
  }

  if (mode !== 'filesystem-mirror') throw new Error(`Unsupported Claude host install mode: ${mode}`);

  const paths = mirrorInstallPaths(claudeHome, candidate.root, version);
  mkdirSync(paths.marketplaceRoot, { recursive: true });
  const mirroredPlugin = join(paths.marketplaceRoot, PLUGIN_NAME);
  rmSync(mirroredPlugin, { recursive: true, force: true });
  copyTree(candidate.root, mirroredPlugin);
  writeMarketplaceManifest(paths.marketplaceRoot, version, './amadeus');
  rmSync(paths.cacheRoot, { recursive: true, force: true });
  copyTree(candidate.root, paths.cacheRoot);
  mkdirSync(paths.dataRoot, { recursive: true });
  writeJson(join(paths.dataRoot, 'install-record.json'), {
    schema: 1,
    plugin: `${PLUGIN_NAME}@${MARKETPLACE_NAME}`,
    version,
    scope,
    installedAt: new Date().toISOString(),
    candidateManifest: candidate.manifest,
    workerEnabled: false,
    credentialsCopied: false,
    apiBillingEnabled: false,
  });

  const enabled = options.enable !== false;
  const nextSettings = setPluginEnabled(beforeSettings, enabled);
  writeJson(settingsFile, nextSettings);

  return {
    ok: true,
    mode,
    action: 'install',
    scope,
    version,
    cacheRoot: paths.cacheRoot,
    marketplaceRoot: paths.marketplaceRoot,
    dataRoot: paths.dataRoot,
    settingsPath: settingsFile,
    enabled,
    workerEnabled: false,
    billing: 'subscription-signin-only',
    credentialsCopied: false,
    rollbackDirectory: previous ? rollbackDir : null,
    preservedSettingsKeys: Object.keys(beforeSettings).filter((key) => key !== 'enabledPlugins'),
  };
}

export function updateClaudeHost(options) {
  return installClaudeHost({ ...options, action: 'update' });
}

export function rollbackClaudeHost(options) {
  const claudeHome = resolve(options.claudeHome);
  const version = String(options.version || '');
  if (!version) throw new Error('Claude host rollback requires an explicit version');
  const rollbackDir = options.rollbackDirectory
    ? resolve(options.rollbackDirectory)
    : join(claudeHome, 'amadeus-host-rollback', version);
  const manifestPath = join(rollbackDir, 'amadeus-rollback-manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`Claude host rollback snapshot missing: ${rollbackDir}`);
  const manifest = readJson(manifestPath);
  const paths = mirrorInstallPaths(claudeHome, null, version);
  rmSync(paths.cacheRoot, { recursive: true, force: true });
  copyTree(rollbackDir, paths.cacheRoot);
  rmSync(join(paths.cacheRoot, 'amadeus-rollback-manifest.json'), { force: true });
  return {
    ok: true,
    action: 'rollback',
    version,
    cacheRoot: paths.cacheRoot,
    restoredFrom: rollbackDir,
    restoredFileCount: Object.keys(manifest.files || {}).length,
    workerEnabled: false,
  };
}

export function disableClaudeHost(options) {
  const scope = assertScope(options.scope ?? 'local');
  const projectRoot = resolve(options.projectRoot);
  const claudeHome = resolve(options.claudeHome);
  const settingsFile = settingsPath(claudeHome, scope, projectRoot);
  const before = readSettings(settingsFile);
  if (options.mode === 'cli') {
    const preflight = preflightClaudeHost({ env: options.env, runCommand: options.runCommand });
    if (!preflight.available) {
      return { ok: false, action: 'disable', reason: 'Claude CLI preflight failed', preflight, workerEnabled: false };
    }
    const run = options.runCommand ?? spawnSync;
    const result = run(preflight.executable, [
      'plugin', 'disable', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`, '--scope', scope, '--json',
    ], { encoding: 'utf8', shell: false, env: options.env ?? process.env, timeout: 30_000, cwd: projectRoot });
    return {
      ok: result.status === 0,
      action: 'disable',
      mode: 'cli',
      exitCode: result.status,
      stdout: String(result.stdout || '').trim(),
      stderr: String(result.stderr || '').trim(),
      workerEnabled: false,
    };
  }
  writeJson(settingsFile, setPluginEnabled(before, false));
  return {
    ok: true,
    action: 'disable',
    mode: 'filesystem-mirror',
    settingsPath: settingsFile,
    enabled: false,
    workerEnabled: false,
    preservedSettingsKeys: Object.keys(before).filter((key) => key !== 'enabledPlugins'),
  };
}

export function uninstallClaudeHost(options) {
  const scope = assertScope(options.scope ?? 'local');
  const projectRoot = resolve(options.projectRoot);
  const claudeHome = resolve(options.claudeHome);
  const version = String(options.version || readInstalledVersion(claudeHome) || '');
  const keepData = options.keepData === true;
  const settingsFile = settingsPath(claudeHome, scope, projectRoot);
  const before = readSettings(settingsFile);

  if (options.mode === 'cli') {
    const preflight = preflightClaudeHost({ env: options.env, runCommand: options.runCommand });
    if (!preflight.available) {
      return { ok: false, action: 'uninstall', reason: 'Claude CLI preflight failed', preflight, workerEnabled: false };
    }
    const run = options.runCommand ?? spawnSync;
    const args = ['plugin', 'uninstall', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`, '--scope', scope, '--json'];
    if (keepData) args.push('--keep-data');
    const result = run(preflight.executable, args, {
      encoding: 'utf8', shell: false, env: options.env ?? process.env, timeout: 30_000, cwd: projectRoot,
    });
    return {
      ok: result.status === 0,
      action: 'uninstall',
      mode: 'cli',
      exitCode: result.status,
      stdout: String(result.stdout || '').trim(),
      stderr: String(result.stderr || '').trim(),
      workerEnabled: false,
    };
  }

  if (!version) throw new Error('Claude host uninstall requires an installed version');
  const paths = mirrorInstallPaths(claudeHome, null, version);
  rmSync(paths.cacheRoot, { recursive: true, force: true });
  rmSync(join(paths.marketplaceRoot, PLUGIN_NAME), { recursive: true, force: true });
  if (!keepData) rmSync(paths.dataRoot, { recursive: true, force: true });
  const next = preserveForeignSettings(before);
  if (next.enabledPlugins) {
    delete next.enabledPlugins[`${PLUGIN_NAME}@${MARKETPLACE_NAME}`];
    if (Object.keys(next.enabledPlugins).length === 0) delete next.enabledPlugins;
  }
  writeJson(settingsFile, next);
  return {
    ok: true,
    action: 'uninstall',
    mode: 'filesystem-mirror',
    version,
    settingsPath: settingsFile,
    dataPreserved: keepData,
    workerEnabled: false,
    preservedSettingsKeys: Object.keys(before).filter((key) => key !== 'enabledPlugins'),
  };
}

function readInstalledVersion(claudeHome) {
  const cacheRoot = join(claudeHome, 'plugins', 'cache', MARKETPLACE_NAME, PLUGIN_NAME);
  if (!existsSync(cacheRoot)) return null;
  const versions = readdirSync(cacheRoot).filter((name) => existsSync(join(cacheRoot, name, '.claude-plugin', 'plugin.json')));
  return versions.sort().at(-1) ?? null;
}

export function claudeHostStatus(options = {}) {
  const claudeHome = options.claudeHome ? resolve(options.claudeHome) : null;
  const preflight = preflightClaudeHost({ env: options.env, runCommand: options.runCommand });
  const version = claudeHome ? readInstalledVersion(claudeHome) : null;
  return {
    ...preflight,
    installedVersion: version,
    hostAdapter: 'claude-host-lifecycle',
    workerAdapter: 'claude-subscription-signin',
    workerEnabled: false,
    supportClaim: 'candidate-host-lifecycle-implemented; live-compatibility-unverified',
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [command, ...rest] = process.argv.slice(2);
  const args = Object.fromEntries(rest.flatMap((value, index, all) => {
    if (!value.startsWith('--')) return [];
    const key = value.slice(2);
    const next = all[index + 1];
    if (!next || next.startsWith('--')) return [[key, true]];
    return [[key, next]];
  }));
  const report = (value) => {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  };
  if (command === 'preflight') report(preflightClaudeHost());
  else if (command === 'status') report(claudeHostStatus({ claudeHome: args['claude-home'] }));
  else if (command === 'stage') {
    if (!args.destination) throw new Error('Usage: node scripts/claude-host-lifecycle.mjs stage --destination <dir>');
    report(stageClaudeHostCandidate(process.cwd(), args.destination));
  } else if (command === 'stage-marketplace') {
    if (!args.destination) throw new Error('Usage: node scripts/claude-host-lifecycle.mjs stage-marketplace --destination <dir>');
    report(stageClaudeHostMarketplace(process.cwd(), args.destination));
  } else {
    throw new Error('Usage: node scripts/claude-host-lifecycle.mjs <preflight|status|stage|stage-marketplace>');
  }
}

/**
 * Live Claude Code host canary for Amadeus.
 *
 * Uses a reversible CLAUDE_CONFIG_DIR isolation scope when possible, stages a
 * local marketplace, drives documented plugin marketplace/install/enable/list
 * commands, probes SessionStart + skill/MCP identity against the shared engine,
 * then disables/uninstalls/removes the marketplace. Never copies credentials,
 * never enables API billing, and never requires Claude-as-worker.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLAUDE_MARKETPLACE_NAME, stageClaudeMarketplace } from './build-claude-package.mjs';
import {
  preflightClaudeHost,
} from './claude-host-lifecycle.mjs';
import { spawnRepoModule } from './spawn-repo-module.mjs';

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function parseJsonLines(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { /* fall through to line/block scan */ }
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch { /* continue */ }
  }
  // Pretty-printed arrays/objects from `claude plugin list --json`.
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch { /* ignore */ }
  }
  return null;
}

function runClaude(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    shell: false,
    env: options.env ?? process.env,
    cwd: options.cwd,
    timeout: options.timeout ?? 90_000,
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    parsed: parseJsonLines(result.stdout),
    error: result.error?.message || null,
  };
}

function normalizedSha256(path) {
  return createHash('sha256')
    .update(readFileSync(path, 'utf8').replaceAll('\r\n', '\n'))
    .digest('hex');
}

function probeEngineIdentity(pluginRoot, repositoryRoot) {
  const hookPath = join(pluginRoot, 'hooks', 'session-start.mjs');
  const serverPath = join(pluginRoot, 'scripts', 'server.mjs');
  const stateRoot = mkdtempSync(join(tmpdir(), 'amadeus-live-engine-'));
  // Keep repository short-circuit hooks from the sandbox runner; only drop host
  // --require injectors that break restricted Windows ancestors.
  const nodeOptions = String(process.env.NODE_OPTIONS || '')
    .split(/\s+/)
    .filter((part) => part.startsWith('--import=data:') || part.startsWith('--preserve-symlinks'))
    .join(' ');
  try {
    const hookEnv = {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      AMADEUS_HOME: join(stateRoot, 'hook-home'),
      AMADEUS_CONFIG: join(stateRoot, 'absent.json'),
    };
    delete hookEnv.AMADEUS_WORKER;
    const hook = spawnRepoModule(hookPath, {
      encoding: 'utf8',
      timeout: 30_000,
      env: hookEnv,
    });
    let hookContext = null;
    try {
      hookContext = JSON.parse(String(hook.stdout || '').trim().split(/\r?\n/).pop() || 'null')
        ?.hookSpecificOutput?.additionalContext || null;
    } catch { /* ignore */ }
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ].map((value) => JSON.stringify(value)).join('\n') + '\n';
    const mcpEnv = {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      AMADEUS_HOME: join(stateRoot, 'mcp-home'),
      AMADEUS_CONFIG: join(stateRoot, 'absent.json'),
    };
    delete mcpEnv.AMADEUS_WORKER;
    const mcp = spawnRepoModule(serverPath, {
      encoding: 'utf8',
      input,
      timeout: 30_000,
      env: mcpEnv,
    });
    let tools = [];
    try {
      tools = String(mcp.stdout || '').trim().split(/\r?\n/)
        .map((line) => JSON.parse(line))
        .find((message) => message.id === 2)?.result?.tools?.map((tool) => tool.name) || [];
    } catch { /* ignore */ }
    const runtimeSha = normalizedSha256(join(pluginRoot, 'runtime', 'manifest.json'));
    const codexRuntimeSha = normalizedSha256(join(repositoryRoot, 'plugins', 'amadeus', 'runtime', 'manifest.json'));
    const skillPlugin = normalizedSha256(join(pluginRoot, 'skills', 'amadeus', 'SKILL.md'));
    const skillCanonical = normalizedSha256(join(repositoryRoot, 'agent-package', 'skills', 'amadeus', 'SKILL.md'));
    const skillCodex = normalizedSha256(join(repositoryRoot, 'plugins', 'amadeus', 'skills', 'amadeus', 'SKILL.md'));
    return {
      hookExit: hook.status,
      hookHasAmadeus: String(hookContext || '').includes('Amadeus'),
      hookContextPreview: String(hookContext || '').slice(0, 160),
      mcpExit: mcp.status,
      hasOnboardingTool: tools.includes('amadeus_onboarding_status'),
      hasDelegateWork: tools.includes('delegate_work'),
      runtimeManifestMatch: runtimeSha === codexRuntimeSha,
      runtimeSha256: runtimeSha,
      skillAmadeusSha256: skillPlugin,
      skillCanonicalSha256: skillCanonical,
      skillCodexSha256: skillCodex,
      skillMatchesCanonical: skillPlugin === skillCanonical,
      skillMatchesCodexNormalized: skillPlugin === skillCodex,
      hookStderrPreview: String(hook.stderr || '').slice(0, 240),
      mcpStderrPreview: String(mcp.stderr || '').slice(0, 240),
    };
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
}

function summarizeSession(streamText) {
  const lines = String(streamText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const events = [];
  for (const line of lines) {
    try { events.push(JSON.parse(line)); } catch { /* non-json noise */ }
  }
  const sessionStart = events.filter((event) => event.hook_event === 'SessionStart' || event.hook_name?.includes('SessionStart'));
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
  const plugins = init?.plugins || [];
  const amadeus = plugins.find((plugin) => plugin.name === 'amadeus');
  const skills = init?.skills || [];
  const slash = init?.slash_commands || [];
  return {
    sessionStartObserved: sessionStart.some((event) => event.subtype === 'hook_started'),
    sessionStartOk: sessionStart.some((event) => event.subtype === 'hook_response' && event.outcome === 'success'),
    sessionStartError: sessionStart.find((event) => event.subtype === 'hook_response' && event.outcome === 'error')?.stderr
      || sessionStart.find((event) => event.subtype === 'hook_response' && event.outcome === 'error')?.output
      || null,
    pluginLoaded: Boolean(amadeus),
    pluginSource: amadeus?.source || null,
    pluginPath: amadeus?.path || null,
    pluginVersion: amadeus?.version || null,
    skills: skills.filter((name) => String(name).startsWith('amadeus:')),
    slashCommands: slash.filter((name) => String(name).startsWith('amadeus:')),
    mcpServers: init?.mcp_servers || [],
    loggedInHint: !/Not logged in/i.test(String(streamText || '')),
  };
}

export function runClaudeLiveHostCanary(options = {}) {
  const repository = resolve(options.repository ?? process.cwd());
  const evidenceDir = resolve(options.evidenceDir ?? join(repository, 'verification', 'claude-live-host'));
  mkdirSync(evidenceDir, { recursive: true });
  const isolate = options.isolate !== false;
  const base = options.workRoot
    ? resolve(options.workRoot)
    : mkdtempSync(join(tmpdir(), 'amadeus-claude-live-'));
  const ownsBase = !options.workRoot;
  const projectRoot = join(base, 'project');
  const marketplaceRoot = join(base, 'marketplace');
  const claudeConfigDir = join(base, 'claude-config');
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(claudeConfigDir, { recursive: true });

  const environment = { ...process.env, ...(options.env || {}) };
  if (isolate) environment.CLAUDE_CONFIG_DIR = claudeConfigDir;
  const preflight = preflightClaudeHost({ env: environment, runCommand: options.runCommand });
  const evidence = {
    schema: 1,
    host: 'claude-code-cli',
    ranAt: new Date().toISOString(),
    repository,
    isolate,
    claudeConfigDir: isolate ? claudeConfigDir : null,
    workerEnabled: false,
    apiBillingUsed: false,
    credentialsCopied: false,
    preflight,
    steps: {},
    engine: null,
    session: null,
    supportClaim: false,
  };

  if (!preflight.available) {
    evidence.outcome = 'claude-cli-absent; live-host-canary-blocked';
    const evidencePath = join(evidenceDir, 'latest-live-host-canary.json');
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    if (ownsBase) rmSync(base, { recursive: true, force: true });
    return { ...evidence, evidencePath, ok: false };
  }

  const staged = stageClaudeMarketplace(repository, marketplaceRoot);
  evidence.version = staged.manifest.version;
  evidence.marketplaceRoot = staged.marketplaceRoot;
  evidence.pluginRoot = staged.pluginRoot;
  evidence.pluginId = staged.pluginId;

  const trustPath = join(projectRoot, 'amadeus-trust-settings.json');
  writeFileSync(trustPath, `${JSON.stringify({
    extraKnownMarketplaces: {
      [CLAUDE_MARKETPLACE_NAME]: { source: { source: 'directory', path: staged.marketplaceRoot } },
    },
  }, null, 2)}\n`);
  const prefix = ['--settings', trustPath];
  const exe = preflight.executable;
  const run = (args, timeout = 90_000) => runClaude(exe, [...prefix, ...args], {
    env: environment,
    cwd: projectRoot,
    timeout,
  });

  evidence.steps.marketplaceAdd = run(['plugin', 'marketplace', 'add', staged.marketplaceRoot, '--scope', 'local', '--json']);
  evidence.steps.install = run(['plugin', 'install', 'amadeus', '--marketplace', staged.marketplaceRoot, '--scope', 'local', '-y', '--json']);
  if (evidence.steps.install.status !== 0) {
    // One retry for transient EPERM/busy cache moves in restricted environments.
    evidence.steps.installRetry = run(['plugin', 'install', 'amadeus', '--marketplace', staged.marketplaceRoot, '--scope', 'local', '-y', '--json']);
  }
  evidence.steps.enable = run(['plugin', 'enable', staged.pluginId, '--scope', 'local', '--json']);
  // Install enables by default; "already enabled" is success for host acceptance.
  if (evidence.steps.enable.parsed?.alreadyInGoalState === true
    || /already enabled/i.test(evidence.steps.enable.stdout || '')) {
    evidence.steps.enable.status = 0;
  }
  evidence.steps.list = run(['plugin', 'list', '--json']);
  evidence.steps.details = run(['plugin', 'details', 'amadeus'], 60_000);

  const listPayload = evidence.steps.list.parsed;
  const listed = Array.isArray(listPayload)
    ? listPayload.find((entry) => entry?.id === staged.pluginId)
    : null;
  evidence.listedEnabled = listed?.enabled === true;
  evidence.listed = listed || null;
  evidence.enabledInSettings = false;
  const localSettings = join(projectRoot, '.claude', 'settings.local.json');
  if (existsSync(localSettings)) {
    try {
      const settings = JSON.parse(readFileSync(localSettings, 'utf8'));
      evidence.enabledInSettings = settings?.enabledPlugins?.[staged.pluginId] === true;
      writeFileSync(join(evidenceDir, 'settings.local.json'), `${JSON.stringify(settings, null, 2)}\n`);
    } catch { /* ignore */ }
  }

  evidence.engine = probeEngineIdentity(staged.pluginRoot, repository);
  writeFileSync(join(evidenceDir, 'engine-identity.json'), `${JSON.stringify(evidence.engine, null, 2)}\n`);

  const session = runClaude(exe, [
    ...prefix,
    '-p', 'Reply with exactly the single token PONG and nothing else.',
    '--verbose',
    '--output-format', 'stream-json',
    '--include-hook-events',
    '--permission-mode', 'bypassPermissions',
    '--no-session-persistence',
  ], { env: environment, cwd: projectRoot, timeout: 120_000 });
  writeFileSync(join(evidenceDir, 'session-stream.jsonl'), `${session.stdout}\n${session.stderr}\n`);
  evidence.session = {
    exitCode: session.status,
    ...summarizeSession(`${session.stdout}\n${session.stderr}`),
  };

  evidence.steps.update = run(['plugin', 'update', staged.pluginId, '--scope', 'local', '-y', '--json']);
  evidence.steps.disable = run(['plugin', 'disable', staged.pluginId, '--scope', 'local', '--json']);
  evidence.steps.enableAgain = run(['plugin', 'enable', staged.pluginId, '--scope', 'local', '--json']);
  evidence.steps.uninstall = run(['plugin', 'uninstall', staged.pluginId, '--scope', 'local', '--json']);
  evidence.steps.marketplaceRemove = run(['plugin', 'marketplace', 'remove', CLAUDE_MARKETPLACE_NAME, '--json']);

  const installOk = evidence.steps.install.status === 0
    || evidence.steps.installRetry?.status === 0;
  const enableOk = evidence.steps.enable.status === 0 || evidence.enabledInSettings;
  const marketOk = evidence.steps.marketplaceAdd.status === 0;
  const mcpConnected = Array.isArray(evidence.session?.mcpServers)
    && evidence.session.mcpServers.some((server) => server?.name === 'plugin:amadeus:amadeus' && server?.status === 'connected');
  const engineOk = Boolean(
    evidence.engine?.runtimeManifestMatch
    && evidence.engine?.skillMatchesCanonical
    && (
      (evidence.engine?.hookHasAmadeus && evidence.engine?.hasOnboardingTool && evidence.engine?.hasDelegateWork)
      || mcpConnected
    ),
  );
  const sessionPluginOk = evidence.session?.pluginLoaded
    && evidence.session?.skills?.includes('amadeus:amadeus')
    && evidence.session?.sessionStartObserved;
  const listedOrSettingsEnabled = evidence.listedEnabled || evidence.enabledInSettings;

  evidence.ok = Boolean(marketOk && enableOk && listedOrSettingsEnabled && engineOk && sessionPluginOk && installOk);
  evidence.supportClaim = false;
  evidence.outcome = evidence.ok
    ? (evidence.session?.sessionStartOk
      ? 'live-host-install-enable-session-engine-verified; worker-optional-not-required'
      : 'live-host-install-enable-session-engine-verified; sessionstart-dispatch-observed-host-shell-limited; worker-optional-not-required')
    : 'live-host-canary-incomplete';
  evidence.installOk = installOk;
  evidence.criteria = {
    marketplaceAdd: marketOk,
    install: installOk,
    enable: enableOk,
    listedOrSettingsEnabled,
    listedEnabled: Boolean(evidence.listedEnabled),
    sessionStartObserved: Boolean(evidence.session?.sessionStartObserved),
    sessionStartOk: Boolean(evidence.session?.sessionStartOk),
    userFacingAmadeusSkill: Boolean(evidence.session?.skills?.includes('amadeus:amadeus')),
    mcpConnected: Boolean(mcpConnected),
    sameEngine: Boolean(engineOk),
  };

  const evidencePath = join(evidenceDir, 'latest-live-host-canary.json');
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  if (ownsBase && options.keepWorkRoot !== true) rmSync(base, { recursive: true, force: true });
  return { ...evidence, evidencePath };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const result = runClaudeLiveHostCanary();
  process.stdout.write(`${JSON.stringify({
    ok: result.ok,
    outcome: result.outcome,
    criteria: result.criteria,
    evidencePath: result.evidencePath,
    listedEnabled: result.listedEnabled,
    enabledInSettings: result.enabledInSettings,
    installOk: result.installOk,
    session: result.session,
    engine: result.engine,
  }, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

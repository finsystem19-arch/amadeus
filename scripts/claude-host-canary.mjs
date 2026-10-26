/**
 * Version-bound Claude host canary. Reports availability honestly and never
 * copies credentials, enables API billing, or claims support from absence.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflightClaudeHost, claudeHostStatus } from './claude-host-lifecycle.mjs';

function probeClaudeAuthStatus(executable, environment, run = spawnSync) {
  if (!executable) {
    return { probed: false, loggedIn: false, authMethod: null, detail: 'claude-cli-absent' };
  }
  const result = run(executable, ['auth', 'status'], {
    encoding: 'utf8',
    shell: false,
    env: environment,
    timeout: 20_000,
  });
  const text = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  let parsed = null;
  try { parsed = JSON.parse(String(result.stdout || '').trim() || 'null'); } catch { /* plain text status */ }
  const loggedIn = parsed && typeof parsed === 'object'
    ? parsed.loggedIn === true
    : /\blogged[\s_-]*in\b/i.test(text) && !/\bloggedIn["']?\s*:\s*false\b/i.test(text);
  return {
    probed: true,
    loggedIn: Boolean(loggedIn),
    authMethod: parsed?.authMethod ?? null,
    apiProvider: parsed?.apiProvider ?? null,
    exitCode: result.status,
    detail: loggedIn ? 'subscription-signin-detected' : 'not-signed-in',
    // Never persist account emails, tokens, or project paths from auth output.
  };
}

export function runClaudeHostCanary(options = {}) {
  const repository = resolve(options.repository ?? process.cwd());
  const evidenceDir = resolve(options.evidenceDir ?? join(repository, 'verification', 'claude-canary'));
  mkdirSync(evidenceDir, { recursive: true });
  const run = options.runCommand ?? spawnSync;
  const environment = options.env ?? process.env;
  const preflight = preflightClaudeHost({ env: environment, runCommand: run });
  const status = claudeHostStatus({
    env: environment,
    runCommand: run,
    claudeHome: options.claudeHome,
  });
  const auth = probeClaudeAuthStatus(preflight.executable, environment, run);
  const evidence = {
    schema: 1,
    host: 'claude-code-cli',
    ranAt: new Date().toISOString(),
    repository,
    preflight,
    status,
    auth,
    liveSession: false,
    signedInWorkerDispatched: false,
    apiBillingUsed: false,
    credentialsCopied: false,
    supportClaim: false,
    outcome: !preflight.available
      ? 'claude-cli-absent; unavailable-capability-reported-honestly'
      : auth.loggedIn
        ? 'claude-cli-present; signed-in; host-lifecycle-ready; live-worker-canary-not-run'
        : 'claude-cli-present; not-signed-in; host-lifecycle-ready; live-signed-in-canary-blocked-on-auth',
  };
  const evidencePath = join(evidenceDir, 'latest-canary.json');
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return { ...evidence, evidencePath, fixturePresent: existsSync(join(repository, 'host-fixtures', 'claude-code', 'parity.json')) };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const result = runClaudeHostCanary();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = 0;
}

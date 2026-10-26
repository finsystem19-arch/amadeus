/** Explicit, origin-host Claude subscription worker canary. Never runs on import. */
import { readFileSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClaudeResult, runClaudeImplementation } from '../src/claude-adapter.ts';

export const CANARY_RESULT = 'AMADEUS_CLAUDE_AUTH_OK';

export function normalizeCanaryResult(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed.replace(/^(["'`])([\s\S]*)\1$/, '$2').trim();
}

function failureKind(result) {
  const detail = `${result.error ?? ''}\n${result.stderr ?? ''}`;
  if (/not logged in|authentication required|please.{0,40}(login|sign in)|auth(entication)? failed/i.test(detail)) return 'authentication-unavailable';
  if (/access.{0,20}denied|permission denied|\bEPERM\b|\bEACCES\b/i.test(detail)) return 'containment-permission';
  if (/requires --verbose|unknown option|invalid.{0,20}option/i.test(detail)) return 'cli-arguments';
  if (/NODE_OPTIONS|cannot find module|module not found/i.test(detail)) return 'runtime-bootstrap';
  if (/\bENOTFOUND\b|\bECONN|network|connect|fetch|dns/i.test(detail)) return 'network-unavailable';
  return result.exitCode === 0 ? 'invalid-result' : 'unclassified-cli-failure';
}

function sanitizedDiagnostics(result) {
  const lines = `${result.error ?? ''}\n${result.stderr ?? ''}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  return lines.slice(0, 12).map((line) => {
    if (/secret|token|(?:api|private)[_-]?key|credential|authorization|bearer/i.test(line)) return '<REDACTED_SENSITIVE_DIAGNOSTIC>';
    return line
      .replace(/[A-Za-z]:\\[^\s"']+/g, '<PATH>')
      .replace(/(?:sk-ant-|Bearer\s+)[A-Za-z0-9._-]+/gi, '<REDACTED>')
      .slice(0, 500);
  });
}

function streamEventKinds(stdout) {
  const kinds = [];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      const kind = [event?.type ?? 'unknown', event?.subtype ?? null, event?.is_error === true ? 'error' : 'ok']
        .filter(Boolean).join(':');
      if (!kinds.includes(kind)) kinds.push(kind);
    } catch { if (!kinds.includes('non-json')) kinds.push('non-json'); }
  }
  return kinds.slice(0, 12);
}

function streamFailure(stdout) {
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      if (event?.type !== 'result' || event?.is_error !== true) continue;
      const raw = typeof event.result === 'string' ? event.result : typeof event.error === 'string' ? event.error : '';
      const kind = /auth|login|sign in/i.test(raw) ? 'authentication'
        : /permission|denied|EPERM|EACCES/i.test(raw) ? 'permission'
          : /network|connect|fetch|dns|ENOTFOUND|ECONN|API Error/i.test(raw) ? 'network-or-provider'
            : /billing|credit|overage|payment/i.test(raw) ? 'billing'
              : 'provider-result-error';
      const summary = /secret|token|(?:api|private)[_-]?key|credential|authorization|bearer/i.test(raw)
        ? '<REDACTED_SENSITIVE_DIAGNOSTIC>'
        : raw.replace(/[A-Za-z]:\\[^\s"']+/g, '<PATH>').slice(0, 500);
      return { kind, subtype: event.subtype ?? null, summary };
    } catch { /* ignore non-JSON lines */ }
  }
  return null;
}

export async function runClaudeLiveWorkerCanary({ configPath, workspace, evidenceDir, runImplementation = runClaudeImplementation }) {
  if (!configPath || !workspace || !evidenceDir) throw new Error('configPath, workspace and evidenceDir are required');
  const config = JSON.parse(readFileSync(resolve(configPath), 'utf8'));
  const target = resolve(evidenceDir);
  mkdirSync(target, { recursive: true });
  const started = new Date().toISOString();
  const jobDirectory = join(resolve(config.runtimeConfigurationRoot), `claude-live-canary-${Date.now()}`);
  const result = await runImplementation(config, resolve(workspace),
    `Reply with exactly ${CANARY_RESULT}. Do not use tools or access files.`, jobDirectory);
  let receipt = null;
  try { if (result.exitCode === 0) receipt = parseClaudeResult(result.stdout); } catch { /* failure is recorded below */ }
  const matched = normalizeCanaryResult(receipt?.result) === CANARY_RESULT;
  const evidence = {
    schema: 1, ranAt: started, provider: 'claude-subscription-signin',
    adapter: 'runClaudeImplementation',
    success: result.exitCode === 0 && !result.timedOut && !result.aborted &&
      matched,
    resultMatched: matched,
    sessionPresent: Boolean(receipt?.sessionId),
    usagePresent: Boolean(receipt?.usage),
    exitCode: result.exitCode, timedOut: result.timedOut,
    timeoutKind: result.timeoutKind ?? null, aborted: result.aborted,
    errorKind: result.error ? 'adapter-error' : result.evidenceError ? 'evidence-error' : null,
    failureKind: result.exitCode === 0 && matched ? null : failureKind(result),
    diagnostics: result.exitCode === 0 && matched ? [] : sanitizedDiagnostics(result),
    streamEventKinds: result.exitCode === 0 && matched ? [] : streamEventKinds(result.stdout),
    streamFailure: result.exitCode === 0 && matched ? null : streamFailure(result.stdout),
    apiBillingUsed: false, credentialsCopied: false,
  };
  const evidencePath = join(target, 'latest-live-worker-canary.json');
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'w' });
  return { ...evidence, evidencePath };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [configPath, workspace, evidenceDir] = process.argv.slice(2);
  const evidence = await runClaudeLiveWorkerCanary({ configPath, workspace, evidenceDir });
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (!evidence.success) process.exitCode = 1;
}

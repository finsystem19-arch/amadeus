/** Origin-host Cursor adapter acceptance. Writes only sanitized evidence. */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeDevelopmentManifest } from "../src/development-project.ts";
import { materializeWorkspace, materializeWritableWorkspacePaths } from "../src/worker-isolation.ts";
import { prepareWorkspaceIsolationAcceptance } from "../src/workspace-isolation-acceptance.ts";
import { parseCursorResult, runCursorImplementation } from "../src/cursor-adapter.ts";
import { prepareWorkspaceRuntimeRoot } from "../src/worker-runtime-layout.ts";

export const CANARY_RESULT = "AMADEUS_CURSOR_AUTH_OK";

function args(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--") || !values[index + 1]) throw new Error(`Invalid argument: ${value}`);
    result[value.slice(2)] = values[++index];
  }
  return result;
}

function required(values, name) {
  const value = values[name];
  if (!value) throw new Error(`--${name} is required`);
  return resolve(value);
}

function normalizeCanaryResult(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed.replace(/^(["'`])([\s\S]*)\1$/, "$2").trim();
}

function sanitizedDiagnostics(result) {
  const lines = `${result.error ?? ""}\n${result.stderr ?? ""}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.slice(0, 12).map((line) => line
    .replace(/[A-Za-z]:\\[^\s"']+/g, "<PATH>")
    .replace(/(?:token|authorization|bearer)[=: ]+[^\s"']+/gi, "$1=<REDACTED>")
    .slice(0, 500));
}

export async function runCursorOriginHostCanary(options) {
  const projectRoot = resolve(options.projectRoot);
  const stateRoot = resolve(options.stateRoot);
  const savedConfigPath = resolve(options.savedConfig);
  // The acceptance receipt must be written under an existing protected root,
  // while the isolated workspace itself must not inherit that deny rule.
  const artifactRoot = join(resolve(options.savedConfig, ".."), "cursor-canary-evidence");
  const coordinatorStateRoot = resolve(savedConfigPath, "..", "..");
  const workspaceRoot = join(coordinatorStateRoot, "worker-workspaces");
  const manifestPath = join(stateRoot, "source.manifest.json");
  const configPath = join(stateRoot, "cursor-worker-config.json");
  for (const directory of [stateRoot, artifactRoot, workspaceRoot]) mkdirSync(directory, { recursive: true });
  if (!existsSync(savedConfigPath)) throw new Error(`Saved Cursor configuration does not exist: ${savedConfigPath}`);

  writeDevelopmentManifest(projectRoot, manifestPath);
  const workspaceId = `cursor-live-${Date.now()}`;
  const { workspace } = materializeWorkspace({ manifestPath, workspaceRoot, workspaceId });
  materializeWritableWorkspacePaths(workspace, []);
  const saved = JSON.parse(readFileSync(savedConfigPath, "utf8"));
  const config = {
    ...saved,
    enabled: true,
    dispatchAuthorized: true,
    implementationPrepared: true,
    implementationDispatchAuthorized: true,
    automaticStartup: false,
    readOnlyOnly: false,
    deniedSourceRoot: projectRoot,
    assignedProjectRoot: workspace,
    runtimeConfigurationRoot: prepareWorkspaceRuntimeRoot(workspace),
    authenticationFile: join(process.env.APPDATA ?? "", "Cursor", "auth.json"),
    isolationAcceptanceHarness: join(projectRoot, "src", "cursor-project-scope-acceptance.mjs"),
    isolationSecurityStateProbe: join(projectRoot, "src", "isolation-security-state.ps1"),
    writableWorkspacePaths: [],
    readIsolationVerified: false,
    readIsolationReceipt: null,
    writeIsolationVerified: false,
    writeIsolationReceipt: null,
  };
  const acceptedConfig = prepareWorkspaceIsolationAcceptance({
    adapter: "cursor", config, workspace, artifactRoot, workspaceId,
  });
  writeFileSync(configPath, `${JSON.stringify(acceptedConfig, null, 2)}\n`, "utf8");

  const result = await runCursorImplementation(
    acceptedConfig,
    workspace,
    `Reply with exactly ${CANARY_RESULT}. Do not use tools or access files.`,
    join(resolve(acceptedConfig.runtimeConfigurationRoot), `cursor-live-canary-${Date.now()}`),
  );
  let receipt = null;
  try { if (result.exitCode === 0) receipt = parseCursorResult(result.stdout); } catch { /* recorded below */ }
  const resultMatched = normalizeCanaryResult(receipt?.result) === CANARY_RESULT;
  const evidence = {
    schema: 1,
    ranAt: new Date().toISOString(),
    provider: "cursor-browser-login",
    adapter: "runCursorImplementation",
    success: result.exitCode === 0 && !result.timedOut && !result.aborted && resultMatched,
    resultMatched,
    sessionPresent: Boolean(receipt?.sessionId),
    usagePresent: Boolean(receipt?.usage),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    timeoutKind: result.timeoutKind ?? null,
    aborted: result.aborted ?? false,
    diagnostics: resultMatched ? [] : sanitizedDiagnostics(result),
    apiBillingUsed: false,
    credentialsCopied: false,
  };
  const evidencePath = join(artifactRoot, "latest-live-worker-canary.json");
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  if (!evidence.success) throw new Error(`The signed-in Cursor response did not pass through the Amadeus adapter: ${JSON.stringify(evidence)}`);
  return {
    success: true,
    provider: evidence.provider,
    workspace,
    configPath,
    isolationReceipt: acceptedConfig.writeIsolationReceipt,
    liveEvidence: evidencePath,
    credentialsCopied: false,
    apiBillingUsed: false,
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const values = args(process.argv.slice(2));
  const result = await runCursorOriginHostCanary({
    projectRoot: required(values, "project-root"),
    stateRoot: required(values, "state-root"),
    savedConfig: required(values, "saved-config"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

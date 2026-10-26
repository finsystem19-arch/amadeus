/** Origin-host Claude adapter acceptance. Writes only sanitized evidence. */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeDevelopmentManifest } from "../src/development-project.ts";
import { materializeWorkspace, materializeWritableWorkspacePaths } from "../src/worker-isolation.ts";
import { prepareWorkspaceIsolationAcceptance } from "../src/workspace-isolation-acceptance.ts";
import { parseClaudeResult, runClaudeImplementation } from "../src/claude-adapter.ts";
import { runClaudeLiveWorkerCanary } from "./claude-live-worker-canary.mjs";
import { prepareWorkspaceRuntimeRoot } from "../src/worker-runtime-layout.ts";

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

function readToolAttempted(stdout, sentinelPath) {
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    for (const part of event?.message?.content ?? []) {
      if (part?.type === "tool_use" && part?.name === "Read"
        && resolve(String(part?.input?.file_path ?? part?.input?.path ?? "")) === sentinelPath) return true;
    }
  }
  return false;
}

export async function runClaudeOriginHostCanary(options) {
  const projectRoot = resolve(options.projectRoot);
  const stateRoot = resolve(options.stateRoot);
  const artifactRoot = join(stateRoot, "evidence");
  const workspaceRoot = resolve(options.workspaceRoot);
  // MXC needs a readable traversal parent before a more specific child can be
  // writable. Keep that parent dedicated to the contained process rather than
  // widening the state root or exposing sibling workspaces/evidence.
  const containedAppData = resolve(options.containedAppData);
  const manifestPath = join(stateRoot, "source.manifest.json");
  const configPath = join(stateRoot, "claude-worker-config.json");
  for (const directory of [stateRoot, artifactRoot, workspaceRoot]) mkdirSync(directory, { recursive: true });
  writeDevelopmentManifest(projectRoot, manifestPath);
  const workspaceId = `claude-live-${Date.now()}`;
  const { workspace } = materializeWorkspace({ manifestPath, workspaceRoot, workspaceId });
  materializeWritableWorkspacePaths(workspace, []);
  const runtimeRoot = prepareWorkspaceRuntimeRoot(workspace);
  const containedUserProfile = resolve(options.containedUserProfile);
  const config = {
    schemaVersion: 1,
    enabled: true,
    dispatchAuthorized: true,
    automaticStartup: false,
    executable: resolve(options.claudeExecutable),
    executableArguments: options.claudeLauncherArgument
      ? ["--preserve-symlinks", "--preserve-symlinks-main", resolve(options.claudeLauncherArgument)]
      : [],
    containmentExecutable: resolve(options.containmentExecutable),
    containmentProfile: "claude_contained",
    containmentWindowsSandbox: "mxc",
    containedAppData,
    containedUsername: options.containedUsername,
    containedUserProfile,
    userInfoShim: resolve(options.userInfoShim),
    pathVerifierShim: resolve(options.pathVerifierShim),
    authentication: "subscription-signin",
    apiKeyAuthenticationAllowed: false,
    spendingRouteReviewed: true,
    readOnlyOnly: false,
    outputFormat: "stream-json",
    model: null,
    deniedSourceRoot: projectRoot,
    assignedProjectRoot: workspace,
    readableProjectRoots: [workspace],
    deniedParentPaths: [resolve(options.deniedParentPath)],
    protectedPaths: [join(workspace, ".git")],
    configurationDirectory: resolve(options.configurationDirectory),
    runtimeConfigurationRoot: runtimeRoot,
    maximumRuntimeSeconds: 180,
    maximumIdleSeconds: 60,
    writableWorkspacePaths: [],
    implementationPrepared: true,
    implementationDispatchAuthorized: true,
    readIsolationVerified: false,
    readIsolationReceipt: null,
    writeIsolationVerified: false,
    writeIsolationReceipt: null,
    developmentMode: false,
    isolationAcceptanceHarness: resolve(options.isolationAcceptanceHarness),
    isolationSecurityStateProbe: resolve(options.isolationSecurityStateProbe),
  };
  mkdirSync(config.containedUserProfile, { recursive: true });
  mkdirSync(config.containedAppData, { recursive: true });
  mkdirSync(join(config.containedUserProfile, "AppData", "Local"), { recursive: true });
  for (const [name, path] of Object.entries({
    claudeExecutable: config.executable,
    ...(options.claudeLauncherArgument ? { claudeLauncherArgument: resolve(options.claudeLauncherArgument) } : {}),
    containmentExecutable: config.containmentExecutable,
    configurationDirectory: config.configurationDirectory,
    userInfoShim: config.userInfoShim,
    pathVerifierShim: config.pathVerifierShim,
    isolationAcceptanceHarness: config.isolationAcceptanceHarness,
    isolationSecurityStateProbe: config.isolationSecurityStateProbe,
  })) if (!existsSync(path)) throw new Error(`${name} does not exist: ${path}`);

  const acceptedConfig = prepareWorkspaceIsolationAcceptance({
    adapter: "claude", config, workspace, artifactRoot, workspaceId,
  });
  writeFileSync(configPath, `${JSON.stringify(acceptedConfig, null, 2)}\n`, "utf8");
  const live = await runClaudeLiveWorkerCanary({ configPath, workspace, evidenceDir: artifactRoot });
  if (!live.success) throw new Error("The signed-in Claude response did not pass through the Amadeus adapter");

  const sentinelPath = join(config.configurationDirectory, `.amadeus-boundary-${workspaceId}.txt`);
  const sentinel = `BOUNDARY_${randomBytes(24).toString("hex").toUpperCase()}`;
  const boundaryEvidencePath = join(artifactRoot, "latest-credential-boundary-canary.json");
  let boundary;
  try {
    writeFileSync(sentinelPath, `${sentinel}\n`, { encoding: "utf8", flag: "wx" });
    const boundaryResult = await runClaudeImplementation(acceptedConfig, workspace,
      `Use the Read tool exactly once on ${JSON.stringify(sentinelPath)}. If access is denied, reply exactly AMADEUS_CLAUDE_BOUNDARY_DENIED. Never repeat file contents.`,
      join(runtimeRoot, `claude-boundary-${Date.now()}`));
    const receipt = boundaryResult.exitCode === 0 ? parseClaudeResult(boundaryResult.stdout) : null;
    boundary = {
      schema: 1,
      ranAt: new Date().toISOString(),
      provider: "claude-subscription-signin",
      adapter: "runClaudeImplementation",
      readToolAttempted: readToolAttempted(boundaryResult.stdout, sentinelPath),
      secretAbsentFromOutput: !boundaryResult.stdout.includes(sentinel) && !boundaryResult.stderr.includes(sentinel),
      deniedResultMatched: receipt?.result.trim() === "AMADEUS_CLAUDE_BOUNDARY_DENIED",
      exitCode: boundaryResult.exitCode,
      timedOut: boundaryResult.timedOut,
      aborted: boundaryResult.aborted,
      apiBillingUsed: false,
      credentialsCopied: false,
    };
    boundary.success = boundary.readToolAttempted && boundary.secretAbsentFromOutput && boundary.deniedResultMatched
      && boundary.exitCode === 0 && !boundary.timedOut && !boundary.aborted;
    writeFileSync(boundaryEvidencePath, `${JSON.stringify(boundary, null, 2)}\n`, "utf8");
  } finally {
    rmSync(sentinelPath, { force: true });
  }
  if (!boundary?.success) throw new Error("Claude restricted-mode credential boundary was not verified");
  return {
    success: true,
    provider: "claude-subscription-signin",
    workspace,
    configPath,
    isolationReceipt: acceptedConfig.writeIsolationReceipt,
    liveEvidence: live.evidencePath,
    boundaryEvidence: boundaryEvidencePath,
    credentialsCopied: false,
    apiBillingUsed: false,
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const values = args(process.argv.slice(2));
  const result = await runClaudeOriginHostCanary({
    projectRoot: required(values, "project-root"),
    stateRoot: required(values, "state-root"),
    workspaceRoot: required(values, "workspace-root"),
    claudeExecutable: required(values, "claude-executable"),
    claudeLauncherArgument: values["claude-launcher-argument"] ? resolve(values["claude-launcher-argument"]) : null,
    containmentExecutable: required(values, "containment-executable"),
    containedAppData: required(values, "contained-app-data"),
    containedUsername: values["contained-username"] ?? process.env.USERNAME ?? "contained-user",
    containedUserProfile: required(values, "contained-user-profile"),
    configurationDirectory: required(values, "configuration-directory"),
    userInfoShim: required(values, "user-info-shim"),
    pathVerifierShim: required(values, "path-verifier-shim"),
    isolationAcceptanceHarness: required(values, "isolation-acceptance-harness"),
    isolationSecurityStateProbe: required(values, "isolation-security-state-probe"),
    deniedParentPath: required(values, "denied-parent-path"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

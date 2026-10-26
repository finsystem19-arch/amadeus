import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { verifyWorkspace } from "./worker-isolation.ts";
import { terminateWorkerTree, WORKER_PROCESS_GROUP } from "./worker-process.ts";
import { WORKER_RUNTIME_DIRECTORY, workerRuntimeLayout } from "./worker-runtime-layout.ts";
import { isolationSecurityStateBinding } from "./isolation-security-state.ts";
import { assertNoWorkspaceReparsePoints, containedLaunch, denyByDefaultFilesystemPolicy, developmentFilesystemPolicy, normalizeProjectScope as normalizeSharedProjectScope, normalizeWritableWorkspacePaths as normalizeSharedWritablePaths, workspacePermissionEntries, writableParentChain as sharedWritableParentChain } from "./worker-sandbox.ts";
import { containedEnvelopeCore, containedSecurityBoundaryPaths, containedWriteReceiptChecks } from "./worker-receipts.ts";
import { processPlumbingEnvironment } from "./worker-environment.ts";

export type ClaudeAdapterConfig = {
  schemaVersion: 1;
  enabled: boolean;
  dispatchAuthorized: boolean;
  automaticStartup: boolean;
  executable: string;
  executableArguments?: string[];
  containmentExecutable: string;
  containmentProfile: "claude_contained";
  containmentWindowsSandbox: "mxc" | "elevated";
  containedAppData: string;
  containedUsername: string;
  containedUserProfile: string;
  userInfoShim: string;
  pathVerifierShim: string;
  authentication: "subscription-signin";
  apiKeyAuthenticationAllowed: false;
  spendingRouteReviewed: boolean;
  readOnlyOnly: boolean;
  /** stream-json for Claude Code; Grok Build's Messages-compatible equivalent for Grok. */
  outputFormat: "stream-json" | "streaming-messages-json";
  /** Which Claude-style CLI this config runs (default Claude Code). */
  cli?: "claude" | "grok";
  /** Capability-tier effort, passed to CLIs that accept one (Grok Build). */
  reasoningEffort?: string;
  model: string | null;
  deniedSourceRoot: string;
  assignedProjectRoot?: string;
  readableProjectRoots?: string[];
  deniedParentPaths?: string[];
  protectedPaths?: string[];
  configurationDirectory: string;
  runtimeConfigurationRoot: string;
  maximumRuntimeSeconds: number;
  maximumIdleSeconds?: number;
  writableWorkspacePaths?: string[];
  implementationPrepared?: boolean;
  implementationDispatchAuthorized?: boolean;
  readIsolationVerified?: boolean;
  readIsolationReceipt?: string | null;
  writeIsolationVerified?: boolean;
  writeIsolationReceipt?: string | null;
  developmentMode?: boolean;
  /** Shared with Codex workers: may a development worker run commands (default true). */
  workerCommandsEnabled?: boolean;
  isolationAcceptanceHarness?: string | null;
  isolationSecurityStateProbe?: string | null;
};

export type ClaudeWriteIsolationReceipt = {
  schemaVersion: 1;
  executableVersion: string;
  executableSha256: string;
  containmentExecutableSha256: string;
  adapterSha256: string;
  acceptanceHarnessPath: string;
  acceptanceHarnessSha256: string;
  isolationEnvelopeSha256: string;
  securityStateProbePath: string;
  securityStateProbeSha256: string;
  securityBoundaryPaths: string[];
  mutableBoundaryRoots: string[];
  hostSecurityStateFingerprint: string;
  workspace: string;
  writableWorkspacePaths: string[];
  authoritativeRepositoryDenied: boolean;
  outsideWorkspaceWritesDenied: true;
  unapprovedWorkspaceWritesDenied: true;
  /** False for development workers, which may read .git and the receipt (writes stay denied). */
  gitHistoryDenied: boolean;
  isolationReceiptDenied: boolean;
  developmentMode?: boolean;
  gitHistoryWritesDenied?: true;
  isolationReceiptWritesDenied?: true;
  deniedPathsProbed?: number;
  registeredProjectReadsAllowed?: true;
  unassignedProjectWritesDenied?: true;
  protectedPathsDenied?: true;
  parentUserDirectoryDenied?: true;
  containmentExecutable: string;
  containmentProfile: "claude_contained";
  containmentWindowsSandbox: "mxc" | "elevated";
  containedAppData: string;
  containedUsername: string;
  containedUserProfile: string;
  userInfoShim: string;
  userInfoShimSha256: string;
  runtimeConfigurationRoot: string;
  runtimeConfigurationWritesRestricted: true;
  runtimeConfigurationWriteProbePassed: true;
  runtimeConfigurationNeighborDenied: true;
  testedAt: string;
  apiKeyAuthenticationAllowed: false;
  credentialsCopied: false;
  authenticationDirectoryReadAllowed?: true;
};

export type ClaudeResultReceipt = {
  result: string;
  sessionId: string;
  requestId: string | null;
  durationMs: number | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  } | null;
};

export type ClaudeExecutionResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  timeoutKind?: "wall-clock" | "idle";
  aborted?: boolean;
  evidenceError?: string;
  stdout: string;
  stderr: string;
  error?: string;
};

export const CLAUDE_WORKER_SAFETY_ARGUMENTS = [
  "--safe-mode", "--restricted", "--strict-mcp-config",
  "--permission-mode", "acceptEdits", "--permission-prompts", "none",
  "--no-session-persistence", "--verbose",
] as const;

/**
 * Tools a development Claude worker may use without a prompt. Restricted mode
 * removes command tools unless named, and the contained process cannot always
 * resolve its workspace's parent folders, so writes would otherwise need a
 * person. The MXC sandbox, not the prompt, is the boundary for these tools.
 */
export const CLAUDE_FILE_TOOLS = "Read,Edit,Write,Glob,Grep";

/**
 * Arguments for a development Claude worker, kept equal to a Codex development
 * worker: the MXC sandbox and project scope are the boundary, and the owner's
 * workerCommandsEnabled setting (default on) decides for both providers whether
 * the worker may run commands. --restricted is not used here: inside the sandbox
 * it cannot resolve the workspace's parent folders and so refuses every write.
 * No settings files, CLAUDE.md, hooks, plugins or MCP servers are loaded.
 */
export function claudeDevelopmentArguments(commandsEnabled: boolean, platform: NodeJS.Platform = process.platform): string[] {
  // Git Bash (MSYS) cannot start inside the Windows MXC sandbox (0xC0000142);
  // PowerShell can, and is what Codex workers use on Windows too.
  const tools = commandsEnabled ? `${platform === "win32" ? "PowerShell" : "Bash"},${CLAUDE_FILE_TOOLS}` : CLAUDE_FILE_TOOLS;
  return ["--safe-mode", "--strict-mcp-config", "--setting-sources", "",
    "--tools", tools, "--allowedTools", tools,
    "--permission-mode", "acceptEdits", "--permission-prompts", "none",
    "--no-session-persistence", "--verbose"];
}

/** Grok Build tool ids for its built-in web access and subagents, which workers never use. */
const GROK_DENIED_TOOLS = ["web_search", "web_fetch", "Agent"];

/**
 * Arguments for a development Grok Build worker, equal in effect to a Claude or
 * Codex development worker: the MXC sandbox and project scope are the boundary;
 * file tools are approved without a prompt; commands follow the shared
 * workerCommandsEnabled setting; web access and subagents are removed; no
 * background update checks. Built from xAI's published headless-mode flags and
 * not yet run on a signed-in machine (the provider is opt-in until it is).
 */
export function grokDevelopmentArguments(commandsEnabled: boolean, options: { model?: string | null; reasoningEffort?: string | null } = {}): string[] {
  const denied = commandsEnabled ? GROK_DENIED_TOOLS : [...GROK_DENIED_TOOLS, "run_terminal_cmd"];
  return [
    "--output-format", "streaming-messages-json", "--no-auto-update",
    "--disallowed-tools", denied.join(","),
    "--allow", "Read", "--allow", "Grep", "--allow", "Edit", "--allow", "Write",
    ...(commandsEnabled ? ["--allow", "Bash"] : []),
    ...(options.model?.trim() ? ["--model", options.model.trim()] : []),
    ...(options.reasoningEffort?.trim() && options.reasoningEffort !== "none" ? ["--effort", options.reasoningEffort.trim()] : []),
  ];
}

function claudeWorkerArguments(config: ClaudeAdapterConfig): readonly string[] {
  return config.developmentMode && !config.readOnlyOnly
    ? claudeDevelopmentArguments(config.workerCommandsEnabled !== false) : CLAUDE_WORKER_SAFETY_ARGUMENTS;
}

const claudeAdapterPath = fileURLToPath(import.meta.url);
export type ClaudeSpawn = typeof spawn;
let claudeSpawnForTests: ClaudeSpawn = spawn;

export function setClaudeSpawnForTests(value: ClaudeSpawn): () => void {
  const previous = claudeSpawnForTests;
  claudeSpawnForTests = value;
  return () => { claudeSpawnForTests = previous; };
}

function sha256File(path: string): string {
  if (!isAbsolute(path) || !existsSync(path)) throw new Error(`Required Claude isolation binding file is missing: ${path}`);
  return createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase();
}

function assertSafeConfig(config: ClaudeAdapterConfig, workspace: string): string {
  if (config.schemaVersion !== 1) throw new Error("Unsupported Claude adapter config");
  if (config.authentication !== "subscription-signin" || config.apiKeyAuthenticationAllowed !== false) {
    throw new Error("Claude adapter permits subscription sign-in only; API-key billing is prohibited");
  }
  const expectedFormat = config.cli === "grok" ? "streaming-messages-json" : "stream-json";
  if (config.outputFormat !== expectedFormat) throw new Error(`${config.cli === "grok" ? "Grok" : "Claude"} adapter requires ${expectedFormat} receipts`);
  if (!Number.isSafeInteger(config.maximumRuntimeSeconds) || config.maximumRuntimeSeconds < 0
    || config.maximumIdleSeconds !== undefined && (!Number.isSafeInteger(config.maximumIdleSeconds) || config.maximumIdleSeconds < 0)) {
    throw new Error("Invalid Claude timeout");
  }
  if (!isAbsolute(config.deniedSourceRoot) || !isAbsolute(config.configurationDirectory)
    || !isAbsolute(config.containmentExecutable) || !isAbsolute(config.containedAppData)
    || !isAbsolute(config.containedUserProfile) || !isAbsolute(config.userInfoShim) || !isAbsolute(config.pathVerifierShim)
    || !isAbsolute(config.runtimeConfigurationRoot)) {
    throw new Error("Claude denied source, configuration, containment, and profile paths must be absolute");
  }
  if (!config.containedUsername.trim() || !existsSync(config.userInfoShim) || !existsSync(config.pathVerifierShim)) {
    throw new Error("Claude contained Windows identity fallback is incomplete");
  }
  const resolvedWorkspace = resolve(workspace);
  if (relative(resolvedWorkspace, resolve(config.runtimeConfigurationRoot)) !== WORKER_RUNTIME_DIRECTORY) {
    throw new Error(`Claude runtimeConfigurationRoot must be the ${WORKER_RUNTIME_DIRECTORY} child of the isolated workspace`);
  }
  if (config.containmentProfile !== "claude_contained" || config.containmentWindowsSandbox !== "mxc") {
    throw new Error("Claude workers require the explicit MXC claude_contained sandbox");
  }
  if (!isAbsolute(config.executable) || (config.executableArguments !== undefined
    && (!Array.isArray(config.executableArguments) || config.executableArguments.some((value) => typeof value !== "string" || !value)))) {
    throw new Error("Claude executable must be absolute and launcher arguments must be nonempty strings");
  }
  const deniedRoot = resolve(config.deniedSourceRoot);
  const workspaceKey = resolvedWorkspace.toLowerCase();
  const deniedKey = deniedRoot.toLowerCase();
  if (workspaceKey === deniedKey || workspaceKey.startsWith(`${deniedKey}\\`) || workspaceKey.startsWith(`${deniedKey}/`)) {
    throw new Error("Claude workspace must not be inside the authoritative repository");
  }
  verifyWorkspace(resolvedWorkspace);
  assertNoWorkspaceReparsePoints(resolvedWorkspace, "Claude");
  return resolvedWorkspace;
}

export function resolveClaudeExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  pathExists: (path: string) => boolean = existsSync,
): string | null {
  const explicit = environment.CLAUDE_EXECUTABLE?.trim();
  if (explicit) return explicit;
  const userProfile = environment.USERPROFILE?.trim() || environment.HOME?.trim();
  if (userProfile) {
    for (const candidate of [
      join(userProfile, "AppData", "Roaming", "npm", "claude.cmd"),
      join(userProfile, "AppData", "Roaming", "npm", "claude"),
      join(userProfile, ".local", "bin", "claude"),
    ]) {
      if (pathExists(candidate)) return candidate;
    }
  }
  return null;
}

export function buildClaudeEnvironment(
  config: ClaudeAdapterConfig,
  configurationDirectory = config.configurationDirectory,
  workspace?: string,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const resolvedConfigurationDirectory = resolve(configurationDirectory);
  const containedProfile = resolve(config.containedUserProfile);
  const containedDrive = containedProfile.match(/^[A-Za-z]:/)?.[0] ?? "";
  const containedHomePath = containedDrive ? containedProfile.slice(containedDrive.length) : containedProfile;
  const temporaryDirectory = resolve(resolvedConfigurationDirectory, "tmp");
  const environment: NodeJS.ProcessEnv = {
    // Workers inherit only process plumbing (see worker-environment.ts).
    ...processPlumbingEnvironment(sourceEnvironment),
    CI: "1",
    AMADEUS_WORKER: "1",
    APPDATA: resolve(config.containedAppData),
    // Keep sign-in state in place and read-only. The per-job directory is used
    // only for temp/cache output below; redirecting CLAUDE_CONFIG_DIR there
    // makes an already signed-in Claude installation appear logged out.
    CLAUDE_CONFIG_DIR: resolve(config.configurationDirectory),
    // Grok Build keeps its sign-in in GROK_HOME (default ~/.grok); HOME is redirected below.
    ...(config.cli === "grok" ? { GROK_HOME: resolve(config.configurationDirectory) } : {}),
    CLAUDE_CONTAINED_USERNAME: config.containedUsername,
    CLAUDE_CONTAINED_HOME: containedProfile,
    CLAUDE_CONTAINED_WORKSPACE: workspace ? resolve(workspace) : "",
    USERNAME: config.containedUsername,
    USERPROFILE: containedProfile,
    HOME: containedProfile,
    HOMEDRIVE: containedDrive,
    HOMEPATH: containedHomePath,
    LOCALAPPDATA: join(containedProfile, "AppData", "Local"),
    NODE_COMPILE_CACHE: resolve(resolvedConfigurationDirectory, "node-cache"),
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    TMPDIR: temporaryDirectory,
  };
  return environment;
}

export function buildClaudeInvocation(config: ClaudeAdapterConfig, workspace: string, objective: string): string[] {
  if (!objective.trim()) throw new Error("objective is required");
  assertSafeConfig(config, workspace);
  if (!config.readOnlyOnly) throw new Error("Read-only Claude invocation requires readOnlyOnly=true");
  const args = ["-p", ...CLAUDE_WORKER_SAFETY_ARGUMENTS, "--output-format", config.outputFormat];
  if (config.model?.trim()) args.push("--model", config.model.trim());
  args.push(objective.trim());
  if (args.some((value) => /dangerously-skip-permissions|dangerously-skip-permissions/i.test(value) || value === "--dangerously-skip-permissions")) {
    throw new Error("Claude adapter must never skip permissions");
  }
  return args;
}

export function buildClaudeContainmentLaunch(
  config: ClaudeAdapterConfig,
  workspace: string,
  workerArgs: string[],
  writableWorkspacePaths: string[] = [],
  runtimeWritableDirectory?: string,
): { executable: string; args: string[]; cwd: string } {
  const cwd = assertSafeConfig(config, workspace);
  const writablePaths = writableWorkspacePaths.length > 0 ? normalizeSharedWritablePaths(writableWorkspacePaths, { label: "Claude", required: true }) : [];
  const deniedRoot = resolve(config.deniedSourceRoot);
  const runtimeWrite = runtimeWritableDirectory ? resolve(runtimeWritableDirectory) : null;
  const runtimePermissions = workerRuntimeLayout(config.runtimeConfigurationRoot, runtimeWrite ?? undefined);
  const metadataAccess = config.developmentMode ? "read" : "deny";
  const workspacePermissions = workspacePermissionEntries(writablePaths, metadataAccess);
  const projectScope = normalizeSharedProjectScope(config, { label: "Claude", deniedPaths: "outside-projects" });
  const absoluteWorkspaceWrites = [...new Set(writablePaths.map((path) => resolve(cwd, path)))];
  const launcherReadPaths = (config.executableArguments ?? [])
    .filter((value) => isAbsolute(value) && existsSync(value))
    .flatMap((path) => [resolve(path), dirname(resolve(path))]);
  const processReadPaths = [dirname(config.executable), ...launcherReadPaths, config.containedAppData, config.configurationDirectory,
    config.userInfoShim, config.pathVerifierShim];
  const filesystem = !projectScope
    ? `":root"="read",":workspace_roots"={${workspacePermissions}},${JSON.stringify(deniedRoot)}="${config.developmentMode ? "read" : "deny"}"${runtimePermissions}`
    : config.developmentMode && !config.readOnlyOnly
      // The same development policy as Codex workers (see worker-sandbox.ts).
      ? developmentFilesystemPolicy({ scope: projectScope, workspace: cwd, writablePaths, metadataAccess, processReadPaths, runtimePermissions,
        extraDenies: config.writeIsolationReceipt && isAbsolute(config.writeIsolationReceipt) ? [dirname(resolve(config.writeIsolationReceipt))] : [] })
      : denyByDefaultFilesystemPolicy({ scope: projectScope, workspacePermissions, absoluteWorkspaceWrites, runtimePermissions, processReadPaths });
  return containedLaunch({ containmentExecutable: config.containmentExecutable, sandbox: config.containmentWindowsSandbox,
    profile: config.containmentProfile, description: "Claude contained worker", filesystem, networkEnabled: true,
    cwd, executable: config.executable, executableArguments: config.executableArguments, args: workerArgs });
}

export function buildClaudeImplementationPlan(config: ClaudeAdapterConfig, workspace: string, objective: string): {
  executable: string;
  args: string[];
  cwd: string;
  launched: false;
} {
  if (!objective.trim()) throw new Error("objective is required");
  const cwd = assertSafeConfig(config, workspace);
  normalizeSharedWritablePaths(config.writableWorkspacePaths, { label: "Claude", required: true });
  if (config.cli === "grok") {
    if (!config.developmentMode || config.readOnlyOnly) throw new Error("Grok workers run only as development workers");
    const args = [...grokDevelopmentArguments(config.workerCommandsEnabled !== false, config), "-p", objective.trim()];
    if (args.some((value) => /^--yolo$|bypassPermissions/.test(value))) throw new Error("Grok adapter must never auto-approve every tool");
    return { executable: config.executable, args, cwd, launched: false };
  }
  const args = ["-p", ...claudeWorkerArguments(config), "--output-format", config.outputFormat];
  if (config.model?.trim()) args.push("--model", config.model.trim());
  args.push(objective.trim());
  if (args.includes("--dangerously-skip-permissions") || args.includes("bypassPermissions")) {
    throw new Error("Claude adapter must never skip permissions");
  }
  return { executable: config.executable, args, cwd, launched: false };
}

export function claudeIsolationEnvelopeSha256(config: ClaudeAdapterConfig, workspace: string): string {
  if (!config.isolationAcceptanceHarness || !isAbsolute(config.isolationAcceptanceHarness)) {
    throw new Error("Claude isolation acceptance harness is not configured");
  }
  const writablePaths = normalizeSharedWritablePaths(config.writableWorkspacePaths ?? [], { label: "Claude", required: true });
  const projectScope = normalizeSharedProjectScope(config, { label: "Claude", deniedPaths: "outside-projects" });
  const plan = buildClaudeImplementationPlan({ ...config, writableWorkspacePaths: writablePaths }, workspace, "isolation-envelope-fingerprint");
  const launch = buildClaudeContainmentLaunch(config, workspace, plan.args, writablePaths);
  const permissionDefinition = launch.args.find((value) => value.startsWith(`permissions.${config.containmentProfile}=`));
  if (!permissionDefinition) throw new Error("Claude effective containment profile could not be derived");
  const launcherArtifacts = (config.executableArguments ?? [])
    .filter((value) => isAbsolute(value) && existsSync(value))
    .map((path) => ({ path: resolve(path), sha256: sha256File(path) }));
  const payload = JSON.stringify({
    ...containedEnvelopeCore(config, workspace, projectScope, launcherArtifacts, sha256File),
    runtimeConfigurationRoot: resolve(config.runtimeConfigurationRoot),
    writableWorkspacePaths: writablePaths,
    authentication: config.authentication,
    apiKeyAuthenticationAllowed: config.apiKeyAuthenticationAllowed,
    developmentMode: config.developmentMode === true,
    readOnlyOnly: config.readOnlyOnly,
    invocationArguments: plan.args.slice(0, -1),
    permissionDefinition,
    acceptanceHarnessPath: resolve(config.isolationAcceptanceHarness),
  });
  return createHash("sha256").update(payload).digest("hex").toUpperCase();
}

export function claudeIsolationSecurityState(
  config: ClaudeAdapterConfig,
  workspace: string,
  receiptPath = config.writeIsolationReceipt ?? config.readIsolationReceipt,
) {
  const writablePaths = normalizeSharedWritablePaths(config.writableWorkspacePaths ?? [], { label: "Claude", required: true });
  if (!receiptPath || !isAbsolute(receiptPath)) throw new Error("Claude isolation receipt path must be configured before acceptance");
  const projectScope = normalizeSharedProjectScope(config, { label: "Claude", deniedPaths: "outside-projects" });
  const mutableParents = sharedWritableParentChain(workspace, writablePaths, "Claude");
  const mutableRoots = [...mutableParents, resolve(config.configurationDirectory), resolve(config.runtimeConfigurationRoot)];
  return isolationSecurityStateBinding(config.isolationSecurityStateProbe, "claude", workspace,
    containedSecurityBoundaryPaths(config, workspace, projectScope, receiptPath, writablePaths, mutableParents), mutableRoots);
}

function readClaudeExecutableVersion(config: ClaudeAdapterConfig): string {
  const result = spawnSync(config.executable, [...(config.executableArguments ?? []), "--version"], {
    encoding: "utf8", shell: false, env: buildClaudeEnvironment(config), timeout: 15_000,
  });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    throw new Error("Claude executable version could not be verified");
  }
  return result.stdout.trim();
}

function validatedWriteIsolationReceipt(config: ClaudeAdapterConfig, workspace: string): ClaudeWriteIsolationReceipt | undefined {
  // Development workers may read the registered project, the workspace .git and
  // its receipt (as Codex development workers do); every write stays denied.
  const development = config.developmentMode === true;
  if (!config.writeIsolationVerified || !config.writeIsolationReceipt || !isAbsolute(config.writeIsolationReceipt)) {
    throw new Error("Claude write isolation receipt is required before dispatch");
  }
  if (!existsSync(config.writeIsolationReceipt)) throw new Error("Claude write-isolation receipt is missing");
  const receipt = JSON.parse(readFileSync(config.writeIsolationReceipt, "utf8")) as ClaudeWriteIsolationReceipt;
  const expectedPaths = normalizeSharedWritablePaths(config.writableWorkspacePaths, { label: "Claude", required: true });
  const executableVersion = readClaudeExecutableVersion(config);
  const securityState = claudeIsolationSecurityState(config, workspace, config.writeIsolationReceipt);
  const scoped = Boolean(normalizeSharedProjectScope(config, { label: "Claude", deniedPaths: "outside-projects" }));
  const checks: Array<[string, boolean]> = [
    ...containedWriteReceiptChecks({ receipt, config, workspace, executableVersion, adapterPath: claudeAdapterPath,
      envelopeSha256: claudeIsolationEnvelopeSha256(config, workspace), expectedWritablePaths: expectedPaths, scoped, securityState, sha256File }),
    // Claude-style only: development workers may read the project, .git and the receipt; writes stay denied.
    ["authoritative repository probe", receipt.authoritativeRepositoryDenied === !development],
    ["git probe", development ? receipt.gitHistoryWritesDenied === true : receipt.gitHistoryDenied === true],
    ["isolation receipt probe", development ? receipt.isolationReceiptWritesDenied === true : receipt.isolationReceiptDenied === true],
    ["API billing", receipt.apiKeyAuthenticationAllowed === false], ["credential copying", receipt.credentialsCopied === false],
    ["authentication directory probe", receipt.authenticationDirectoryReadAllowed === true],
  ];
  const mismatches = checks.filter(([, valid]) => !valid).map(([name]) => name);
  if (mismatches.length > 0) {
    throw new Error(`Claude write-isolation receipt is stale or incomplete (${mismatches.join(", ")}); rerun the approved non-model host acceptance`);
  }
  return receipt;
}

export function assertClaudeImplementationDispatchAllowed(config: ClaudeAdapterConfig, workspace: string): ClaudeWriteIsolationReceipt | undefined {
  if (!config.enabled || !config.dispatchAuthorized || !config.implementationDispatchAuthorized) {
    throw new Error("Claude implementation dispatch is disabled");
  }
  if (!config.implementationPrepared) throw new Error("Claude implementation adapter is not prepared");
  if (config.automaticStartup) throw new Error("Claude automatic startup must remain disabled");
  if (!config.spendingRouteReviewed) throw new Error("Claude spending route has not been reviewed");
  assertSafeConfig(config, workspace);
  if (config.readOnlyOnly) throw new Error("Claude configuration remains read-only");
  buildClaudeImplementationPlan(config, workspace, "dispatch-boundary-check");
  return validatedWriteIsolationReceipt(config, workspace);
}

function saveClaudeEvidence(
  evidence: { stdout: string; stderr: string; captureWorkspace?: boolean },
  sink?: (evidence: { stdout: string; stderr: string; captureWorkspace?: boolean }) => void,
): string | undefined {
  try { sink?.(evidence); return undefined; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}

function spawnClaude(
  config: ClaudeAdapterConfig,
  args: string[],
  workspace: string,
  configurationDirectory: string,
  signal?: AbortSignal,
  options: { spawn?: ClaudeSpawn; terminate?: (child: ReturnType<ClaudeSpawn>) => void; onEvidence?: (evidence: { stdout: string; stderr: string; captureWorkspace?: boolean }) => void } = {},
): Promise<ClaudeExecutionResult> {
  const effectiveSpawn = options.spawn ?? claudeSpawnForTests;
  return new Promise((resolveResult) => {
    mkdirSync(resolve(configurationDirectory, "tmp"), { recursive: true });
    const writablePaths = config.readOnlyOnly ? [] : normalizeSharedWritablePaths(config.writableWorkspacePaths, { label: "Claude", required: true });
    const launch = buildClaudeContainmentLaunch(config, workspace, args, writablePaths, configurationDirectory);
    const child = effectiveSpawn(launch.executable, launch.args, {
      cwd: launch.cwd,
      env: buildClaudeEnvironment(config, configurationDirectory, workspace),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: WORKER_PROCESS_GROUP,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeoutKind: "wall-clock" | "idle" | undefined;
    let aborted = false;
    let settled = false;
    let evidenceError: string | undefined;
    const persist = (captureWorkspace = false) => {
      evidenceError ??= saveClaudeEvidence({ stdout, stderr, captureWorkspace }, options.onEvidence);
    };
    const idleMilliseconds = (config.maximumIdleSeconds ?? 180) * 1000;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = config.maximumRuntimeSeconds > 0
      ? setTimeout(() => { timedOut = true; timeoutKind = "wall-clock"; persist(true); abort(); }, config.maximumRuntimeSeconds * 1000)
      : undefined;
    const closeTimers = () => { clearTimeout(timer); clearTimeout(idleTimer); };
    const finish = (result: { exitCode: number | null; signal: NodeJS.Signals | null; error?: string }) => {
      if (settled) return;
      settled = true;
      closeTimers();
      signal?.removeEventListener("abort", handleOwnerAbort);
      persist(true);
      resolveResult({ ...result, timedOut, timeoutKind, aborted, evidenceError, stdout, stderr });
    };
    const abort = () => {
      try { (options.terminate ?? terminateWorkerTree)(child); }
      catch (error) { stderr += `\n${String(error)}`; child.kill(); }
    };
    const markActivity = () => {
      persist(false);
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { timedOut = true; timeoutKind = "idle"; abort(); }, idleMilliseconds);
      }
    };
    const handleOwnerAbort = () => { aborted = true; persist(true); abort(); };
    signal?.addEventListener("abort", handleOwnerAbort, { once: true });
    if (signal?.aborted) { aborted = true; abort(); }
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; markActivity(); });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; markActivity(); });
    if (idleMilliseconds > 0) idleTimer = setTimeout(() => { timedOut = true; timeoutKind = "idle"; persist(true); abort(); }, idleMilliseconds);
    child.on("error", (error) => finish({ exitCode: null, signal: null, error: error.message }));
    child.on("close", (exitCode, childSignal) => finish({ exitCode, signal: childSignal }));
  });
}

export async function runClaudeImplementation(
  config: ClaudeAdapterConfig,
  workspace: string,
  objective: string,
  jobConfigurationDirectory: string,
  signal?: AbortSignal,
  options: { spawn?: ClaudeSpawn; terminate?: (child: ReturnType<ClaudeSpawn>) => void; onEvidence?: (evidence: { stdout: string; stderr: string; captureWorkspace?: boolean }) => void } = {},
): Promise<ClaudeExecutionResult> {
  assertClaudeImplementationDispatchAllowed(config, workspace);
  const plan = buildClaudeImplementationPlan(config, workspace, objective);
  const runtimeRoot = resolve(config.runtimeConfigurationRoot);
  const resolvedJobConfig = resolve(jobConfigurationDirectory);
  const runtimeRelative = relative(runtimeRoot, resolvedJobConfig);
  if (!runtimeRelative || runtimeRelative.startsWith(`..${sep}`) || runtimeRelative === ".." || isAbsolute(runtimeRelative)) {
    throw new Error("Claude job configuration must be inside runtimeConfigurationRoot");
  }
  mkdirSync(resolvedJobConfig, { recursive: true });
  writeFileSync(resolve(resolvedJobConfig, "dispatch-plan.json"), `${JSON.stringify({ ...plan, credentialsCopied: false, apiKeyAuthenticationAllowed: false }, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  const result = await spawnClaude(config, plan.args, plan.cwd, resolvedJobConfig, signal, options);
  if (result.exitCode === 0 && !result.timedOut && !result.aborted) {
    try { parseClaudeResult(result.stdout); }
    catch (error) {
      return {
        ...result,
        exitCode: 1,
        error: `Claude exited without one verified success result: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return result;
}

export function parseClaudeResult(jsonl: string): ClaudeResultReceipt {
  const results: ClaudeResultReceipt[] = [];
  for (const line of jsonl.split(/\r?\n/).filter(Boolean)) {
    let event: unknown;
    try { event = JSON.parse(line); }
    catch { continue; }
    if (typeof event !== "object" || event === null) continue;
    const item = event as Record<string, unknown>;
    if (item.type !== "result") continue;
    const isError = item.is_error === true || item.subtype === "error";
    if (isError) continue;
    const resultText = typeof item.result === "string" ? item.result
      : typeof item.content === "string" ? item.content
      : null;
    const sessionId = typeof item.session_id === "string" ? item.session_id
      : typeof item.sessionId === "string" ? item.sessionId
      : null;
    if (!resultText || !sessionId) continue;
    const usageRaw = item.usage;
    let usage: ClaudeResultReceipt["usage"] = null;
    if (usageRaw !== undefined) {
      if (typeof usageRaw !== "object" || usageRaw === null) throw new Error("Claude result usage is malformed");
      const record = usageRaw as Record<string, unknown>;
      const inputTokens = Number(record.input_tokens ?? record.inputTokens);
      const outputTokens = Number(record.output_tokens ?? record.outputTokens);
      const cacheReadTokens = Number(record.cache_read_input_tokens ?? record.cacheReadTokens ?? 0);
      const cacheWriteTokens = Number(record.cache_creation_input_tokens ?? record.cacheWriteTokens ?? 0);
      if (![inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].every((value) => Number.isSafeInteger(value) && value >= 0)) {
        throw new Error("Claude result usage token fields are malformed");
      }
      usage = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
    }
    results.push({
      result: resultText,
      sessionId,
      requestId: typeof item.request_id === "string" ? item.request_id : typeof item.requestId === "string" ? item.requestId : null,
      durationMs: Number.isFinite(item.duration_ms) ? Number(item.duration_ms) : Number.isFinite(item.durationMs) ? Number(item.durationMs) : null,
      usage,
    });
  }
  if (results.length !== 1) throw new Error(`Expected exactly one successful Claude result event; found ${results.length}`);
  return results[0];
}

export function inspectClaudeCli(config: Partial<ClaudeAdapterConfig> & { executable?: string }): Record<string, unknown> {
  if (config.enabled !== true) {
    return { installed: false, modelInvoked: false, reason: "Optional Claude is disabled", supportClaim: false };
  }
  if (typeof config.executable !== "string" || !config.executable.trim()) {
    return { installed: false, modelInvoked: false, reason: "Optional Claude is not configured", supportClaim: false };
  }
  if (config.authentication && config.authentication !== "subscription-signin") {
    return { installed: false, modelInvoked: false, reason: "Claude API-key authentication is prohibited", supportClaim: false };
  }
  if ((config.apiKeyAuthenticationAllowed as unknown) === true) {
    return { installed: false, modelInvoked: false, reason: "Claude API-key billing is prohibited", supportClaim: false };
  }
  const version = spawnSync(config.executable, [...(config.executableArguments ?? []), "--version"], {
    encoding: "utf8", shell: false, timeout: 15_000,
  });
  if (version.error || version.status !== 0) {
    return {
      installed: false,
      executable: config.executable,
      modelInvoked: false,
      error: version.error?.message || version.stderr || "version probe failed",
      supportClaim: false,
    };
  }
  return {
    installed: true,
    executable: config.executable,
    version: String(version.stdout || version.stderr || "").trim(),
    modelInvoked: false,
    billing: "subscription-signin-only",
    supportClaim: false,
  };
}

export function qualifyClaudeDispatchBoundaries(config: ClaudeAdapterConfig, workspace: string): {
  workspace: true;
  reads: true;
  writes: boolean;
  shell: boolean;
  history: true;
  credentials: true;
  network: true;
  patch: boolean;
} {
  assertSafeConfig(config, workspace);
  const writable = normalizeSharedWritablePaths(config.writableWorkspacePaths ?? [], { label: "Claude", required: true });
  return {
    workspace: true,
    reads: true,
    writes: !config.readOnlyOnly && writable.length > 0,
    shell: Boolean(config.developmentMode) && !config.readOnlyOnly,
    history: true,
    credentials: true,
    network: true,
    patch: !config.readOnlyOnly && writable.length > 0,
  };
}

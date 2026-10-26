import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { spawn, spawnSync } from "node:child_process";
import { verifyWorkspace } from "./worker-isolation.ts";
import { terminateWorkerTree } from "./worker-process.ts";
import { WORKER_RUNTIME_DIRECTORY, workerRuntimeLayout } from "./worker-runtime-layout.ts";
import { isolationSecurityStateBinding } from "./isolation-security-state.ts";
import { developerToolEnvironment } from "./worker-environment.ts";
import { assertWorkspaceOutsideProject, assertNoWorkspaceReparsePoints, containedLaunch, denyByDefaultFilesystemPolicy, normalizeProjectScope as normalizeSharedProjectScope, normalizeWritableWorkspacePaths as normalizeSharedWritablePaths, workspacePermissionEntries, writableParentChain as sharedWritableParentChain } from "./worker-sandbox.ts";
import { containedEnvelopeCore, containedSecurityBoundaryPaths, containedWriteReceiptChecks } from "./worker-receipts.ts";

export type CursorAdapterConfig = {
  schemaVersion: 1;
  enabled: boolean;
  dispatchAuthorized: boolean;
  automaticStartup: boolean;
  executable: string;
  executableArguments?: string[];
  containmentExecutable: string;
  containmentProfile: "cursor_contained";
  containmentWindowsSandbox: "mxc" | "elevated";
  containedAppData: string;
  containedUsername: string;
  containedUserProfile: string;
  userInfoShim: string;
  pathVerifierShim: string;
  authentication: "browser-login";
  apiKeyAuthenticationAllowed: false;
  spendingRouteReviewed: boolean;
  readOnlyOnly: boolean;
  mode: "ask";
  sandbox: "disabled";
  model: string | null;
  outputFormat: "stream-json";
  deniedSourceRoot: string;
  assignedProjectRoot?: string;
  readableProjectRoots?: string[];
  deniedParentPaths?: string[];
  protectedPaths?: string[];
  configurationDirectory: string;
  authenticationFile: string;
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
  isolationAcceptanceHarness?: string | null;
  isolationSecurityStateProbe?: string | null;
};

export type CursorWriteIsolationReceipt = {
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
  gitHistoryDenied: true;
  isolationReceiptDenied: true;
  registeredProjectReadsAllowed?: true;
  unassignedProjectWritesDenied?: true;
  protectedPathsDenied?: true;
  parentUserDirectoryDenied?: true;
  containmentExecutable: string;
  containmentProfile: "cursor_contained";
  containmentWindowsSandbox: "mxc" | "elevated";
  containedAppData: string;
  containedUsername: string;
  containedUserProfile: string;
  userInfoShim: string;
  userInfoShimSha256: string;
  cursorSandboxMode: "disabled";
  runtimeConfigurationRoot: string;
  runtimeConfigurationWritesRestricted: true;
  runtimeConfigurationWriteProbePassed: true;
  runtimeConfigurationNeighborDenied: true;
  testedAt: string;
};

export type CursorReadIsolationReceipt = {
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
  authoritativeRepositoryDenied: boolean;
  outsideWorkspaceReadsDenied: true;
  gitHistoryDenied: true;
  protectedEvidenceDenied: true;
  registeredProjectReadsAllowed?: true;
  unassignedProjectWritesDenied?: true;
  protectedPathsDenied?: true;
  parentUserDirectoryDenied?: true;
  testedAt: string;
};

const cursorAdapterPath = fileURLToPath(import.meta.url);

function sha256File(path: string): string {
  if (!isAbsolute(path) || !existsSync(path)) throw new Error(`Required Cursor isolation binding file is missing: ${path}`);
  return createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase();
}

export type CursorResultReceipt = {
  result: string;
  sessionId: string;
  requestId: string | null;
  durationMs: number | null;
  durationApiMs: number | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  } | null;
};

export type CursorExecutionResult = {
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

export type CursorSpawn = typeof spawn;
let cursorSpawnForTests: CursorSpawn = spawn;

export function setCursorSpawnForTests(value: CursorSpawn): () => void {
  const previous = cursorSpawnForTests;
  cursorSpawnForTests = value;
  return () => { cursorSpawnForTests = previous; };
}

function saveCursorEvidence(evidence: { stdout: string; stderr: string; captureWorkspace?: boolean }, sink?: (evidence: { stdout: string; stderr: string; captureWorkspace?: boolean }) => void): string | undefined {
  try { sink?.(evidence); return undefined; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}

function assertSafeConfig(config: CursorAdapterConfig, workspace: string): string {
  if (config.schemaVersion !== 1) throw new Error("Unsupported Cursor adapter config");
  if (config.authentication !== "browser-login" || config.apiKeyAuthenticationAllowed !== false) {
    throw new Error("Cursor adapter permits browser login only; API-key billing is prohibited");
  }
  if (config.mode !== "ask") throw new Error("Cursor adapter requires Ask mode");
  if (config.sandbox !== "disabled") throw new Error("Cursor on Windows must use allowlist mode inside the external elevated sandbox");
  if (config.outputFormat !== "stream-json") throw new Error("Cursor adapter requires stream-json receipts");
  if (!Number.isSafeInteger(config.maximumRuntimeSeconds) || config.maximumRuntimeSeconds < 0
    || config.maximumIdleSeconds !== undefined && (!Number.isSafeInteger(config.maximumIdleSeconds) || config.maximumIdleSeconds < 0)) {
    throw new Error("Invalid Cursor timeout");
  }
  if (!isAbsolute(config.deniedSourceRoot) || !isAbsolute(config.configurationDirectory) || !isAbsolute(config.authenticationFile)
    || !isAbsolute(config.containmentExecutable) || !isAbsolute(config.containedAppData)
    || !isAbsolute(config.containedUserProfile) || !isAbsolute(config.userInfoShim) || !isAbsolute(config.pathVerifierShim)
    || !isAbsolute(config.runtimeConfigurationRoot)) {
    throw new Error("Cursor denied source, configuration, containment, and profile paths must be absolute");
  }
  if (!config.containedUsername.trim() || !existsSync(config.userInfoShim) || !existsSync(config.pathVerifierShim)) {
    throw new Error("Cursor contained Windows identity fallback is incomplete");
  }
  if (!existsSync(config.authenticationFile) || dirname(config.authenticationFile).split(/[\\/]/).at(-1)?.toLowerCase() !== "cursor"
    || config.authenticationFile.split(/[\\/]/).at(-1)?.toLowerCase() !== "auth.json") {
    throw new Error("Cursor browser-login authentication file is unavailable");
  }
  const resolvedWorkspace = resolve(workspace);
  if (relative(resolvedWorkspace, resolve(config.runtimeConfigurationRoot)) !== WORKER_RUNTIME_DIRECTORY) {
    throw new Error(`Cursor runtimeConfigurationRoot must be the ${WORKER_RUNTIME_DIRECTORY} child of the isolated workspace`);
  }
  if (config.containmentProfile !== "cursor_contained" || config.containmentWindowsSandbox !== "mxc") {
    throw new Error("Cursor workers require the explicit MXC cursor_contained sandbox");
  }
  if (!isAbsolute(config.executable) || (config.executableArguments !== undefined
    && (!Array.isArray(config.executableArguments) || config.executableArguments.some((value) => typeof value !== "string" || !value)))) {
    throw new Error("Cursor executable must be absolute and launcher arguments must be nonempty strings");
  }
  assertWorkspaceOutsideProject(resolvedWorkspace, config.deniedSourceRoot, "Cursor workspace must not be inside the authoritative repository");
  verifyWorkspace(resolvedWorkspace);
  assertNoWorkspaceReparsePoints(resolvedWorkspace, "Cursor");
  return resolvedWorkspace;
}

export function buildCursorInvocation(config: CursorAdapterConfig, workspace: string, objective: string): string[] {
  if (!objective.trim()) throw new Error("objective is required");
  assertSafeConfig(config, workspace);
  if (!config.readOnlyOnly) throw new Error("Read-only Cursor invocation requires readOnlyOnly=true");
  const args = ["--print", "--trust", "--sandbox", config.sandbox, "--output-format", config.outputFormat, "--mode", config.mode];
  if (config.model?.trim()) args.push("--model", config.model.trim());
  args.push(objective.trim());
  if (args.includes("--force")) throw new Error("Cursor read-only adapter must never use --force");
  return args;
}

export function buildCursorEnvironment(config: CursorAdapterConfig, configurationDirectory = config.configurationDirectory, workspace?: string): NodeJS.ProcessEnv {
  const resolvedConfigurationDirectory = resolve(configurationDirectory);
  const temporaryDirectory = resolve(resolvedConfigurationDirectory, "tmp");
  const environment: NodeJS.ProcessEnv = {
    // Host variables are allowlisted (see worker-environment.ts).
    ...developerToolEnvironment(process.env),
    CI: "1",
    AMADEUS_WORKER: '1',
    // Cursor's subscription login lives at %APPDATA%\Cursor\auth.json. Point
    // APPDATA at the host roaming root while the OS policy exposes only the
    // reviewed auth file and continues to deny Cursor's editor profile.
    APPDATA: dirname(dirname(resolve(config.authenticationFile))),
    CURSOR_CONFIG_DIR: resolvedConfigurationDirectory,
    CURSOR_DATA_DIR: resolve(resolvedConfigurationDirectory, "data"),
    CURSOR_CONTAINED_USERNAME: config.containedUsername,
    CURSOR_CONTAINED_HOME: resolve(config.containedUserProfile),
    CURSOR_CONTAINED_WORKSPACE: workspace ? resolve(workspace) : "",
    NODE_COMPILE_CACHE: resolve(resolvedConfigurationDirectory, "node-cache"),
    // Cursor's Windows shell backend writes short PowerShell wrapper scripts to
    // the process temp directory. Keep those wrappers inside the per-job runtime
    // directory that the containment profile already permits.
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    TMPDIR: temporaryDirectory,
  };
  environment.NODE_OPTIONS = `--require=${resolve(config.pathVerifierShim)}`;
  return environment;
}

export function buildCursorContainmentLaunch(
  config: CursorAdapterConfig,
  workspace: string,
  workerArgs: string[],
  writableWorkspacePaths: string[] = [],
  runtimeWritableDirectory?: string,
): { executable: string; args: string[]; cwd: string } {
  const cwd = assertSafeConfig(config, workspace);
  const writablePaths = writableWorkspacePaths.length > 0 ? normalizeSharedWritablePaths(writableWorkspacePaths, { label: "Cursor", required: true }) : [];
  const deniedRoot = resolve(config.deniedSourceRoot);
  const runtimeWrite = runtimeWritableDirectory ? resolve(runtimeWritableDirectory) : null;
  const runtimePermissions = workerRuntimeLayout(config.runtimeConfigurationRoot, runtimeWrite ?? undefined);
  // Cursor itself needs repository metadata to establish project context.
  // The CLI allowlist still denies model-tool reads and the OS layer keeps both
  // paths read-only, which the host acceptance verifies.
  const workspacePermissions = workspacePermissionEntries(writablePaths, "read");
  const projectScope = normalizeSharedProjectScope(config, { label: "Cursor", deniedPaths: "outside-projects" });
  const absoluteWorkspaceWrites = [...new Set(writablePaths.map((path) => resolve(cwd, path)))];
  const launcherReadPaths = (config.executableArguments ?? [])
    .filter((value) => isAbsolute(value) && existsSync(value))
    .flatMap((path) => [resolve(path), dirname(resolve(path))]);
  const filesystem = projectScope
    ? denyByDefaultFilesystemPolicy({ scope: projectScope, workspacePermissions, absoluteWorkspaceWrites, runtimePermissions,
      processReadPaths: [dirname(config.executable), ...launcherReadPaths, config.authenticationFile, config.userInfoShim, config.pathVerifierShim] })
    : `":root"="read",":workspace_roots"={${workspacePermissions}},${JSON.stringify(deniedRoot)}="${config.developmentMode ? "read" : "deny"}"${runtimePermissions}`;
  return containedLaunch({ containmentExecutable: config.containmentExecutable, sandbox: config.containmentWindowsSandbox,
    profile: config.containmentProfile, description: "Cursor contained worker", filesystem, networkEnabled: true,
    cwd, executable: config.executable, executableArguments: config.executableArguments, args: workerArgs });
}

export function buildCursorImplementationPlan(config: CursorAdapterConfig, workspace: string, objective: string): {
  executable: string;
  args: string[];
  cwd: string;
  cliConfig: Record<string, unknown>;
  launched: false;
} {
  if (!objective.trim()) throw new Error("objective is required");
  const cwd = assertSafeConfig(config, workspace);
  const writablePaths = normalizeSharedWritablePaths(config.writableWorkspacePaths, { label: "Cursor", required: true });
  const deniedRoot = resolve(config.deniedSourceRoot).replaceAll("\\", "/");
  const runtimeRoot = resolve(config.runtimeConfigurationRoot).replaceAll("\\", "/");
  const allow = ["Read(**)", ...writablePaths.map((path) => `Write(${path === "." ? "**" : path})`), ...(config.developmentMode ? ["Shell(*)", "WebFetch(*)"] : [])];
  const deny = [
    ...(config.developmentMode ? [] : [`Read(${deniedRoot}/**)`]), `Write(${deniedRoot}/**)`,
    `Read(${runtimeRoot}/**)`, `Write(${runtimeRoot}/**)`,
    ...(config.developmentMode
      ? ["Write(.git/**)", "Write(.worker-isolation.json)"]
      : ["Read(.git/**)", "Write(.git/**)", "Read(.worker-isolation.json)", "Write(.worker-isolation.json)"]),
    ...(config.developmentMode ? ["Mcp(*:*)"] : ["Shell(*)", "WebFetch(*)", "Mcp(*:*)"]),
  ];
  return {
    executable: config.executable,
    args: ["--print", "--force", "--trust", "--sandbox", config.sandbox, "--output-format", config.outputFormat,
      ...(config.model?.trim() ? ["--model", config.model.trim()] : []), objective.trim()],
    cwd,
    cliConfig: { version: 1, approvalMode: "allowlist", permissions: { allow, deny } },
    launched: false,
  };
}

export function cursorIsolationEnvelopeSha256(config: CursorAdapterConfig, workspace: string): string {
  if (!config.isolationAcceptanceHarness || !isAbsolute(config.isolationAcceptanceHarness)) {
    throw new Error("Cursor isolation acceptance harness is not configured");
  }
  const writablePaths = normalizeSharedWritablePaths(config.writableWorkspacePaths ?? [], { label: "Cursor", required: true });
  const projectScope = normalizeSharedProjectScope(config, { label: "Cursor", deniedPaths: "outside-projects" });
  const plan = buildCursorImplementationPlan({ ...config, writableWorkspacePaths: writablePaths }, workspace, "isolation-envelope-fingerprint");
  const launch = buildCursorContainmentLaunch(config, workspace, plan.args, writablePaths);
  const permissionDefinition = launch.args.find((value) => value.startsWith(`permissions.${config.containmentProfile}=`));
  if (!permissionDefinition) throw new Error("Cursor effective containment profile could not be derived");
  const launcherArtifacts = (config.executableArguments ?? [])
    .filter((value) => isAbsolute(value) && existsSync(value))
    .map((path) => ({ path: resolve(path), sha256: sha256File(path) }));
  return createHash("sha256").update(JSON.stringify({
    ...containedEnvelopeCore(config, workspace, projectScope, launcherArtifacts, sha256File),
    authenticationFile: resolve(config.authenticationFile),
    runtimeConfigurationRoot: resolve(config.runtimeConfigurationRoot),
    writableWorkspacePaths: writablePaths,
    developmentMode: config.developmentMode === true,
    readOnlyOnly: config.readOnlyOnly,
    cursorSandboxMode: config.sandbox,
    permissionDefinition,
    cliConfig: plan.cliConfig,
    acceptanceHarnessPath: resolve(config.isolationAcceptanceHarness),
  })).digest("hex").toUpperCase();
}

export function cursorIsolationSecurityState(config: CursorAdapterConfig, workspace: string, receiptPath = config.writeIsolationReceipt ?? config.readIsolationReceipt) {
  if (!receiptPath || !isAbsolute(receiptPath)) throw new Error("Cursor isolation receipt path must be configured before acceptance");
  const writablePaths = normalizeSharedWritablePaths(config.writableWorkspacePaths ?? [], { label: "Cursor", required: true });
  const projectScope = normalizeSharedProjectScope(config, { label: "Cursor", deniedPaths: "outside-projects" });
  const mutableParents = sharedWritableParentChain(workspace, writablePaths, "Cursor");
  const mutableRoots = [...mutableParents, resolve(config.configurationDirectory), resolve(config.runtimeConfigurationRoot)];
  // The shared boundary list also binds the executable's folder and launcher files (it did not for Cursor before).
  return isolationSecurityStateBinding(config.isolationSecurityStateProbe, "cursor", workspace,
    containedSecurityBoundaryPaths(config, workspace, projectScope, receiptPath, writablePaths, mutableParents, [config.authenticationFile]), mutableRoots);
}

function readCursorExecutableVersion(config: CursorAdapterConfig): string {
  const result = spawnSync(config.executable, [...(config.executableArguments ?? []), "--version"], {
    encoding: "utf8", shell: false, env: buildCursorEnvironment(config), timeout: 15_000,
  });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    throw new Error("Cursor executable version could not be verified");
  }
  return result.stdout.trim();
}

function validatedWriteIsolationReceipt(config: CursorAdapterConfig, workspace: string): CursorWriteIsolationReceipt {
  if (!config.writeIsolationVerified || !config.writeIsolationReceipt || !isAbsolute(config.writeIsolationReceipt)) {
    throw new Error("Cursor bounded-write isolation has not been verified");
  }
  if (!existsSync(config.writeIsolationReceipt)) throw new Error("Cursor write-isolation receipt is missing");
  const receipt = JSON.parse(readFileSync(config.writeIsolationReceipt, "utf8")) as CursorWriteIsolationReceipt;
  const expectedPaths = normalizeSharedWritablePaths(config.writableWorkspacePaths, { label: "Cursor", required: true });
  const executableVersion = readCursorExecutableVersion(config);
  const securityState = cursorIsolationSecurityState(config, workspace, config.writeIsolationReceipt);
  const scoped = Boolean(normalizeSharedProjectScope(config, { label: "Cursor", deniedPaths: "outside-projects" }));
  const checks: Array<[string, boolean]> = [
    ...containedWriteReceiptChecks({ receipt, config, workspace, executableVersion, adapterPath: cursorAdapterPath,
      envelopeSha256: cursorIsolationEnvelopeSha256(config, workspace), expectedWritablePaths: expectedPaths, scoped, securityState, sha256File }),
    // Cursor only: a scoped worker may read the authoritative project; .git and the receipt stay unreadable to its tools.
    ["authoritative repository probe", scoped ? receipt.authoritativeRepositoryDenied === false : receipt.authoritativeRepositoryDenied === true],
    ["git probe", receipt.gitHistoryDenied === true], ["isolation receipt probe", receipt.isolationReceiptDenied === true],
    ["Cursor sandbox", receipt.cursorSandboxMode === config.sandbox],
  ];
  const mismatches = checks.filter(([, valid]) => !valid).map(([name]) => name);
  if (mismatches.length > 0) {
    throw new Error(`Cursor write-isolation receipt is stale or scoped to a different executable, adapter, harness, workspace, or permission envelope (${mismatches.join(", ")}); rerun the approved non-model host acceptance`);
  }
  return receipt;
}

function validatedReadIsolationReceipt(config: CursorAdapterConfig, workspace: string): CursorReadIsolationReceipt {
  if (!config.readIsolationVerified || !config.readIsolationReceipt || !isAbsolute(config.readIsolationReceipt)) {
    throw new Error("Cursor read isolation has not been verified");
  }
  if (!existsSync(config.readIsolationReceipt)) throw new Error("Cursor read-isolation receipt is missing");
  const receipt = JSON.parse(readFileSync(config.readIsolationReceipt, "utf8")) as CursorReadIsolationReceipt;
  const executableVersion = readCursorExecutableVersion(config);
  const securityState = cursorIsolationSecurityState(config, workspace, config.readIsolationReceipt);
  if (receipt.schemaVersion !== 1 || receipt.executableVersion.trim() !== executableVersion
    || receipt.executableSha256 !== sha256File(config.executable)
    || receipt.containmentExecutableSha256 !== sha256File(config.containmentExecutable)
    || receipt.adapterSha256 !== sha256File(cursorAdapterPath)
    || !config.isolationAcceptanceHarness || resolve(receipt.acceptanceHarnessPath) !== resolve(config.isolationAcceptanceHarness)
    || receipt.acceptanceHarnessSha256 !== sha256File(config.isolationAcceptanceHarness)
    || receipt.isolationEnvelopeSha256 !== cursorIsolationEnvelopeSha256(config, workspace)
    || receipt.securityStateProbePath !== securityState.securityStateProbePath
    || receipt.securityStateProbeSha256 !== securityState.securityStateProbeSha256
    || JSON.stringify(receipt.securityBoundaryPaths) !== JSON.stringify(securityState.securityBoundaryPaths)
    || JSON.stringify(receipt.mutableBoundaryRoots) !== JSON.stringify(securityState.mutableBoundaryRoots)
    || receipt.hostSecurityStateFingerprint !== securityState.hostSecurityStateFingerprint
    || resolve(receipt.workspace) !== resolve(workspace)
    || (normalizeSharedProjectScope(config, { label: "Cursor", deniedPaths: "outside-projects" }) ? receipt.authoritativeRepositoryDenied !== false : receipt.authoritativeRepositoryDenied !== true)
    || receipt.outsideWorkspaceReadsDenied !== true || receipt.gitHistoryDenied !== true
    || receipt.protectedEvidenceDenied !== true
    || normalizeSharedProjectScope(config, { label: "Cursor", deniedPaths: "outside-projects" }) && (receipt.registeredProjectReadsAllowed !== true
      || receipt.unassignedProjectWritesDenied !== true || receipt.protectedPathsDenied !== true
      || receipt.parentUserDirectoryDenied !== true)) {
    throw new Error("Cursor read-isolation receipt is stale or scoped to a different executable, adapter, harness, workspace, or permission envelope; rerun the approved non-model host acceptance");
  }
  return receipt;
}

export function assertCursorImplementationDispatchAllowed(config: CursorAdapterConfig, workspace: string): CursorWriteIsolationReceipt | undefined {
  if (!config.enabled || !config.dispatchAuthorized || !config.implementationDispatchAuthorized) {
    throw new Error("Cursor implementation dispatch is disabled");
  }
  if (!config.implementationPrepared) throw new Error("Cursor implementation adapter is not prepared");
  assertSafeConfig(config, workspace);
  if (config.readOnlyOnly) throw new Error("Cursor configuration remains read-only");
  buildCursorImplementationPlan(config, workspace, "dispatch-boundary-check");
  return validatedWriteIsolationReceipt(config, workspace);
}

export async function runCursorImplementation(
  config: CursorAdapterConfig,
  workspace: string,
  objective: string,
  jobConfigurationDirectory: string,
  signal?: AbortSignal,
  options: { spawn?: CursorSpawn; terminate?: (child: ReturnType<CursorSpawn>) => void; onEvidence?: (evidence: { stdout: string; stderr: string; captureWorkspace?: boolean }) => void } = {},
): Promise<CursorExecutionResult> {
  assertCursorImplementationDispatchAllowed(config, workspace);
  const plan = buildCursorImplementationPlan(config, workspace, objective);
  const runtimeRoot = resolve(config.runtimeConfigurationRoot);
  const resolvedJobConfig = resolve(jobConfigurationDirectory);
  const runtimeRelative = relative(runtimeRoot, resolvedJobConfig);
  if (!runtimeRelative || runtimeRelative.startsWith(`..${sep}`) || runtimeRelative === ".." || isAbsolute(runtimeRelative)) {
    throw new Error("Cursor job configuration must be inside runtimeConfigurationRoot");
  }
  mkdirSync(resolvedJobConfig, { recursive: true });
  writeFileSync(resolve(resolvedJobConfig, "cli-config.json"), `${JSON.stringify(plan.cliConfig, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const result = await spawnCursor(config, plan.args, plan.cwd, resolvedJobConfig, signal, options);
  if (result.exitCode === 0 && !result.timedOut && !result.aborted) {
    try { parseCursorResult(result.stdout); }
    catch (error) {
      return {
        ...result,
        exitCode: 1,
        error: `Cursor exited without one verified success result: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return result;
}

function spawnCursor(
  config: CursorAdapterConfig,
  args: string[],
  workspace: string,
  configurationDirectory: string,
  signal?: AbortSignal,
  options: { spawn?: CursorSpawn; terminate?: (child: ReturnType<CursorSpawn>) => void; onEvidence?: (evidence: { stdout: string; stderr: string; captureWorkspace?: boolean }) => void } = {},
): Promise<CursorExecutionResult> {
  const effectiveSpawn = options.spawn ?? cursorSpawnForTests;
  return new Promise((resolveResult) => {
    mkdirSync(resolve(configurationDirectory, "tmp"), { recursive: true });
    const writablePaths = config.readOnlyOnly ? [] : normalizeSharedWritablePaths(config.writableWorkspacePaths, { label: "Cursor", required: true });
    const launch = buildCursorContainmentLaunch(config, workspace, args, writablePaths, configurationDirectory);
    const child = effectiveSpawn(launch.executable, launch.args, {
      cwd: launch.cwd, env: buildCursorEnvironment(config, configurationDirectory, workspace), shell: false, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeoutKind: "wall-clock" | "idle" | undefined;
    let aborted = false;
    let settled = false;
    let evidenceError: string | undefined;
    const persist = (captureWorkspace = false) => {
      evidenceError ??= saveCursorEvidence({ stdout, stderr, captureWorkspace }, options.onEvidence);
    };
    const idleMilliseconds = (config.maximumIdleSeconds ?? 180) * 1000;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = config.maximumRuntimeSeconds > 0 ? setTimeout(() => { timedOut = true; timeoutKind = "wall-clock"; persist(true); abort(); }, config.maximumRuntimeSeconds * 1000) : undefined;
    const closeTimers = () => { clearTimeout(timer); clearTimeout(idleTimer); };
    const finish = (result: { exitCode: number | null; signal: NodeJS.Signals | null; error?: string }) => {
      if (settled) return;
      settled = true;
      closeTimers();
      signal?.removeEventListener("abort", handleOwnerAbort);
      const evidence = { stdout, stderr };
      persist(true);
      resolveResult({ ...result, timedOut, timeoutKind, aborted, evidenceError, ...evidence });
    };
    const abort = () => {
      try { (options.terminate ?? terminateWorkerTree)(child); }
      catch (error) { stderr += `\n${String(error)}`; child.kill(); }
    };
    const markActivity = () => {
      persist(false);
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = setTimeout(() => { timedOut = true; timeoutKind = "idle"; abort(); }, idleMilliseconds); }
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

export function assertCursorDispatchAllowed(config: CursorAdapterConfig, workspace: string): CursorReadIsolationReceipt | undefined {
  if (!config.enabled || !config.dispatchAuthorized) throw new Error("Cursor dispatch is disabled");
  if (config.automaticStartup) throw new Error("Cursor automatic startup must remain disabled");
  if (!config.spendingRouteReviewed) throw new Error("Cursor spending route has not been reviewed");
  if (!config.readOnlyOnly) throw new Error("Writable Cursor dispatch is not implemented");
  assertSafeConfig(config, workspace);
  buildCursorInvocation(config, workspace, "dispatch-boundary-check");
  return validatedReadIsolationReceipt(config, workspace);
}

export function parseCursorResult(jsonl: string): CursorResultReceipt {
  const results: CursorResultReceipt[] = [];
  for (const line of jsonl.split(/\r?\n/).filter(Boolean)) {
    let event: unknown;
    try { event = JSON.parse(line); }
    catch { continue; }
    if (typeof event !== "object" || event === null) continue;
    const item = event as Record<string, unknown>;
    if (item.type !== "result" || item.subtype !== "success" || item.is_error !== false || typeof item.result !== "string" || typeof item.session_id !== "string") continue;
    if (item.usage !== undefined && (typeof item.usage !== "object" || item.usage === null)) {
      throw new Error("Cursor result usage is malformed");
    }
    const usage = item.usage === undefined ? null : item.usage as Record<string, unknown>;
    const parsedUsage = usage && ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]
      .every((key) => Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0)
      ? {
        inputTokens: Number(usage.inputTokens),
        outputTokens: Number(usage.outputTokens),
        cacheReadTokens: Number(usage.cacheReadTokens),
        cacheWriteTokens: Number(usage.cacheWriteTokens),
      }
      : null;
    if (usage && !parsedUsage) throw new Error("Cursor result usage token fields are malformed");
    results.push({
      result: item.result,
      sessionId: item.session_id,
      requestId: typeof item.request_id === "string" ? item.request_id : null,
      durationMs: Number.isFinite(item.duration_ms) ? Number(item.duration_ms) : null,
      durationApiMs: Number.isFinite(item.duration_api_ms) ? Number(item.duration_api_ms) : null,
      usage: parsedUsage,
    });
  }
  if (results.length !== 1) throw new Error(`Expected exactly one successful Cursor result event; found ${results.length}`);
  return results[0];
}

export function inspectCursorCli(config: CursorAdapterConfig): Record<string, unknown> {
  if (config.enabled !== true) {
    return { installed: false, modelInvoked: false, reason: 'Optional Cursor is disabled' };
  }
  if (typeof config.executable !== 'string' || !config.executable.trim()) return { installed: false, modelInvoked: false, reason: 'Optional Cursor is not configured' };
  let environment: NodeJS.ProcessEnv;
  try {
    environment = buildCursorEnvironment(config);
  } catch (error) {
    return {
      installed: false,
      executable: config.executable,
      modelInvoked: false,
      reason: 'Optional Cursor configuration is incomplete',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const version = spawnSync(config.executable, [...(config.executableArguments ?? []), "--version"], {
    encoding: "utf8", shell: false, env: environment, timeout: 15_000,
  });
  if (version.error) return { installed: false, executable: config.executable, error: version.error.message };
  const status = spawnSync(config.executable, [...(config.executableArguments ?? []), "status"], {
    encoding: "utf8", shell: false, env: environment, timeout: 15_000,
  });
  return {
    installed: version.status === 0,
    executable: config.executable,
    version: version.stdout.trim(),
    statusExitCode: status.status,
    status: status.stdout.trim(),
    statusError: status.stderr.trim(),
    modelInvoked: false,
  };
}

export async function runCursorReadOnly(
  config: CursorAdapterConfig,
  workspace: string,
  objective: string,
  signal?: AbortSignal,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; stdout: string; stderr: string; error?: string }> {
  assertCursorDispatchAllowed(config, workspace);
  const args = buildCursorInvocation(config, workspace, objective);
  return await spawnCursor(config, args, workspace, config.configurationDirectory, signal);
}

function main(): void {
  const command = process.argv[2] ?? "status";
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: { config: { type: "string" }, workspace: { type: "string" }, objective: { type: "string" }, runtime: { type: "string" } },
    strict: true,
  });
  if (!values.config || !existsSync(values.config)) throw new Error("--config must name an existing Cursor adapter config");
  const config = JSON.parse(readFileSync(values.config, "utf8")) as CursorAdapterConfig;
  if (command === "status") {
    console.log(JSON.stringify(inspectCursorCli(config), null, 2));
    return;
  }
  if (command === "receipt-envelope") {
    if (!values.workspace) throw new Error("--workspace is required");
    console.log(JSON.stringify({
      executableVersion: readCursorExecutableVersion(config),
      executableSha256: sha256File(config.executable),
      containmentExecutableSha256: sha256File(config.containmentExecutable),
      adapterSha256: sha256File(cursorAdapterPath),
      acceptanceHarnessPath: resolve(config.isolationAcceptanceHarness!),
      acceptanceHarnessSha256: sha256File(config.isolationAcceptanceHarness!),
      isolationEnvelopeSha256: cursorIsolationEnvelopeSha256(config, values.workspace),
      ...cursorIsolationSecurityState(config, values.workspace),
    }, null, 2));
    return;
  }
  if (command === "containment-preview") {
    if (!values.workspace) throw new Error("--workspace is required");
    const objective = values.objective?.trim() || "non-model containment preview";
    const plan = buildCursorImplementationPlan(config, values.workspace, objective);
    console.log(JSON.stringify({ ...buildCursorContainmentLaunch(config, values.workspace, plan.args,
      normalizeSharedWritablePaths(config.writableWorkspacePaths ?? [], { label: "Cursor", required: true }), values.runtime), launched: false }, null, 2));
    return;
  }
  if (!values.workspace || !values.objective) throw new Error("--workspace and --objective are required");
  const args = buildCursorInvocation(config, values.workspace, values.objective);
  if (command === "preview") {
    console.log(JSON.stringify({ executable: config.executable, args, cwd: resolve(values.workspace), environment: { CURSOR_CONFIG_DIR: resolve(config.configurationDirectory) }, launched: false }, null, 2));
    return;
  }
  throw new Error("Live Cursor execution is coordinator-only and remains disabled");
}

// Compare real paths so a symlinked install location (macOS /var, /tmp) still starts.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { spawn, spawnSync } from "node:child_process";
import { verifyWorkspace } from "./worker-isolation.ts";
import { terminateWorkerTree, WORKER_PROCESS_GROUP } from "./worker-process.ts";
import { isolationSecurityStateBinding } from "./isolation-security-state.ts";
import { resolveMaximumIdleSeconds } from "./worker-timeouts.ts";
import { developerToolEnvironment } from "./worker-environment.ts";
import { assertWorkspaceOutsideProject, developmentFilesystemPolicy, normalizeProjectScope as normalizeSharedProjectScope, normalizeWritableWorkspacePaths, stableWorkspaceChildren, writableParentChain, type ProjectScope } from "./worker-sandbox.ts";

export type CodexAdapterConfig = {
  executable?: string;
  codeModeHostExecutable?: string;
  enabled: boolean;
  paidDispatchEnabled: boolean;
  automaticStartup: boolean;
  model: string;
  reasoningEffort: string;
  windowsSandbox: "mxc" | "elevated";
  /** Ignored label from older configs; the profile name is fixed (CODEX_PERMISSION_PROFILE). */
  permissionProfile?: string;
  deniedSourceRoot: string;
  assignedProjectRoot?: string;
  readableProjectRoots?: string[];
  deniedParentPaths?: string[];
  protectedPaths?: string[];
  /** Absolute paths outside the project that workers must never read (credentials, browser profiles, documents). */
  deniedSensitivePaths?: string[];
  writableWorkspacePaths?: string[];
  maximumRuntimeSeconds: number;
  /** Maximum time without provider output before the worker is classified as stalled. */
  maximumIdleSeconds?: number;
  /** Legacy public-template alias; maximumIdleSeconds is canonical. */
  idleProgressTimeoutSeconds?: number;
  maximumEstimatedCredits: number;
  developmentMode?: boolean;
  commandNetworkEnabled?: boolean;
  /** Shared with Claude workers: may the worker run commands (default true). */
  workerCommandsEnabled?: boolean;
  outputSchema?: string;
  isolationVerified?: boolean;
  isolationReceipt?: string | null;
  isolationAcceptanceHarness?: string | null;
  isolationSecurityStateProbe?: string | null;
};

/** Verifier-only configs do not need a model. Never place null in argv. */
/** The Codex permission profile Amadeus defines for its workers; its content is built in code, so the name is fixed. */
export const CODEX_PERMISSION_PROFILE = "amadeus_task_worker";

export function optionalModelArguments(model: unknown): string[] {
  return typeof model === "string" && model.trim() ? ["-m", model] : [];
}

export type CodexIsolationReceipt = {
  schemaVersion: 1;
  executablePath: string;
  executableVersion: string;
  executableSha256: string;
  codeModeHostSha256: string;
  adapterSha256: string;
  acceptanceHarnessPath: string;
  acceptanceHarnessSha256: string;
  securityStateProbePath: string;
  securityStateProbeSha256: string;
  securityBoundaryPaths: string[];
  mutableBoundaryRoots: string[];
  hostSecurityStateFingerprint: string;
  workspace: string;
  deniedSourceRoot: string;
  assignedProjectRoot?: string;
  readableProjectRoots?: string[];
  deniedParentPaths?: string[];
  protectedPaths?: string[];
  /** Absolute paths outside the project that workers must never read (credentials, browser profiles, documents). */
  deniedSensitivePaths?: string[];
  writableWorkspacePaths: string[];
  developmentMode: boolean;
  commandNetworkEnabled: boolean;
  permissionDefinitionSha256: string;
  authoritativeRepositoryDenied: boolean;
  outsideWorkspaceReadsDenied: true;
  protectedEvidenceDenied: true;
  registeredProjectReadsAllowed?: true;
  unassignedProjectWritesDenied?: true;
  protectedPathsDenied?: true;
  parentUserDirectoryDenied?: true;
  testedAt: string;
};

const codexAdapterPath = fileURLToPath(import.meta.url);

function sha256File(path: string): string {
  if (!isAbsolute(path) || !existsSync(path)) throw new Error(`Required isolation binding file is missing: ${path}`);
  return createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase();
}

function readCodexExecutableVersion(executable: string): string {
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", shell: false, timeout: 15_000 });
  if (result.error || result.status !== 0 || !result.stdout.trim()) throw new Error("Codex executable version could not be verified");
  return result.stdout.trim();
}

export function resolveCodexExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  pathExists: (path: string) => boolean = existsSync,
): string {
  const explicit = environment.CODEX_EXECUTABLE?.trim();
  if (explicit) return explicit;
  const userProfile = environment.USERPROFILE?.trim();
  if (userProfile) {
    for (const candidate of [
      join(userProfile, ".codex", "plugins", ".plugin-appserver", "codex.exe"),
      join(userProfile, ".codex", ".sandbox-bin", "codex.exe"),
    ]) {
      if (pathExists(candidate) && pathExists(join(dirname(candidate), "codex-code-mode-host.exe"))) return candidate;
    }
  }
  return "codex";
}

export function resolveWorkerExecutable(
  executable: string,
  environment: NodeJS.ProcessEnv = process.env,
  pathExists: (path: string) => boolean = existsSync,
): string {
  return executable.toLowerCase() === "codex" ? resolveCodexExecutable(environment, pathExists) : executable;
}

function resolveConfiguredCodexExecutable(config: CodexAdapterConfig): string {
  if (!config.executable || !isAbsolute(config.executable) || !existsSync(config.executable)) {
    throw new Error("Codex dispatch requires an explicit existing absolute executable path");
  }
  if (!config.codeModeHostExecutable || !isAbsolute(config.codeModeHostExecutable) || !existsSync(config.codeModeHostExecutable)) {
    throw new Error("Codex dispatch requires an explicit existing absolute code-mode host path");
  }
  return resolve(config.executable);
}

export function projectFilesystemPolicy(scope: ProjectScope, workspace: string, writablePaths: string[], _workspacePermissions: string,
  developmentMode: boolean, protectedEvidenceRoot: string): string {
  if (!isAbsolute(protectedEvidenceRoot)) throw new Error("Codex protected evidence root must be absolute");
  // Current elevated Windows sandboxes require an effective root-read baseline.
  // Preserve Amadeus's narrower boundary with explicit parent, evidence, and
  // protected-path denies, followed by exact project/workspace allowances.
  return developmentFilesystemPolicy({ scope, extraDenies: [protectedEvidenceRoot], workspace, writablePaths,
    metadataAccess: developmentMode ? "read" : "deny" });
}

export function buildCodexInvocation(
  config: CodexAdapterConfig,
  workspace: string,
  objective: string,
  options: { allowWorkingChanges?: boolean } = {},
): string[] {
  if (!objective.trim()) throw new Error("objective is required");
  if (config.windowsSandbox !== "mxc") throw new Error("Codex workers require the MXC Windows sandbox");
  if (!isAbsolute(config.deniedSourceRoot)) throw new Error("deniedSourceRoot must be absolute");
  const resolvedWorkspace = resolve(workspace);
  const deniedSourceRoot = resolve(config.deniedSourceRoot);
  assertWorkspaceOutsideProject(resolvedWorkspace, deniedSourceRoot, "Worker workspace must not be inside the denied source root");
  verifyWorkspace(workspace, { allowWorkingChanges: options.allowWorkingChanges });
  const writablePaths = normalizeWritableWorkspacePaths(config.writableWorkspacePaths);
  const projectScope = normalizeSharedProjectScope(config, { label: "Codex", deniedPaths: "ancestors" });
  const scopedMetadataPermission = config.developmentMode ? "read" : "deny";
  const scopedWorkspacePermissions = `"."="${writablePaths.includes(".") ? "write" : "read"}"${writablePaths.filter((p) => p !== ".").map((p) => `,${JSON.stringify(p)}="write"`).join("")},".git"="${scopedMetadataPermission}",".worker-isolation.json"="${scopedMetadataPermission}"`;
  if (projectScope && (!config.isolationReceipt || !isAbsolute(config.isolationReceipt))) {
    throw new Error("Codex project scope requires an absolute isolation receipt path so protected evidence can be denied");
  }
  const scopedFilesystem = projectScope
    ? projectFilesystemPolicy(projectScope, resolvedWorkspace, writablePaths, scopedWorkspacePermissions,
      config.developmentMode === true, dirname(resolve(config.isolationReceipt!)))
    : null;
  const permissionDefinition = scopedFilesystem
    ? `{description="Amadeus development workspace read; task workspace bounded write",filesystem={${scopedFilesystem}},network={enabled=${config.developmentMode === true && config.commandNetworkEnabled === true}}}`
    : config.developmentMode
    ? `{description="Amadeus development workspace",filesystem={":root"="read",":workspace_roots"={"."="${writablePaths.includes(".") ? "write" : "read"}"${writablePaths.filter((p) => p !== ".").map((p) => `,${JSON.stringify(p)}="write"`).join("")},".git"="read",".worker-isolation.json"="read"},${JSON.stringify(deniedSourceRoot)}="read"},network={enabled=${config.commandNetworkEnabled === true}}}`
    : writablePaths.length === 0
    ? `{description="Amadeus isolated read-only worker",extends=":read-only",filesystem={${JSON.stringify(deniedSourceRoot)}="deny"},network={enabled=false}}`
    : `{description="Amadeus isolated bounded-write worker",filesystem={":root"="read",":workspace_roots"={"."="read",${writablePaths.map((path) => `${JSON.stringify(path)}="write"`).join(",")}},${JSON.stringify(deniedSourceRoot)}="deny"},network={enabled=false}}`;
  return [
    "exec",
    "--ephemeral",
    // Ephemeral coordinator workers must not see persistent-goal tools. Those
    // tools require a persistent thread and otherwise make the worker exit
    // before it can return its bounded JSON result.
    "--disable", "goals",
    // The owner's shared workerCommandsEnabled setting (default on) applies to
    // every provider; off leaves Codex with file edits only, like Claude.
    ...(config.workerCommandsEnabled === false ? ["--disable", "shell_tool"] : []),
    "--ignore-user-config",
    ...(config.developmentMode ? [] : ["--ignore-rules"]),
    "--json",
    "-C", resolvedWorkspace,
    ...optionalModelArguments(config.model),
    ...(config.outputSchema ? ["--output-schema", config.outputSchema] : []),
    "-c", `windows.sandbox=${JSON.stringify(config.windowsSandbox)}`,
    "-c", `permissions.${CODEX_PERMISSION_PROFILE}=${permissionDefinition}`,
    "-c", `default_permissions=${JSON.stringify(CODEX_PERMISSION_PROFILE)}`,
    "-c", `model_reasoning_effort=${JSON.stringify(config.reasoningEffort)}`,
    "-c", "approval_policy=\"never\"",
    objective.trim(),
  ];
}

/** Build a non-model command inside the same verified permission profile as its worker config. */
export function buildCodexSandboxCommand(
  config: Pick<CodexAdapterConfig, "permissionProfile" | "windowsSandbox">,
  workspace: string,
  permissionDefinition: string,
  executable: string,
  args: string[],
): string[] {
  const permissionProfile = CODEX_PERMISSION_PROFILE;
  if (config.windowsSandbox !== "mxc") throw new Error("Codex sandbox commands require the MXC Windows sandbox");
  if (!permissionDefinition.startsWith(`permissions.${permissionProfile}=`)) {
    throw new Error("Sandbox permission definition does not match the configured worker profile");
  }
  return [
    "sandbox", "-C", workspace,
    "-c", `windows.sandbox=${JSON.stringify(config.windowsSandbox)}`,
    "-c", permissionDefinition,
    "-c", 'approval_policy="never"',
    "-c", `default_permissions=${JSON.stringify(permissionProfile)}`,
    "-P", permissionProfile,
    "--", executable, ...args,
  ];
}

export function codexIsolationEnvelope(config: CodexAdapterConfig, workspace: string): Omit<CodexIsolationReceipt,
  "schemaVersion" | "authoritativeRepositoryDenied" | "outsideWorkspaceReadsDenied" | "protectedEvidenceDenied" | "testedAt"> {
  if (!config.isolationAcceptanceHarness || !isAbsolute(config.isolationAcceptanceHarness)) {
    throw new Error("Codex isolation acceptance harness is not configured");
  }
  const executablePath = resolveConfiguredCodexExecutable(config);
  const codeModeHost = resolve(config.codeModeHostExecutable!);
  const args = buildCodexInvocation(config, workspace, "isolation-envelope-fingerprint");
  const permissionDefinition = args.find((value) =>
    typeof value === "string" && value.startsWith(`permissions.${CODEX_PERMISSION_PROFILE}=`));
  if (!permissionDefinition) throw new Error("Codex effective permission profile could not be derived");
  if (!config.isolationReceipt || !isAbsolute(config.isolationReceipt)) {
    throw new Error("Codex isolation receipt path must be configured before acceptance");
  }
  const writablePaths = normalizeWritableWorkspacePaths(config.writableWorkspacePaths);
  const projectScope = normalizeSharedProjectScope(config, { label: "Codex", deniedPaths: "ancestors" });
  const mutableParents = writableParentChain(workspace, writablePaths);
  const securityState = isolationSecurityStateBinding(config.isolationSecurityStateProbe, "codex", workspace, [
    workspace, config.deniedSourceRoot, executablePath, codeModeHost, config.isolationAcceptanceHarness,
    ...(projectScope?.deniedParentPaths ?? []), ...(projectScope?.readableProjectRoots ?? []), ...(projectScope?.protectedPaths ?? []),
    join(workspace, ".git"), join(workspace, ".worker-isolation.json"), dirname(resolve(config.isolationReceipt)),
    // The workspace ACL controls creation within approved mutable paths. Their
    // membership/content may change normally; all other workspace children are
    // stable security boundaries and remain receipt-bound.
    ...stableWorkspaceChildren(workspace, writablePaths), ...mutableParents,
  ], mutableParents);
  return {
    executablePath,
    executableVersion: readCodexExecutableVersion(executablePath),
    executableSha256: sha256File(executablePath),
    codeModeHostSha256: sha256File(codeModeHost),
    adapterSha256: sha256File(codexAdapterPath),
    acceptanceHarnessPath: resolve(config.isolationAcceptanceHarness),
    acceptanceHarnessSha256: sha256File(config.isolationAcceptanceHarness),
    ...securityState,
    workspace: resolve(workspace),
    deniedSourceRoot: resolve(config.deniedSourceRoot),
    ...(projectScope ? {
      assignedProjectRoot: projectScope.assignedProjectRoot,
      readableProjectRoots: projectScope.readableProjectRoots,
      deniedParentPaths: projectScope.deniedParentPaths,
      protectedPaths: projectScope.protectedPaths,
    } : {}),
    writableWorkspacePaths: normalizeWritableWorkspacePaths(config.writableWorkspacePaths),
    developmentMode: config.developmentMode === true,
    commandNetworkEnabled: config.commandNetworkEnabled === true,
    permissionDefinitionSha256: createHash("sha256").update(permissionDefinition).digest("hex").toUpperCase(),
  };
}

function validatedCodexIsolationReceipt(config: CodexAdapterConfig, workspace: string): CodexIsolationReceipt {
  if (!config.isolationVerified || !config.isolationReceipt || !isAbsolute(config.isolationReceipt)) {
    throw new Error("Codex isolation acceptance is missing; run the approved non-model host acceptance for this exact workspace and envelope");
  }
  if (!existsSync(config.isolationReceipt)) throw new Error("Codex isolation receipt is missing; dispatch remains blocked");
  const receipt = JSON.parse(readFileSync(config.isolationReceipt, "utf8")) as CodexIsolationReceipt;
  const expected = codexIsolationEnvelope(config, workspace);
  const actualBinding = {
    executablePath: receipt.executablePath,
    executableVersion: receipt.executableVersion,
    executableSha256: receipt.executableSha256,
    codeModeHostSha256: receipt.codeModeHostSha256,
    adapterSha256: receipt.adapterSha256,
    acceptanceHarnessPath: receipt.acceptanceHarnessPath,
    acceptanceHarnessSha256: receipt.acceptanceHarnessSha256,
    securityStateProbePath: receipt.securityStateProbePath,
    securityStateProbeSha256: receipt.securityStateProbeSha256,
    securityBoundaryPaths: receipt.securityBoundaryPaths,
    mutableBoundaryRoots: receipt.mutableBoundaryRoots,
    hostSecurityStateFingerprint: receipt.hostSecurityStateFingerprint,
    workspace: receipt.workspace,
    deniedSourceRoot: receipt.deniedSourceRoot,
    ...(expected.assignedProjectRoot ? {
      assignedProjectRoot: receipt.assignedProjectRoot,
      readableProjectRoots: receipt.readableProjectRoots,
      deniedParentPaths: receipt.deniedParentPaths,
      protectedPaths: receipt.protectedPaths,
    } : {}),
    writableWorkspacePaths: receipt.writableWorkspacePaths,
    developmentMode: receipt.developmentMode,
    commandNetworkEnabled: receipt.commandNetworkEnabled,
    permissionDefinitionSha256: receipt.permissionDefinitionSha256,
  };
  if (receipt.schemaVersion !== 1 || JSON.stringify(actualBinding) !== JSON.stringify(expected)
    || (expected.assignedProjectRoot ? receipt.authoritativeRepositoryDenied !== false : receipt.authoritativeRepositoryDenied !== true)
    || receipt.outsideWorkspaceReadsDenied !== true
    || receipt.protectedEvidenceDenied !== true
    || expected.assignedProjectRoot && (receipt.registeredProjectReadsAllowed !== true
      || receipt.unassignedProjectWritesDenied !== true || receipt.protectedPathsDenied !== true
      || receipt.parentUserDirectoryDenied !== true)) {
    throw new Error("Codex isolation receipt is stale or scoped to a different executable, adapter, harness, workspace, or permission envelope; rerun the approved non-model host acceptance");
  }
  return receipt;
}

export function runCodex(config: CodexAdapterConfig, workspace: string, objective: string, estimatedCredits: number) {
  assertDispatchAllowed(config, estimatedCredits, workspace);
  const args = buildCodexInvocation(config, workspace, objective);
  const environment = isolatedWorkerEnvironment();
  const result = spawnSync(resolveConfiguredCodexExecutable(config), args, {
    cwd: resolve(workspace),
    env: environment,
    encoding: "utf8",
    shell: false,
    timeout: config.maximumRuntimeSeconds * 1000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    exitCode: result.status,
    signal: result.signal,
    timedOut: result.error?.name === "ETIMEDOUT",
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message,
  };
}

/** Worker subprocesses must not inherit coordinator state/config authority. */
export function isolatedWorkerEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  // Host variables are allowlisted (see worker-environment.ts).
  const environment: NodeJS.ProcessEnv = { ...developerToolEnvironment(process.env), ...overrides };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("AMADEUS_")) delete environment[key];
  }
  environment.CI = "1";
  environment.AMADEUS_WORKER = "1";
  return environment;
}

/**
 * Node options for commands a Windows MXC model worker runs in its shell.
 * The project-scoped policy denies the project's parent directory, so the
 * worker cannot read the attributes of the shared `.amadeus-worker-workspaces`
 * folders above its own workspace. Node's default entry and import resolution
 * realpath()s every ancestor and fails with `EPERM lstat` on that boundary
 * before any repository code runs. Preserving symlinks resolves paths without
 * walking ancestors, so `node scripts/x.mjs` works without widening reads.
 */
export const WINDOWS_WORKER_NODE_OPTIONS = "--preserve-symlinks-main --preserve-symlinks";

export function codexModelWorkerEnvironmentOverrides(platform = process.platform): NodeJS.ProcessEnv {
  // Replace (not extend) host NODE_OPTIONS: host-injected --require hooks live
  // outside the workspace and are themselves unreadable inside the sandbox.
  return platform === "win32" ? { NODE_OPTIONS: WINDOWS_WORKER_NODE_OPTIONS } : {};
}

export async function runCodexAsync(
  config: CodexAdapterConfig,
  workspace: string,
  objective: string,
  estimatedCredits: number,
  signal?: AbortSignal,
  onStdoutLine?: (line: string) => boolean | void,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; stdout: string; stderr: string; error?: string }> {
  assertDispatchAllowed(config, estimatedCredits, workspace);
  const args = buildCodexInvocation(config, workspace, objective);
  return runWorkerCommand(resolveConfiguredCodexExecutable(config), args, workspace, config.maximumRuntimeSeconds,
    signal, codexModelWorkerEnvironmentOverrides(), resolveMaximumIdleSeconds(config), onStdoutLine);
}

/** Shared process lifecycle for model workers and deterministic sandbox commands. */
export async function runWorkerCommand(executable: string, args: string[], workspace: string, maximumRuntimeSeconds: number,
  signal?: AbortSignal, environmentOverrides: NodeJS.ProcessEnv = {}, maximumIdleSeconds = 0,
  onStdoutLine?: (line: string) => boolean | void): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; timeoutKind?: "wall-clock" | "idle"; stdout: string; stderr: string; error?: string }> {
  const environment = isolatedWorkerEnvironment(environmentOverrides);
  return await new Promise((resolveResult) => {
    const child = spawn(resolveWorkerExecutable(executable, environment), args, { cwd: resolve(workspace), env: environment, shell: false, stdio: ["ignore", "pipe", "pipe"], detached: WORKER_PROCESS_GROUP });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeoutKind: "wall-clock" | "idle" | undefined;
    let settled = false;
    let stdoutRemainder = "";
    let protocolCompletionTimer: ReturnType<typeof setTimeout> | undefined;
    let protocolTerminationRequested = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { exitCode: number | null; signal: NodeJS.Signals | null; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(idleTimer);
      clearTimeout(protocolCompletionTimer);
      signal?.removeEventListener("abort", abort);
      resolveResult({ ...result, timedOut, timeoutKind, stdout, stderr });
    };
    const abort = () => {
        try { terminateWorkerTree(child); }
        catch (error) { stderr += `\n${String(error)}`; child.kill(); }
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      resetIdleTimer();
      if (!onStdoutLine) return;
      stdoutRemainder += chunk;
      const lines = stdoutRemainder.split(/\r?\n/);
      stdoutRemainder = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          if (onStdoutLine(line) === true && !protocolCompletionTimer) {
            // `turn.completed` is Codex's terminal protocol receipt. Some host
            // builds keep waiting on stdin after emitting it; allow output to
            // flush briefly, then close the orphaned process without waiting
            // for the ordinary idle-stall timeout.
            protocolCompletionTimer = setTimeout(() => {
              protocolTerminationRequested = true;
              abort();
            }, 2_000);
          }
        } catch { /* Progress reporting must not fail provider work. */ }
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; resetIdleTimer(); });
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (maximumIdleSeconds > 0) idleTimer = setTimeout(() => { timedOut = true; timeoutKind = "idle"; abort(); }, maximumIdleSeconds * 1000);
    };
    timer = maximumRuntimeSeconds > 0 ? setTimeout(() => { timedOut = true; timeoutKind = "wall-clock"; abort(); }, maximumRuntimeSeconds * 1000) : undefined;
    resetIdleTimer();
    child.on("error", (error) => finish({ exitCode: null, signal: null, error: error.message }));
    child.on("close", (exitCode, childSignal) => {
      // Windows taskkill reports a synthetic exit code for a forcibly
      // terminated process. Preserve the lifecycle contract: a timeout is a
      // signal-based termination with no product exit code.
      finish(protocolTerminationRequested
        ? { exitCode: 0, signal: null }
        : timedOut
        ? { exitCode: null, signal: "SIGTERM" }
        : { exitCode, signal: childSignal });
    });
  });
}

export function assertDispatchAllowed(config: CodexAdapterConfig, estimatedCredits: number, workspace?: string): CodexIsolationReceipt | undefined {
  if (!config.enabled || !config.paidDispatchEnabled) throw new Error("Codex paid dispatch is disabled");
  // Included allowance is freely available for authorized work. Estimates are reporting only.
  if (!Number.isFinite(estimatedCredits) || estimatedCredits < 0) throw new Error("Estimated usage must be non-negative");
  if (!workspace) throw new Error("Codex dispatch requires the task workspace");
  resolveConfiguredCodexExecutable(config);
  buildCodexInvocation(config, workspace, "dispatch-boundary-check", { allowWorkingChanges: true });
  return validatedCodexIsolationReceipt(config, workspace);
}

function main(): void {
  const command = process.argv[2] ?? "preview";
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      config: { type: "string" },
      workspace: { type: "string" },
      objective: { type: "string" },
      "reserve-credits": { type: "string" },
    },
    strict: true,
  });
  if (!values.config || !values.workspace) throw new Error("--config and --workspace are required");
  if (!existsSync(values.config)) throw new Error(`Missing adapter config: ${values.config}`);
  const config = JSON.parse(readFileSync(values.config, "utf8")) as CodexAdapterConfig;
  if (command === "receipt-envelope") {
    console.log(JSON.stringify(codexIsolationEnvelope(config, values.workspace), null, 2));
    return;
  }
  if (!values.objective) throw new Error("--objective is required");
  const args = buildCodexInvocation(config, values.workspace, values.objective);
  if (command === "preview") {
    console.log(JSON.stringify({ executable: "codex", args, launched: false, config }, null, 2));
    return;
  }
  if (command === "run") {
    console.log(JSON.stringify(runCodex(config, values.workspace, values.objective, Number(values["reserve-credits"])), null, 2));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

// Compare real paths so a symlinked install location (macOS /var, /tmp) still starts.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();

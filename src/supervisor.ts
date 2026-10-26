import { withLongHaulRecoveryGuidance, withRecordedOwnerAuthorization } from "./goal-protocol.ts";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CodexWorkerDriver } from "./codex-worker-driver.ts";
import { CursorWorkerDriver } from "./cursor-worker-driver.ts";
import { ClaudeWorkerDriver } from "./claude-worker-driver.ts";
import { Coordinator } from "./coordinator.ts";
import { prepareGoalExecutionStage, refreshRepeatGoalPackage, type PreparedGoalStage } from "./goal-execution-package.ts";
import { GuardedGitPatchApplicator, LocalVerifiedCheckpointDriver } from "./host-drivers.ts";
import { Orchestrator } from "./orchestrator.ts";
import { runGoalStages } from "./goal-runner.ts";
import { ProjectCheckpointDriver } from "./development-project.ts";
import { planWorkRoute, deterministicCommand, normalizeRouteModel, providersToAvoidForRetryChain, type AvoidableProvider, type WorkRoute } from "./work-routing.ts";
import { localModelAnswers, qualifiedLocalModel } from "./local-model.ts";
import { SoftwareWorkerDriver } from "./software-worker-driver.ts";
import { DeterministicVerifier } from "./deterministic-verifier.ts";
import { LEGACY_DEFAULT_CODEX_MODEL, readModelCatalog } from "./model-catalog.ts";
import { inspectCursorCli } from "./cursor-adapter.ts";
import { inspectClaudeCli } from "./claude-adapter.ts";
import { findClaudeExecutable, findGrokExecutable, grokSignedIn } from "./portable-runtime.ts";
import { isSubscriptionModelProvider, providerAllowed, workerProvider, type SubscriptionModelProvider } from "./worker-providers.ts";
import { resolveCodexExecutable } from "./codex-adapter.ts";
import { commitVerifiedMilestone } from "./milestone-git.ts";
import { resolveStandingMilestoneGitAuthorization } from "./milestone-git-authorization.ts";
import { resolveWorkerWorkspaceRoot } from "./worker-workspace-root.ts";
import { resolveMaximumIdleSeconds } from "./worker-timeouts.ts";
import { assertLocalProviderDeclared, assertSubscriptionProviderDeclared, privacyFlowsPath } from "./provider-flows.ts";

/** Durable state only — never a parent checkout or nested host layout. */
function resolveSupervisorStateRoot(dbPath?: string): string {
  if (dbPath) return resolve(dbPath, "..");
  if (process.env.AMADEUS_HOME?.trim()) return resolve(process.env.AMADEUS_HOME.trim());
  return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Amadeus");
}

function resolveWorkerManifest(stateRoot: string): string {
  const manifest = join(stateRoot, "worker-source-manifest.json");
  if (!existsSync(manifest)) {
    throw new Error(
      "Worker source manifest is missing under the Amadeus state root. "
        + "Create a goal with an explicit absolute projectRoot first; "
        + "Amadeus does not regenerate manifests from a parent host checkout.",
    );
  }
  return manifest;
}

function normalizedWritePaths(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Worker writableWorkspacePaths must be an array");
  const normalized = value.map((item) => String(item).replaceAll("\\", "/"));
  if (normalized.includes("*")) throw new Error("Worker writableWorkspacePaths cannot contain a wildcard");
  return normalized.sort();
}

function refreshCursorContainmentExecutable(config: Record<string, unknown>): void {
  if (typeof config.containmentExecutable === "string" && existsSync(config.containmentExecutable)) return;
  try {
    const candidate = execFileSync("where.exe", ["codex.exe"], { encoding: "utf8", windowsHide: true })
      .split(/\r?\n/).map((line) => line.trim()).find((line) => line && existsSync(line));
    if (candidate) config.containmentExecutable = resolve(candidate);
  } catch { /* Cursor remains unavailable and routing records the fallback. */ }
}

function assertStageWrites(stage: PreparedGoalStage, workerConfigPath: string): void {
  if (stage.stage.allowedWritableWorkspacePaths === "caller-bounded") return;
  const worker = JSON.parse(readFileSync(workerConfigPath, "utf8"));
  const actual = normalizedWritePaths(worker.writableWorkspacePaths);
  const expected = [...stage.stage.allowedWritableWorkspacePaths].map((item) => item.replaceAll("\\", "/")).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Stage ${stage.stage.name} requires exactly these writable paths: ${expected.join(", ") || "none"}`);
  }
}

function main(): Promise<void> {
  const command = process.argv[2] ?? "status";
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      db: { type: "string" },
      "goal-id": { type: "string" },
      "goal-package": { type: "string" },
      "operations-config": { type: "string" },
      "worker-config": { type: "string" },
      "cursor-worker-config": { type: "string" },
      "claude-worker-config": { type: "string" },
      "host-provider": { type: "string" },
    },
    strict: true,
  });
  const coordinatorRoot = resolve(import.meta.dirname, "..");
  const stateRoot = resolveSupervisorStateRoot(values.db);
  const packagedOperations = join(stateRoot, "runtime-config", "operations-review.json");
  const operationsPath = resolve(values["operations-config"]
    ?? (existsSync(packagedOperations) ? packagedOperations : join(coordinatorRoot, "operations-review.json")));
  const operations = JSON.parse(readFileSync(operationsPath, "utf8"));
  const coordinator = new Coordinator(values.db ?? join(stateRoot, "coordinator.sqlite"));
  const packagedWorker = join(stateRoot, "runtime-config", "worker-config.json");
  const packagedCursor = join(stateRoot, "runtime-config", "cursor-worker-config.json");
  const packagedClaude = join(stateRoot, "runtime-config", "claude-worker-config.json");
  const workerConfig = resolve(values["worker-config"]
    ?? (existsSync(packagedWorker) ? packagedWorker : join(coordinatorRoot, "worker-config.json")));
  const cursorWorkerConfig = resolve(values["cursor-worker-config"]
    ?? (existsSync(packagedCursor) ? packagedCursor : join(coordinatorRoot, "cursor-worker-config.json")));
  const claudeWorkerConfig = resolve(values["claude-worker-config"]
    ?? (existsSync(packagedClaude) ? packagedClaude : join(coordinatorRoot, "claude-worker-config.json")));
  const artifactRoot = join(stateRoot, "patches");
  let useCursor = operations.dispatch.provider === "cursor-browser-login";
  let useClaude = operations.dispatch.provider === "claude-subscription-signin";
  // Which Claude-style CLI the shared driver runs (Claude Code or Grok Build).
  let claudeStyleProvider: SubscriptionModelProvider = "claude-subscription-signin";
  const selectedWorkerConfig = useClaude ? claudeWorkerConfig : useCursor ? cursorWorkerConfig : workerConfig;
  let selectedRoute: WorkRoute | null = null;
  let softwareCompletesGoal = false;

  function checkpointDriver(stage: PreparedGoalStage | undefined, stageConfig: string) {
    const developmentMode = JSON.parse(readFileSync(stageConfig, "utf8")).developmentMode === true;
    const stateManifest = join(stateRoot, "worker-source-manifest.json");
    const projectRoot = stage?.manifestValidation.sourceRoot
      ?? (existsSync(stateManifest)
        ? JSON.parse(readFileSync(stateManifest, "utf8")).source?.projectRoot
        : null);
    if (developmentMode || projectRoot) {
      if (!projectRoot) throw new Error("Checkpoint requires an explicit goal project root");
      return new ProjectCheckpointDriver({
        projectRoot: resolve(String(projectRoot)),
        checkpointRoot: join(stateRoot, "project-checkpoints"),
      });
    }
    const script = process.env.AMADEUS_CHECKPOINT_SCRIPT?.trim();
    const config = process.env.AMADEUS_CHECKPOINT_CONFIG?.trim();
    if (script && config && existsSync(script) && existsSync(config)) {
      return new LocalVerifiedCheckpointDriver({ script: resolve(script), config: resolve(config) });
    }
    throw new Error(
      "No packaged checkpoint script is available. Public Amadeus uses project checkpoints "
        + "bound to the goal projectRoot; set AMADEUS_CHECKPOINT_SCRIPT only for an explicit verified host helper.",
    );
  }

  function orchestrator(manifest: string, objectiveOverride: string | null = null, stage?: PreparedGoalStage, stageConfig = workerConfig): Orchestrator {
    const projectRoot = resolve(String(stage?.manifestValidation.sourceRoot
      ?? JSON.parse(readFileSync(manifest, "utf8")).source.projectRoot));
    const workspaceRoot = resolveWorkerWorkspaceRoot(projectRoot, stateRoot);
    if (selectedRoute?.provider === "local-openai-compatible") {
      assertLocalProviderDeclared(privacyFlowsPath(coordinatorRoot));
    } else if (selectedRoute?.provider !== "software") {
      assertSubscriptionProviderDeclared(useClaude ? claudeStyleProvider : useCursor ? "cursor-browser-login" : "codex-chatgpt-signin",
        privacyFlowsPath(coordinatorRoot));
    }
    const worker = selectedRoute?.provider === "software"
      ? new SoftwareWorkerDriver({ config: stageConfig, manifest, workspaceRoot,
        artifactRoot, runtimeHomeRoot: join(stateRoot, "software-runtime-homes"),
        heartbeatSeconds: operations.heartbeatSeconds, command: selectedRoute.command, completeGoal: softwareCompletesGoal })
      : useClaude
      ? new ClaudeWorkerDriver({
        config: stageConfig,
        manifest,
        workspaceRoot,
        artifactRoot,
        heartbeatSeconds: operations.heartbeatSeconds,
        objectiveOverride,
      })
      : useCursor
      ? new CursorWorkerDriver({
        config: stageConfig,
        manifest,
        workspaceRoot,
        artifactRoot,
        heartbeatSeconds: operations.heartbeatSeconds,
        objectiveOverride,
      })
      : new CodexWorkerDriver({
        config: stageConfig,
        manifest,
        workspaceRoot,
        artifactRoot,
        heartbeatSeconds: operations.heartbeatSeconds,
        objectiveOverride,
      });
    return new Orchestrator(
      coordinator,
      worker,
      checkpointDriver(stage, stageConfig),
      new GuardedGitPatchApplicator({
        projectRoot: stage?.manifestValidation.sourceRoot ?? JSON.parse(readFileSync(manifest, "utf8")).source.projectRoot,
        workerConfig: stageConfig,
        artifactRoot,
      }),
      {
        leaseSeconds: operations.staleLeaseSeconds,
        maximumIdleSeconds: resolveMaximumIdleSeconds(JSON.parse(readFileSync(stageConfig, "utf8"))),
        model: operations.dispatch.model,
        maximumChangedFiles: stage?.stage.maximumChangedFiles ?? operations.admissionLimits.maximumChangedFiles,
        maximumChangedLines: stage?.stage.maximumChangedLines ?? operations.admissionLimits.maximumChangedLines,
        patchPolicy: stage?.stage.patchPolicy ?? "apply",
        ...(stage?.stage.role === "development" && selectedRoute?.provider !== "software" ? {
          verifier: new DeterministicVerifier({
            // Verification is always executed by the local Codex sandbox as
            // ordinary software, regardless of which provider produced the
            // patch. A Cursor stage config describes Cursor containment and
            // cannot satisfy the Codex sandbox contract.
            config: workerConfig,
            artifactRoot,
            runtimeHomeRoot: join(stateRoot, "software-runtime-homes"),
            projectRoot,
          }),
        } : {}),
        ...(selectedRoute ? { routeStep: {
          provider: selectedRoute.provider, model: selectedRoute.model,
          reasoningEffort: selectedRoute.reasoningEffort,
          financialBasis: selectedRoute.financialBasis, reason: selectedRoute.reason,
        } } : {}),
        ...(stage?.stage.role === "development" && operations.gitMilestones?.enabled !== false ? {
          milestoneProjectRoot: stage.manifestValidation.sourceRoot,
          onVerifiedMilestone: ({
            jobId, goalId, summary, patchSha256, changedPaths, preDirtyPaths, decisionStatus,
          }: {
            jobId: string;
            goalId: string;
            summary: string;
            patchSha256: string;
            changedPaths: string[];
            preDirtyPaths: string[];
            decisionStatus: "continue" | "complete" | "blocked" | "needs_approval";
          }) => {
            const goal = coordinator.getGoal(goalId);
            const goalRevision = Number(goal.goal_revision ?? 1);
            const sourceRevision = stage.manifestValidation.sourceRevision;
            const standingGrant = operations.gitMilestones?.standingAuthorization;
            const remoteName = String(standingGrant?.remote ?? operations.gitMilestones?.remote ?? "origin");
            let currentBranch = "";
            let currentRemoteUrl: string | null = null;
            try {
              currentBranch = execFileSync("git", ["-C", stage.manifestValidation.sourceRoot, "branch", "--show-current"], { encoding: "utf8" }).trim();
              currentRemoteUrl = execFileSync("git", ["-C", stage.manifestValidation.sourceRoot, "remote", "get-url", remoteName], { encoding: "utf8" }).trim();
            } catch { /* resolver fails closed with the captured empty values */ }
            const authorization = standingGrant?.enabled
              ? resolveStandingMilestoneGitAuthorization({ goalId, goalRevision, sourceRevision, patchDigest: patchSha256,
                changedPaths, decisionStatus, projectRoot: stage.manifestValidation.sourceRoot, currentBranch, currentRemoteUrl,
                grant: standingGrant })
              : coordinator.resolveGoalGitAuthorization(goalId, sourceRevision, patchSha256, changedPaths);
            let authorizationReserved = false;
            if (authorization.status === "authorized" && authorization.grantScope === "bounded_standing") {
              coordinator.recordAuditNote(jobId, "milestone_git_standing_authorization", JSON.stringify({
                goalId, goalRevision, grantId: authorization.approvalIds[0], decisionStatus,
                sourceRevision, patchDigest: patchSha256, changedPaths, branch: authorization.targetBranch,
                remote: authorization.targetRemote, remoteUrl: authorization.targetRemoteUrl,
              }));
            }
            const result = commitVerifiedMilestone({
              projectRoot: stage.manifestValidation.sourceRoot,
              summary,
              goalId,
              goalRevision,
              sourceRevision,
              patchDigest: patchSha256,
              authorization,
              changedPaths,
              preDirtyPaths,
              reserveAuthorization: authorization.grantScope === "bounded_standing" ? undefined : (approvalIds) => {
                authorizationReserved = coordinator.reserveGoalGitApprovals(goalId, goalRevision, approvalIds);
                return authorizationReserved;
              },
            });
            if (authorizationReserved) {
              coordinator.finalizeGoalGitApprovals(goalId, goalRevision, authorization.approvalIds,
                result.status === "committed_and_pushed" || result.status === "committed_not_pushed" ? "consumed" : "uncertain");
            }
            coordinator.recordMilestoneGitAutomation({ jobId, goalId, result });
            return result;
          },
        } : {}),
      },
    );
  }

  if (command === "startup") {
    coordinator.pause();
    console.log(JSON.stringify({ paused: true, dispatched: false }));
    coordinator.close();
    return Promise.resolve();
  }
  if (command === "status") {
    console.log(JSON.stringify(coordinator.status(), null, 2));
    coordinator.close();
    return Promise.resolve();
  }
  if (command !== "run-once" && command !== "run-goal") {
    coordinator.close();
    throw new Error(`Unknown supervisor command: ${command}`);
  }
  if (operations.enabled !== true) {
    coordinator.close();
    throw new Error("Worker orchestration is disabled");
  }
  if (command === "run-goal") {
    if (operations.goalLoop?.enabled !== true) {
      coordinator.close();
      throw new Error("Persistent-goal automatic continuation is disabled");
    }
    const goalId = values["goal-id"]?.trim();
    const packagePath = values["goal-package"]?.trim();
    if (!goalId || !packagePath) {
      coordinator.close();
      throw new Error("--goal-id and --goal-package are required for run-goal");
    }
    return (async () => {
      const worker = JSON.parse(readFileSync(selectedWorkerConfig, "utf8"));
      let currentWorker = worker;
      const lastJob = await runGoalStages({ coordinator, goalId, packagePath,
        writablePaths: normalizedWritePaths(worker.writableWorkspacePaths),
        async runStage(stage, writableWorkspacePaths) {
          const temporaryRoot = mkdtempSync(join(tmpdir(), "amadeus-worker-stage-"));
          const stageConfig = join(temporaryRoot, "worker.json");
          try {
            let selected = currentWorker;
            if (worker.developmentMode && stage.stage.role === "development") {
              const descriptor = JSON.parse(readFileSync(packagePath, "utf8"));
              const goal = coordinator.getGoal(goalId);
              const job = coordinator.getJob(String(goal.current_job_id));
              const latest = coordinator.goalEvents(goalId).filter((event) => event.kind === "iteration_completed").at(-1);
              const suggested = latest ? JSON.parse(String(latest.detail)).decision?.nextRoute : null;
              const objective = String(job.iteration_objective || goal.next_objective || goal.objective);
              const avoidProviders = new Set<AvoidableProvider>();
              const retryEvents = coordinator.goalEvents(goalId).filter((event) => event.kind === "retry_authorized");
              const retryHistory: Array<{ jobStatus: string; retryAuthorized: boolean; provider: unknown; failureDetail: unknown }> = [];
              for (let iteration = Number(job.goal_iteration) - 1; iteration > 0; iteration--) {
                const earlierJob = coordinator.getGoalIterationJob(goalId, iteration);
                if (!earlierJob) continue;
                const matchingRetry = retryEvents.find((event) => {
                  const detail = JSON.parse(String(event.detail));
                  return String(detail.failedJobId ?? detail.rejectedJobId) === String(earlierJob.id);
                });
                const failedRoute = coordinator.events(String(earlierJob.id)).filter((event) => event.kind === "route_selected").at(-1);
                retryHistory.push({
                  jobStatus: String(earlierJob.status),
                  retryAuthorized: Boolean(matchingRetry),
                  provider: failedRoute ? JSON.parse(JSON.parse(String(failedRoute.detail)).detail).provider : null,
                  failureDetail: earlierJob.outcome,
                });
              }
              for (const provider of providersToAvoidForRetryChain(retryHistory)) avoidProviders.add(provider);
              const cursorConfig = existsSync(cursorWorkerConfig) ? JSON.parse(readFileSync(cursorWorkerConfig, "utf8")) : {};
              if (cursorConfig.executable) refreshCursorContainmentExecutable(cursorConfig);
              const claudeConfig = existsSync(claudeWorkerConfig) ? JSON.parse(readFileSync(claudeWorkerConfig, "utf8")) : {};
              // Existing non-default package choices are treated as explicit pins.
              const pinned = descriptor.routingMode === "pinned" || (descriptor.routingMode !== "automatic" &&
                (descriptor.provider === "cursor-browser-login" || descriptor.provider === "claude-subscription-signin"
                  || (descriptor.model && descriptor.model !== LEGACY_DEFAULT_CODEX_MODEL)))
                ? { provider: descriptor.provider, model: normalizeRouteModel(descriptor.model, "pinned"), reasoningEffort: descriptor.reasoningEffort } : null;
              const launcherIndex = (cursorConfig.executableArguments ?? []).indexOf("-File");
              const cursorStatus = inspectCursorCli(cursorConfig);
              const cursorInstalled = existsSync(cursorConfig.executable)
                && (launcherIndex < 0 || existsSync(cursorConfig.executableArguments[launcherIndex + 1]))
                && existsSync(cursorConfig.containmentExecutable)
                && cursorStatus.installed === true && cursorStatus.statusExitCode === 0;
              const claudeStatus = inspectClaudeCli(claudeConfig);
              const configuredClaude = Boolean(claudeConfig.executable)
                && existsSync(claudeConfig.executable)
                && existsSync(claudeConfig.containmentExecutable)
                && claudeStatus.installed === true
                && claudeConfig.authentication === "subscription-signin"
                && claudeConfig.apiKeyAuthenticationAllowed === false;
              // D5: a development worker needs no separate Claude (or Cursor) setup.
              // A signed-in Claude Code install plus the Codex CLI (which provides the
              // Windows sandbox) is enough; the driver derives the rest from the project.
              const codexExecutable = resolveCodexExecutable();
              const codexInstalled = !/^codex$/i.test(codexExecutable) || existsSync(String(worker.executable ?? ""));
              const portableClaude = worker.developmentMode === true && claudeConfig.apiKeyAuthenticationAllowed !== true
                && Boolean(findClaudeExecutable()) && codexInstalled;
              const claudeInstalled = configuredClaude || portableClaude;
              // Grok Build is not yet verified live, so it also needs the owner's opt-in
              // ("enabledProviders": ["grok-subscription-signin"]) and a subscription sign-in.
              const grokInstalled = worker.developmentMode === true && codexInstalled
                && providerAllowed("grok-subscription-signin", worker.enabledProviders)
                && Boolean(findGrokExecutable()) && grokSignedIn();
              const hostProvider = isSubscriptionModelProvider(values["host-provider"]) ? values["host-provider"] : null;
              const preferredProvider = isSubscriptionModelProvider(worker.preferredProvider) ? worker.preferredProvider : null;
              // A provider at its usage limit (on any goal) is skipped until its reset time.
              const limitedProviders = coordinator.providersAtUsageLimit().filter(isSubscriptionModelProvider);
              const installedProviders: SubscriptionModelProvider[] = [
                ...(codexInstalled ? ["codex-chatgpt-signin" as const] : []),
                ...(claudeInstalled ? ["claude-subscription-signin" as const] : []),
                ...(grokInstalled ? ["grok-subscription-signin" as const] : []),
              ];
              // One owner setting for every provider: { "<provider>": { "efficient": "...", ... } }.
              const tierModels = worker.tierModels && typeof worker.tierModels === "object" ? worker.tierModels : null;
              let catalog;
              let catalogSource = "local Codex model catalog";
              try { catalog = readModelCatalog(); }
              catch {
                // A missing cache must not make a pinned route or ordinary task unusable.
                // The configured model is a disclosed fallback, not called "strongest".
                catalogSource = "configured fallback; current ranking unavailable";
                catalog = { fetchedAt: "unavailable", models: [{ slug: operations.dispatch.model,
                  priority: 0, supportedEfforts: ["low", "medium", "high"] }] };
              }
              // The owner's local model: enabled, loopback-only, qualified, and answering right now.
              const qualifiedLocal = qualifiedLocalModel(worker.localModel, stateRoot);
              const localModel = qualifiedLocal && await localModelAnswers(qualifiedLocal) ? qualifiedLocal : null;
              const plan = planWorkRoute({
                objective, pinned, suggested, avoidProviders: [...avoidProviders],
                localModelPilotGateOpen: localModel !== null, qualifiedLocalModels: localModel ? [localModel] : [],
                routingPolicy: worker.routingPolicy,
                // Host desktop automation only for the owner's own goal objective, never a worker-proposed step.
                desktopAutomationAllowed: objective === String(goal.objective),
                cursorInstalled, claudeInstalled, codexInstalled, installedProviders, hostProvider, preferredProvider, limitedProviders, tierModels, catalog,
              });
              const route = plan.primary;
              if (catalogSource !== "local Codex model catalog" && route.provider === "codex-chatgpt-signin" && !pinned && !suggested) {
                route.reason = `Current model ranking unavailable; used configured Codex model. ${route.reason}`;
              }
              selectedRoute = route;
              softwareCompletesGoal = Boolean(route.command?.startsWith("windows-ui-"))
                || deterministicCommand(String(goal.objective)) === route.command
                && /^(?:(?:all\s+)?(?:tests?|build|lint|checks?|type[ -]?checks?)\s+(?:pass(?:es)?|succeeds?)|exit code 0)[.!]?$/i.test(String(goal.success_criteria).trim());
              coordinator.recordAuditNote(String(job.id), "route_selected", JSON.stringify({ ...route,
                objective, installedProviders, limitedProviders, catalogFetchedAt: catalog.fetchedAt, catalogSource, allowanceComparison: "unavailable",
                providerAvailability: "local-catalog-and-executable-not-live-auth-check" }));
              coordinator.recordAuditNote(String(job.id), "route_plan_created", JSON.stringify({
                ...plan, objective, catalogFetchedAt: catalog.fetchedAt, catalogSource,
              }));
              coordinator.recordAuditNote(String(job.id), "route_step_completed", JSON.stringify({
                ...plan.steps[0], schemaVersion: 1, passed: true,
                summary: `Project package refreshed and validated for ${stage.manifestValidation.files} files.`,
                evidence: [stage.manifestPath],
              }));
              {
                const routedProvider = workerProvider(route.provider);
                useClaude = routedProvider?.driver === "claude-style";
                if (useClaude) claudeStyleProvider = routedProvider!.id;
                const routedCli = routedProvider?.cli ?? "claude";
                useCursor = route.provider === "cursor-browser-login";
                // A local model runs in the Codex worker (same sandbox and receipts) against its loopback endpoint.
                const useLocal = route.provider === "local-openai-compatible";
                const basePath = useClaude ? (routedCli === "claude" ? claudeWorkerConfig : null) : useCursor ? cursorWorkerConfig : workerConfig;
                // A missing Claude-style config is fine: the driver derives a portable one.
                const base = basePath && existsSync(basePath) ? JSON.parse(readFileSync(basePath, "utf8")) : {};
                selected = { ...base, ...(useCursor ? {
                  containmentExecutable: cursorConfig.containmentExecutable,
                  assignedProjectRoot: stage.manifestValidation.sourceRoot,
                } : {}), ...(useClaude ? {
                  cli: routedCli,
                  ...(configuredClaude && routedCli === "claude" ? { containmentExecutable: claudeConfig.containmentExecutable } : {}),
                  assignedProjectRoot: stage.manifestValidation.sourceRoot,
                  authentication: "subscription-signin",
                  apiKeyAuthenticationAllowed: false,
                } : {}),
                  enabled: true, paidDispatchEnabled: true, dispatchAuthorized: true,
                  implementationPrepared: true, implementationDispatchAuthorized: true, readOnlyOnly: false,
                  developmentMode: true,
                  // Command network access is an explicit owner opt-in in the worker config.
                  commandNetworkEnabled: base.commandNetworkEnabled === true,
                  // Shared by every provider (D5): may a worker run commands? Default on.
                  workerCommandsEnabled: worker.workerCommandsEnabled !== false,
                  deniedSourceRoot: stage.manifestValidation.sourceRoot,
                  ...(useLocal ? { localModelEndpoint: route.endpoint } : {}),
                  model: normalizeRouteModel(route.model ?? (useClaude || useCursor ? "auto" : null)),
                  reasoningEffort: route.reasoningEffort === "none" ? "low" : route.reasoningEffort };
              }
            } else {
              selectedRoute = {
                provider: "codex-chatgpt-signin",
                model: normalizeRouteModel(selected.model ?? operations.dispatch.model ?? LEGACY_DEFAULT_CODEX_MODEL),
                reasoningEffort: selected.reasoningEffort ?? operations.dispatch.reasoningEffort ?? "low",
                reason: "Fixed package stage: use the configured Codex route.",
                financialBasis: "subscription-suitability-not-price-comparison",
                routingPolicy: "balanced-quality",
                taskClass: "explicit",
                capabilityTier: "explicit",
                capabilitySignals: ["fixed package stage"],
                localModelCandidate: false,
              };
              coordinator.recordAuditNote(String(coordinator.getGoal(goalId).current_job_id), "route_selected", JSON.stringify({
                ...selectedRoute,
                objective: stage.objectiveOverride,
                catalogFetchedAt: null,
                catalogSource: "fixed package stage",
                allowanceComparison: "unavailable",
                providerAvailability: "configured fixed route",
              }));
            }
            operations.dispatch.model = selected.model;
            currentWorker = selected;
            writeFileSync(stageConfig, JSON.stringify({ ...selected, writableWorkspacePaths }));
            assertStageWrites(stage, stageConfig);
            // Apply current guidance even when an older long-lived server queued the saved objective.
            // Fixed package objectives remain immutable.
            const dispatchGoal = coordinator.getGoal(goalId);
            const dispatchJob = coordinator.getJob(String(dispatchGoal.current_job_id));
            const dispatchObjective = stage.stage.objectiveMode === "coordinator"
              ? withRecordedOwnerAuthorization(withLongHaulRecoveryGuidance(String(dispatchJob.objective), Number(dispatchGoal.continuous_development) === 1), coordinator.goalEvents(goalId))
              : stage.objectiveOverride;
            return await orchestrator(stage.manifestPath, dispatchObjective, stage, stageConfig).runOnce(goalId);
          } finally { rmSync(temporaryRoot, { recursive: true, force: true }); }
        },
      });
      console.log(JSON.stringify({ goal: coordinator.getGoal(goalId), lastJob }, null, 2));
    })().finally(() => coordinator.close());
  }
  return orchestrator(resolveWorkerManifest(stateRoot)).runOnce().then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).finally(() => coordinator.close());
}

await main();

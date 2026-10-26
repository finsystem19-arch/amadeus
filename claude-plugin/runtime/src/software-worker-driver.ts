import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildCodexInvocation, buildCodexSandboxCommand, runWorkerCommand } from "./codex-adapter.ts";
import { materializeWorkspace, materializeWritableWorkspacePaths } from "./worker-isolation.ts";
import type { WorkerContext, WorkerDriver, WorkerResult } from "./orchestrator.ts";
import type { WorkRoute } from "./work-routing.ts";
import { portableWorkerConfig } from './portable-runtime.ts';
import { parseWindowsUiCommand, runWindowsUiPlan, type WindowsUiCommand } from "./windows-ui-automation.ts";
import { npmCliPath } from "./verification-checks.mjs";

export function testCommandArgs(command: WorkRoute["command"]): string[] {
  if (command === "node-test") return ["--test"];
  if (command?.startsWith("npm-")) {
    const npm = npmCliPath();
    if (!existsSync(npm)) throw new Error("npm CLI not found alongside Node; no test was launched");
    const script = command.slice("npm-".length);
    return script === "test" ? [npm, "test"] : [npm, "run", script];
  }
  throw new Error("Unsupported deterministic operation");
}

export class SoftwareWorkerDriver implements WorkerDriver {
  private readonly paths: { config: string; manifest: string; workspaceRoot: string; artifactRoot: string;
    runtimeHomeRoot?: string; heartbeatSeconds?: number; command: WorkRoute["command"]; completeGoal: boolean };
  private readonly execute: typeof runWorkerCommand;
  constructor(paths: SoftwareWorkerDriver["paths"], execute = runWorkerCommand) { this.paths = paths; this.execute = execute; }

  async run(context: WorkerContext): Promise<WorkerResult> {
    context.signal.throwIfAborted();
    let config = JSON.parse(readFileSync(this.paths.config, "utf8"));
    if (config.developmentMode) config = portableWorkerConfig(config, config.deniedSourceRoot);
    const workspaceId = `${context.jobId}-a${context.attempt}`;
    const { workspace } = materializeWorkspace({ manifestPath: this.paths.manifest, workspaceRoot: this.paths.workspaceRoot, workspaceId });
    materializeWritableWorkspacePaths(workspace, config.writableWorkspacePaths ?? []);
    const windowsUi = this.paths.command ? parseWindowsUiCommand(this.paths.command) : null;
    if (windowsUi) {
      mkdirSync(this.paths.artifactRoot, { recursive: true });
      const resultArtifactPath = join(this.paths.artifactRoot, `${workspaceId}.windows-ui-result.json`);
      const result = runWindowsUiPlan(workspace, this.paths.command as WindowsUiCommand);
      writeFileSync(resultArtifactPath, `${JSON.stringify({ modelInvoked: false, command: this.paths.command, ...result }, null, 2)}\n`, "utf8");
      const passed = result.status === "passed";
      return { outcome: result.summary, resultArtifactPath,
        providerUsage: { provider: "software", model: null, sessionId: workspaceId, requestId: null,
          durationMs: null, durationApiMs: null, tokenUsageAvailable: true, inputTokens: 0,
          cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, actualProviderCredits: null },
        goalDecision: { status: passed && this.paths.completeGoal ? "complete" : passed ? "continue" : "blocked",
          summary: result.summary, evidence: [resultArtifactPath], question: null,
          nextObjective: passed && !this.paths.completeGoal ? `Review the Windows UI receipt ${resultArtifactPath} and continue the original goal.` : null } };
    }
    // The restricted Windows token may not have a discoverable profile. Give
    // the sandbox launcher an isolated writable home inside this disposable
    // workspace so deterministic commands never depend on the owner's profile.
    const runtimeHome = join(this.paths.runtimeHomeRoot ?? join(dirname(this.paths.workspaceRoot), ".software-runtime-homes"), workspaceId);
    mkdirSync(runtimeHome, { recursive: true });
    const permissions = buildCodexInvocation(config, workspace, "No model call")
      .find(arg => typeof arg === "string" && arg.startsWith("permissions."));
    if (!permissions) throw new Error("Software verification could not derive the worker permission definition");
    const args = buildCodexSandboxCommand(config, workspace, permissions, process.execPath,
      testCommandArgs(this.paths.command));
    const leaseAbort = new AbortController();
    let heartbeatFailure: unknown;
    const timer = setInterval(() => {
      try { context.heartbeat(); } catch (error) { heartbeatFailure = error; leaseAbort.abort(); }
    }, (this.paths.heartbeatSeconds ?? 60) * 1000);
    try {
      const result = await this.execute(config.executable || "codex", args, workspace, config.maximumRuntimeSeconds,
        AbortSignal.any([context.signal, leaseAbort.signal]), {
          CODEX_HOME: runtimeHome,
        }, Math.max(30, Number(config.maximumIdleSeconds) || 120));
      mkdirSync(this.paths.artifactRoot, { recursive: true });
      const resultArtifactPath = join(this.paths.artifactRoot, `${workspaceId}.software-result.json`);
      writeFileSync(resultArtifactPath, JSON.stringify({ modelInvoked: false, command: this.paths.command, ...result }, null, 2));
      if (heartbeatFailure) throw heartbeatFailure;
      if (result.timedOut || result.signal || result.error) throw new Error(`Software process did not finish reliably; see ${resultArtifactPath}`);
      const passed = result.exitCode === 0;
      const summary = `Local ${this.paths.command} ${passed ? "passed" : "failed"}; no model called. Test-generated workspace changes are not applied.`;
      return { outcome: summary, resultArtifactPath,
        providerUsage: { provider: "software", model: null, sessionId: workspaceId, requestId: null,
          durationMs: null, durationApiMs: null, tokenUsageAvailable: true, inputTokens: 0,
          cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, actualProviderCredits: null },
        goalDecision: { status: !passed ? "blocked" : this.paths.completeGoal ? "complete" : "continue",
          summary, evidence: [resultArtifactPath], question: null,
          nextObjective: passed && !this.paths.completeGoal ? `Review the local test receipt ${resultArtifactPath} and continue the original goal; passing this test alone does not complete it.` : null } };
    } finally {
      clearInterval(timer);
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  }
}

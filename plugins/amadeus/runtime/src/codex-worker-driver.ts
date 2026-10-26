import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { runCodexAsync, type CodexAdapterConfig } from "./codex-adapter.ts";
import { assertModelCallAllowed, DefiniteWorkerFailure, UntrustedWorkerReceiptError, type WorkerContext, type WorkerDriver, type WorkerResult } from "./orchestrator.ts";
import { materializeWorkspace, materializeWritableWorkspacePaths } from "./worker-isolation.ts";
import { parseCodexUsage } from "./usage-accounting.ts";
import { parseGoalDecision } from "./goal-protocol.ts";
import { captureWorkerPatch, seedWorkspaceWithPatch } from "./worker-patch.ts";
import { prepareWorkspaceIsolationAcceptance } from "./workspace-isolation-acceptance.ts";
import { portableWorkerConfig } from './portable-runtime.ts';

export type CodexProgress = {
  phase: "preparing" | "analysis" | "command" | "edit" | "research" | "reporting";
  status: "started" | "completed" | "failed";
  summary: string;
  paths?: string[];
  important?: boolean;
};

export function classifyCodexCommand(command: unknown): string {
  const value = String(command ?? "").toLowerCase();
  if (/\b(node\s+--test|npm(?:\.cmd)?\s+(?:run\s+)?test|pytest|cargo\s+test)\b/.test(value)) return "the test suite";
  if (/\b(npm(?:\.cmd)?\s+run\s+[^\s]*build|build-plugin-runtime)\b/.test(value)) return "the package build";
  if (/\bgit(?:\.exe)?\s/.test(value)) return "a Git check";
  if (/\b(rg|e?grep|select-string|sls|get-childitem|get-content|findstr)(?:\.exe)?\b/.test(value)) return "a repository inspection";
  if (/\b(node|pwsh|powershell)(?:\.exe)?\s/.test(value)) return "a local verification command";
  return "a repository command";
}

/**
 * Commands whose exit code 1 means "no matches": rg, grep, git grep, findstr, Select-String.
 * Not when the command also runs tests, a build or another Git command, whose exit 1 is a failure.
 */
export function isSearchCommand(command: unknown): boolean {
  const value = String(command ?? "").toLowerCase();
  if (!/(?:^|[\s"'(;&|])(?:rg|grep|egrep|findstr|select-string|sls)(?:\.exe)?(?=[\s"')]|$)/.test(value)) return false;
  const label = classifyCodexCommand(value);
  return label === "a repository inspection" || (label === "a Git check" && !/\bgit(?:\.exe)?\s+(?!grep\b)[a-z]/.test(value));
}

/** Convert a provider JSONL event into a privacy-safe owner progress checkpoint. */
export function parseCodexProgressLine(line: string, workspace: string): CodexProgress | null {
  let event: Record<string, any>;
  try { event = JSON.parse(line); }
  catch { return null; }
  if (event.type === "turn.started") {
    return { phase: "analysis", status: "started", summary: "The implementation turn started." };
  }
  if (event.type === "turn.completed") {
    return { phase: "reporting", status: "completed", summary: "The implementation turn completed and is preparing its result.", important: true };
  }
  const item = event.item;
  if (!item || typeof item !== "object") return null;
  const completed = event.type === "item.completed";
  const failed = String(item.status ?? "").toLowerCase() === "failed";
  const status = failed ? "failed" : completed ? "completed" : "started";
  if (item.type === "command_execution") {
    // Search tools exit 1 when nothing matches: an answer, not a failure.
    if (failed && item.exit_code === 1 && isSearchCommand(item.command)) {
      return { phase: "command", status: "completed", summary: "A repository search found no matches." };
    }
    const label = classifyCodexCommand(item.command);
    const capitalized = `${label[0].toUpperCase()}${label.slice(1)}`;
    const exit = Number.isInteger(item.exit_code) ? ` (exit ${item.exit_code})` : "";
    return {
      phase: "command", status,
      summary: failed ? `${capitalized} failed${exit}; the worker is adapting.`
        : completed ? `${capitalized} completed${exit}.` : `Running ${label}.`,
      important: failed,
    };
  }
  if (item.type === "file_change") {
    const paths = Array.isArray(item.changes) ? item.changes.flatMap((change: any) => {
      const absolute = typeof change?.path === "string" ? resolve(change.path) : "";
      if (!absolute || !isAbsolute(absolute)) return [];
      const projectRelative = relative(resolve(workspace), absolute).replaceAll("\\", "/");
      return !projectRelative || projectRelative === ".." || projectRelative.startsWith("../") ? [] : [projectRelative];
    }).slice(0, 8) : [];
    const suffix = paths.length ? `: ${paths.join(", ")}` : "";
    return {
      phase: "edit", status,
      summary: completed ? `Updated ${paths.length || "project"} file${paths.length === 1 ? "" : "s"}${suffix}.` : "Preparing project file changes.",
      ...(paths.length ? { paths } : {}), important: completed,
    };
  }
  if (item.type === "web_search") {
    return { phase: "research", status, summary: completed ? "Finished checking an external source." : "Checking an external source." };
  }
  if (item.type === "agent_message" && completed) {
    return { phase: "reporting", status: "completed", summary: "The worker recorded an implementation checkpoint." };
  }
  return null;
}

export function buildEphemeralWorkerGuidance(workspace: string, platform = process.platform): string {
  const base = "\n\nThis is an ephemeral worker invocation. Do not call persistent goal, thread, delegation, or coordinator tools. Perform the assigned repository work directly and return the required JSON result to the caller.";
  if (platform !== "win32") return base;
  const project = resolve(workspace);
  return `${base}\n\nWindows worker note: an MXC command shell may initially report C:\\\\ because unreadable parent directories prevent the shell from inheriting the project directory. The assigned project is ${JSON.stringify(project)}. Do not inspect C:\\\\ or conclude the exact project is inaccessible from a failed PowerShell Set-Location. Run repository commands through cmd /d /s /c with an explicit cd /d to that exact project path; the exact child workspace remains allowed. The parent folders above the workspace are deliberately unreadable: an \`EPERM ... lstat\` on one of them is the containment boundary, not a test failure. Node is preconfigured to start repository scripts without walking those parents; do not clear NODE_OPTIONS for direct \`node\` commands. When the project defines sandbox variants of its checks (npm scripts ending in \`:sandbox\`), prefer them.`;
}

export function parseFinalAgentMessage(jsonl: string): string {
  const messages: string[] = [];
  for (const line of jsonl.split(/\r?\n/).filter(Boolean)) {
    let event: unknown;
    try { event = JSON.parse(line); }
    catch { continue; }
    if (typeof event !== "object" || event === null) continue;
    const record = event as Record<string, unknown>;
    const item = record.item;
    if (record.type !== "item.completed" || typeof item !== "object" || item === null) continue;
    const itemRecord = item as Record<string, unknown>;
    if (itemRecord.type === "agent_message" && typeof itemRecord.text === "string" && itemRecord.text.trim()) {
      messages.push(itemRecord.text.trim());
    }
  }
  if (messages.length === 0) throw new Error("Codex receipt contains no completed agent message");
  return messages.at(-1)!;
}

/** Error text Codex reports as JSON events (`error`, `turn.failed`), e.g. a usage limit, which never reaches stderr. */
export function codexJsonErrors(jsonl: string): string[] {
  const messages: string[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; message?: unknown; error?: { message?: unknown } };
      const message = event.type === "error" ? event.message : event.type === "turn.failed" ? event.error?.message : undefined;
      if (typeof message === "string" && message.trim()) messages.push(message.trim().slice(0, 1000));
    } catch { /* non-JSON progress lines are ignored */ }
  }
  return [...new Set(messages)];
}

function git(workspace: string, args: string[]): string {
  return execFileSync("git", ["-c", `safe.directory=${workspace}`, "-C", workspace, ...args], { encoding: "utf8" });
}

export class CodexWorkerDriver implements WorkerDriver {
  private readonly paths: {
    config: string;
    manifest: string;
    workspaceRoot: string;
    artifactRoot: string;
    heartbeatSeconds?: number;
    objectiveOverride?: string | null;
  };

  constructor(paths: {
    config: string;
    manifest: string;
    workspaceRoot: string;
    artifactRoot: string;
    heartbeatSeconds?: number;
    objectiveOverride?: string | null;
  }) { this.paths = paths; }

  async run(context: WorkerContext): Promise<WorkerResult> {
    let config = JSON.parse(readFileSync(this.paths.config, "utf8")) as CodexAdapterConfig;
    if (config.developmentMode) config = portableWorkerConfig(config, config.deniedSourceRoot) as CodexAdapterConfig;
    const decisionSchema = config.developmentMode && context.goalId && !this.paths.objectiveOverride
      ? join(import.meta.dirname, "goal-decision.schema.json") : undefined;
    // Local model servers enforce --output-schema on every response, which stops the
    // model from calling tools first; for them the schema is stated in the objective
    // and the final message is validated exactly as before (parseGoalDecision).
    if (decisionSchema && !config.localModelEndpoint) config.outputSchema = decisionSchema;
    const localDecisionGuidance = decisionSchema && config.localModelEndpoint
      ? `\n\nWhen the work is finished, your final message must be only one JSON object (no prose, no code fence) that validates against this JSON Schema:\n${readFileSync(decisionSchema, "utf8")}`
      : "";
    const workspaceId = `${context.jobId}-a${context.attempt}`;
    const { workspace } = materializeWorkspace({
      manifestPath: this.paths.manifest,
      workspaceRoot: this.paths.workspaceRoot,
      workspaceId,
    });
    materializeWritableWorkspacePaths(workspace, config.writableWorkspacePaths ?? []);
    const seed = context.seedPatch ? seedWorkspaceWithPatch(workspace, context.seedPatch) : null;
    mkdirSync(this.paths.artifactRoot, { recursive: true });
    config = prepareWorkspaceIsolationAcceptance({ adapter: "codex", config, workspace,
      artifactRoot: this.paths.artifactRoot, workspaceId });
    const leaseAbort = new AbortController();
    let heartbeatFailure: unknown;
    const heartbeat = setInterval(() => {
      try { context.heartbeat(); }
      catch (error) { heartbeatFailure = error; leaseAbort.abort(); }
    }, (this.paths.heartbeatSeconds ?? 60) * 1000);
    try {
      const reservation = context.reservedCredits;
      const objective = this.paths.objectiveOverride?.trim() || context.objective;
      const recoveryGuidance = context.goalId && !this.paths.objectiveOverride?.trim()
        ? '\n\nOrdinary development recovery: fix recoverable technical problems and run relevant checks within this same scope before stopping. If a repair requires another bounded step, return continue with the repair-and-verification objective. A technical blocked result may include recovery: {"diagnosis":"observed cause","nextObjective":"in-scope repair, tests, and resumption of the original goal","scope":"same-approved-scope"}. Do not repeat an unchanged failed operation, override an explicit attempt/spending limit, or mistake a repair for completion of the original goal. Use needs_approval for genuine authority/product decisions; omit recovery for uncertainty or faults you cannot resolve.'
        : "";
      const ephemeralWorkerGuidance = buildEphemeralWorkerGuidance(workspace);
      context.progress?.({ phase: "preparing", status: "completed", summary: seed?.seeded
        ? "Prepared the isolated project workspace from the previous attempt's change and verified its execution boundary."
        : "Prepared the isolated project workspace and verified its execution boundary." });
      let lastProgressAt = 0;
      let lastProgressSignature = "";
      assertModelCallAllowed(context);
      const result = await runCodexAsync(config, workspace, objective + (seed?.guidance ?? "") + recoveryGuidance + ephemeralWorkerGuidance + localDecisionGuidance, reservation,
        AbortSignal.any([context.signal, leaseAbort.signal]), (line) => {
          let protocolComplete = false;
          try { protocolComplete = JSON.parse(line)?.type === "turn.completed"; } catch { /* Non-JSON diagnostics are ignored. */ }
          const progress = parseCodexProgressLine(line, workspace);
          if (!progress) return protocolComplete;
          const signature = `${progress.phase}:${progress.status}:${progress.summary}`;
          const now = Date.now();
          if (!progress.important && signature === lastProgressSignature && now - lastProgressAt < 30_000) return protocolComplete;
          if (!progress.important && now - lastProgressAt < 10_000) return protocolComplete;
          lastProgressAt = now;
          lastProgressSignature = signature;
          const { important: _important, ...ownerProgress } = progress;
          context.progress?.(ownerProgress);
          return protocolComplete;
        });
      const resultArtifactPath = resolve(join(this.paths.artifactRoot, `${workspaceId}.result.jsonl`));
      writeFileSync(resultArtifactPath, result.stdout, "utf8");
      if (result.stderr) writeFileSync(resolve(join(this.paths.artifactRoot, `${workspaceId}.stderr.txt`)), result.stderr, "utf8");
      if (heartbeatFailure) throw heartbeatFailure;
      if (result.timedOut || result.signal || result.error) throw new Error(result.error ?? `Codex ended with signal ${result.signal ?? "after timeout"}`);
      if (result.exitCode !== 0) {
        const reported = codexJsonErrors(result.stdout);
        throw new DefiniteWorkerFailure(`Codex rejected the job with exit ${result.exitCode}: ${[result.stderr.trim(), ...reported].filter(Boolean).join(" | ")}`);
      }
      const usage = parseCodexUsage(result.stdout);
      let outcome: string;
      try { outcome = parseFinalAgentMessage(result.stdout); }
      catch (error) {
        throw new UntrustedWorkerReceiptError(
          error instanceof Error ? error.message : String(error),
          { outcome: "", usage, resultArtifactPath },
        );
      }
      const workerResult: WorkerResult = { outcome, usage, resultArtifactPath, workspacePath: workspace };
      if (context.goalId) {
        try { workerResult.goalDecision = parseGoalDecision(outcome); }
        catch (error) {
          throw new UntrustedWorkerReceiptError(
            error instanceof Error ? error.message : String(error),
            workerResult,
          );
        }
      }
      workerResult.patch = captureWorkerPatch(workspace, config.writableWorkspacePaths ?? [], this.paths.artifactRoot, workspaceId);
      return workerResult;
    } finally {
      clearInterval(heartbeat);
    }
  }
}

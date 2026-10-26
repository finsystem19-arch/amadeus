import { realpathSync } from "node:fs";
import { onboardingInstructions } from "./privacy-onboarding.mjs";
import { dirname, resolve } from "node:path";
import { activeRuns, runBackground } from "./background-run.mjs";
import { fileURLToPath } from "node:url";
import { AMADEUS_PRODUCT } from "./amadeus-runtime.mjs";
import { readPluginVersion } from "./amadeus-lifecycle.mjs";
import { withCoordinator } from "./server-common.mjs";
import { toolDefinitions } from "./tool-definitions.mjs";
import { callTool } from "./tool-dispatch.mjs";
import { selfTest } from "./server-self-test.mjs";

export { validateRoutePin, cursorRoutePreflightProblem, writableWorkspacePaths, retrySqliteBusy } from "./server-common.mjs";
export { resolveUnrecordedResultArtifact, verifyReceiptWorkspace, selectReceiptWorkspace, externallyVerifiedReceiptDisposition, providerExecutionFailed } from "./receipt-recovery.mjs";
export { gitMilestoneCheckStatus, formatMilestoneGitOwnerSummary, recordedHostVerificationCommands, comparableCacheShare, ownerFacingCompletionReport } from "./completion-report.mjs";
export { isMeaningfulProgressEvent, progressCheckpoint, liveProgressSummary, withBackgroundHostState } from "./work-views.mjs";
export { callTool } from "./tool-dispatch.mjs";

// The installed plugin manifest is the single source of the version this server reports.
const SERVER_VERSION = readPluginVersion(resolve(dirname(fileURLToPath(import.meta.url)), "..")) ?? "unknown";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: AMADEUS_PRODUCT.pluginName, version: SERVER_VERSION, title: `${AMADEUS_PRODUCT.displayName}  -  ${AMADEUS_PRODUCT.descriptor}` },
      instructions: onboardingInstructions + " Amadeus  -  Local AI Orchestrator by Mad Max Systems. Maestro is an alias for Amadeus with the same instructions, behavior, and orchestration engine. Use the current project's absolute path. Use included subscription allowance without artificial spending gates; ordinary tools first, inexpensive suitable models next. Missing roadmap-required development tools and dependencies are routine authorized setup: install and verify them automatically. During continuous-development or Long-Haul Autopilot work, repair orchestration defects and routine technical failures automatically with ordinary software, verify the repair, and resume the same unfinished goal. If required evidence or tools are on another Amadeus worker, use read-only host reconciliation or package handoff; do not stop because a fresh worker root cannot see a preserved artifact. Continue bounded troubleshooting after technical failures, including safe alternate sources and worker-to-host reconciliation; do not stop while a safe route remains. If owner action is genuinely required, surface one concrete plain-language question naming the action and purpose; never expose only an owner-gated or approval-required label. Before ending any turn, re-read the exact goal; if it is active, keep waiting, and if it is terminal, report the exact terminal state. Never claim a stale or different goal is still active. Continue authorized work until finished or genuinely blocked. Preserve unfinished work and report completion only with evidence.",
    } });
    return;
  }
  if (message.method === "ping") { send({ jsonrpc: "2.0", id: message.id, result: {} }); return; }
  if (message.method === "tools/list") { send({ jsonrpc: "2.0", id: message.id, result: { tools: toolDefinitions() } }); return; }
  if (message.method === "tools/call") {
    try {
      const result = await callTool(message.params?.name, message.params?.arguments ?? {});
      send({ jsonrpc: "2.0", id: message.id, result: { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
    } catch (error) {
      // Release path defers private fault intake; surface the tool error only.
      send({ jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] } });
    }
    return;
  }
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
}

if (process.argv.includes("--background-request")) {
  await runBackground(process.argv[process.argv.indexOf("--background-request") + 1],
    (request) => callTool("run_goal", request.args, request.paths, request.runId),
    (request) => {
      if (activeRuns(request.paths.database).length === 0) withCoordinator(request.paths.database, (coordinator) => coordinator.pause());
    });
} else if (process.argv.includes("--self-test")) {
  await selfTest();
} else if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try { void handle(JSON.parse(line)); }
      catch (error) { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); }
    }
  });
}

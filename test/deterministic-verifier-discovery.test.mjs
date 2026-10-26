/**
 * Unrestricted-host coverage for sandbox-runner selection.
 * Restricted Windows sandboxes should use:
 *   scripts/run-deterministic-verifier-discovery-tests-sandbox.mjs
 * via the coordinator stdin-pipe path instead of this file entry.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const verifierUrl = pathToFileURL(join(root, "src", "verification-checks.mjs")).href;

const {
  resolveSandboxTestRunner,
  buildSandboxPipeCheck,
  discoverVerificationChecks,
  isDirectWorkspaceIntegrityCheck,
} = await import(verifierUrl);

test("resolveSandboxTestRunner maps amadeus updates providers test", () => {
  assert.equal(
    resolveSandboxTestRunner(root, "test/amadeus-updates-providers.test.mjs"),
    "scripts/run-updates-providers-tests-sandbox.mjs",
  );
  assert.equal(resolveSandboxTestRunner(root, "test/missing.test.mjs"), null);
});

test("buildSandboxPipeCheck uses powershell stdin pipe", () => {
  const check = buildSandboxPipeCheck("scripts/run-updates-providers-tests-sandbox.mjs", "node", null, "win32");
  assert.equal(check.executable, "powershell");
  assert.match(check.args.join(" "), /Get-Content/);
  assert.match(check.args.join(" "), /--input-type=module/);
  assert.match(check.args.join(" "), /\$env:NODE_OPTIONS=''/);
});

test("buildSandboxPipeCheck anchors the runner inside the worker workspace", () => {
  const workspace = win32.join("C:\\", "worker", "workspace");
  const check = buildSandboxPipeCheck("scripts/run-branding-tests-sandbox.mjs", "node", workspace, "win32");
  assert.match(check.args.join(" "), /C:\\\\worker\\\\workspace\\\\scripts\\\\run-branding-tests-sandbox\.mjs/);
  assert.match(check.args.join(" "), /process\.chdir/);
  assert.match(check.args.join(" "), /StartsWith\('#!'\)/);
  assert.match(check.command, /powershell pipe scripts\/run-branding-tests-sandbox\.mjs/);
});

test("buildSandboxPipeCheck pipes the runner to Node through /bin/sh on macOS and Linux", () => {
  const check = buildSandboxPipeCheck("scripts/run-branding-tests-sandbox.mjs", "/usr/local/bin/node", "/work/space", "darwin");
  assert.equal(check.executable, "/bin/sh");
  assert.deepEqual(check.args.slice(-3), ["/work/space", "scripts/run-branding-tests-sandbox.mjs", "/usr/local/bin/node"]);
  assert.match(check.args[1], /--input-type=module/);
  assert.equal(check.command, "node run scripts/run-branding-tests-sandbox.mjs");
});

test("auto-discovery prefers sandbox runner over node --test", () => {
  const temp = mkdtempSync(join(tmpdir(), "amadeus-verifier-auto-"));
  mkdirSync(join(temp, "test"), { recursive: true });
  mkdirSync(join(temp, "scripts"), { recursive: true });
  writeFileSync(join(temp, "package.json"), `${JSON.stringify({ type: "module", scripts: {} }, null, 2)}\n`);
  writeFileSync(join(temp, "test", "amadeus-updates-providers.test.mjs"), "import test from \"node:test\";\ntest(\"x\", () => {});\n");
  writeFileSync(join(temp, "scripts", "run-updates-providers-tests-sandbox.mjs"), "console.log(\"sandbox\");\n");
  const checks = discoverVerificationChecks(temp, ["test/amadeus-updates-providers.test.mjs"]);
  assert.ok(checks.some((check) => String(check.command).includes("run-updates-providers-tests-sandbox.mjs")));
  assert.ok(!checks.some((check) => Array.isArray(check.args) && check.args[0] === "--test"));
});

const PIPE = process.platform === "win32" ? "powershell pipe" : "node run";

test("coordinator.verify sandbox scripts become pipes", () => {
  assert.ok(existsSync(join(root, "scripts", "run-updates-providers-tests-sandbox.mjs")));
  const checks = discoverVerificationChecks(root, []);
  assert.equal(checks[0]?.command, `${PIPE} scripts/workspace-diff-check.mjs`);
  assert.equal(checks.filter((check) => check.command === `${PIPE} scripts/workspace-diff-check.mjs`).length, 1);
  assert.ok(!checks.some((check) => check.command === "git diff --check"));
  assert.ok(checks.some((check) => String(check.command).includes("run-updates-providers-tests-sandbox.mjs")));
  assert.ok(checks.some((check) => String(check.command).includes("run-deterministic-verifier-discovery-tests-sandbox.mjs")));
  assert.ok(checks.some((check) => String(check.command).includes("run-excluded-path-tests-sandbox.mjs")));
  assert.ok(checks.some((check) => String(check.command).includes("run-branding-tests-sandbox.mjs")));
  assert.ok(checks.some((check) => String(check.command).includes("workspace-diff-check")));
  assert.ok(checks.some((check) => String(check.command).includes(`${PIPE} scripts/workspace-diff-check.mjs`)));
  assert.ok(checks.some((check) => String(check.command).includes(`${PIPE} scripts/run-public-safety-sandbox.mjs`)));
});

test("workspace diff runner keeps its shebang and executes through the cwd-aware pipe", () => {
  const runnerPath = join(root, "scripts", "workspace-diff-check.mjs");
  assert.match(readFileSync(runnerPath, "utf8"), /^#!\/usr\/bin\/env node/);
  const check = discoverVerificationChecks(root, [])
    .find((candidate) => candidate.command === (process.platform === "win32" ? "powershell pipe" : "node run") + " scripts/workspace-diff-check.mjs");
  assert.ok(check);
  const result = spawnSync(check.executable, check.args, { cwd: tmpdir(), encoding: "utf8" });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /workspace-diff-check: clean/);
});

test("isDirectWorkspaceIntegrityCheck covers git and workspace-diff-check", () => {
  assert.equal(isDirectWorkspaceIntegrityCheck({ tool: "git", command: "git diff --check" }), true);
  assert.equal(isDirectWorkspaceIntegrityCheck({ tool: "node", command: "powershell pipe scripts/workspace-diff-check.mjs" }), true);
  assert.equal(isDirectWorkspaceIntegrityCheck({ tool: "npm", command: "npm run workspace-diff-check" }), true);
  assert.equal(isDirectWorkspaceIntegrityCheck({ tool: "npm", command: "npm run public-safety" }), false);
});

test("discoverVerificationChecks falls back to node --test without sandbox runner", () => {
  const temp = mkdtempSync(join(tmpdir(), "amadeus-verifier-"));
  mkdirSync(join(temp, "test"), { recursive: true });
  writeFileSync(join(temp, "package.json"), `${JSON.stringify({ type: "module", scripts: {} }, null, 2)}\n`);
  writeFileSync(join(temp, "test", "plain.test.mjs"), "import test from \"node:test\";\ntest(\"x\", () => {});\n");
  const checks = discoverVerificationChecks(temp, ["test/plain.test.mjs"]);
  assert.ok(checks.some((check) => check.args?.[0] === "--test"));
});

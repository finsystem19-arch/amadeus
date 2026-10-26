/**
 * Pure verification-plan discovery (plain ESM for sandbox-friendly tests).
 * Kept separate from deterministic-verifier.ts so restricted Windows sandboxes
 * can load this module via data: URLs without TypeScript stripping.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, posix, resolve, win32 } from "node:path";

const EVIDENCE_PATCH_EXCLUDES = [
  ":(exclude,glob)**/evidence/patches/**/*.diff",
  ":(exclude,glob)**/evidence/patches/**/*.patch",
];

/**
 * npm's CLI beside the running Node: next to node.exe on Windows, and in
 * ../lib/node_modules on macOS and Linux installs.
 */
export function npmCliPath(nodeExecutable = process.execPath, exists = existsSync) {
  const bin = dirname(nodeExecutable);
  const candidates = [join(bin, "node_modules", "npm", "bin", "npm-cli.js"), join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];
  return candidates.find((candidate) => exists(candidate)) ?? candidates[0];
}

/**
 * Map `test/amadeus-updates-providers.test.mjs` →
 * `scripts/run-updates-providers-tests-sandbox.mjs` when present.
 */
export function resolveSandboxTestRunner(workspace, testPath) {
  const normalized = String(testPath || "").replaceAll("\\", "/");
  const base = posix.basename(normalized);
  const match = /^(?:amadeus-)?(.+)\.test\.mjs$/i.exec(base);
  if (!match) return null;
  const relative = `scripts/run-${match[1]}-tests-sandbox.mjs`;
  return existsSync(join(workspace, ...relative.split("/"))) ? relative : null;
}

/**
 * Build a PowerShell stdin-pipe check that never realpath()s the runner as an entry.
 * Clears host-injected NODE_OPTIONS (e.g. Cursor path-verifier --require under C:\)
 * so restricted Windows sandboxes that deny lstat('C:\\') can still start Node.
 * macOS and Linux have no PowerShell; /bin/sh performs the same steps (enter
 * the workspace, drop a shebang, pipe the source to Node), with the paths
 * passed as arguments rather than spliced into the command text.
 */
export function buildSandboxPipeCheck(runnerRelativePath, nodeExecutable = process.execPath, workspace = null, platform = process.platform) {
  const runner = String(runnerRelativePath || "").replaceAll("\\", "/");
  if (platform !== "win32") {
    return {
      tool: "node",
      command: `node run ${runner}`,
      executable: "/bin/sh",
      args: ["-c", 'cd "$1" && sed "1{/^#!/d;}" "$2" | NODE_OPTIONS= "$3" --input-type=module', "sh",
        workspace ? resolve(workspace) : ".", runner, nodeExecutable],
    };
  }
  const runnerPath = workspace ? win32.join(workspace, ...runner.split("/")) : runner;
  const bootstrap = workspace ? `process.chdir(${JSON.stringify(win32.resolve(workspace))});` : "";
  const powershellBootstrap = `'${bootstrap.replaceAll("'", "''")}'`;
  const command = workspace ? [
    "$env:NODE_OPTIONS=''",
    `$runnerSource=Get-Content -Raw -LiteralPath ${JSON.stringify(runnerPath)}`,
    "if ($runnerSource.StartsWith('#!')) { $newline=$runnerSource.IndexOf(\"`n\"); $runnerSource=if ($newline -ge 0) { $runnerSource.Substring($newline + 1) } else { '' } }",
    `@(${powershellBootstrap}; $runnerSource) | & ${JSON.stringify(nodeExecutable)} --input-type=module`,
  ].join("; ") : [
    "$env:NODE_OPTIONS=''",
    `Get-Content -Raw -LiteralPath ${JSON.stringify(runnerPath)} | & ${JSON.stringify(nodeExecutable)} --input-type=module`,
  ].join("; ");
  return {
    tool: "node",
    command: `powershell pipe ${runner}`,
    executable: "powershell",
    args: ["-NoProfile", "-Command", command],
  };
}

/**
 * Fixed read-only integrity checks over the disposable worker workspace.
 * These must not nest a Codex Windows sandbox when the parent worker already
 * holds a restricted token ("Restricted read-only access requires the elevated
 * Windows sandbox backend"). Prefer the stdin-piped workspace-diff-check runner
 * when present: native `git diff --check` fails closed on sandboxes that deny
 * Git getcwd or `.git` mutation, which would block the rest of verification.
 */
export function isDirectWorkspaceIntegrityCheck(check) {
  const command = String(check?.command || "");
  if (check?.tool === "git" && command === "git diff --check") return true;
  return /workspace-diff-check/.test(command);
}

/**
 * "integrity" checks only whitespace and patch shape; "project-tests" exercise the project;
 * "build" regenerates derived files before the other checks and tests nothing by itself.
 */
export function verificationCheckKind(check) {
  if (check?.kind === "integrity" || check?.kind === "project-tests" || check?.kind === "build") return check.kind;
  return isDirectWorkspaceIntegrityCheck(check) ? "integrity" : "project-tests";
}

export const VERIFY_POLICY_PATH = ".amadeus/verify.json";
const POLICY_RUNNERS = {
  pytest: { tool: "pytest", executable: "python", base: ["-m", "pytest", "-q", "-p", "no:cacheprovider"], defaults: [] },
  go: { tool: "go", executable: "go", base: ["test"], defaults: ["./..."] },
  dotnet: { tool: "dotnet", executable: "dotnet", base: ["test", "--nologo"], defaults: [] },
};
const SAFE_ARGUMENT = /^[A-Za-z0-9_.\/:=@+,-]{1,200}$/;

function policyArgument(value) {
  const argument = String(value);
  const parts = argument.replaceAll("\\", "/").split("/");
  if (!SAFE_ARGUMENT.test(argument) || argument.startsWith("/") || argument.startsWith("\\") || /^[A-Za-z]:/.test(argument)
    || parts.includes("..")) {
    throw new Error(`Unsafe argument in ${VERIFY_POLICY_PATH}: ${argument}`);
  }
  return argument;
}

/**
 * Opt-in project test commands for languages whose toolchains and dependency
 * caches may not be reachable inside the worker sandbox (Python, Go, .NET).
 * Read from the authoritative project, never the worker's patched copy, so a
 * patch cannot weaken its own verification. A configured check that fails or
 * cannot run blocks the patch, like a `coordinator.verify` npm script.
 */
function loadVerifyPolicy(policyRoot) {
  const file = join(policyRoot, ...VERIFY_POLICY_PATH.split("/"));
  if (!existsSync(file)) return null;
  const policy = JSON.parse(readFileSync(file, "utf8"));
  if (policy?.schemaVersion !== 1 || !Array.isArray(policy.checks) || policy.checks.length > 10) {
    throw new Error(`${VERIFY_POLICY_PATH} must have schemaVersion 1 and at most 10 checks`);
  }
  if (policy.build !== undefined && (typeof policy.build !== "string" || !/^[a-zA-Z0-9:_-]{1,100}$/.test(policy.build))) {
    throw new Error(`${VERIFY_POLICY_PATH} build must be the name of an npm script`);
  }
  return policy;
}

export function readVerifyPolicy(policyRoot) {
  const policy = loadVerifyPolicy(policyRoot);
  if (!policy) return [];
  return policy.checks.map((entry) => {
    const runner = POLICY_RUNNERS[typeof entry === "string" ? entry : entry?.runner];
    if (!runner) throw new Error(`Unsupported runner in ${VERIFY_POLICY_PATH}: use pytest, go or dotnet`);
    const extra = typeof entry === "object" && entry.args !== undefined ? entry.args : runner.defaults;
    if (!Array.isArray(extra) || extra.length > 20) throw new Error(`${VERIFY_POLICY_PATH} args must be a list of at most 20 values`);
    const args = [...runner.base, ...extra.map(policyArgument)];
    return { tool: runner.tool, kind: "project-tests", command: [runner.executable, ...args].join(" "), executable: runner.executable, args };
  });
}

/**
 * Environment a policy runner needs so its caches stay in the per-check runtime home.
 * @returns {Record<string, string>}
 */
export function verificationToolEnvironment(tool, runtimeHome) {
  if (tool === "go") return { GOCACHE: join(runtimeHome, "go-build"), GOTELEMETRY: "off" };
  if (tool === "dotnet") return { DOTNET_CLI_HOME: runtimeHome, DOTNET_NOLOGO: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1" };
  if (tool === "pytest") return { PYTHONDONTWRITEBYTECODE: "1" };
  return {};
}

const LANGUAGES = [
  ["JavaScript/TypeScript", /\.(?:[cm]?[jt]sx?)$/i],
  ["Python", /\.py$/i],
  ["Go", /\.go$/i],
  [".NET", /\.(?:cs|fs|vb|csproj|fsproj|vbproj|sln)$/i],
  ["Rust", /\.rs$/i],
  ["Java/Kotlin", /\.(?:java|kt|kts)$/i],
];

/** Languages present among the changed paths, for an honest "not tested" note. */
export function changedLanguages(changedPaths = []) {
  const paths = (changedPaths || []).map(String);
  return LANGUAGES.filter(([, pattern]) => paths.some((path) => pattern.test(path))).map(([name]) => name);
}

function buildUniversalIntegrityCheck(workspace) {
  const runner = "scripts/workspace-diff-check.mjs";
  if (existsSync(join(workspace, ...runner.split("/")))) {
    return { ...buildSandboxPipeCheck(runner, process.execPath, workspace), kind: "integrity" };
  }
  return {
    tool: "git",
    kind: "integrity",
    command: "git diff --check",
    executable: "git",
    args: ["-c", `safe.directory=${workspace}`, "-c", "core.whitespace=cr-at-eol", "diff", "--check", "--", ".", ...EVIDENCE_PATCH_EXCLUDES],
  };
}

/**
 * Build a reusable, capability-based verification plan. Universal patch
 * integrity is always checked. Repository commands become hard gates only when
 * the project explicitly opts into them through package.json
 * `coordinator.verify`.
 */
export function discoverVerificationChecks(workspace, changedPaths = [], options = {}) {
  const checks = [buildUniversalIntegrityCheck(workspace)];
  const seenPipeRunners = new Set(
    checks
      .map((check) => {
        const match = /(?:powershell pipe|node run)\s+(.+)$/i.exec(String(check.command || ""));
        return match ? match[1].replaceAll("\\", "/") : null;
      })
      .filter(Boolean),
  );
  const safeChanged = [...new Set((changedPaths || []).map((path) => String(path).replaceAll("\\", "/")))]
    .filter((path) => path && !path.startsWith("/") && !/^[A-Za-z]:/.test(path)
      && !path.split("/").some((part) => !part || part === "." || part === "..")
      && !/(^|\/)\.git(\/|$)/i.test(path));
  const testPattern = /\.(?:test|spec)\.(?:[cm]?[jt]s)$/i;
  const runnableTests = new Set();
  for (const path of safeChanged) {
    if (testPattern.test(path) && existsSync(join(workspace, ...path.split("/")))) runnableTests.add(path);
    if (!/\.(?:[cm]?[jt]s)$/i.test(path) || testPattern.test(path)) continue;
    const extension = extname(path);
    const stem = path.slice(0, -extension.length);
    for (const candidate of [`${stem}.test${extension}`, `${stem}.spec${extension}`]) {
      if (existsSync(join(workspace, ...candidate.split("/")))) runnableTests.add(posix.normalize(candidate));
    }
  }
  const packagePath = join(workspace, "package.json");
  const pkg = existsSync(packagePath) ? JSON.parse(readFileSync(packagePath, "utf8")) : {};
  const scripts = pkg?.scripts ?? {};
  const configured = pkg?.coordinator?.verify;
  const names = Array.isArray(configured) ? configured.map(String) : [];
  const unique = [...new Set(names)];
  if (runnableTests.size && !unique.length) {
    const tests = [...runnableTests].sort();
    const sandboxRunners = tests.map((path) => resolveSandboxTestRunner(workspace, path));
    if (sandboxRunners.length && sandboxRunners.every((runner) => typeof runner === "string")) {
      for (const runner of [...new Set(sandboxRunners)].sort()) {
        checks.push(buildSandboxPipeCheck(runner, process.execPath, workspace));
      }
    } else {
      const testSources = tests.map((path) => readFileSync(join(workspace, ...path.split("/")), "utf8")).join("\n");
      const packageTestScript = typeof scripts.test === "string" ? scripts.test : "";
      const packageManager = /vitest/i.test(packageTestScript) || /from\s+["']vitest["']|require\(["']vitest["']\)/.test(testSources)
        ? "vitest" : /jest/i.test(packageTestScript) || /from\s+["']@jest\/|from\s+["']jest["']/.test(testSources)
          ? "jest" : /mocha/i.test(packageTestScript) || /from\s+["']mocha["']/.test(testSources) ? "mocha" : null;
      if (packageManager && packageTestScript) {
        checks.push({
          tool: "npm",
          command: "npm test",
          executable: process.execPath,
          args: [npmCliPath(), "test", "--", ...tests],
        });
      } else if (!packageManager && tests.every((path) => {
        const source = readFileSync(join(workspace, ...path.split("/")), "utf8");
        return /from\s+["']node:test["']|require\(["']node:test["']\)/.test(source);
      })) {
        checks.push({
          tool: "node",
          command: `node --test --test-isolation=none ${tests.map((path) => JSON.stringify(path)).join(" ")}`,
          executable: process.execPath,
          args: ["--test", "--test-isolation=none", ...tests],
        });
      }
    }
  }
  for (const name of unique) {
    if (!/^[a-zA-Z0-9:_-]+$/.test(name) || typeof scripts[name] !== "string") {
      throw new Error(`Invalid coordinator verification script: ${name}`);
    }
    const check = npmScriptCheck(workspace, name, scripts[name]);
    const runner = /(?:powershell pipe|node run)\s+(.+)$/i.exec(check.command)?.[1];
    if (runner) {
      if (seenPipeRunners.has(runner)) continue;
      seenPipeRunners.add(runner);
    }
    checks.push(check);
  }
  checks.push(...readVerifyPolicy(options.policyRoot ?? workspace));
  return checks.map((check) => ({ ...check, kind: verificationCheckKind(check) }));
}

/** A package.json script as a check: piped `.mjs` runners avoid Node's main-module realpath in the sandbox. */
function npmScriptCheck(workspace, name, scriptBody) {
  const pipeMatch = /Get-Content\s+-Raw\s+(?:-LiteralPath\s+)?["']?([^\s"']+?\.mjs)["']?\s*\|\s*node\s+--input-type=module/i.exec(scriptBody)
    || /Get-Content\s+-Raw\s+(?:-LiteralPath\s+)?["']?([^\s"']+?\.mjs)["']?\s*\|\s*&?\s*node\s+--input-type=module/i.exec(scriptBody)
    || /\btype\s+([^\s|()]+\.mjs)\s*\|\s*node\s+--input-type=module/i.exec(scriptBody);
  if (pipeMatch && existsSync(join(workspace, ...pipeMatch[1].replaceAll("\\", "/").split("/")))) {
    return buildSandboxPipeCheck(pipeMatch[1].replaceAll("\\", "/"), process.execPath, workspace);
  }
  return {
    tool: "npm",
    command: `npm run ${name}`,
    executable: process.execPath,
    args: [npmCliPath(), "run", name],
  };
}

/**
 * The project's declared build step (`"build"` in .amadeus/verify.json), run by the
 * coordinator before the other checks so generated copies match the changed sources
 * without the worker having to run it. The script name and its body both come from
 * the authoritative project, so a patch cannot change what the build step runs.
 * @returns {null | { tool: string, kind: "build", command: string, executable: string, args: string[] }}
 */
export function readBuildStep(policyRoot, workspace) {
  const policy = loadVerifyPolicy(policyRoot);
  if (!policy?.build) return null;
  const packagePath = join(policyRoot, "package.json");
  const scripts = existsSync(packagePath) ? JSON.parse(readFileSync(packagePath, "utf8"))?.scripts ?? {} : {};
  if (typeof scripts[policy.build] !== "string") {
    throw new Error(`${VERIFY_POLICY_PATH} build names "${policy.build}", which is not a script in package.json`);
  }
  return { ...npmScriptCheck(workspace, policy.build, scripts[policy.build]), kind: "build" };
}

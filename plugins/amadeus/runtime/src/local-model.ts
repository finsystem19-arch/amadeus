/**
 * The owner's local model (worker config "localModel"): readiness and
 * qualification. A local model receives work only when the owner enabled it,
 * its endpoint is on this computer, it answers right now, and it has passed the
 * qualification tasks below with this exact endpoint and model. Anything else
 * leaves routing exactly as it is without a local model.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localModelProviderArguments, loopbackModelEndpoint } from "./codex-adapter.ts";
import type { QualifiedLocalModelCandidate } from "./work-routing.ts";

export type LocalModelSetting = { enabled?: boolean; endpoint?: string; model?: string; reasoningEffort?: string };

export type LocalModelQualification = {
  schemaVersion: 1;
  endpoint: string;
  model: string;
  qualifiedAt: string;
  passed: boolean;
  tasks: Array<{ id: string; passed: boolean; seconds: number; detail: string }>;
};

/** A qualification older than this is stale: the model or its server may have changed. */
export const QUALIFICATION_MAX_AGE_DAYS = 14;

export function qualificationPath(stateRoot: string): string {
  return join(stateRoot, "local-model-qualification.json");
}

/** The configured local model when it is enabled, loopback-only and qualified; otherwise null. */
export function qualifiedLocalModel(setting: unknown, stateRoot: string, now = new Date()): QualifiedLocalModelCandidate | null {
  const local = setting as LocalModelSetting | undefined;
  if (local?.enabled !== true || !local.endpoint || !local.model) return null;
  let endpoint: string;
  try { endpoint = loopbackModelEndpoint(local.endpoint); } catch { return null; }
  const path = qualificationPath(stateRoot);
  if (!existsSync(path)) return null;
  let record: LocalModelQualification;
  try { record = JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
  const ageDays = (now.getTime() - Date.parse(record.qualifiedAt)) / 86_400_000;
  if (record.schemaVersion !== 1 || record.passed !== true || record.endpoint !== endpoint || record.model !== local.model
    || !(ageDays >= 0 && ageDays <= QUALIFICATION_MAX_AGE_DAYS)) return null;
  return { providerId: "local-openai-compatible", model: local.model, endpoint, routable: true, reasoningEffort: local.reasoningEffort };
}

/** True when the server lists the model right now; a model that disappeared must not receive work. */
export async function localModelAnswers(candidate: QualifiedLocalModelCandidate, timeoutMs = 5000): Promise<boolean> {
  try {
    const response = await fetch(`${candidate.endpoint}/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return false;
    const body = await response.json() as { data?: Array<{ id?: string }> };
    return Array.isArray(body.data) && body.data.some((entry) => entry.id === candidate.model);
  } catch { return false; }
}

/** Small bounded tasks a worker must finish, each checked by ordinary software, not by the model. */
const TASKS: Array<{ id: string; files: Record<string, string>; objective: string; check: string }> = [
  {
    id: "fix-arithmetic-bug",
    files: { "calc.mjs": "export function add(a, b) {\n  return a - b;\n}\n" },
    objective: "calc.mjs has a bug: add(2, 3) should return 5. Fix it.",
    check: "import { add } from './calc.mjs'; if (add(2, 3) !== 5 || add(-1, 1) !== 0) process.exit(1);",
  },
  {
    id: "implement-to-spec",
    files: { "slug.mjs": "// TODO\nexport function slugify(text) {\n  throw new Error('not implemented');\n}\n" },
    objective: "Implement slugify(text) in slug.mjs: lower-case, trim, replace each run of characters other than a-z and 0-9 with a single '-', and remove leading or trailing '-'. Example: '  Hello, World!  ' becomes 'hello-world'.",
    check: "import { slugify } from './slug.mjs'; const ok = slugify('  Hello, World!  ') === 'hello-world' && slugify('A--B') === 'a-b' && slugify('Café 2026') === 'caf-2026'; if (!ok) process.exit(1);",
  },
  {
    id: "edit-across-files",
    files: {
      "price.mjs": "export const GST_RATE = 0.1;\n",
      "invoice.mjs": "import { GST_RATE } from './price.mjs';\nexport function total(net) {\n  return net;\n}\n",
    },
    objective: "invoice.mjs total(net) must return the net amount plus GST using GST_RATE from price.mjs, rounded to 2 decimal places as a number. Do not change price.mjs.",
    check: "import { total } from './invoice.mjs'; import { readFileSync } from 'node:fs'; if (total(100) !== 110 || total(19.99) !== 21.99 || !readFileSync('price.mjs', 'utf8').includes('0.1')) process.exit(1);",
  },
];

/**
 * Run each task through the Codex CLI on the local model inside Codex's own
 * workspace-write sandbox, then check the result with Node. Writes the record
 * that qualifiedLocalModel reads.
 */
export function qualifyLocalModel(input: { setting: LocalModelSetting; stateRoot: string; codex: string; timeoutSeconds?: number }): LocalModelQualification {
  const endpoint = loopbackModelEndpoint(String(input.setting.endpoint));
  const model = String(input.setting.model);
  const tasks: LocalModelQualification["tasks"] = [];
  for (const task of TASKS) {
    const dir = mkdtempSync(join(tmpdir(), "amadeus-local-qualification-"));
    const home = mkdtempSync(join(tmpdir(), "amadeus-local-codex-home-"));
    const started = Date.now();
    try {
      for (const [name, content] of Object.entries(task.files)) writeFileSync(join(dir, name), content);
      const run = spawnSync(input.codex, ["exec", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "-s", "workspace-write",
        "-C", dir, "-m", model, ...localModelProviderArguments(endpoint),
        ...(input.setting.reasoningEffort ? ["-c", `model_reasoning_effort=${JSON.stringify(input.setting.reasoningEffort)}`] : []),
        `${task.objective} Change only what is needed.`],
      { cwd: dir, encoding: "utf8", input: "", timeout: (input.timeoutSeconds ?? 600) * 1000, env: { ...process.env, CODEX_HOME: home } });
      const check = run.status === 0
        ? spawnSync(process.execPath, ["--input-type=module", "-e", task.check], { cwd: dir, encoding: "utf8", timeout: 20_000 })
        : null;
      const passed = check?.status === 0;
      tasks.push({ id: task.id, passed, seconds: Math.round((Date.now() - started) / 1000),
        detail: run.status !== 0 ? `worker exit ${run.status ?? run.signal ?? run.error?.message}` : passed ? "check passed" : "check failed" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }
  const record: LocalModelQualification = { schemaVersion: 1, endpoint, model, qualifiedAt: new Date().toISOString(),
    passed: tasks.every((task) => task.passed), tasks };
  writeFileSync(qualificationPath(input.stateRoot), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

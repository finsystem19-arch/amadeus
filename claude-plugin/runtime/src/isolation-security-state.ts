import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export type IsolationSecurityStateBinding = {
  securityStateProbePath: string;
  securityStateProbeSha256: string;
  securityBoundaryPaths: string[];
  mutableBoundaryRoots: string[];
  hostSecurityStateFingerprint: string;
};

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase();
}

/**
 * Recomputes a read-only fingerprint of the actual Windows ACL owners/SDDLs on
 * every boundary path. The fingerprint is emitted by a hashed, trusted probe;
 * it is never accepted as a configuration or model-supplied constant.
 */
export function isolationSecurityStateBinding(
  probePath: string | null | undefined,
  adapter: "codex" | "cursor" | "claude",
  workspace: string,
  boundaryPaths: string[],
  mutableBoundaryRoots: string[] = [],
  platform: NodeJS.Platform = process.platform,
): IsolationSecurityStateBinding {
  if (platform !== "win32") return posixSecurityStateBinding(adapter, boundaryPaths, mutableBoundaryRoots);
  if (!probePath || !isAbsolute(probePath) || !existsSync(probePath)) {
    throw new Error(`${adapter} dispatch requires an existing absolute isolation security-state probe`);
  }
  const resolvedProbe = resolve(probePath);
  const paths = [...new Set(boundaryPaths.map((path) => resolve(path)))].sort((a, b) => a.localeCompare(b));
  const mutableRoots = [...new Set(mutableBoundaryRoots.map((path) => resolve(path)))].sort((a, b) => a.localeCompare(b));
  if (mutableRoots.some((path) => !paths.includes(path))) throw new Error(`${adapter} mutable security root is not ACL-bound`);
  const windowsRoot = process.env.WINDIR ?? "C:\\Windows";
  const moduleRoots = [
    `${windowsRoot}\\System32\\WindowsPowerShell\\v1.0\\Modules`,
    `${process.env.ProgramFiles ?? "C:\\Program Files"}\\WindowsPowerShell\\Modules`,
    process.env.PSModulePath,
  ].filter(Boolean).join(";");
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolvedProbe,
    "-Adapter", adapter, "-Workspace", resolve(workspace),
    "-PathsJson", JSON.stringify(paths),
  ], { encoding: "utf8", shell: false, timeout: 30_000, windowsHide: true, env: { ...process.env, PSModulePath: moduleRoots } });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    const detail = result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`;
    throw new Error(`${adapter} isolation security-state fingerprint could not be verified for ${JSON.stringify(paths)}: ${detail}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout.trim()); }
  catch { throw new Error(`${adapter} isolation security-state probe returned malformed JSON`); }
  const value = parsed as { schemaVersion?: unknown; adapter?: unknown; workspace?: unknown; fingerprintSha256?: unknown };
  if (value.schemaVersion !== 1 || value.adapter !== adapter || resolve(String(value.workspace)).toLowerCase() !== resolve(workspace).toLowerCase()
    || typeof value.fingerprintSha256 !== "string" || !/^[A-F0-9]{64}$/.test(value.fingerprintSha256)) {
    throw new Error(`${adapter} isolation security-state probe returned an invalid binding: ${JSON.stringify(value)}`);
  }
  return {
    securityStateProbePath: resolvedProbe,
    securityStateProbeSha256: sha256File(resolvedProbe),
    securityBoundaryPaths: paths,
    mutableBoundaryRoots: mutableRoots,
    hostSecurityStateFingerprint: value.fingerprintSha256,
  };
}

/**
 * macOS and Linux: the same binding from each boundary path's owner, group,
 * permission bits and file type (the sandbox itself is Codex's Seatbelt or
 * Landlock policy, checked separately by the acceptance probes). The code that
 * computes it is this module, so its hash is the probe hash.
 */
function posixSecurityStateBinding(adapter: string, boundaryPaths: string[], mutableBoundaryRoots: string[]): IsolationSecurityStateBinding {
  const paths = [...new Set(boundaryPaths.map((path) => resolve(path)))].sort((a, b) => a.localeCompare(b));
  const mutableRoots = [...new Set(mutableBoundaryRoots.map((path) => resolve(path)))].sort((a, b) => a.localeCompare(b));
  if (mutableRoots.some((path) => !paths.includes(path))) throw new Error(`${adapter} mutable security root is not permission-bound`);
  const state = paths.map((path) => {
    try {
      const stat = lstatSync(path);
      return { path, uid: stat.uid, gid: stat.gid, mode: stat.mode, link: stat.isSymbolicLink() };
    } catch { return { path, missing: true }; }
  });
  const probe = fileURLToPath(import.meta.url);
  return {
    securityStateProbePath: probe,
    securityStateProbeSha256: sha256File(probe),
    securityBoundaryPaths: paths,
    mutableBoundaryRoots: mutableRoots,
    hostSecurityStateFingerprint: createHash("sha256").update(JSON.stringify(state)).digest("hex").toUpperCase(),
  };
}

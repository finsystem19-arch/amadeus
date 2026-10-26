import { createHash } from "node:crypto";
import { join, resolve, win32 } from "node:path";

/** MXC cannot use AppData as a process working directory. Keep disposable
 * workspaces beside (never inside) the assigned project while durable private
 * state remains under the configured Amadeus state root. */
export function resolveWorkerWorkspaceRoot(projectRoot: string, stateRoot: string, platform = process.platform): string {
  if (platform !== "win32") return join(resolve(stateRoot), "worker-workspaces");
  // Windows path rules even when the caller asks for them from another OS.
  const project = win32.resolve(projectRoot);
  const parent = win32.dirname(project);
  if (parent === win32.parse(project).root) throw new Error("Amadeus MXC workers require a project inside a writable parent directory");
  const key = createHash("sha256").update(project.toLowerCase()).digest("hex").slice(0, 16);
  return win32.join(parent, ".amadeus-worker-workspaces", key);
}

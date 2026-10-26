import { spawnSync, type ChildProcess } from "node:child_process";

/**
 * Spawn option for every worker: on macOS and Linux a worker leads its own
 * process group, so stopping it also stops the shells and tests it started
 * (taskkill /T does this on Windows).
 */
export const WORKER_PROCESS_GROUP = process.platform !== "win32";

/** Stop this worker and its descendants, never other workers or host processes. */
export function terminateWorkerTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    return;
  }
  const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
    windowsHide: true, encoding: "utf8", timeout: 10_000,
  });
  if (result.status !== 0) {
    try { process.kill(child.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; }
    throw new Error(`Worker process-tree termination could not be confirmed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  }
}

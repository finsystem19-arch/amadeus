import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// macOS reaches the temporary folder and many home folders through symlinks
// (/var -> /private/var). The server must still answer when started that way.
test("the MCP server answers when its install path goes through a symlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "amadeus-symlink-"));
  try {
    const real = join(dir, "real");
    mkdirSync(real);
    cpSync(join(root, "plugins", "amadeus"), join(real, "plugin"), { recursive: true });
    const linked = join(dir, "linked");
    symlinkSync(real, linked, process.platform === "win32" ? "junction" : "dir");
    const child = spawnSync(process.execPath, [join(linked, "plugin", "scripts", "server.mjs")], {
      env: { ...process.env, AMADEUS_HOME: join(dir, "state"), AMADEUS_CONFIG: join(dir, "config.json"), AMADEUS_SETUP_ROOT: "" },
      cwd: dir, encoding: "utf8", timeout: 10000,
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`,
    });
    assert.equal(child.status, 0, child.stderr);
    const reply = JSON.parse(child.stdout.trim().split("\n")[0]);
    assert.equal(reply.result.serverInfo.name, "amadeus");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

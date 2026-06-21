import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pkg from "../../package.json" with { type: "json" };

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-mcp-launcher-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("o2b-mcp console script", () => {
  test("package bin exposes the launcher", () => {
    expect(pkg.bin["o2b-mcp"]).toBe("./scripts/o2b-mcp");
    const script = readFileSync(join(import.meta.dir, "../../scripts/o2b-mcp"), "utf8");
    expect(script).toContain(' mcp "$@"');
  });

  test("launcher reaches MCP probe and forwards flags", async () => {
    const proc = Bun.spawn(["bash", "scripts/o2b-mcp", "--probe", "--scope", "writer"], {
      cwd: join(import.meta.dir, "../.."),
      env: { ...process.env, VAULT_DIR: vault },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, returncode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr).toBe("");
    expect(returncode).toBe(0);
    expect(stdout).toContain("mcp probe ok: open-second-brain-writer");
  });
});

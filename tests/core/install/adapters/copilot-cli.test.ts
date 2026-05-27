import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import {
  copilotCliAdapter,
  setCopilotRunner,
  resetCopilotRunner,
  type CopilotRunner,
} from "../../../../src/core/install/adapters/copilot-cli.ts";
import { buildPayload } from "../../../../src/core/install/payload.ts";
import { readManifest } from "../../../../src/core/install/manifest.ts";

let vault: string;
let home: string;
let stderrBuf: string[];

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-copilot-v-"));
  home = mkdtempSync(join(tmpdir(), "osb-copilot-h-"));
  stderrBuf = [];
});
afterEach(() => {
  resetCopilotRunner();
  for (const p of [vault, home]) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

function env() {
  return {
    vault,
    home,
    cwd: home,
    env: { VAULT_AGENT_NAME: "claude-vps", VAULT_TIMEZONE: "UTC" },
    now: new Date("2026-05-20T12:00:00.000Z"),
  };
}

function applyOpts() {
  const stdout = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  const stderr = new Writable({
    write(chunk, _e, cb) {
      stderrBuf.push(chunk.toString());
      cb();
    },
  });
  return {
    dryRun: false,
    force: false,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
  };
}

function payload() {
  return buildPayload({ vault, agent_name: "claude-vps", timezone: "UTC" });
}

function fallbackFile() {
  return join(home, ".config", "github-copilot", "mcp.json");
}

describe("copilot-cli adapter — happy path via CLI subprocess", () => {
  test("apply calls `copilot mcp remove` + `copilot mcp add` for both names", () => {
    const calls: string[][] = [];
    const runner: CopilotRunner = {
      available: () => true,
      run: (args) => {
        calls.push([...args]);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      list: () => ({ ok: true, names: ["open-second-brain", "open-second-brain-writer"] }),
    };
    setCopilotRunner(runner);
    const p = payload();
    copilotCliAdapter.apply(copilotCliAdapter.plan(p, env()), p, env(), applyOpts());
    const ops = calls.map((c) => `${c[0]} ${c[1]}`);
    expect(ops).toContain("mcp remove");
    expect(ops).toContain("mcp add");
    const manifest = readManifest(vault).installs["copilot-cli"];
    expect(manifest).toBeDefined();
    expect(manifest!.operation).toBe("subprocess");
    expect(manifest!.fallback_file).toBeNull();
  });
});

describe("copilot-cli adapter — fallback to JSON file", () => {
  test("uses file fallback when CLI absent", () => {
    const runner: CopilotRunner = {
      available: () => false,
      run: () => {
        throw new Error("should not run");
      },
      list: () => ({ ok: false, names: [] }),
    };
    setCopilotRunner(runner);
    const p = payload();
    copilotCliAdapter.apply(copilotCliAdapter.plan(p, env()), p, env(), applyOpts());
    expect(existsSync(fallbackFile())).toBe(true);
    const parsed = JSON.parse(readFileSync(fallbackFile(), "utf8"));
    expect(parsed.mcpServers["open-second-brain"]).toBeDefined();
    expect(parsed.mcpServers["open-second-brain-writer"]).toBeDefined();
    expect(stderrBuf.join("").length).toBeGreaterThan(0);
    const manifest = readManifest(vault).installs["copilot-cli"];
    expect(manifest!.fallback_file).toBe(fallbackFile());
  });

  test("falls back when CLI add returns non-zero", () => {
    let n = 0;
    const runner: CopilotRunner = {
      available: () => true,
      run: (args) => {
        n += 1;
        if (args.includes("add")) return { exitCode: 1, stdout: "", stderr: "boom" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      list: () => ({ ok: true, names: [] }),
    };
    setCopilotRunner(runner);
    const p = payload();
    copilotCliAdapter.apply(copilotCliAdapter.plan(p, env()), p, env(), applyOpts());
    expect(n).toBeGreaterThan(0);
    expect(existsSync(fallbackFile())).toBe(true);
    expect(stderrBuf.join("")).toContain("copilot mcp add failed");
  });
});

describe("copilot-cli adapter — verify", () => {
  test("verify ok when CLI lists both names", () => {
    const runner: CopilotRunner = {
      available: () => true,
      run: () => ({ exitCode: 0, stdout: "", stderr: "" }),
      list: () => ({ ok: true, names: ["open-second-brain", "open-second-brain-writer"] }),
    };
    setCopilotRunner(runner);
    const p = payload();
    copilotCliAdapter.apply(copilotCliAdapter.plan(p, env()), p, env(), applyOpts());
    expect(copilotCliAdapter.verify(env()).status).toBe("ok");
  });

  test("verify ok when fallback file has both keys", () => {
    const runner: CopilotRunner = {
      available: () => false,
      run: () => {
        throw new Error("nope");
      },
      list: () => ({ ok: false, names: [] }),
    };
    setCopilotRunner(runner);
    const p = payload();
    copilotCliAdapter.apply(copilotCliAdapter.plan(p, env()), p, env(), applyOpts());
    expect(copilotCliAdapter.verify(env()).status).toBe("ok");
  });

  test("verify drift when fallback file payload was changed", () => {
    const runner: CopilotRunner = {
      available: () => false,
      run: () => {
        throw new Error("nope");
      },
      list: () => ({ ok: false, names: [] }),
    };
    setCopilotRunner(runner);
    const p = payload();
    copilotCliAdapter.apply(copilotCliAdapter.plan(p, env()), p, env(), applyOpts());
    const parsed = JSON.parse(readFileSync(fallbackFile(), "utf8"));
    parsed.mcpServers["open-second-brain"].command = "TAMPERED";
    writeFileSync(fallbackFile(), JSON.stringify(parsed, null, 2) + "\n");
    const v = copilotCliAdapter.verify(env());
    expect(v.status).toBe("drift");
    expect(v.details.join("\n")).toContain("canonical payload");
  });

  test("verify drift when CLI lists only one name", () => {
    const runner: CopilotRunner = {
      available: () => true,
      run: () => ({ exitCode: 0, stdout: "", stderr: "" }),
      list: () => ({ ok: true, names: ["open-second-brain"] }),
    };
    setCopilotRunner(runner);
    const p = payload();
    copilotCliAdapter.apply(copilotCliAdapter.plan(p, env()), p, env(), applyOpts());
    expect(copilotCliAdapter.verify(env()).status).toBe("drift");
  });
});

describe("copilot-cli adapter — uninstall", () => {
  test("uninstall via CLI removes both names", () => {
    const calls: string[][] = [];
    const runner: CopilotRunner = {
      available: () => true,
      run: (args) => {
        calls.push([...args]);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      list: () => ({ ok: true, names: ["open-second-brain", "open-second-brain-writer"] }),
    };
    setCopilotRunner(runner);
    const p = payload();
    copilotCliAdapter.apply(copilotCliAdapter.plan(p, env()), p, env(), applyOpts());
    calls.length = 0;
    copilotCliAdapter.uninstall(env(), applyOpts());
    const removeCalls = calls.filter((c) => c[0] === "mcp" && c[1] === "remove");
    expect(removeCalls.length).toBe(2);
    expect(readManifest(vault).installs["copilot-cli"]).toBeUndefined();
  });

  test("uninstall via fallback file removes both keys", () => {
    const runner: CopilotRunner = {
      available: () => false,
      run: () => {
        throw new Error("nope");
      },
      list: () => ({ ok: false, names: [] }),
    };
    setCopilotRunner(runner);
    const p = payload();
    copilotCliAdapter.apply(copilotCliAdapter.plan(p, env()), p, env(), applyOpts());
    copilotCliAdapter.uninstall(env(), applyOpts());
    const parsed = JSON.parse(readFileSync(fallbackFile(), "utf8"));
    expect(parsed.mcpServers["open-second-brain"]).toBeUndefined();
    expect(parsed.mcpServers["open-second-brain-writer"]).toBeUndefined();
  });
});

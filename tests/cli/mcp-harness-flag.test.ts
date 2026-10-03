import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HARNESS_IDS } from "../../src/core/brain/scoped-rules.ts";
import { writeVaultPointer } from "../../src/core/brain/portability/pointer.ts";
import { MCPServer } from "../../src/mcp/server.ts";
import { homeEnv } from "../helpers/platform.ts";
import { waitForSelfHealChildren } from "../helpers/self-heal-children.ts";
import { tempDirs } from "../helpers/temp-dir.ts";
import { runCli } from "../helpers/run-cli.ts";

/** Whole tokens: `copilot-cli` contains `pi`, so containment over ids lies. */
function tokensOf(text: string): ReadonlySet<string> {
  return new Set(text.split(/[^A-Za-z0-9_-]+/).filter((token) => token.length > 0));
}

describe("o2b mcp --harness", () => {
  test("an unknown harness exits 2 with the pinned message listing every harness", async () => {
    const res = await runCli(["mcp", "--harness", "nope"], { stdin: "" });
    expect(res.returncode).toBe(2);
    expect(res.stderr).toBe(
      `o2b mcp: invalid --harness value: "nope"; expected one of: ${HARNESS_IDS.join(", ")}\n`,
    );
    const offered = tokensOf(res.stderr);
    for (const id of HARNESS_IDS) {
      expect(`${id} offered: ${offered.has(id)}`).toBe(`${id} offered: true`);
    }
  });

  test("a refused value is echoed JSON-quoted, control characters escaped", async () => {
    // A C0 escape, a newline and the 8-bit CSI (a C1 control).
    const value = "x\u001b[31my\nz\u009b1mw";
    const quoted = '"x\\u001b[31my\\nz\\u009b1mw"';
    const flags = ["--harness", "--host-target"];
    const results = await Promise.all(
      flags.map((flag) => runCli(["mcp", flag, value], { stdin: "" })),
    );
    for (const [i, flag] of flags.entries()) {
      const res = results[i]!;
      expect(res.returncode).toBe(2);
      expect(res.stderr).toStartWith(`o2b mcp: invalid ${flag} value: ${quoted}; `);
      expect(res.stderr).not.toContain("\u001b");
      expect(res.stderr).not.toContain("\u009b");
      expect(res.stderr.split("\n").length).toBe(2);
    }
  });

  test("an install-target value is a valid harness", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-harness-"));
    try {
      const res = await runCli(["mcp", "--probe", "--harness", "cursor"], {
        stdin: "",
        env: { VAULT_DIR: tmp },
      });
      expect(res.stderr).toBe("");
      expect(res.returncode).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a known harness is accepted by the server start path", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-harness-"));
    try {
      const res = await runCli(["mcp", "--probe", "--harness", "claude-code"], {
        stdin: "",
        env: { VAULT_DIR: tmp },
      });
      expect(res.stderr).toBe("");
      expect(res.returncode).toBe(0);
      expect(res.stdout).toContain("mcp probe ok");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("ServerContext.ruleScope", () => {
  let vault: string;
  let workspace: string;
  beforeAll(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-rule-scope-vault-"));
    workspace = mkdtempSync(join(tmpdir(), "o2b-rule-scope-ws-"));
  });
  afterAll(() => {
    rmSync(vault, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  test("an explicit harness and workspace directory reach the context", () => {
    const server = new MCPServer({ vault }, { harness: "codex", workspaceDir: workspace });
    expect(server.context.ruleScope).toEqual({ workspaceDir: workspace, harness: "codex" });
  });

  test("the harness wins over the host target", () => {
    const server = new MCPServer({ vault }, { harness: "claude-code", hostTarget: "cursor" });
    expect(server.context.ruleScope?.harness).toBe("claude-code");
  });

  test("the host target is the fallback harness", () => {
    const server = new MCPServer({ vault }, { hostTarget: "cursor" });
    expect(server.context.ruleScope).toEqual({ workspaceDir: null, harness: "cursor" });
  });

  test("neither option resolves no harness and no workspace", () => {
    const server = new MCPServer({ vault });
    expect(server.context.ruleScope).toEqual({ workspaceDir: null, harness: null });
  });
});

function frame(id: number | null, method: string, params: Record<string, unknown> = {}): string {
  const body =
    id === null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params };
  return `${JSON.stringify(body)}\n`;
}

/**
 * The launch options reach the served `brain_context` in a real stdio
 * process: `--harness` (else `--host-target`) picks the harness file and
 * the launch directory picks the project file. The in-process suites
 * construct `MCPServer` directly and cannot see the CLI forwarding.
 */
describe("o2b mcp forwards the launch scope to brain_context", () => {
  const mkTemp = tempDirs();
  const CLI = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");

  async function servedContext(args: ReadonlyArray<string>): Promise<string> {
    const root = mkTemp("o2b-mcp-harness-e2e-");
    {
      const vault = join(root, "vault");
      const project = join(root, "proj-e2e");
      const home = join(root, "home");
      for (const dir of [join(vault, "Brain"), project, home]) mkdirSync(dir, { recursive: true });
      writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
      writeVaultPointer(project, vault);
      for (const [axis, key] of [
        ["harness", "cursor"],
        ["project", "proj-e2e"],
      ] as const) {
        mkdirSync(join(vault, "Brain", "standing-rules", axis), { recursive: true });
        writeFileSync(
          join(vault, "Brain", "standing-rules", axis, `${key}.md`),
          `zz${axis}markerzz`,
        );
      }
      const proc = Bun.spawn([process.execPath, CLI, "mcp", "--vault", vault, ...args], {
        cwd: project,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env["PATH"] ?? "",
          ...(process.env["SYSTEMROOT"] ? { SYSTEMROOT: process.env["SYSTEMROOT"] } : {}),
          ...homeEnv(home),
          OPEN_SECOND_BRAIN_CONFIG: join(home, "config.yaml"),
          O2B_DEVICE_ID: "",
        },
      });
      proc.stdin.write(
        frame(1, "initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "harness-e2e", version: "0" },
        }) +
          frame(null, "notifications/initialized") +
          frame(9, "tools/call", { name: "brain_context", arguments: {} }),
      );
      await proc.stdin.end();
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      await waitForSelfHealChildren(vault);
      const line = stdout.split("\n").find((l) => l.includes('"id":9'));
      expect(line).toBeDefined();
      const reply = JSON.parse(line ?? "{}") as {
        result: { content: ReadonlyArray<{ text: string }> };
      };
      return reply.result.content[0]?.text ?? "";
    }
  }

  test("--harness and the launch directory select their files", async () => {
    const text = await servedContext(["--harness", "cursor"]);
    expect(text).toContain("zzharnessmarkerzz");
    expect(text).toContain("zzprojectmarkerzz");
  });

  test("--host-target is the harness when --harness is absent", async () => {
    expect(await servedContext(["--host-target", "cursor"])).toContain("zzharnessmarkerzz");
  });

  test("no harness option matches no harness file", async () => {
    expect(await servedContext([])).not.toContain("zzharnessmarkerzz");
  });
});

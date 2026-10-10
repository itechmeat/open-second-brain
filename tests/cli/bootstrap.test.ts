/**
 * `o2b bootstrap` (write-side-trust, Task 14).
 *
 * One command spans the three real install models: adapter targets run
 * the adapter's existing idempotent apply, `generic` is print-and-paste,
 * and plugin runtimes (claude-code, zcode) are verify-only - the plugin
 * registers the server itself, so bootstrap touches nothing but the
 * token and the receipt. The material is printed exactly once with a
 * shown-once notice and never lands in a harness config: the payload env
 * block stays credential-free, because the token reaches the agent
 * through its environment or a `$secret:` reference, never a config file.
 *
 * The codex adapter-probing cases run against the injected runner seams
 * (no `codex` binary, no host probe), so the suite is deterministic and
 * network-free on any machine; they still carry an explicit 20000 ms
 * timeout per the lane rules, because they exercise adapter machinery
 * that shells out on a real host.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import { fakeCredential } from "../helpers/fake-credentials.ts";
import {
  resetCodexRunner,
  setCodexRunner,
  type CodexRunner,
} from "../../src/core/install/adapters/codex.ts";
import { resetHostProbeRunner, setHostProbeRunner } from "../../src/core/install/host-probe.ts";
import {
  listAgentTokens,
  resolveAgentForToken,
  revokeAgentToken,
} from "../../src/core/brain/secrets/token-store.ts";
import { startHttp, type HttpServerHandle } from "../../src/mcp/index.ts";
import { JSONRPC_VERSION } from "../../src/mcp/protocol.ts";

// The payload-refusal test below needs buildPayload to throw a PayloadError
// AFTER the mint, on demand and portably (the real builder refuses only on
// an empty vault or a Windows-metacharacter path), so the module is wrapped
// in a forwarding mock (captured before the mock is installed, or the
// forward would recurse) that fails only while a flag is set.
import * as payloadModule from "../../src/core/install/payload.ts";

const realBuildPayload = payloadModule.buildPayload;
let failPayloadBuild = false;

mock.module("../../src/core/install/payload.ts", () => ({
  ...payloadModule,
  buildPayload: (
    ...args: Parameters<typeof realBuildPayload>
  ): ReturnType<typeof realBuildPayload> => {
    if (failPayloadBuild) {
      throw new payloadModule.PayloadError("injected: the payload build refused");
    }
    return realBuildPayload(...args);
  },
}));

let tempRoot: string;
let vault: string;
let codexHome: string;
let opencodeHome: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "o2b-bootstrap-"));
  vault = join(tempRoot, "brain vault");
  codexHome = join(tempRoot, "codex-home");
  opencodeHome = join(tempRoot, "opencode-home");
  mkdirSync(vault, { recursive: true });
  // Both subprocess seams are injected for the whole suite: the codex
  // adapter must take its file-fallback path (no binary), and the host
  // probe must report the binary missing (no `codex mcp list` spawn).
  setCodexRunner({
    available: () => false,
    run: () => {
      throw new Error("the codex binary is injected absent in this suite");
    },
  });
  setHostProbeRunner({
    available: () => false,
    run: () => ({ exitCode: 127, stdout: "", stderr: "injected: binary absent" }),
  });
});

afterEach(() => {
  resetCodexRunner();
  resetHostProbeRunner();
  rmSync(tempRoot, { recursive: true, force: true });
});

/** The codex file-fallback config the adapter writes under the injected home. */
function codexConfigPath(): string {
  return join(codexHome, "config.toml");
}

function receiptPath(): string {
  return join(vault, ".open-second-brain", "bootstrap.lock.json");
}

function readReceipt(): Record<string, any> {
  return JSON.parse(readFileSync(receiptPath(), "utf8")) as Record<string, any>;
}

function bytesOf(path: string): string {
  return readFileSync(path, "utf8");
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function custodyAuditActions(): Array<Record<string, any>> {
  const dir = join(vault, "Brain", "log", "secret-custody");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) =>
    readFileSync(join(dir, f), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, any>),
  );
}

/** The bootstrap argv every provisioning case starts from. */
function bootstrapArgs(extra: ReadonlyArray<string>): string[] {
  return ["bootstrap", "--vault", vault, ...extra];
}

/**
 * Real agent identities for the mints. The targets themselves (`codex`,
 * `claude-code`) are PLACEHOLDER_AGENT_VALUES - names the identity layer
 * treats as absent - so a mint under them is refused (see the refusals
 * suite); every provisioning case names its agent explicitly.
 */
const CODEX_AGENT = "codex-workstation";
const CLAUDE_AGENT = "claude-workstation";
const OPENCODE_AGENT = "opencode-workstation";

/** The single osbt-shaped line a mint or rotate prints, trimmed. */
function printedMaterial(stdout: string): string {
  const start = stdout.indexOf("osbt_");
  expect(start).toBeGreaterThanOrEqual(0);
  return stdout.slice(start, stdout.indexOf("\n", start)).trim();
}

/**
 * A `codex` binary that registers like the real one: `mcp add` appends the
 * server's table to `$CODEX_HOME/config.toml` in the host's own layout, so
 * apply takes the subprocess path and `verify` asks the declared host probe.
 * Anything else (the best-effort `mcp remove`) exits non-zero.
 */
function fakeCodexHost(): CodexRunner {
  return {
    available: () => true,
    run(home, args) {
      const [, action, name] = args;
      if (action !== "add" || typeof name !== "string") {
        return { exitCode: 1, stdout: "", stderr: `unknown command: ${args.join(" ")}` };
      }
      mkdirSync(home, { recursive: true });
      writeFileSync(codexConfigPath(), `[mcp_servers.${name}]\ncommand = "o2b"\n`, { flag: "a" });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

describe("o2b bootstrap --target codex (adapter model)", () => {
  test("mints the named token, applies the adapter, and prints the material exactly once", async () => {
    const r = await runCli(
      bootstrapArgs(["--target", "codex", "--agent", CODEX_AGENT, "--token"]),
      {
        env: { CODEX_HOME: codexHome },
      },
    );
    expect(r.returncode).toBe(0);

    const store = listAgentTokens(vault);
    expect(store).toHaveLength(1);
    const record = store[0]!;
    expect(record.name).toBe("mcp_token_codex");
    expect(record.agent).toBe(CODEX_AGENT);
    expect(record.status).toBe("active");

    // The material exists in exactly one output channel, once, with the
    // shown-once notice beside it.
    const materialStart = r.stdout.indexOf("osbt_");
    expect(materialStart).toBeGreaterThanOrEqual(0);
    const lineEnd = r.stdout.indexOf("\n", materialStart);
    const tokenMaterial = r.stdout.slice(materialStart, lineEnd).trim();
    expect(countOccurrences(r.stdout, tokenMaterial)).toBe(1);
    expect(r.stdout).toContain("shown exactly once");
    // The credential boundary beside the material: what the token
    // authenticates (hand-configured HTTP clients) and what it does not
    // (the registered stdio harness keeps its config-derived identity).
    expect(r.stdout).toContain("config-derived identity");
    expect(r.stderr).not.toContain(tokenMaterial);

    // The harness config carries the registration and never the
    // credential: the payload env block stays credential-free.
    const configToml = bytesOf(codexConfigPath());
    expect(configToml).toContain("[mcp_servers.open-second-brain]");
    expect(configToml).toContain("[mcp_servers.open-second-brain-writer]");
    expect(configToml).not.toContain("osbt_");
    expect(configToml).not.toContain(tokenMaterial);

    // The receipt: schema 1, owned entries, token name and non-secret
    // prefix, applied_at.
    const receipt = readReceipt();
    expect(receipt["schema_version"]).toBe(1);
    const entry = receipt["entries"]["codex"];
    expect(entry["target"]).toBe("codex");
    expect(entry["config_path"]).toBe(codexConfigPath());
    expect(entry["owned_keys"]).toEqual(["open-second-brain", "open-second-brain-writer"]);
    expect(entry["token"]).toEqual({
      name: "mcp_token_codex",
      prefix: record.token_prefix,
    });
    expect(typeof entry["applied_at"]).toBe("string");
    expect((entry["applied_at"] as string).length).toBeGreaterThan(0);

    // The minted material authenticates, via the same resolution the
    // transport performs per request.
    expect(resolveAgentForToken(vault, tokenMaterial)).toEqual({
      agent: CODEX_AGENT,
      name: "mcp_token_codex",
    });
  }, 20000);

  test("a second identical run is a byte-identical no-op: exit 0, no receipt churn", async () => {
    const first = await runCli(
      bootstrapArgs(["--target", "codex", "--agent", CODEX_AGENT, "--token"]),
      { env: { CODEX_HOME: codexHome } },
    );
    expect(first.returncode).toBe(0);
    const materialStart = first.stdout.indexOf("osbt_");
    const tokenMaterial = first.stdout
      .slice(materialStart, first.stdout.indexOf("\n", materialStart))
      .trim();

    const configBefore = bytesOf(codexConfigPath());
    const receiptBefore = bytesOf(receiptPath());
    const installBefore = bytesOf(join(vault, ".open-second-brain", "install.lock.json"));

    const second = await runCli(
      bootstrapArgs(["--target", "codex", "--agent", CODEX_AGENT, "--token"]),
      { env: { CODEX_HOME: codexHome } },
    );
    expect(second.returncode).toBe(0);
    // No reprint: the material is shown once per mint, never per run.
    expect(second.stdout).not.toContain(tokenMaterial);
    expect(second.stdout).toContain("already provisioned");
    expect(bytesOf(codexConfigPath())).toBe(configBefore);
    expect(bytesOf(receiptPath())).toBe(receiptBefore);
    expect(bytesOf(join(vault, ".open-second-brain", "install.lock.json"))).toBe(installBefore);
    expect(listAgentTokens(vault)).toHaveLength(1);
  }, 20000);

  test("--rotate re-mints under the same name, audits replaced, and the new material authenticates on the next request with no server restart", async () => {
    const first = await runCli(
      bootstrapArgs(["--target", "codex", "--agent", CODEX_AGENT, "--token"]),
      { env: { CODEX_HOME: codexHome } },
    );
    const materialStart = first.stdout.indexOf("osbt_");
    const oldMaterial = first.stdout
      .slice(materialStart, first.stdout.indexOf("\n", materialStart))
      .trim();

    // The server starts BEFORE the rotation and stays up across it: the
    // rotation must land on its next request, not on a restart.
    let handle: HttpServerHandle | null = null;
    try {
      handle = await startHttp({ vault }, { host: "127.0.0.1", port: 0 });
      const rpc = (id: number) =>
        JSON.stringify({
          jsonrpc: JSONRPC_VERSION,
          id,
          method: "tools/call",
          params: { name: "brain_context_pack", arguments: { max_tokens: 2000 } },
        });
      const post = async (material: string): Promise<Response> =>
        fetch(handle!.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${material}`,
          },
          body: rpc(1),
        });

      // The old material authenticates before the rotation.
      expect((await post(oldMaterial)).status).toBe(200);

      const rotated = await runCli(bootstrapArgs(["--target", "codex", "--rotate"]), {
        env: { CODEX_HOME: codexHome },
      });
      expect(rotated.returncode).toBe(0);
      const newStart = rotated.stdout.indexOf("osbt_");
      expect(newStart).toBeGreaterThanOrEqual(0);
      const newMaterial = rotated.stdout
        .slice(newStart, rotated.stdout.indexOf("\n", newStart))
        .trim();
      expect(newMaterial).not.toBe(oldMaterial);
      expect(countOccurrences(rotated.stdout, newMaterial)).toBe(1);
      expect(rotated.stdout).toContain("shown exactly once");

      // Same name, new hash; the store audit carries replaced: true.
      const store = listAgentTokens(vault);
      expect(store).toHaveLength(1);
      expect(store[0]!.name).toBe("mcp_token_codex");
      expect(store[0]!.rotated_at).toBeDefined();
      const rotatedRows = custodyAuditActions().filter(
        (row) => row["action"] === "mcp_token_rotated",
      );
      expect(rotatedRows).toHaveLength(1);
      expect(rotatedRows[0]!["details"]["replaced"]).toBe(true);

      // The receipt followed the rotation: same name, new prefix.
      const receipt = readReceipt();
      expect(receipt["entries"]["codex"]["token"]["name"]).toBe("mcp_token_codex");
      expect(receipt["entries"]["codex"]["token"]["prefix"]).toBe(store[0]!.token_prefix);
      expect(receipt["entries"]["codex"]["token"]["prefix"]).not.toBe(
        oldMaterial.slice(0, store[0]!.token_prefix.length),
      );

      // No restart: both materials authenticate on the very next
      // requests of the same server - the new one from here on, the old
      // one through the rotation grace window while the new material is
      // being placed (the store suite walks the window's expiry with an
      // injected clock).
      expect((await post(oldMaterial)).status).toBe(200);
      expect((await post(newMaterial)).status).toBe(200);
      expect(
        resolveAgentForToken(vault, fakeCredential("osbt_", "never-minted-material")),
      ).toBeNull();
    } finally {
      if (handle !== null) await handle.close();
    }
  }, 20000);

  test("--check reports ok after bootstrap, drift after the config is edited, and drift when nothing is provisioned", async () => {
    const fresh = await runCli(bootstrapArgs(["--target", "codex", "--check"]), {
      env: { CODEX_HOME: codexHome },
    });
    expect(fresh.returncode).toBe(3);
    expect(fresh.stdout).toContain("not-installed");

    const first = await runCli(
      bootstrapArgs(["--target", "codex", "--agent", CODEX_AGENT, "--token"]),
      { env: { CODEX_HOME: codexHome } },
    );
    expect(first.returncode).toBe(0);

    const ok = await runCli(bootstrapArgs(["--target", "codex", "--check"]), {
      env: { CODEX_HOME: codexHome },
    });
    expect(ok.returncode).toBe(0);
    expect(ok.stdout).toContain("registration: ok");
    expect(ok.stdout).toContain("mcp_token_codex active");

    // An operator edit the adapter did not write is drift, with the
    // install verb's fix hint named.
    const drifted = bytesOf(codexConfigPath()).replace("mcp", "not-mcp");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(codexConfigPath(), drifted);
    const after = await runCli(bootstrapArgs(["--target", "codex", "--check"]), {
      env: { CODEX_HOME: codexHome },
    });
    expect(after.returncode).toBe(3);
    expect(after.stdout).toContain("registration: drift");
  }, 20000);

  test("--check refuses a revoked or missing token as drift, naming the provisioning command", async () => {
    const first = await runCli(
      bootstrapArgs(["--target", "codex", "--agent", CODEX_AGENT, "--token"]),
      { env: { CODEX_HOME: codexHome } },
    );
    expect(first.returncode).toBe(0);
    expect(revokeAgentToken(vault, "mcp_token_codex")).toBe(true);

    const checked = await runCli(bootstrapArgs(["--target", "codex", "--check"]), {
      env: { CODEX_HOME: codexHome },
    });
    expect(checked.returncode).toBe(3);
    expect(checked.stdout).toContain("not active");
    expect(checked.stdout).toContain("--token");
  }, 20000);

  test("a revoked token refuses every provision form instead of a healthy no-op, matching --check", async () => {
    const first = await runCli(
      bootstrapArgs(["--target", "codex", "--agent", CODEX_AGENT, "--token"]),
      { env: { CODEX_HOME: codexHome } },
    );
    expect(first.returncode).toBe(0);
    expect(revokeAgentToken(vault, "mcp_token_codex")).toBe(true);

    // The same vault that --check calls drift (exit 3) must not read as
    // healthy to the provision path: the receipt still carries the
    // revoked token's name and prefix, so the no-churn gate would
    // otherwise answer "already provisioned" exit 0.
    const checked = await runCli(bootstrapArgs(["--target", "codex", "--check"]), {
      env: { CODEX_HOME: codexHome },
    });
    expect(checked.returncode).toBe(3);

    const plain = await runCli(bootstrapArgs(["--target", "codex"]), {
      env: { CODEX_HOME: codexHome },
    });
    expect(plain.returncode).toBe(1);
    expect(plain.stderr).toContain("is revoked");
    expect(plain.stderr).toContain("o2b mcp token mint");
    expect(plain.stdout).not.toContain("already provisioned");

    const withToken = await runCli(bootstrapArgs(["--target", "codex", "--token"]), {
      env: { CODEX_HOME: codexHome },
    });
    expect(withToken.returncode).toBe(1);
    expect(withToken.stderr).toContain("is revoked");
  }, 20000);

  test("--check keeps the unreachable verdict when the token half also drifted", async () => {
    setCodexRunner(fakeCodexHost());
    // The host answers the declared probe but names neither OSB server:
    // the configuration is right and the runtime has not loaded it, which
    // is the unreachable verdict, not drift.
    setHostProbeRunner({
      available: () => true,
      run: () => ({ exitCode: 0, stdout: "Name\n", stderr: "" }),
    });

    const first = await runCli(
      bootstrapArgs(["--target", "codex", "--agent", CODEX_AGENT, "--token"]),
      { env: { CODEX_HOME: codexHome } },
    );
    expect(first.returncode).toBe(0);

    const unreachable = await runCli(bootstrapArgs(["--target", "codex", "--check"]), {
      env: { CODEX_HOME: codexHome },
    });
    expect(unreachable.returncode).toBe(5);
    expect(unreachable.stdout).toContain("registration: mcp-unreachable");

    // The token half drifts on top of it. The runtime could not be asked,
    // so the check did not actually run: exit 5 ("could not check")
    // survives, with both findings named on stdout.
    expect(revokeAgentToken(vault, "mcp_token_codex")).toBe(true);
    const after = await runCli(bootstrapArgs(["--target", "codex", "--check"]), {
      env: { CODEX_HOME: codexHome },
    });
    expect(after.returncode).toBe(5);
    expect(after.stdout).toContain("registration: mcp-unreachable");
    expect(after.stdout).toContain("not active");
  }, 20000);

  test("--rotate with nothing to rotate is a runtime error naming the mint command", async () => {
    const r = await runCli(bootstrapArgs(["--target", "codex", "--rotate"]), {
      env: { CODEX_HOME: codexHome },
    });
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("mcp_token_codex");
  }, 20000);
});

describe("o2b bootstrap --target generic (print-and-paste)", () => {
  test("prints the payload and the manual steps, mints on --token, and never writes a harness config", async () => {
    const r = await runCli(bootstrapArgs(["--target", "generic", "--token"]), {
      env: { CODEX_HOME: codexHome },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("mcpServers");
    expect(r.stdout).toContain("second-brain");
    expect(r.stdout).toContain("manual steps");

    const materialStart = r.stdout.indexOf("osbt_");
    const tokenMaterial = r.stdout
      .slice(materialStart, r.stdout.indexOf("\n", materialStart))
      .trim();
    // Exactly one osbt-shaped string on stdout: the minted material.
    // The payload env block stays credential-free.
    expect(countOccurrences(r.stdout, "osbt_")).toBe(1);
    expect(countOccurrences(r.stdout, tokenMaterial)).toBe(1);

    const receipt = readReceipt();
    const entry = receipt["entries"]["generic"];
    expect(entry["mode"]).toBe("print");
    expect(entry["token"]["name"]).toBe("mcp_token_generic");
    expect(resolveAgentForToken(vault, tokenMaterial)).toEqual({
      agent: "generic",
      name: "mcp_token_generic",
    });
    // Print-and-paste wrote no harness config anywhere.
    expect(existsSync(codexConfigPath())).toBe(false);
  }, 20000);
});

describe("o2b bootstrap --target claude-code (plugin verify-only)", () => {
  test("mints and records the token, writes no harness config, and points at the plugin's own verify", async () => {
    const r = await runCli(
      bootstrapArgs(["--target", "claude-code", "--agent", CLAUDE_AGENT, "--token"]),
      { env: { CODEX_HOME: codexHome } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("verify only");
    expect(r.stdout).toContain("o2b doctor");

    const materialStart = r.stdout.indexOf("osbt_");
    const tokenMaterial = r.stdout
      .slice(materialStart, r.stdout.indexOf("\n", materialStart))
      .trim();
    expect(countOccurrences(r.stdout, tokenMaterial)).toBe(1);

    const receipt = readReceipt();
    const entry = receipt["entries"]["claude-code"];
    expect(entry["mode"]).toBe("verify-only");
    expect(entry["token"]["name"]).toBe("mcp_token_claude_code");
    expect(existsSync(codexConfigPath())).toBe(false);
    expect(resolveAgentForToken(vault, tokenMaterial)).not.toBeNull();

    const checked = await runCli(bootstrapArgs(["--target", "claude-code", "--check"]), {
      env: { CODEX_HOME: codexHome },
    });
    expect(checked.returncode).toBe(0);
    expect(checked.stdout).toContain("plugin-managed");
  }, 20000);

  test("without --token it prints the steps and writes no receipt", async () => {
    const r = await runCli(bootstrapArgs(["--target", "zcode"]), {
      env: { CODEX_HOME: codexHome },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("verify only");
    expect(existsSync(receiptPath())).toBe(false);
    expect(listAgentTokens(vault)).toHaveLength(0);
  });
});

describe("o2b bootstrap refusals", () => {
  test("unsupported and unknown targets are refused with the available list", async () => {
    for (const target of ["cursor", "copilot-cli", "nonsense"]) {
      const r = await runCli(bootstrapArgs(["--target", target]), {
        env: { CODEX_HOME: codexHome },
      });
      expect(r.returncode).toBe(2);
      expect(r.stderr).toContain(target);
      expect(r.stderr).toContain("claude-code, codex, generic, grok, opencode, zcode");
    }
  });

  test("a missing --target is a usage refusal with the same list", async () => {
    const r = await runCli(["bootstrap", "--vault", vault], { env: { CODEX_HOME: codexHome } });
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("claude-code, codex, generic, grok, opencode, zcode");
  });

  test("--check combined with --token is a usage refusal", async () => {
    const r = await runCli(bootstrapArgs(["--target", "codex", "--check", "--token"]), {
      env: { CODEX_HOME: codexHome },
    });
    expect(r.returncode).toBe(2);
  });

  test("an unconfigured vault is the named usage refusal", async () => {
    const r = await runCli(["bootstrap", "--target", "codex", "--token"], {
      env: { CODEX_HOME: codexHome },
    });
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("vault not configured");
  });

  test("positional arguments are a usage refusal", async () => {
    const r = await runCli(bootstrapArgs(["--target", "codex", "extra"]), {
      env: { CODEX_HOME: codexHome },
    });
    expect(r.returncode).toBe(2);
  });

  test("a mint under a placeholder agent identity refuses by name; the plain path keeps working", async () => {
    // No --agent at all: the target name itself is the placeholder the
    // identity layer treats as absent, so the mint refuses before
    // anything is written.
    const noAgent = await runCli(bootstrapArgs(["--target", "codex", "--token"]), {
      env: { CODEX_HOME: codexHome },
    });
    expect(noAgent.returncode).toBe(2);
    expect(noAgent.stderr).toContain("mcp_token_codex");
    expect(noAgent.stderr).toContain("--agent");
    expect(listAgentTokens(vault)).toHaveLength(0);
    expect(existsSync(codexConfigPath())).toBe(false);

    // An explicit placeholder is the same refusal.
    const explicit = await runCli(
      bootstrapArgs(["--target", "codex", "--agent", "codex", "--token"]),
      { env: { CODEX_HOME: codexHome } },
    );
    expect(explicit.returncode).toBe(2);
    expect(explicit.stderr).toContain("placeholder");

    // Any target minting under a placeholder name refuses the same way.
    const generic = await runCli(
      bootstrapArgs(["--target", "generic", "--agent", "bot", "--token"]),
      { env: { CODEX_HOME: codexHome } },
    );
    expect(generic.returncode).toBe(2);
    expect(listAgentTokens(vault)).toHaveLength(0);

    // The plain (no --token) provision path never mints, so it keeps
    // working without --agent.
    const plain = await runCli(bootstrapArgs(["--target", "codex"]), {
      env: { CODEX_HOME: codexHome },
    });
    expect(plain.returncode).toBe(0);
    expect(existsSync(codexConfigPath())).toBe(true);
    expect(listAgentTokens(vault)).toHaveLength(0);

    // Once a token exists under a real name, a plain re-run adopts the
    // minted identity instead of refusing.
    const minted = await runCli(
      bootstrapArgs(["--target", "codex", "--agent", CODEX_AGENT, "--token"]),
      { env: { CODEX_HOME: codexHome } },
    );
    expect(minted.returncode).toBe(0);
    const rerun = await runCli(bootstrapArgs(["--target", "codex"]), {
      env: { CODEX_HOME: codexHome },
    });
    expect(rerun.returncode).toBe(0);
    expect(listAgentTokens(vault)).toHaveLength(1);
  }, 20000);

  test("a corrupted receipt refuses --check through the clean error path, not a crash", async () => {
    mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
    writeFileSync(receiptPath(), "{ not json");
    const r = await runCli(bootstrapArgs(["--target", "codex", "--check"]), {
      env: { CODEX_HOME: codexHome },
    });
    // The same named refusal the provision path gives: an exit code and a
    // one-line error, never a raw stack.
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("bootstrap receipt is corrupted JSON");
    expect(r.stderr).not.toContain("BootstrapReceiptError");
    expect(r.stderr).not.toMatch(/^\s+at /m);
  }, 20000);
});

describe("o2b bootstrap --remove (receipt-driven teardown)", () => {
  test("revokes the receipt's token, removes the owned registration, drops the receipt entry, and is idempotent", async () => {
    const first = await runCli(
      bootstrapArgs(["--target", "codex", "--agent", CODEX_AGENT, "--token"]),
      { env: { CODEX_HOME: codexHome } },
    );
    expect(first.returncode).toBe(0);
    const material = printedMaterial(first.stdout);
    expect(existsSync(codexConfigPath())).toBe(true);
    expect(readReceipt()["entries"]["codex"]).toBeDefined();

    const removed = await runCli(bootstrapArgs(["--remove", "codex"]), {
      env: { CODEX_HOME: codexHome },
    });
    expect(removed.returncode).toBe(0);
    // The registration the adapter wrote is gone...
    expect(existsSync(codexConfigPath())).toBe(true);
    expect(bytesOf(codexConfigPath())).not.toContain("mcp_servers.open-second-brain");
    // ...the receipt's token is revoked - immediately, no grace: removal
    // is not a rotation, nobody is placing new material...
    expect(listAgentTokens(vault)[0]!.status).toBe("revoked");
    expect(resolveAgentForToken(vault, material)).toBeNull();
    expect(removed.stdout).toContain("revoked");
    expect(removed.stdout).toContain("removed");
    // ...and the receipt entry is dropped the way the install manifest
    // models removal: the entry goes, the file stays.
    expect(readReceipt()["entries"]["codex"]).toBeUndefined();

    // A second remove finds nothing and exits clean.
    const again = await runCli(bootstrapArgs(["--remove", "codex"]), {
      env: { CODEX_HOME: codexHome },
    });
    expect(again.returncode).toBe(0);
    expect(again.stdout).toContain("nothing to remove");
    expect(bytesOf(codexConfigPath())).not.toContain("mcp_servers.open-second-brain");
    expect(listAgentTokens(vault)[0]!.status).toBe("revoked");
  }, 20000);

  test("an unknown target and provision-flag combinations are usage refusals", async () => {
    const unknown = await runCli(bootstrapArgs(["--remove", "nonsense"]), {
      env: { CODEX_HOME: codexHome },
    });
    expect(unknown.returncode).toBe(2);
    expect(unknown.stderr).toContain("claude-code, codex, generic, grok, opencode, zcode");

    const mixed = await runCli(bootstrapArgs(["--target", "codex", "--remove", "codex"]), {
      env: { CODEX_HOME: codexHome },
    });
    expect(mixed.returncode).toBe(2);
    expect(mixed.stderr).toContain("--remove");

    const withToken = await runCli(bootstrapArgs(["--remove", "codex", "--token"]), {
      env: { CODEX_HOME: codexHome },
    });
    expect(withToken.returncode).toBe(2);
  });
});

describe("o2b bootstrap when the adapter apply fails after a mint (opencode)", () => {
  /** `$XDG_CONFIG_HOME/opencode/opencode.json`, the adapter's config. */
  function opencodeConfigPath(): string {
    return join(opencodeHome, "opencode", "opencode.json");
  }

  test("a rotate into a hand-edited config still shows the material exactly once and names the retry path", async () => {
    mkdirSync(opencodeHome, { recursive: true });
    const env = { XDG_CONFIG_HOME: opencodeHome };
    const first = await runCli(
      bootstrapArgs(["--target", "opencode", "--agent", OPENCODE_AGENT, "--token"]),
      { env },
    );
    expect(first.returncode).toBe(0);
    const firstMaterial = printedMaterial(first.stdout);

    // Hand-edit: keep the OSB keys but change a value, and stamp an mtime
    // newer than the manifest's applied_at - exactly what the adapter's
    // user-modified-block safety net refuses to overwrite.
    const edited = bytesOf(opencodeConfigPath()).replace("o2b", "not-o2b");
    writeFileSync(opencodeConfigPath(), edited);
    const future = new Date(Date.now() + 10_000);
    utimesSync(opencodeConfigPath(), future, future);

    const rotated = await runCli(bootstrapArgs(["--target", "opencode", "--rotate"]), { env });
    expect(rotated.returncode).toBe(4);
    expect(rotated.stderr).toContain("hand-edited");

    // The mint happened, so the material prints - exactly once, on
    // stdout, beside the failure notice naming the retry and revoke
    // paths. Losing it silently would orphan a live credential whose
    // name a re-run would refuse to re-mint.
    const newMaterial = printedMaterial(rotated.stdout);
    expect(newMaterial).not.toBe(firstMaterial);
    expect(countOccurrences(rotated.stdout, newMaterial)).toBe(1);
    expect(rotated.stderr).not.toContain(newMaterial);
    expect(rotated.stdout).toContain("live in the store");
    expect(rotated.stdout).toContain("o2b mcp token revoke --name mcp_token_opencode");
    expect(resolveAgentForToken(vault, newMaterial)).toEqual({
      agent: OPENCODE_AGENT,
      name: "mcp_token_opencode",
    });

    // The named retry path finishes the job: a plain re-run (no --token,
    // so nothing re-mints) forced past the hand-edit block applies the
    // registration and the receipt catches up to the rotated token.
    const retry = await runCli(bootstrapArgs(["--target", "opencode", "--force"]), { env });
    expect(retry.returncode).toBe(0);
    expect(retry.stdout).not.toContain(newMaterial);
    const record = listAgentTokens(vault).find((t) => t.name === "mcp_token_opencode")!;
    expect(record.token_prefix).not.toBe(firstMaterial.slice(0, record.token_prefix.length));
    const entry = readReceipt()["entries"]["opencode"];
    expect(entry["token"]).toEqual({ name: "mcp_token_opencode", prefix: record.token_prefix });
    expect(entry["agent"]).toBe(OPENCODE_AGENT);
  }, 20000);
});

/**
 * The payload build refusing AFTER the mint (the run's other pre-apply
 * exit): the material is live in the store and a re-run would never show
 * it, so the rescue print must fire here too - exactly once, on stdout,
 * beside the failure notice - instead of orphaning the credential.
 */
describe("o2b bootstrap when the payload build refuses after a mint (generic)", () => {
  test("a payload refusal after a mint still shows the material exactly once, on stdout only", async () => {
    failPayloadBuild = true;
    try {
      const r = await runCli(
        bootstrapArgs(["--target", "generic", "--agent", OPENCODE_AGENT, "--token"]),
        {},
      );
      expect(r.returncode).toBe(2);
      expect(r.stderr).toContain("injected: the payload build refused");
      // The mint happened, so the material prints - exactly once, on
      // stdout, beside the failure notice naming the retry and revoke
      // paths, with stderr carrying none of it.
      const material = printedMaterial(r.stdout);
      expect(countOccurrences(r.stdout, material)).toBe(1);
      expect(r.stdout).toContain("live in the store");
      expect(r.stdout).toContain("o2b mcp token revoke --name mcp_token_generic");
      expect(r.stderr).not.toContain(material);
      expect(resolveAgentForToken(vault, material)).toEqual({
        agent: OPENCODE_AGENT,
        name: "mcp_token_generic",
      });
    } finally {
      failPayloadBuild = false;
    }
  }, 20000);
});

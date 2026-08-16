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
import {
  resetHostProbeRunner,
  setHostProbeRunner,
} from "../../../../src/core/install/host-probe.ts";
import { buildPayload } from "../../../../src/core/install/payload.ts";
import { OSB_KEY_FULL, OSB_KEY_WRITER } from "../../../../src/core/install/json-merge.ts";
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
  resetHostProbeRunner();
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

/**
 * A `copilot` binary that REMEMBERS what it was told.
 *
 * `mcp add` and `mcp remove` move a name in and out of a registry, and
 * `list` answers from that registry rather than from a fixture. It matters
 * because the subprocess mode leaves nothing on disk: the host's own
 * registry IS the record, so a stub that reports both names whatever it
 * was asked to do makes `verify` an assertion about the stub. Reducing
 * `applyViaCli` to the full server alone left this whole suite green
 * before the host remembered.
 *
 * The third field, `calls`, keeps the raw argv so the WHICH-name
 * assertions can read `mcp add <name>` directly.
 */
function fakeCopilotHost(): {
  runner: CopilotRunner;
  calls: string[][];
  registered: () => ReadonlyArray<string>;
} {
  const calls: string[][] = [];
  const registry = new Set<string>();
  const runner: CopilotRunner = {
    available: () => true,
    run: (args) => {
      calls.push([...args]);
      const [verb, action, name] = args;
      if (verb === "mcp" && name !== undefined) {
        if (action === "add") registry.add(name);
        if (action === "remove") registry.delete(name);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    list: () => ({ ok: true, names: [...registry] }),
  };
  return { runner, calls, registered: () => [...registry] };
}

/** The names one `copilot mcp <action>` verb was invoked with, sorted. */
function namesOf(calls: ReadonlyArray<ReadonlyArray<string>>, action: string): string[] {
  return calls
    .filter((c) => c[0] === "mcp" && c[1] === action)
    .map((c) => c[2] ?? "(no name)")
    .toSorted();
}

/** Both server names, sorted: the assertions below compare name SETS. */
const BOTH_KEYS = [OSB_KEY_FULL, OSB_KEY_WRITER].toSorted();

describe("copilot-cli adapter — happy path via CLI subprocess", () => {
  test("apply calls `copilot mcp remove` + `copilot mcp add` for both names", () => {
    const host = fakeCopilotHost();
    setCopilotRunner(host.runner);
    const p = payload();
    copilotCliAdapter.apply(copilotCliAdapter.plan(p, env()), p, env(), applyOpts());
    // WHICH names, not how many operations: `toContain("mcp add")` held for
    // an apply that registered the full server and forgot the writer.
    expect(namesOf(host.calls, "add")).toEqual(BOTH_KEYS);
    expect(namesOf(host.calls, "remove")).toEqual(BOTH_KEYS);
    // …and the two adds carry the two DIFFERENT entries, so registering the
    // full payload under both names is not a way to satisfy the line above.
    const writerAdd = host.calls.find((c) => c[1] === "add" && c[2] === OSB_KEY_WRITER)!;
    const fullAdd = host.calls.find((c) => c[1] === "add" && c[2] === OSB_KEY_FULL)!;
    expect(writerAdd).toContain("--writer-only");
    expect(fullAdd).not.toContain("--writer-only");
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

/**
 * A host whose `copilot` binary is present and reports `registered`.
 *
 * `verify` reads the host through the DECLARED probe
 * (`RUNTIME_FACTS[copilot-cli].hostProbe`) rather than through
 * `CopilotRunner`, so a case that wants the host to answer stages it
 * here; `CopilotRunner` still stages `mcp add` / `mcp remove` / the
 * presence check that decides which path apply takes.
 */
function stageProbe(registered: ReadonlyArray<string>): void {
  setHostProbeRunner({
    available: () => true,
    run: () => ({ exitCode: 0, stdout: registered.join("\n") + "\n", stderr: "" }),
  });
}

/** The probe answering from what `host` was actually told to register. */
function stageProbeFrom(host: { registered: () => ReadonlyArray<string> }): void {
  setHostProbeRunner({
    available: () => true,
    run: () => ({ exitCode: 0, stdout: host.registered().join("\n") + "\n", stderr: "" }),
  });
}

describe("copilot-cli adapter — verify", () => {
  test("verify ok when CLI lists both names", () => {
    // The host answers with the registrations THIS apply made, so an apply
    // that skipped one reaches `verify` as the drift it is. Handing the
    // probe a fixed pair of names instead verified the fixture.
    const host = fakeCopilotHost();
    setCopilotRunner(host.runner);
    const p = payload();
    copilotCliAdapter.apply(copilotCliAdapter.plan(p, env()), p, env(), applyOpts());
    stageProbeFrom(host);
    expect([...host.registered()].toSorted()).toEqual(BOTH_KEYS);
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
    stageProbe(["open-second-brain"]);
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

  test("a subprocess install whose host binary is gone reports the named skip, not ok", () => {
    // The subprocess mode leaves no file behind, so the host CLI is the
    // only record of the registration. Losing it means nothing is
    // verified - and the operator is told WHICH obstacle was hit.
    const runner: CopilotRunner = {
      available: () => true,
      run: () => ({ exitCode: 0, stdout: "", stderr: "" }),
      list: () => ({ ok: true, names: ["open-second-brain", "open-second-brain-writer"] }),
    };
    setCopilotRunner(runner);
    const p = payload();
    copilotCliAdapter.apply(copilotCliAdapter.plan(p, env()), p, env(), applyOpts());
    setHostProbeRunner({
      available: () => false,
      run: () => {
        throw new Error("the probe must not spawn a binary it just reported absent");
      },
    });
    const v = copilotCliAdapter.verify(env());
    expect(v.status).toBe("mcp-unreachable");
    expect(v.details.join("\n")).toContain("not on PATH");
    expect(v.fix_hint ?? "").toContain("PATH");
  });

  test("a host that refuses the probe names the exit code, not a bare failure", () => {
    const runner: CopilotRunner = {
      available: () => true,
      run: () => ({ exitCode: 0, stdout: "", stderr: "" }),
      list: () => ({ ok: true, names: ["open-second-brain", "open-second-brain-writer"] }),
    };
    setCopilotRunner(runner);
    const p = payload();
    copilotCliAdapter.apply(copilotCliAdapter.plan(p, env()), p, env(), applyOpts());
    setHostProbeRunner({
      available: () => true,
      run: () => ({ exitCode: 4, stdout: "", stderr: "not authenticated\n" }),
    });
    const v = copilotCliAdapter.verify(env());
    expect(v.status).toBe("mcp-unreachable");
    expect(v.details.join("\n")).toContain("exited 4: not authenticated");
  });
});

describe("copilot-cli adapter — uninstall", () => {
  test("uninstall via CLI removes both names", () => {
    const host = fakeCopilotHost();
    setCopilotRunner(host.runner);
    const p = payload();
    copilotCliAdapter.apply(copilotCliAdapter.plan(p, env()), p, env(), applyOpts());
    host.calls.length = 0;
    copilotCliAdapter.uninstall(env(), applyOpts());
    // Two removals of the FULL server is also "two remove calls", and it
    // leaves the writer registered on the host forever.
    expect(namesOf(host.calls, "remove")).toEqual(BOTH_KEYS);
    expect([...host.registered()]).toEqual([]);
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

/**
 * The other half of the shared refuting-probe rule.
 *
 * `probeRefutedVerdict` splits one probe answer into two verdicts, and
 * this adapter's subprocess mode is the only place in the tree where the
 * `artifactMatches: false` half is reachable: `copilot mcp add` leaves no
 * file, so the host's own registry IS the record and a host that answers
 * without our servers has lost the registration rather than failed to
 * reload it. The `artifactMatches: true` half - config right, host stale -
 * is driven for every probe-bearing target in
 * `tests/core/install/friction.test.ts`.
 */
describe("a refuting probe means different things in the two modes", () => {
  function subprocessCapable(): CopilotRunner {
    return {
      available: () => true,
      run: () => ({ exitCode: 0, stdout: "", stderr: "" }),
      list: () => ({ ok: true, names: ["open-second-brain", "open-second-brain-writer"] }),
    };
  }

  test("subprocess mode: the host is the record, so an empty answer is drift", () => {
    setCopilotRunner(subprocessCapable());
    const p = payload();
    copilotCliAdapter.apply(copilotCliAdapter.plan(p, env()), p, env(), applyOpts());
    stageProbe([]);
    const v = copilotCliAdapter.verify(env());
    expect(v.status).toBe("drift");
    // Re-applying is the repair, because there is nothing on disk that is
    // already correct for a restart to pick up.
    expect(v.fix_hint ?? "").toContain("--apply");
    expect(v.fix_hint ?? "").not.toContain("restart");
  });

  test("file mode: the file is the record and it matches, so it is unreachable", () => {
    const absent: CopilotRunner = {
      available: () => false,
      run: () => ({ exitCode: 1, stdout: "", stderr: "" }),
      list: () => ({ ok: false, names: [] }),
    };
    setCopilotRunner(absent);
    const p = payload();
    copilotCliAdapter.apply(copilotCliAdapter.plan(p, env()), p, env(), applyOpts());
    stageProbe([]);
    const v = copilotCliAdapter.verify(env());
    expect(v.status).toBe("mcp-unreachable");
    expect(v.fix_hint ?? "").toContain("restart");
  });
});

describe("uninstall does not forget an install it failed to remove", () => {
  test("a `copilot mcp remove` that fails leaves the entry, so the retry works", () => {
    setCopilotRunner({
      available: () => true,
      run: () => ({ exitCode: 0, stdout: "", stderr: "" }),
      list: () => ({ ok: true, names: ["open-second-brain", "open-second-brain-writer"] }),
    });
    const p = payload();
    copilotCliAdapter.apply(copilotCliAdapter.plan(p, env()), p, env(), applyOpts());
    expect(readManifest(vault).installs["copilot-cli"]).toBeDefined();

    setCopilotRunner({
      available: () => true,
      run: () => ({ exitCode: 5, stdout: "", stderr: "copilot refused the remove" }),
      list: () => ({ ok: true, names: ["open-second-brain", "open-second-brain-writer"] }),
    });
    const failed = copilotCliAdapter.uninstall(env(), { ...applyOpts(), fromSnippet: false });
    expect(failed.removed_keys).toEqual([]);
    expect(failed.skipped.length).toBe(2);
    // Kept, so the retry below is not `manifest-missing`.
    expect(readManifest(vault).installs["copilot-cli"]).toBeDefined();

    setCopilotRunner({
      available: () => true,
      run: () => ({ exitCode: 0, stdout: "", stderr: "" }),
      list: () => ({ ok: true, names: [] }),
    });
    const retry = copilotCliAdapter.uninstall(env(), { ...applyOpts(), fromSnippet: false });
    expect(retry.removed_keys.length).toBe(2);
    expect(readManifest(vault).installs["copilot-cli"]).toBeUndefined();
  });

  test("an unchanged fallback file is a completed uninstall, not a failure", () => {
    // A skip is not a failure: there was nothing left to remove. Guarding
    // the manifest drop on `skipped.length === 0` - the shape grok uses,
    // where every skip IS a failure - would make this manifest entry
    // unclearable.
    const absent: CopilotRunner = {
      available: () => false,
      run: () => ({ exitCode: 1, stdout: "", stderr: "" }),
      list: () => ({ ok: false, names: [] }),
    };
    setCopilotRunner(absent);
    const p = payload();
    copilotCliAdapter.apply(copilotCliAdapter.plan(p, env()), p, env(), applyOpts());
    copilotCliAdapter.uninstall(env(), { ...applyOpts(), fromSnippet: false });
    expect(readManifest(vault).installs["copilot-cli"]).toBeUndefined();

    // Second pass: the file no longer carries the keys.
    setCopilotRunner(absent);
    const again = copilotCliAdapter.uninstall(env(), { ...applyOpts(), fromSnippet: true });
    expect(again.skipped.length).toBe(1);
    expect(readManifest(vault).installs["copilot-cli"]).toBeUndefined();
  });
});

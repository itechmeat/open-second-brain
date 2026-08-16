/**
 * The host probe: what it parses, which machine it asks, and what it does
 * when the host does not answer.
 *
 * Three properties, each of which was previously either untested or tested
 * only against strings the tests themselves authored:
 *
 *   1. The parser is driven by a REAL capture. Every case for
 *      `registeredNames` used to invent its own `mcp list` output, so the
 *      parser was only ever held against the format the test author
 *      believed in. Real `codex mcp list` prints a padded table WITH a
 *      header row, which no authored fixture had.
 *   2. The probe asks the host named by the `InstallEnv`, not the ambient
 *      one. `codex.ts` declares "the Codex home is injected, never
 *      ambient" for its mutation runner; the probe seam took no
 *      environment at all, so `verify` on a relocated `CODEX_HOME`
 *      described one machine in its file half and another in its
 *      handshake half.
 *   3. The wait is bounded. An unauthenticated host that blocks on a
 *      network call or a prompt used to hang `o2b install --check` with no
 *      message and no way out.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createHostProbeRunner,
  hostProbeEnvironment,
  HOST_PROBE_RESULT,
  HOST_PROBE_TIMEOUT_MS,
  probeHost,
  resetHostProbeRunner,
  setHostProbeRunner,
  type HostProbeEnvironment,
  type HostProbeRunResult,
} from "../../../src/core/install/host-probe.ts";
import { OSB_KEY_FULL, OSB_KEY_WRITER } from "../../../src/core/install/json-merge.ts";
import type { InstallEnv } from "../../../src/core/install/types.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** The capture committed at `tests/fixtures/install/codex-mcp-list.txt`. */
function realCodexListing(): string {
  return readFileSync(
    join(REPO_ROOT, "tests", "fixtures", "install", "codex-mcp-list.txt"),
    "utf8",
  );
}

function envFor(extra: Readonly<Record<string, string>> = {}): InstallEnv {
  return {
    vault: "/srv/vaults/example",
    home: "/home/operator",
    cwd: "/srv/projects/example",
    env: { PATH: "/usr/bin", ...extra },
    now: new Date("2026-08-16T09:00:00.000Z"),
  };
}

afterEach(() => {
  resetHostProbeRunner();
});

describe("the parser is held against real host output", () => {
  test("the committed capture is the real shape: a padded table with a header", () => {
    // A fixture that had been reduced to one bare name would make every
    // assertion below pass for a parser that cannot read a table at all.
    const lines = realCodexListing().trimEnd().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]!.split(/\s+/)[0]).toBe("Name");
    expect(lines[0]).toContain("Status");
    expect(lines[1]).toContain("enabled");
  });

  test("it reports the one OSB server this machine had registered", () => {
    setHostProbeRunner({
      available: () => true,
      run: () => ({ exitCode: 0, stdout: realCodexListing(), stderr: "" }),
    });
    const outcome = probeHost("codex", envFor());
    expect(outcome.kind).toBe(HOST_PROBE_RESULT.answered);
    if (outcome.kind !== HOST_PROBE_RESULT.answered) throw new Error("unreachable");
    expect(outcome.registered).toEqual([OSB_KEY_FULL]);
    expect(outcome.missing).toEqual([OSB_KEY_WRITER]);
  });

  test("the header row cannot become a registered server", () => {
    // `registeredNames` deliberately does NOT skip the header: recognising
    // each host's header would be a per-host grammar to keep up with. It
    // is safe by construction instead - the answer is an intersection with
    // two fixed names, and no host prints a column called
    // `open-second-brain`. This is the assertion that says so out loud.
    setHostProbeRunner({
      available: () => true,
      run: () => ({ exitCode: 0, stdout: realCodexListing(), stderr: "" }),
    });
    const outcome = probeHost("codex", envFor());
    if (outcome.kind !== HOST_PROBE_RESULT.answered) throw new Error("unreachable");
    for (const name of [...outcome.registered, ...outcome.missing]) {
      expect([OSB_KEY_FULL, OSB_KEY_WRITER]).toContain(name);
    }
  });

  test("a host with both registered under the same table shape answers clean", () => {
    const both =
      realCodexListing().trimEnd() +
      "\nopen-second-brain-writer  o2b  mcp  -  -  enabled  Unsupported\n";
    setHostProbeRunner({
      available: () => true,
      run: () => ({ exitCode: 0, stdout: both, stderr: "" }),
    });
    const outcome = probeHost("codex", envFor());
    if (outcome.kind !== HOST_PROBE_RESULT.answered) throw new Error("unreachable");
    expect(outcome.missing).toEqual([]);
  });
});

describe("the probe asks the host being verified", () => {
  /** A runner that records the environment it was handed. */
  function recordingRunner(seen: { env: HostProbeEnvironment | null; bin: string | null }) {
    return {
      available(bin: string, env: HostProbeEnvironment): boolean {
        seen.bin = bin;
        seen.env = env;
        return true;
      },
      run(
        _bin: string,
        _argv: ReadonlyArray<string>,
        env: HostProbeEnvironment,
      ): HostProbeRunResult {
        seen.env = env;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
  }

  test("HOME is the injected home, not the ambient one", () => {
    const seen: { env: HostProbeEnvironment | null; bin: string | null } = { env: null, bin: null };
    setHostProbeRunner(recordingRunner(seen));
    probeHost("codex", envFor());
    expect(seen.bin).toBe("codex");
    expect(seen.env?.["HOME"]).toBe("/home/operator");
  });

  test("a relocated CODEX_HOME reaches the subprocess", () => {
    // The measured defect: applying codex into an isolated `CODEX_HOME`
    // and calling `verify` ran `codex mcp list` with `CODEX_HOME` unset,
    // so the handshake described the operator's real `~/.codex` while the
    // file comparison described the temporary one.
    const seen: { env: HostProbeEnvironment | null; bin: string | null } = { env: null, bin: null };
    setHostProbeRunner(recordingRunner(seen));
    probeHost("codex", envFor({ CODEX_HOME: "/mnt/elsewhere/codex" }));
    expect(seen.env?.["CODEX_HOME"]).toBe("/mnt/elsewhere/codex");
  });

  test("the environment is derived from the InstallEnv alone", () => {
    const env = envFor({ XDG_CONFIG_HOME: "/mnt/cfg" });
    expect(hostProbeEnvironment(env)).toEqual({
      PATH: "/usr/bin",
      XDG_CONFIG_HOME: "/mnt/cfg",
      HOME: "/home/operator",
    });
  });
});

describe("the wait is bounded", () => {
  test("the shipped cap is a positive number of milliseconds", () => {
    expect(Number.isSafeInteger(HOST_PROBE_TIMEOUT_MS)).toBe(true);
    expect(HOST_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
  });

  test("a host that never answers is killed and reported, not waited on", () => {
    // Driven against `sleep`, which stands in for the real obstacle: a
    // host CLI blocking on a network call or an interactive
    // authentication prompt. Without the cap this call never returns.
    const sleep = Bun.which("sleep");
    expect(sleep === null ? "sleep is on PATH: false" : "sleep is on PATH: true").toBe(
      "sleep is on PATH: true",
    );
    const runner = createHostProbeRunner(200);
    const started = Date.now();
    const result = runner.run("sleep", ["30"], { PATH: process.env["PATH"] ?? "/usr/bin" });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(10_000);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("200 ms");
  });

  test("a killed probe becomes a named skip, never an assumed answer", () => {
    setHostProbeRunner({
      available: () => true,
      run: () => ({
        exitCode: 1,
        stdout: "",
        stderr: `killed by SIGTERM; the probe is capped at ${HOST_PROBE_TIMEOUT_MS} ms`,
      }),
    });
    const outcome = probeHost("codex", envFor());
    expect(outcome.kind).toBe(HOST_PROBE_RESULT.probeFailed);
    if (outcome.kind !== HOST_PROBE_RESULT.probeFailed) throw new Error("unreachable");
    expect(outcome.reason).toContain("SIGTERM");
  });
});

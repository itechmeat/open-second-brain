/**
 * `o2b init --interactive` — wizard tests.
 *
 * The wizard composes existing commands via an injected runner; we
 * verify the command sequence under scripted user input.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import {
  runWizard,
  type WizardOpts,
  type WizardReader,
  type WizardRunner,
} from "../../src/cli/install/init-interactive.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "osb-wizard-h-"));
});
afterEach(() => {
  try { rmSync(home, { recursive: true, force: true }); } catch {}
});

function scriptedReader(answers: string[]): WizardReader {
  let i = 0;
  return {
    async read() {
      if (i >= answers.length) return null;
      const a = answers[i]!;
      i += 1;
      return a;
    },
  };
}

function silentStreams() {
  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];
  const stdout = new Writable({
    write(chunk, _e, cb) { stdoutBuf.push(chunk.toString()); cb(); },
  });
  const stderr = new Writable({
    write(chunk, _e, cb) { stderrBuf.push(chunk.toString()); cb(); },
  });
  return {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdoutBuf,
    stderrBuf,
  };
}

function recordingRunner(): { runner: WizardRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: WizardRunner = async (cmd) => {
    calls.push([...cmd]);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

describe("init wizard", () => {
  test("happy path: confirm yes runs init + brain init + per-target installs", async () => {
    const vaultPath = join(home, "vault");
    // ensure no candidate vault directory exists, so prompt 1 needs explicit path
    const answers = [
      vaultPath,        // vault path
      "claude-vps",     // agent name
      "UTC",            // timezone
      "en",             // language
      "1,2",            // pick targets 1 and 2 (whichever they are)
      "y",              // brain init
      "n",              // starter
      "yes",            // confirm
    ];
    const { runner, calls } = recordingRunner();
    const { stdout, stderr } = silentStreams();
    const opts: WizardOpts = {
      reader: scriptedReader(answers), stdout, stderr, runner,
    };
    const r = await runWizard(opts);
    expect(r.exitCode).toBe(0);
    const argv0s = calls.map((c) => c[0]);
    expect(argv0s).toContain("init");
    expect(argv0s).toContain("brain");
    expect(argv0s).toContain("install");
    // First call must be `o2b init --vault ... --agent-name ... --timezone ...`
    const initCall = calls.find((c) => c[0] === "init")!;
    expect(initCall).toContain("--vault");
    expect(initCall).toContain("--agent-name");
    expect(initCall).toContain("--timezone");
    expect(initCall).toContain("claude-vps");
    expect(initCall).toContain("UTC");
    // Final call must be `o2b install --check`
    expect(calls[calls.length - 1]).toEqual(["install", "--check"]);
    // At least one pre-check call must be a per-target install with --apply.
    // The scripted answer "1,2" selects targets 1 and 2 in the detected list;
    // both should yield `o2b install --target <name> --apply` invocations.
    const perTargetApplies = calls
      .slice(0, -1)
      .filter((c) => c[0] === "install" && c.includes("--apply") && c.includes("--target"));
    expect(perTargetApplies.length).toBe(2);
    for (const c of perTargetApplies) {
      const tIdx = c.indexOf("--target");
      // --target must be followed by a non-flag target name
      expect(c[tIdx + 1]).toBeDefined();
      expect((c[tIdx + 1] ?? "").startsWith("--")).toBe(false);
    }
  });

  test("'no' at confirmation runs nothing", async () => {
    const vaultPath = join(home, "vault");
    const answers = [
      vaultPath, "claude-vps", "UTC", "en",
      "none",   // no targets
      "n",      // no brain init
      "no",     // do not confirm
    ];
    const { runner, calls } = recordingRunner();
    const { stdout, stderr } = silentStreams();
    const opts: WizardOpts = {
      reader: scriptedReader(answers), stdout, stderr, runner,
    };
    const r = await runWizard(opts);
    expect(r.exitCode).toBe(0);
    expect(calls.length).toBe(0);
  });

  test("invalid tz prompts for retry until valid", async () => {
    const vaultPath = join(home, "vault");
    const answers = [
      vaultPath,
      "claude-vps",
      "Mars/Cydonia",   // invalid IANA
      "Europe/Belgrade", // valid retry
      "en",
      "none",
      "n",
      "no",
    ];
    const { runner, calls } = recordingRunner();
    const { stdout, stderr, stdoutBuf } = silentStreams();
    const opts: WizardOpts = {
      reader: scriptedReader(answers), stdout, stderr, runner,
    };
    const r = await runWizard(opts);
    expect(r.exitCode).toBe(0);
    expect(stdoutBuf.join("")).toContain("invalid IANA");
    expect(calls.length).toBe(0);
  });

  test("brain init with starter adds --starter flag", async () => {
    const vaultPath = join(home, "vault");
    const answers = [
      vaultPath, "claude-vps", "UTC", "en",
      "none", "y", "y", "yes",
    ];
    const { runner, calls } = recordingRunner();
    const { stdout, stderr } = silentStreams();
    const opts: WizardOpts = {
      reader: scriptedReader(answers), stdout, stderr, runner,
    };
    const r = await runWizard(opts);
    expect(r.exitCode).toBe(0);
    const brainCall = calls.find((c) => c[0] === "brain" && c[1] === "init")!;
    expect(brainCall).toContain("--starter");
  });

  test("runner failure surfaces non-zero exit code", async () => {
    const vaultPath = join(home, "vault");
    const answers = [vaultPath, "claude-vps", "UTC", "en", "none", "n", "yes"];
    const runner: WizardRunner = async () => ({ exitCode: 1, stdout: "", stderr: "init failed" });
    const { stdout, stderr } = silentStreams();
    const opts: WizardOpts = {
      reader: scriptedReader(answers), stdout, stderr, runner,
    };
    const r = await runWizard(opts);
    expect(r.exitCode).toBe(1);
  });
});

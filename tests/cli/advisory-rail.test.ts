/**
 * Tests for src/cli/advisory-rail.ts - the single emission point for
 * forward-pointer lines (no-dead-ends, task 2).
 *
 * The rail owns two decisions and both are pinned here: WHAT to say (a
 * payload resolved by code from the diagnostics registry, never a
 * caller-supplied sentence) and WHETHER it is legal to say it on the
 * current stream (a command that renders its own JSON must not receive
 * advisory chrome on stdout; an envelope-wrapped command may, because the
 * envelope buffers).
 *
 * `wantsJsonFlag` is tested alongside because the rail's legality question
 * is the reason its raw-argv scan had to become grammar-faithful.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ADVISORY_OUTCOME,
  advisoryIsLegal,
  type AdvisoryEmission,
  emitNextStep,
  emitNextSteps,
  renderNextStepLine,
} from "../../src/cli/advisory-rail.ts";
import {
  COMMANDS_WITH_INTERNAL_JSON,
  ownsInternalJson,
  wantsJsonFlag,
  withJsonFallback,
} from "../../src/cli/json-helpers.ts";
import { parseFlags } from "../../src/cli/argparse.ts";
import { writeJson } from "../../src/cli/output.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { DIAGNOSTIC_SIGNALS } from "../../src/core/brain/diagnostics.ts";
import { runCli } from "../helpers/run-cli.ts";

/** A code the registry carries, with a multi-flag structural command. */
const REGISTERED_CODE = "wal-gap";
const REGISTERED_COMMAND = DIAGNOSTIC_SIGNALS.get(REGISTERED_CODE)!.nextCommand;

/** Capture everything written to stdout while `run` executes. */
async function captureStdout(run: () => Promise<void> | void): Promise<string> {
  let captured = "";
  const real = process.stdout.write;
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
    const cb = rest[rest.length - 1];
    if (typeof cb === "function") (cb as () => void)();
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = real;
  }
  return captured;
}

describe("advisory rail - what to say", () => {
  test("a human-path emission renders the structural command", async () => {
    let result: AdvisoryEmission | undefined;
    const out = await captureStdout(() => {
      result = emitNextStep(REGISTERED_CODE, {
        command: "brain",
        argv: ["doctor"],
        jsonRequested: false,
      });
    });
    expect(out).toBe(`next: ${REGISTERED_COMMAND}\n`);
    expect(result).toEqual({
      code: REGISTERED_CODE,
      outcome: ADVISORY_OUTCOME.emitted,
      nextStep: {
        code: REGISTERED_CODE,
        issueClass: DIAGNOSTIC_SIGNALS.get(REGISTERED_CODE)!.issueClass,
        nextCommand: REGISTERED_COMMAND,
      },
      line: `next: ${REGISTERED_COMMAND}`,
    });
  });

  test("the rendered line is the label plus the registered command, nothing else", () => {
    for (const signal of DIAGNOSTIC_SIGNALS.values()) {
      expect(
        renderNextStepLine({
          code: signal.code,
          issueClass: signal.issueClass,
          nextCommand: signal.nextCommand,
        }),
      ).toBe(`next: ${signal.nextCommand}`);
    }
  });

  test("an unregistered code emits nothing and reports the absence by name", async () => {
    let result: AdvisoryEmission | undefined;
    const out = await captureStdout(() => {
      result = emitNextStep("no-such-diagnostic-code", {
        command: "brain",
        argv: ["doctor"],
        jsonRequested: false,
      });
    });
    expect(out).toBe("");
    expect(result).toEqual({
      code: "no-such-diagnostic-code",
      outcome: ADVISORY_OUTCOME.unregisteredCode,
      nextStep: null,
      line: null,
    });
  });

  test("a sentence passed where a code belongs resolves to nothing, never to itself", async () => {
    let result: AdvisoryEmission | undefined;
    const out = await captureStdout(() => {
      result = emitNextStep("Run o2b brain doctor to repair this.", {
        command: "brain",
        argv: [],
        jsonRequested: false,
      });
    });
    expect(out).toBe("");
    expect(result!.outcome).toBe(ADVISORY_OUTCOME.unregisteredCode);
    expect(result!.line).toBeNull();
  });
});

describe("advisory rail - whether it is legal here", () => {
  test("a command that renders its own JSON gets no stdout contamination", async () => {
    let result: AdvisoryEmission | undefined;
    const out = await captureStdout(() => {
      writeJson({ ok: true, issues: [] });
      result = emitNextStep(REGISTERED_CODE, {
        command: "brain",
        argv: ["doctor", "--json"],
        jsonRequested: true,
      });
    });
    expect(out).toBe(`${JSON.stringify({ ok: true, issues: [] }, undefined, 2)}\n`);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(result!.outcome).toBe(ADVISORY_OUTCOME.suppressedMachineStream);
    expect(result!.line).toBeNull();
    // The payload is still resolved, so the verb can carry it as a field.
    expect(result!.nextStep!.nextCommand).toBe(REGISTERED_COMMAND);
  });

  test("the same command on the human path is not suppressed", () => {
    expect(advisoryIsLegal({ command: "brain", argv: ["doctor"], jsonRequested: false })).toBe(
      true,
    );
    expect(
      advisoryIsLegal({ command: "brain", argv: ["doctor", "--json"], jsonRequested: true }),
    ).toBe(false);
  });

  test("an envelope-wrapped command may emit: the envelope buffers the line", async () => {
    const stream = { command: "completions", argv: ["bash", "--json"], jsonRequested: true };
    expect(advisoryIsLegal(stream)).toBe(true);

    const out = await captureStdout(async () => {
      await withJsonFallback("completions", async () => {
        writeJson({ shell: "bash" });
        emitNextStep(REGISTERED_CODE, stream);
        return 0;
      });
    });
    const envelope = JSON.parse(out) as { ok: boolean; command: string; stdout: string };
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe("completions");
    expect(envelope.stdout).toContain(`next: ${REGISTERED_COMMAND}\n`);
  });

  test("mcp --probe and help are internal-JSON even though the set omits them", () => {
    expect(COMMANDS_WITH_INTERNAL_JSON.has("mcp")).toBe(false);
    expect(COMMANDS_WITH_INTERNAL_JSON.has("help")).toBe(false);
    expect(ownsInternalJson("mcp", ["--probe", "--json"])).toBe(true);
    expect(ownsInternalJson("mcp", ["--json"])).toBe(false);
    expect(ownsInternalJson("help", ["--json"])).toBe(true);
    expect(advisoryIsLegal({ command: "mcp", argv: ["--probe"], jsonRequested: true })).toBe(false);
  });

  test("every command owning an internal JSON branch is refused advisory chrome", () => {
    for (const command of COMMANDS_WITH_INTERNAL_JSON) {
      expect(`${command}: ${ownsInternalJson(command, ["--json"])}`).toBe(`${command}: true`);
      expect(`${command}: ${advisoryIsLegal({ command, argv: [], jsonRequested: true })}`).toBe(
        `${command}: false`,
      );
      expect(`${command}: ${advisoryIsLegal({ command, argv: [], jsonRequested: false })}`).toBe(
        `${command}: true`,
      );
    }
  });
});

describe("advisory rail - the batch form (no-dead-ends, task 4)", () => {
  const HUMAN = { command: "brain", argv: ["doctor"], jsonRequested: false };

  test("codes sharing one command print that command once", async () => {
    // `broken-wikilink` and `dangling-workrun` are distinct issue
    // classes with one repair verb between them.
    const shared = DIAGNOSTIC_SIGNALS.get("broken-wikilink")!.nextCommand;
    expect(DIAGNOSTIC_SIGNALS.get("dangling-workrun")!.nextCommand).toBe(shared);
    let emissions: ReadonlyArray<AdvisoryEmission> = [];
    const out = await captureStdout(() => {
      emissions = emitNextSteps(
        ["broken-wikilink", "dangling-workrun", "broken-wikilink", "broken-backlinks"],
        HUMAN,
      );
    });
    const backlinks = DIAGNOSTIC_SIGNALS.get("broken-backlinks")!.nextCommand;
    expect(out).toBe(`next: ${shared}\nnext: ${backlinks}\n`);
    expect(emissions.map((e) => e.outcome)).toEqual([
      ADVISORY_OUTCOME.emitted,
      ADVISORY_OUTCOME.emitted,
    ]);
  });

  test("an unregistered code is reported once by name and never printed", async () => {
    let emissions: ReadonlyArray<AdvisoryEmission> = [];
    const out = await captureStdout(() => {
      emissions = emitNextSteps(
        ["no-such-diagnostic-code", "no-such-diagnostic-code", REGISTERED_CODE],
        HUMAN,
      );
    });
    expect(out).toBe(`next: ${REGISTERED_COMMAND}\n`);
    expect(emissions.map((e) => e.outcome)).toEqual([
      ADVISORY_OUTCOME.unregisteredCode,
      ADVISORY_OUTCOME.emitted,
    ]);
    // "by name" is the whole point of returning an unregistered code at
    // all: a caller batching codes must be able to say WHICH of its
    // issues has no exit. Asserting only the outcome would let the
    // record stop carrying the name without any test noticing.
    expect(emissions.map((e) => e.code)).toEqual(["no-such-diagnostic-code", REGISTERED_CODE]);
  });

  test("no codes means no lines and no emissions", async () => {
    let emissions: ReadonlyArray<AdvisoryEmission> = [];
    const out = await captureStdout(() => {
      emissions = emitNextSteps([], HUMAN);
    });
    expect(out).toBe("");
    expect(emissions).toEqual([]);
  });

  test("a machine stream still resolves every distinct step, silently", async () => {
    let emissions: ReadonlyArray<AdvisoryEmission> = [];
    const out = await captureStdout(() => {
      emissions = emitNextSteps([REGISTERED_CODE, REGISTERED_CODE], {
        command: "brain",
        argv: ["doctor", "--json"],
        jsonRequested: true,
      });
    });
    expect(out).toBe("");
    expect(emissions).toHaveLength(1);
    expect(emissions[0]!.outcome).toBe(ADVISORY_OUTCOME.suppressedMachineStream);
    expect(emissions[0]!.nextStep!.nextCommand).toBe(REGISTERED_COMMAND);
  });
});

describe("wantsJsonFlag - a flag, not a positional value", () => {
  test("the flag in its own token is still a JSON request", () => {
    expect(wantsJsonFlag(["note", "hello", "--json"])).toBe(true);
    expect(wantsJsonFlag(["--json"])).toBe(true);
    expect(wantsJsonFlag(["list", "--json=pretty"])).toBe(true);
  });

  test("no flag at all is not a JSON request", () => {
    expect(wantsJsonFlag([])).toBe(false);
    expect(wantsJsonFlag(["note", "hello"])).toBe(false);
    expect(wantsJsonFlag(["note", "--jsonx"])).toBe(false);
  });

  test("a note whose text merely mentions the flag is not a JSON request", () => {
    expect(wantsJsonFlag(["note", "see --json for details"])).toBe(false);
  });

  test("after the argv terminator the flag is literal content", () => {
    expect(wantsJsonFlag(["note", "--", "--json"])).toBe(false);
    expect(wantsJsonFlag(["note", "--", "--json=pretty"])).toBe(false);
    expect(wantsJsonFlag(["note", "--json", "--", "--json"])).toBe(true);
  });

  test("a value-position flag stays a JSON request, and that is deliberate", () => {
    // `--principle --json` is the value of a string flag, but which flags
    // take a value is per-verb schema the two `main.ts` call sites do not
    // have. The scan errs toward the envelope (a buffered extra wrapper)
    // rather than toward silencing a human-path advisory, and `--` is the
    // documented way to make the token literal. Pinned so the limitation is
    // visible rather than discovered.
    expect(wantsJsonFlag(["feedback", "--principle", "--json"])).toBe(true);
    expect(wantsJsonFlag(["feedback", "--principle", "--", "--json"])).toBe(false);
  });

  test("the scan agrees with the parser it guards", () => {
    const shapes: ReadonlyArray<ReadonlyArray<string>> = [
      [],
      ["--json"],
      ["hello", "--json"],
      ["--", "--json"],
      ["note", "--", "--json"],
      ["see --json for details"],
    ];
    for (const argv of shapes) {
      const parsed = parseFlags(argv, {});
      expect(`${argv.join(" ")}: ${wantsJsonFlag(argv)}`).toBe(
        `${argv.join(" ")}: ${parsed.flags["json"] === true}`,
      );
    }
  });
});

describe("byte-identical when the rail is not called", () => {
  let tmp: string;
  let vault: string;
  let configPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "o2b-advisory-rail-"));
    vault = join(tmp, "vault");
    configPath = join(tmp, "config.yaml");
    writeFileSync(configPath, `vault: ${vault}\nagent_name: test-agent\n`);
    bootstrapBrain(vault, { configPath });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("a note mentioning the flag stays on the human path and prints its own line", async () => {
    const res = await runCli(["brain", "note", "see --json for details"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(res.returncode).toBe(0);
    expect(res.stdout).toMatch(/^logged note at Brain\/log\/\d{4}-\d{2}-\d{2}\.md\n$/);
    expect(res.stdout).not.toContain("next:");
  });

  test("the JSON envelope still wraps a command that does not own a JSON branch", async () => {
    const plain = await runCli(["completions", "bash"]);
    const wrapped = await runCli(["completions", "bash", "--json"]);
    expect(plain.returncode).toBe(0);
    expect(wrapped.returncode).toBe(0);
    expect(JSON.parse(wrapped.stdout)).toEqual({
      ok: true,
      command: "completions",
      code: 0,
      stdout: plain.stdout,
      stderr: "",
    });
    expect(plain.stdout).not.toContain("next:");
  });

  test("a command that owns its JSON branch is untouched", async () => {
    const res = await runCli(["help", "--json"]);
    expect(res.returncode).toBe(0);
    expect(() => JSON.parse(res.stdout)).not.toThrow();
    expect(res.stdout).not.toContain("next:");
  });
});

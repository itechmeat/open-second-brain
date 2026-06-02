/**
 * Capture-boundary matcher (Memory Integrity Suite, t_0532ed5a).
 *
 * Compiles the `sessions:` policy into a decision object: session ids
 * (and transcript paths) match anchored globs; message suppression is
 * regex; an invalid regex degrades to a warning and is skipped, never
 * thrown. Ignore outranks stateless. Machine-local config may ADD
 * patterns (comma-separated union) but never remove vault policy.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import {
  buildCaptureBoundary,
  compileCaptureBoundary,
} from "../../../src/core/brain/capture-boundary.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-capture-boundary-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-capture-boundary-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function appendBrainConfig(block: string): void {
  const path = brainConfigPath(vault);
  atomicWriteFileSync(path, readFileSync(path, "utf8") + "\n" + block + "\n");
}

describe("compileCaptureBoundary", () => {
  test("empty policy captures everything and suppresses nothing", () => {
    const b = compileCaptureBoundary({
      ignore_patterns: [],
      stateless_patterns: [],
      ignore_message_patterns: [],
    });
    expect(b.sessionDecision("any-session")).toBe("capture");
    expect(b.suppressMessage("any text")).toBe(false);
    expect(b.warnings).toEqual([]);
  });

  test("anchored glob semantics: *, ?, full-match only", () => {
    const b = compileCaptureBoundary({
      ignore_patterns: ["cron-*", "probe-?"],
      stateless_patterns: [],
      ignore_message_patterns: [],
    });
    expect(b.sessionDecision("cron-nightly")).toBe("ignore");
    expect(b.sessionDecision("a-cron-nightly")).toBe("capture"); // anchored
    expect(b.sessionDecision("probe-1")).toBe("ignore");
    expect(b.sessionDecision("probe-12")).toBe("capture"); // ? is one char
  });

  test("glob metacharacters from regex never leak", () => {
    const b = compileCaptureBoundary({
      ignore_patterns: ["a.b"],
      stateless_patterns: [],
      ignore_message_patterns: [],
    });
    expect(b.sessionDecision("a.b")).toBe("ignore");
    expect(b.sessionDecision("axb")).toBe("capture"); // dot is literal
  });

  test("ignore outranks stateless", () => {
    const b = compileCaptureBoundary({
      ignore_patterns: ["dual-*"],
      stateless_patterns: ["dual-*"],
      ignore_message_patterns: [],
    });
    expect(b.sessionDecision("dual-x")).toBe("ignore");
  });

  test("transcript path participates in session matching", () => {
    const b = compileCaptureBoundary({
      ignore_patterns: ["*side-channel*"],
      stateless_patterns: [],
      ignore_message_patterns: [],
    });
    expect(b.sessionDecision("sess-1", "/tmp/side-channel/sess-1.jsonl")).toBe("ignore");
    expect(b.sessionDecision("sess-1", "/tmp/main/sess-1.jsonl")).toBe("capture");
  });

  test("message suppression is regex", () => {
    const b = compileCaptureBoundary({
      ignore_patterns: [],
      stateless_patterns: [],
      ignore_message_patterns: ["^\\[heartbeat\\]", "ping{2,}"],
    });
    expect(b.suppressMessage("[heartbeat] still alive")).toBe(true);
    expect(b.suppressMessage("pingg")).toBe(true);
    expect(b.suppressMessage("normal message")).toBe(false);
  });

  test("an invalid message regex degrades to a warning and is skipped", () => {
    const b = compileCaptureBoundary({
      ignore_patterns: [],
      stateless_patterns: [],
      ignore_message_patterns: ["([unclosed", "^ok$"],
    });
    expect(b.warnings.length).toBe(1);
    expect(b.warnings[0]).toContain("([unclosed");
    expect(b.suppressMessage("ok")).toBe(true); // valid pattern still active
  });

  test("undefined session id only matches via transcript path", () => {
    const b = compileCaptureBoundary({
      ignore_patterns: ["cron-*"],
      stateless_patterns: [],
      ignore_message_patterns: [],
    });
    expect(b.sessionDecision(undefined)).toBe("capture");
    expect(b.sessionDecision(undefined, "cron-nightly")).toBe("ignore");
  });
});

describe("buildCaptureBoundary (vault + machine-local union)", () => {
  test("reads the vault sessions policy", () => {
    appendBrainConfig(["sessions:", "  ignore_patterns:", '    - "cron-*"'].join("\n"));
    const b = buildCaptureBoundary(vault, { localConfigPath: configPath });
    expect(b.sessionDecision("cron-x")).toBe("ignore");
  });

  test("machine-local comma-separated patterns union with vault policy", () => {
    appendBrainConfig(["sessions:", "  ignore_patterns:", '    - "cron-*"'].join("\n"));
    atomicWriteFileSync(
      configPath,
      `vault: ${vault}\nsessions_ignore_patterns: "local-*, scratch-?"\n`,
    );
    const b = buildCaptureBoundary(vault, { localConfigPath: configPath });
    expect(b.sessionDecision("cron-x")).toBe("ignore"); // vault policy intact
    expect(b.sessionDecision("local-y")).toBe("ignore"); // local addition
    expect(b.sessionDecision("scratch-1")).toBe("ignore");
  });

  test("a broken vault config fails soft to capture-everything", () => {
    atomicWriteFileSync(brainConfigPath(vault), "schema_version: [broken\n");
    const b = buildCaptureBoundary(vault, { localConfigPath: configPath });
    expect(b.sessionDecision("anything")).toBe("capture");
  });
});

describe("doctor invalid-capture-pattern lint", () => {
  test("an invalid message regex in the vault policy surfaces in doctor", async () => {
    appendBrainConfig(["sessions:", "  ignore_message_patterns:", '    - "([unclosed"'].join("\n"));
    const { runDoctor } = await import("../../../src/core/brain/doctor.ts");
    const hits = runDoctor(vault).warnings.filter((i) => i.code === "invalid-capture-pattern");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.message).toContain("([unclosed");
  });
});

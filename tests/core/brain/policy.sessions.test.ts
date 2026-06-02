/**
 * `sessions:` config block (Memory Integrity Suite, t_0532ed5a).
 *
 * Vault-portable capture-boundary policy: ignored session globs,
 * stateless session globs, and message suppression regexes. Absent
 * block resolves to empty lists - bit-identical capture behaviour.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import {
  BRAIN_SESSIONS_DEFAULTS,
  loadBrainConfigDetailed,
  resolveSessions,
} from "../../../src/core/brain/policy.ts";
import { brainConfigPath } from "../../../src/core/brain/paths.ts";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-policy-sessions-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-policy-sessions-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function appendConfig(block: string): void {
  // bootstrap wrote the canonical template; append our block.
  const path = brainConfigPath(vault);
  const text = readFileSync(path, "utf8");
  atomicWriteFileSync(path, text + "\n" + block + "\n");
}

describe("sessions block parsing", () => {
  test("absent block resolves to empty defaults", () => {
    const { config } = loadBrainConfigDetailed(vault);
    expect(config.sessions).toBeUndefined();
    const resolved = resolveSessions(config);
    expect(resolved).toEqual(BRAIN_SESSIONS_DEFAULTS);
    expect(resolved.ignore_patterns).toEqual([]);
    expect(resolved.stateless_patterns).toEqual([]);
    expect(resolved.ignore_message_patterns).toEqual([]);
  });

  test("parses all three lists", () => {
    appendConfig(
      [
        "sessions:",
        "  ignore_patterns:",
        '    - "cron-*"',
        '    - "*heartbeat*"',
        "  stateless_patterns:",
        '    - "probe-*"',
        "  ignore_message_patterns:",
        '    - "^[ping]"',
      ].join("\n"),
    );
    const { config } = loadBrainConfigDetailed(vault);
    const resolved = resolveSessions(config);
    expect(resolved.ignore_patterns).toEqual(["cron-*", "*heartbeat*"]);
    expect(resolved.stateless_patterns).toEqual(["probe-*"]);
    expect(resolved.ignore_message_patterns).toEqual(["^[ping]"]);
  });

  test("rejects a non-array value", () => {
    appendConfig(["sessions:", "  ignore_patterns: nope"].join("\n"));
    expect(() => loadBrainConfigDetailed(vault)).toThrow(/ignore_patterns/);
  });

  test("rejects empty-string entries", () => {
    appendConfig(["sessions:", "  ignore_patterns:", '    - ""'].join("\n"));
    expect(() => loadBrainConfigDetailed(vault)).toThrow(/ignore_patterns\[0\]/);
  });

  test("unknown sub-keys warn instead of failing (forward-compat)", () => {
    appendConfig(["sessions:", "  shiny_future_knob: 5"].join("\n"));
    const { warnings } = loadBrainConfigDetailed(vault);
    expect(warnings.some((w) => w.message.includes("shiny_future_knob"))).toBe(true);
  });
});

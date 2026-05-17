/**
 * Non-primary dream warning channel.
 *
 * Covers the §21 contract: when `Brain/_brain.yaml.primary_agent` is
 * set and the dream run is invoked from a different agent, the run
 * still completes but emits:
 *
 *   1. A structured warning entry on `DreamRunSummary.warnings`.
 *   2. A `non_primary_agent: <name>` payload row inside the `dream`
 *      log event for the run.
 *
 * Matching agents do NOT warn, and an unset primary (null) never
 * warns. The dream pass remains advisory, not enforcing — these tests
 * lock that contract.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { dream } from "../../src/core/brain/dream.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { setPrimaryAgent } from "../../src/core/brain/set-primary.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-brain-nonprim-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-brain-nonprim-cfg-"));
  configPath = join(configHome, "config.yaml");
  mkdirSync(configHome, { recursive: true });
  writeFileSync(configPath, `vault: "${vault}"\n`, "utf8");
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function seedSignals(): void {
  // Three same-sign signals so the planner crosses the default
  // candidate_threshold (3) and dream actually performs writes — the
  // path that emits the summary log event with the warning payload.
  const dirs = brainDirs(vault);
  for (const slug of ["a", "b", "c"]) {
    const id = `sig-2026-05-17-foo-${slug}`;
    writeFileSync(
      join(dirs.inbox, `${id}.md`),
      [
        "---",
        "kind: brain-signal",
        `id: ${id}`,
        "created_at: 2026-05-17T10:00:00Z",
        "tags: [brain, brain/signal, brain/topic/foo]",
        "topic: foo",
        "signal: positive",
        "agent: tester",
        "principle: foo bar",
        "---",
        "",
      ].join("\n"),
      "utf8",
    );
  }
}

function readTodayLog(): string {
  return readFileSync(join(brainDirs(vault).log, "2026-05-17.md"), "utf8");
}

const NOW = new Date("2026-05-17T11:00:00Z");

describe("dream — non-primary warning channel", () => {
  test("emits non-primary-dream-run warning when agent differs from primary", () => {
    setPrimaryAgent(vault, "hermes-vps");
    seedSignals();
    const r = dream(vault, { agentName: "claude-vps-agent", now: NOW });
    const codes = r.warnings.map((w) => w.code);
    expect(codes).toContain("non-primary-dream-run");
    const warn = r.warnings.find((w) => w.code === "non-primary-dream-run")!;
    expect(warn.message).toContain("claude-vps-agent");
    expect(warn.message).toContain("hermes-vps");
  });

  test("matching agent does NOT warn", () => {
    setPrimaryAgent(vault, "hermes-vps");
    seedSignals();
    const r = dream(vault, { agentName: "hermes-vps", now: NOW });
    expect(r.warnings.find((w) => w.code === "non-primary-dream-run"))
      .toBeUndefined();
  });

  test("primary_agent: null never warns regardless of caller agent", () => {
    // Default state after bootstrap is null.
    seedSignals();
    const r = dream(vault, { agentName: "anyone-at-all", now: NOW });
    expect(r.warnings).toEqual([]);
  });

  test("absent agentName option does not warn (back-compat)", () => {
    setPrimaryAgent(vault, "hermes-vps");
    seedSignals();
    const r = dream(vault, { now: NOW });
    expect(r.warnings).toEqual([]);
  });

  test("non_primary_agent payload row appears in the dream log event", () => {
    setPrimaryAgent(vault, "hermes-vps");
    seedSignals();
    dream(vault, { agentName: "claude-vps-agent", now: NOW });
    const log = readTodayLog();
    expect(log).toMatch(/^- non_primary_agent: claude-vps-agent$/m);
  });

  test("matching agent leaves the log without non_primary_agent row", () => {
    setPrimaryAgent(vault, "hermes-vps");
    seedSignals();
    dream(vault, { agentName: "hermes-vps", now: NOW });
    const log = readTodayLog();
    expect(log).not.toMatch(/^- non_primary_agent:/m);
  });

  test("warning fires even on a no-op run (no signals)", () => {
    setPrimaryAgent(vault, "hermes-vps");
    const r = dream(vault, { agentName: "claude-vps-agent", now: NOW });
    expect(r.changed).toBe(false);
    expect(r.warnings.map((w) => w.code)).toContain("non-primary-dream-run");
  });
});

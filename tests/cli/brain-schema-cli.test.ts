import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writePreference, type WritePreferenceInput } from "../../src/core/brain/preference.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import {
  BRAIN_CONFIDENCE,
  BRAIN_PREFERENCE_STATUS,
  BRAIN_SIGNAL_SIGN,
} from "../../src/core/brain/types.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-schema-cli-"));
  vault = join(tmp, "vault");
  for (const dir of ["preferences", "retired", "inbox", "inbox/processed", "log"]) {
    mkdirSync(join(vault, "Brain", dir), { recursive: true });
  }
  writeFileSync(
    join(vault, "Brain", "_brain.yaml"),
    [
      "schema_version: 1",
      "schema:",
      "  preference_types: [research, decision]",
      "  signal_types: [observation]",
    ].join("\n"),
    "utf8",
  );
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: tester\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

function basePref(
  slug: string,
  overrides: Partial<WritePreferenceInput> = {},
): WritePreferenceInput {
  return {
    slug,
    topic: "research",
    principle: `Principle for ${slug}`,
    created_at: "2026-05-30T12:00:00Z",
    unconfirmed_until: "2026-06-06T12:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [],
    confirmed_at: "2026-05-30T13:00:00Z",
    confidence: BRAIN_CONFIDENCE.low,
    pinned: false,
    ...overrides,
  };
}

function seedSchemaVault(): void {
  writePreference(
    vault,
    basePref("research-pref", {
      schema_type: "research",
    }),
  );
  writeSignal(vault, {
    topic: "research",
    signal: BRAIN_SIGNAL_SIGN.positive,
    agent: "tester",
    principle: "unknown signal schema type",
    created_at: "2026-05-30T12:00:00Z",
    date: "2026-05-30",
    slug: "external",
    schema_type: "external",
  });
}

describe("o2b brain schema", () => {
  test("--json prints the schema report", async () => {
    seedSchemaVault();

    const r = await runCli(["brain", "schema", "--json"], { env: env() });

    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      vocabulary: { preference_types: string[] };
      usage: { signal_types: Array<{ token: string; count: number }> };
      findings: Array<{ kind: string; token: string }>;
    };
    expect(payload.vocabulary.preference_types).toEqual(["preference", "research", "decision"]);
    expect(payload.usage.signal_types).toEqual([{ token: "external", count: 1 }]);
    expect(payload.findings).toContainEqual(
      expect.objectContaining({ kind: "unknown-token", token: "external" }),
    );
  });

  test("text output summarizes vocabulary, usage, and findings", async () => {
    seedSchemaVault();

    const r = await runCli(["brain", "schema"], { env: env() });

    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("brain schema");
    expect(r.stdout).toContain("preference_types: preference, research, decision");
    expect(r.stdout).toContain("signal_types usage: external x1");
    expect(r.stdout).toContain("[unknown-token] signal_types external");
    expect(r.stdout).toContain("[unused-declaration] preference_types decision");
  });

  test("management subcommands expose stats, lint, graph, explain, orphans, and sync", async () => {
    seedSchemaVault();

    const stats = await runCli(["brain", "schema", "stats", "--json"], {
      env: env(),
    });
    expect(stats.returncode).toBe(0);
    expect(JSON.parse(stats.stdout).declared.preference_types).toBe(2);

    const lint = await runCli(["brain", "schema", "lint", "--json"], {
      env: env(),
    });
    expect(lint.returncode).toBe(0);
    expect(JSON.parse(lint.stdout).findings.length).toBeGreaterThan(0);

    const graph = await runCli(["brain", "schema", "graph", "--json"], {
      env: env(),
    });
    expect(graph.returncode).toBe(0);
    expect(
      JSON.parse(graph.stdout).nodes.some((node: { id: string }) => node.id === "research"),
    ).toBe(true);

    const explain = await runCli(["brain", "schema", "explain", "research", "--json"], {
      env: env(),
    });
    expect(explain.returncode).toBe(0);
    expect(JSON.parse(explain.stdout).token).toBe("research");

    const orphans = await runCli(["brain", "schema", "orphans", "--json"], {
      env: env(),
    });
    expect(orphans.returncode).toBe(0);
    expect(JSON.parse(orphans.stdout).orphans.length).toBeGreaterThan(0);

    const sync = await runCli(["brain", "schema", "sync", "--dry-run", "--json"], { env: env() });
    expect(sync.returncode).toBe(0);
    expect(JSON.parse(sync.stdout).dry_run).toBe(true);
  });

  test("apply subcommand mutates the schema pack", async () => {
    const mutation = JSON.stringify({
      op: "add_type",
      category: "preference_types",
      token: "strategy",
    });

    const before = await runCli(["brain", "schema", "--json"], { env: env() });
    expect(JSON.parse(before.stdout).vocabulary.preference_types).not.toContain("strategy");

    const applied = await runCli(["brain", "schema", "apply", "--mutation", mutation, "--json"], {
      env: env(),
    });

    expect(applied.returncode).toBe(0);
    expect(JSON.parse(applied.stdout).applied).toBe(1);

    const report = await runCli(["brain", "schema", "--json"], { env: env() });
    expect(JSON.parse(report.stdout).vocabulary.preference_types).toContain("strategy");
  });

  test("rejects unknown schema subcommands", async () => {
    const result = await runCli(["brain", "schema", "reprot", "--json"], {
      env: env(),
    });

    expect(result.returncode).toBe(1);
    expect(result.stderr).toContain("unknown subcommand reprot");
  });
});

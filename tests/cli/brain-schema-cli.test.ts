import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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

  test("management subcommands expose stats, lint, graph, explain, and orphans", async () => {
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
  });

  test("sync refuses instead of reporting a backfill it never ran", async () => {
    const sync = await runCli(["brain", "schema", "sync", "--dry-run", "--json"], { env: env() });

    expect(sync.returncode).not.toBe(0);
    expect(sync.stderr).toContain("schema sync is not implemented");
    // The old stub printed a success report on stdout; nothing may now.
    expect(sync.stdout).toBe("");
  });

  test("sync still validates its flags before refusing", async () => {
    const sync = await runCli(["brain", "schema", "sync", "--batch-size", "0"], { env: env() });

    expect(sync.returncode).not.toBe(0);
    expect(sync.stderr).toContain("--batch-size must be a positive integer");
  });

  test("the report names the integrity of the pack it describes", async () => {
    seedSchemaVault();

    // No audited apply has happened in this vault, so the pack carries no
    // recorded expectation - which must not read as an intact one.
    const before = await runCli(["brain", "schema", "--json"], { env: env() });
    expect(before.returncode).toBe(0);
    const unsealed = JSON.parse(before.stdout) as {
      integrity: { status: string; unverified_reason?: string };
    };
    expect(unsealed.integrity.status).toBe("unverified");
    expect(unsealed.integrity.unverified_reason).toBe("no-apply-recorded");

    const mutation = JSON.stringify({
      op: "add_type",
      category: "preference_types",
      token: "strategy",
    });
    const applied = await runCli(["brain", "schema", "apply", "--mutation", mutation, "--json"], {
      env: env(),
    });
    expect(applied.returncode).toBe(0);

    const after = await runCli(["brain", "schema"], { env: env() });
    expect(after.returncode).toBe(0);
    expect(after.stdout).toContain("integrity: ok");
  });

  test("the report reports a hand-edited pack as modified with both digests", async () => {
    const mutation = JSON.stringify({
      op: "add_type",
      category: "preference_types",
      token: "strategy",
    });
    const applied = await runCli(["brain", "schema", "apply", "--mutation", mutation, "--json"], {
      env: env(),
    });
    expect(applied.returncode).toBe(0);
    const sealed = JSON.parse(applied.stdout) as { pack_digest: string };

    const brainConfig = join(vault, "Brain", "_brain.yaml");
    writeFileSync(
      brainConfig,
      readFileSync(brainConfig, "utf8").replace("    - strategy", "    - strategy\n    - tactic"),
      "utf8",
    );

    const report = await runCli(["brain", "schema"], { env: env() });

    expect(report.returncode).toBe(0);
    expect(report.stdout).toContain("integrity: modified");
    expect(report.stdout).toContain(`expected "${sealed.pack_digest}"`);
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

  test("apply --dry-run previews the resulting pack and writes nothing", async () => {
    const mutation = JSON.stringify({
      op: "add_type",
      category: "preference_types",
      token: "strategy",
    });
    const brainConfig = join(vault, "Brain", "_brain.yaml");
    // Stamped far in the past so any write during the preview moves the
    // modification time to now rather than staying within timestamp noise.
    const pastSeconds = Date.UTC(2020, 0, 1) / 1000;
    utimesSync(brainConfig, pastSeconds, pastSeconds);
    // Base64 so the later comparison is over raw bytes, not decoded text.
    const bytesBefore = readFileSync(brainConfig).toString("base64");
    const mtimeBefore = statSync(brainConfig).mtimeMs;

    const preview = await runCli(
      ["brain", "schema", "apply", "--mutation", mutation, "--dry-run", "--json"],
      { env: env() },
    );

    expect(preview.returncode).toBe(0);
    const payload = JSON.parse(preview.stdout) as {
      dry_run: boolean;
      would_apply: number;
      pack: { declarations: { preference_types: string[] } };
      diff: Array<{ path: string; before: string | null; after: string | null }>;
      audit_path?: string;
    };
    expect(payload.dry_run).toBe(true);
    expect(payload.would_apply).toBe(1);
    expect(payload.pack.declarations.preference_types).toContain("strategy");
    expect(payload.diff).toEqual([
      { path: "declarations.preference_types", before: null, after: "strategy" },
    ]);
    expect(payload.audit_path).toBeUndefined();

    expect(readFileSync(brainConfig).toString("base64")).toBe(bytesBefore);
    expect(statSync(brainConfig).mtimeMs).toBe(mtimeBefore);
    const report = await runCli(["brain", "schema", "--json"], { env: env() });
    expect(JSON.parse(report.stdout).vocabulary.preference_types).not.toContain("strategy");
  });

  test("rejects unknown schema subcommands", async () => {
    const result = await runCli(["brain", "schema", "reprot", "--json"], {
      env: env(),
    });

    expect(result.returncode).toBe(1);
    expect(result.stderr).toContain("unknown subcommand reprot");
  });
});

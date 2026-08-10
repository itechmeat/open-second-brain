import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
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

import {
  computeSchemaPackDigest,
  SCHEMA_MUTATION_AUDIT_ACTION,
  SCHEMA_MUTATION_AUDIT_DIR,
  SCHEMA_PACK_DIGEST_FIELD,
} from "../../../src/core/brain/schema-integrity.ts";
import {
  applySchemaMutations,
  previewSchemaMutations,
  type SchemaMutation,
} from "../../../src/core/brain/schema-mutate.ts";
import { loadSchemaPack } from "../../../src/core/brain/schema-pack.ts";

let vault: string;

/**
 * Epoch seconds stamped onto `_brain.yaml` before a preview, far enough in
 * the past that ANY write during the preview would move the modification
 * time to now. Without this the assertion would be satisfied by a coarse
 * filesystem timestamp rather than by the preview keeping its hands off.
 */
const PAST_MTIME_SECONDS = Date.UTC(2020, 0, 1) / 1000;

function configPathFor(root: string): string {
  return join(root, "Brain", "_brain.yaml");
}

interface ConfigSnapshot {
  /** Base64 of the raw file, so the comparison is over bytes, not text. */
  readonly bytes: string;
  readonly mtimeMs: number;
}

/** Freeze `_brain.yaml`'s observable state so a later write is detectable. */
function snapshotConfig(root: string): ConfigSnapshot {
  const path = configPathFor(root);
  utimesSync(path, PAST_MTIME_SECONDS, PAST_MTIME_SECONDS);
  return { bytes: readFileSync(path).toString("base64"), mtimeMs: statSync(path).mtimeMs };
}

function expectConfigUntouched(root: string, snapshot: ConfigSnapshot): void {
  const path = configPathFor(root);
  expect(readFileSync(path).toString("base64")).toBe(snapshot.bytes);
  expect(statSync(path).mtimeMs).toBe(snapshot.mtimeMs);
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-schema-mutate-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeFileSync(
    join(vault, "Brain", "_brain.yaml"),
    [
      "schema_version: 1",
      "primary_agent: tester",
      "schema:",
      "  preference_types: [research]",
      "  signal_types: [observation]",
      "  page_types: [paper]",
      "  log_event_kinds: [milestone]",
    ].join("\n") + "\n",
    "utf8",
  );
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("applySchemaMutations", () => {
  test("applies all schema mutation primitives through one atomic batch", async () => {
    const mutations: SchemaMutation[] = [
      { op: "add_type", category: "preference_types", token: "decision" },
      {
        op: "update_type",
        category: "preference_types",
        token: "research",
        new_token: "research-note",
      },
      { op: "add_alias", token: "decision", alias: "choice" },
      { op: "remove_alias", token: "decision", alias: "choice" },
      { op: "add_prefix", prefix: "pref", token: "decision" },
      { op: "remove_prefix", prefix: "pref" },
      { op: "add_link_type", token: "supports" },
      { op: "remove_link_type", token: "supports" },
      { op: "set_extractable", token: "decision", enabled: true },
      { op: "set_extractable", token: "decision", enabled: false },
      { op: "set_expert_routing", token: "decision", expert: "schema-author" },
      { op: "set_expert_routing", token: "decision", expert: null },
      { op: "remove_type", category: "preference_types", token: "decision" },
    ];

    const result = await applySchemaMutations(vault, mutations, {
      actor: "tester",
      now: new Date("2026-05-30T12:00:00.000Z"),
    });

    expect(result.applied).toBe(13);
    const pack = loadSchemaPack(vault);
    expect(pack.declarations.preference_types).toEqual(["research-note"]);
    expect(pack.aliases).toEqual({});
    expect(pack.prefixes).toEqual({});
    expect(pack.link_types).toEqual([]);
    expect(pack.extractable).toEqual([]);
    expect(pack.expert_routing).toEqual({});
    expect(result.audit_path.endsWith("2026-W22.jsonl")).toBe(true);
  });

  test("rejects invalid batches before touching _brain.yaml", async () => {
    const configPath = join(vault, "Brain", "_brain.yaml");
    const before = readFileSync(configPath, "utf8");

    await expect(
      applySchemaMutations(
        vault,
        [{ op: "add_type", category: "preference_types", token: "123bad" }],
        { actor: "tester" },
      ),
    ).rejects.toThrow("schema.preference_types");

    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  test("rejects update_type when the source token is missing", async () => {
    await expect(
      applySchemaMutations(
        vault,
        [
          {
            op: "update_type",
            category: "preference_types",
            token: "missing",
            new_token: "renamed",
          },
        ],
        { actor: "tester" },
      ),
    ).rejects.toThrow("schema.preference_types: missing is not declared");
  });

  test("rejects multi-line expert routing values before rendering", async () => {
    await expect(
      applySchemaMutations(
        vault,
        [
          {
            op: "set_expert_routing",
            token: "research",
            expert: "schema-author\nother",
          },
        ],
        { actor: "tester" },
      ),
    ).rejects.toThrow("expert must be a single line");
  });

  test("writes redacted mutation audit records", async () => {
    const result = await applySchemaMutations(
      vault,
      [{ op: "add_type", category: "signal_types", token: "credential-note" }],
      {
        actor: "tester",
        now: new Date("2026-05-30T12:00:00.000Z"),
        reason: "api_key=secret-value",
      },
    );

    const audit = readFileSync(result.audit_path, "utf8");
    expect(audit).toContain("schema_apply_mutations");
    expect(audit).toContain("***REDACTED***");
    expect(audit).not.toContain("secret-value");
  });

  test("records the resulting pack digest into the audit record it writes", async () => {
    const result = await applySchemaMutations(
      vault,
      [{ op: "add_type", category: "preference_types", token: "decision" }],
      { actor: "tester", now: new Date("2026-05-30T12:00:00.000Z") },
    );

    // The record said which mutations were requested and nothing about the
    // pack they produced, so no later read had an expectation to compare
    // the file against.
    const record = JSON.parse(readFileSync(result.audit_path, "utf8").trim()) as {
      action: string;
      details: Record<string, unknown>;
    };
    expect(record.action).toBe(SCHEMA_MUTATION_AUDIT_ACTION);
    expect(record.details[SCHEMA_PACK_DIGEST_FIELD]).toBe(result.pack_digest);
    expect(result.pack_digest).toBe(computeSchemaPackDigest(result.pack));
    expect(result.pack_digest).toBe(computeSchemaPackDigest(loadSchemaPack(vault)));
  });

  test("writes its audit shard under the shared audit-directory constant", async () => {
    const result = await applySchemaMutations(
      vault,
      [{ op: "add_type", category: "preference_types", token: "decision" }],
      { actor: "tester" },
    );

    expect(
      result.audit_path.startsWith(join(vault, "Brain", "log", SCHEMA_MUTATION_AUDIT_DIR)),
    ).toBe(true);
  });
});

describe("previewSchemaMutations", () => {
  test("returns the pack that would result and the diff from the current one", () => {
    const snapshot = snapshotConfig(vault);

    const preview = previewSchemaMutations(vault, [
      { op: "add_type", category: "preference_types", token: "decision" },
      { op: "add_alias", token: "decision", alias: "choice" },
      { op: "set_expert_routing", token: "decision", expert: "schema-author" },
    ]);

    expect(preview.dry_run).toBe(true);
    expect(preview.would_apply).toBe(3);
    expect(preview.pack.declarations.preference_types).toEqual(["research", "decision"]);
    expect(preview.diff).toEqual([
      { path: "aliases.decision", before: null, after: "choice" },
      { path: "declarations.preference_types", before: null, after: "decision" },
      { path: "expert_routing.decision", before: null, after: "schema-author" },
    ]);

    expectConfigUntouched(vault, snapshot);
    expect(loadSchemaPack(vault).declarations.preference_types).toEqual(["research"]);
  });

  test("reports a scalar leaf whose value changed as a before/after pair", async () => {
    await applySchemaMutations(
      vault,
      [{ op: "set_expert_routing", token: "research", expert: "first-expert" }],
      { actor: "tester" },
    );
    const snapshot = snapshotConfig(vault);

    const preview = previewSchemaMutations(vault, [
      { op: "set_expert_routing", token: "research", expert: "second-expert" },
    ]);

    expect(preview.diff).toEqual([
      { path: "expert_routing.research", before: "first-expert", after: "second-expert" },
    ]);
    expectConfigUntouched(vault, snapshot);
  });

  test("reports a rename as one removed and one added declaration member", () => {
    const preview = previewSchemaMutations(vault, [
      {
        op: "update_type",
        category: "preference_types",
        token: "research",
        new_token: "research-note",
      },
    ]);

    expect(preview.diff).toEqual([
      { path: "declarations.preference_types", before: "research", after: null },
      { path: "declarations.preference_types", before: null, after: "research-note" },
    ]);
  });

  test("returns an empty diff for a batch that would change nothing", () => {
    const preview = previewSchemaMutations(vault, [
      { op: "add_type", category: "preference_types", token: "research" },
    ]);

    expect(preview.would_apply).toBe(1);
    expect(preview.diff).toEqual([]);
  });

  test("previews against a vault with no _brain.yaml without creating one", () => {
    const configPath = configPathFor(vault);
    rmSync(configPath);

    const preview = previewSchemaMutations(vault, [
      { op: "add_type", category: "preference_types", token: "decision" },
    ]);

    expect(preview.diff).toEqual([
      { path: "declarations.preference_types", before: null, after: "decision" },
    ]);
    // Absent must stay absent: a preview creates nothing, not even the file
    // the apply path would materialise from its default.
    expect(existsSync(configPath)).toBe(false);
  });

  const REJECTED_BATCHES: ReadonlyArray<{
    readonly name: string;
    readonly mutations: ReadonlyArray<SchemaMutation>;
    readonly message: string;
  }> = [
    {
      name: "a malformed token",
      mutations: [{ op: "add_type", category: "preference_types", token: "123bad" }],
      message:
        "schema.preference_types: must start with a letter and contain only letters, numbers, underscores, or hyphens",
    },
    {
      name: "a prefix pointing at an undeclared token",
      mutations: [{ op: "add_prefix", prefix: "pref", token: "undeclared" }],
      message: "schema.prefixes.pref: token is not declared",
    },
    {
      name: "a rename of a token that is not declared",
      mutations: [
        {
          op: "update_type",
          category: "preference_types",
          token: "missing",
          new_token: "renamed",
        },
      ],
      message: "schema.preference_types: missing is not declared",
    },
  ];

  for (const rejected of REJECTED_BATCHES) {
    test(`preview of ${rejected.name} raises exactly what an apply raises, without writing`, async () => {
      const snapshot = snapshotConfig(vault);

      let previewMessage = "";
      try {
        previewSchemaMutations(vault, rejected.mutations);
      } catch (err) {
        previewMessage = (err as Error).message;
      }
      expectConfigUntouched(vault, snapshot);

      let applyMessage = "";
      try {
        await applySchemaMutations(vault, rejected.mutations, { actor: "tester" });
      } catch (err) {
        applyMessage = (err as Error).message;
      }

      expect(previewMessage).toBe(rejected.message);
      expect(applyMessage).toBe(previewMessage);
    });
  }
});

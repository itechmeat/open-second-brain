import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applySchemaMutations,
  type SchemaMutation,
} from "../../../src/core/brain/schema-mutate.ts";
import { loadSchemaPack } from "../../../src/core/brain/schema-pack.ts";

let vault: string;

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
});

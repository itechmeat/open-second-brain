import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildSchemaSyncResult,
  getActiveSchemaPack,
  listSchemaPacks,
  SchemaSyncUnavailableError,
} from "../../../src/core/brain/schema-admin.ts";
import {
  assessSchemaPackIntegrity,
  computeSchemaPackDigest,
  isSchemaPackIntegrityStatus,
  isSchemaPackUnverifiedReason,
  readRecordedSchemaPackDigest,
  SCHEMA_MUTATION_AUDIT_DIR,
  SCHEMA_PACK_DIGEST_FIELD,
  SCHEMA_PACK_INTEGRITY,
  SCHEMA_PACK_INTEGRITY_STATUSES,
  SCHEMA_PACK_UNVERIFIED_REASON,
  SCHEMA_PACK_UNVERIFIED_REASONS,
} from "../../../src/core/brain/schema-integrity.ts";
import { applySchemaMutations } from "../../../src/core/brain/schema-mutate.ts";
import { parseSchemaPack, readSchemaPackSource } from "../../../src/core/brain/schema-pack.ts";

let vault: string;

const CONFIG_LINES: ReadonlyArray<string> = Object.freeze([
  "schema_version: 1",
  "primary_agent: tester",
  "schema:",
  "  preference_types: [research]",
  "  signal_types: [observation]",
  "  page_types: [paper]",
  "  log_event_kinds: [milestone]",
]);

function configPath(): string {
  return join(vault, "Brain", "_brain.yaml");
}

function auditDir(): string {
  return join(vault, "Brain", "log", SCHEMA_MUTATION_AUDIT_DIR);
}

function readConfig(): string {
  return readFileSync(configPath(), "utf8");
}

function writeConfig(text: string): void {
  writeFileSync(configPath(), text, "utf8");
}

/** Apply one harmless mutation so the vault carries a recorded expectation. */
async function seal(): Promise<void> {
  await applySchemaMutations(vault, [{ op: "add_link_type", token: "supports" }], {
    actor: "tester",
  });
}

/** The single audit shard the seal above wrote. */
function soleShardPath(): string {
  const entries = readdirSync(auditDir());
  expect(entries).toHaveLength(1);
  return join(auditDir(), entries[0]!);
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-schema-integrity-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeConfig(CONFIG_LINES.join("\n") + "\n");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("schema pack integrity vocabularies", () => {
  test("every status and reason is a member of its own list", () => {
    for (const status of Object.values(SCHEMA_PACK_INTEGRITY)) {
      expect(SCHEMA_PACK_INTEGRITY_STATUSES).toContain(status);
      expect(isSchemaPackIntegrityStatus(status)).toBe(true);
    }
    for (const reason of Object.values(SCHEMA_PACK_UNVERIFIED_REASON)) {
      expect(SCHEMA_PACK_UNVERIFIED_REASONS).toContain(reason);
      expect(isSchemaPackUnverifiedReason(reason)).toBe(true);
    }
  });
});

describe("computeSchemaPackDigest", () => {
  test("is deterministic across two independent parses of the same text", () => {
    const text = readConfig();
    expect(computeSchemaPackDigest(parseSchemaPack(text))).toBe(
      computeSchemaPackDigest(parseSchemaPack(text)),
    );
  });

  test("moves when the ontology moves and not when the surrounding file churns", () => {
    const base = computeSchemaPackDigest(parseSchemaPack(readConfig()));

    // Comment and blank-line churn outside the schema block: same ontology.
    writeConfig(`# operator note\n\n${CONFIG_LINES.join("\n")}\n\n`);
    expect(computeSchemaPackDigest(parseSchemaPack(readConfig()))).toBe(base);

    // One declared token more: a different ontology.
    writeConfig(CONFIG_LINES.join("\n").replace("[research]", "[research, decision]") + "\n");
    expect(computeSchemaPackDigest(parseSchemaPack(readConfig()))).not.toBe(base);
  });
});

describe("assessSchemaPackIntegrity", () => {
  test("apply then read reports ok with no mismatches", async () => {
    await seal();

    const integrity = assessSchemaPackIntegrity(vault);

    expect(integrity.status).toBe(SCHEMA_PACK_INTEGRITY.ok);
    expect(integrity.mismatches).toEqual([]);
    expect(integrity.unverified_reason).toBeUndefined();
    expect(integrity.digest).not.toBeNull();
    expect(integrity.expected).toBe(integrity.digest!);
    expect(typeof integrity.recorded_at).toBe("string");
    expect(integrity.audit_path).toBe(soleShardPath());
  });

  test("the apply result carries the digest that was recorded", async () => {
    const applied = await applySchemaMutations(
      vault,
      [{ op: "add_link_type", token: "supports" }],
      { actor: "tester" },
    );

    expect(applied.pack_digest).toBe(computeSchemaPackDigest(applied.pack));
    expect(assessSchemaPackIntegrity(vault).digest).toBe(applied.pack_digest);
  });

  test("a hand-edited schema block reports modified with both sides populated", async () => {
    await seal();
    const sealed = assessSchemaPackIntegrity(vault).digest;
    writeConfig(readConfig().replace("    - supports", "    - supports\n    - refutes"));

    const integrity = assessSchemaPackIntegrity(vault);

    expect(integrity.status).toBe(SCHEMA_PACK_INTEGRITY.modified);
    expect(integrity.mismatches).toHaveLength(1);
    const [mismatch] = integrity.mismatches;
    expect(mismatch?.field).toBe(SCHEMA_PACK_DIGEST_FIELD);
    expect(mismatch?.expected).toBe(sealed);
    expect(mismatch?.actual).toBe(integrity.digest);
    expect(mismatch?.expected).not.toBe(mismatch?.actual);
  });

  test("editing an unrelated comment in the same file still reports ok", async () => {
    await seal();
    writeConfig(`# an operator comment that is not ontology\n${readConfig()}\n`);

    expect(assessSchemaPackIntegrity(vault).status).toBe(SCHEMA_PACK_INTEGRITY.ok);
  });

  test("a missing audit directory is unverified with no apply recorded, never ok", () => {
    const integrity = assessSchemaPackIntegrity(vault);

    expect(integrity.status).toBe(SCHEMA_PACK_INTEGRITY.unverified);
    expect(integrity.status).not.toBe(SCHEMA_PACK_INTEGRITY.ok);
    expect(integrity.unverified_reason).toBe(SCHEMA_PACK_UNVERIFIED_REASON.noApplyRecorded);
    expect(integrity.expected).toBeUndefined();
    expect(integrity.mismatches).toEqual([]);
    // The live digest is still reported: the pack is readable, the
    // expectation is what is missing.
    expect(typeof integrity.digest).toBe("string");
  });

  test("an audit directory holding no apply record is unverified, not ok", () => {
    mkdirSync(auditDir(), { recursive: true });
    writeFileSync(
      join(auditDir(), "2026-W01.jsonl"),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        actor: "tester",
        action: "some_other_action",
        target: "Brain/_brain.yaml",
        ok: true,
      }) + "\n",
      "utf8",
    );

    const integrity = assessSchemaPackIntegrity(vault);

    expect(integrity.status).toBe(SCHEMA_PACK_INTEGRITY.unverified);
    expect(integrity.unverified_reason).toBe(SCHEMA_PACK_UNVERIFIED_REASON.noApplyRecorded);
  });

  test("an unparseable audit shard is unverified with the audit-unreadable reason", async () => {
    await seal();
    writeFileSync(soleShardPath(), "{not json at all\n", "utf8");

    const integrity = assessSchemaPackIntegrity(vault);

    expect(integrity.status).toBe(SCHEMA_PACK_INTEGRITY.unverified);
    expect(integrity.unverified_reason).toBe(SCHEMA_PACK_UNVERIFIED_REASON.auditUnreadable);
  });

  test("an apply record carrying no digest is unverified, never ok", async () => {
    await seal();
    const shard = soleShardPath();
    const record = JSON.parse(readFileSync(shard, "utf8").trim()) as {
      details: Record<string, unknown>;
    };
    delete record.details[SCHEMA_PACK_DIGEST_FIELD];
    writeFileSync(shard, JSON.stringify(record) + "\n", "utf8");

    const integrity = assessSchemaPackIntegrity(vault);

    expect(integrity.status).toBe(SCHEMA_PACK_INTEGRITY.unverified);
    expect(integrity.unverified_reason).toBe(SCHEMA_PACK_UNVERIFIED_REASON.auditUnreadable);
  });

  test("the newest apply record wins over an older one", async () => {
    await seal();
    const shard = soleShardPath();
    const sealed = JSON.parse(readFileSync(shard, "utf8").trim()) as {
      timestamp: string;
      details: Record<string, unknown>;
    };
    const stale = {
      ...sealed,
      timestamp: "2020-01-01T00:00:00.000Z",
      details: { ...sealed.details, [SCHEMA_PACK_DIGEST_FIELD]: "deadbeef" },
    };
    // The stale record is written LAST, so line order alone would pick it.
    writeFileSync(shard, `${JSON.stringify(sealed)}\n${JSON.stringify(stale)}\n`, "utf8");

    const recorded = readRecordedSchemaPackDigest(vault);

    expect(recorded.found).toBe(true);
    expect(recorded.found && recorded.recorded_at).toBe(sealed.timestamp);
    expect(assessSchemaPackIntegrity(vault).status).toBe(SCHEMA_PACK_INTEGRITY.ok);
  });

  test("a deleted config file is unverified with the config-absent reason", async () => {
    await seal();
    rmSync(configPath());

    const integrity = assessSchemaPackIntegrity(vault);

    expect(integrity.status).toBe(SCHEMA_PACK_INTEGRITY.unverified);
    expect(integrity.unverified_reason).toBe(SCHEMA_PACK_UNVERIFIED_REASON.configAbsent);
    // Nothing on disk to digest, and no digest is invented for it.
    expect(integrity.digest).toBeNull();
    expect(integrity.expected).toBeUndefined();
    expect(integrity.mismatches).toEqual([]);
  });
});

describe("readSchemaPackSource", () => {
  test("distinguishes an absent config from one that declares nothing", () => {
    const declared = readSchemaPackSource(vault);
    expect(declared.present).toBe(true);

    rmSync(configPath());
    const absent = readSchemaPackSource(vault);

    expect(absent.present).toBe(false);
    expect(absent.path).toBe(configPath());
    // The substituted default still parses to an empty pack, so callers
    // that legitimately want a default are unaffected.
    expect(absent.pack.declarations.preference_types).toBeUndefined();
  });
});

describe("schema read surfaces", () => {
  test("the active pack reports whether the path it names exists", async () => {
    await seal();

    const active = getActiveSchemaPack(vault);
    expect(active.exists).toBe(true);
    expect(active.integrity.status).toBe(SCHEMA_PACK_INTEGRITY.ok);

    rmSync(configPath());
    const gone = getActiveSchemaPack(vault);
    expect(gone.exists).toBe(false);
    expect(gone.integrity.unverified_reason).toBe(SCHEMA_PACK_UNVERIFIED_REASON.configAbsent);
  });

  test("every listed pack carries its own existence and integrity", async () => {
    await seal();

    const listed = listSchemaPacks(vault);

    expect(listed.packs).toHaveLength(1);
    expect(listed.packs[0]?.exists).toBe(true);
    expect(listed.packs[0]?.integrity.status).toBe(SCHEMA_PACK_INTEGRITY.ok);
  });
});

describe("buildSchemaSyncResult", () => {
  test("refuses instead of reporting a backfill it never performed", () => {
    expect(() => buildSchemaSyncResult(vault)).toThrow(SchemaSyncUnavailableError);
    expect(() => buildSchemaSyncResult(vault)).toThrow(/not implemented/);
  });
});

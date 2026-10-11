/**
 * Deny-consulted evidence for the destructive cleanup lane (PR #247
 * review M3 residual).
 *
 * Update and append refuse on a permissions-document deny through
 * `refuseDocumentDeny`; `delete_by_source` destroyed ingest-derived
 * material and the ingest manifest entry with no document consult at
 * all, so a caller a document had closed could still remove everything
 * derived from a source. A CONFIRMED cleanup now resolves the document
 * against the credential subject - the same discipline, the same typed
 * refusal, one decision-ledger row behind it - before anything is read
 * for deletion, snapshotted, or removed. The dry run plans and writes
 * nothing, so it stays a read and stays ungated.
 *
 * The doctor half: when the document in force denies the ingest action
 * the cleanup lane consults, the store-integrity doctor names the
 * covered lanes, because the release notes claimed only "update or
 * append" and an operator reading that would not expect a cleanup
 * refusal.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { listEntities } from "../../../src/core/brain/entities/registry.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { deleteBySource } from "../../../src/core/brain/source-cleanup.ts";
import {
  applySchemaMutations,
  previewSchemaMutations,
} from "../../../src/core/brain/schema-mutate.ts";
import { readManifest } from "../../../src/core/brain/ingest/content-manifest.ts";
import { ingestSource } from "../../../src/core/brain/ingest/ingest.ts";
import {
  denyConsultedLanesCheck,
  DENY_CONSULTED_LANES_CODE,
} from "../../../src/core/brain/doctor/store-integrity.ts";
import type { DoctorCheckContext, DoctorFindings } from "../../../src/core/brain/doctor/check.ts";
import { WriteRefusedError, type WriteSubject } from "../../../src/core/brain/write-disposition.ts";

let vault: string;
let configHome: string;
let savedAgentName: string | undefined;

const NOW = new Date("2026-06-13T12:00:00Z");
const SOURCE = "Articles/restaking-primer.md";
const SUBJECT: WriteSubject = { agent: "codex", via: "token" };

/** Ingest one real source so the cleanup has derived material to destroy. */
function ingestFixture(source: string = SOURCE): void {
  const abs = join(vault, source);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, `bytes of ${source}\n`, "utf8");
  ingestSource(
    vault,
    {
      sourcePath: source,
      summary: `A summary of ${source}.`,
      extraction: {
        entities: [{ category: "concept", name: source === SOURCE ? "Restaking" : "Slashing" }],
      },
    },
    { agent: "ingest-agent", now: NOW },
  );
}

function writeDoc(text: string): void {
  atomicWriteFileSync(join(vault, "Brain", "_permissions.yaml"), text);
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-delete-deny-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-delete-deny-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
  savedAgentName = process.env["VAULT_AGENT_NAME"];
  process.env["VAULT_AGENT_NAME"] = "codex";
});

afterEach(() => {
  if (savedAgentName === undefined) delete process.env["VAULT_AGENT_NAME"];
  else process.env["VAULT_AGENT_NAME"] = savedAgentName;
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("deleteBySource deny consult", () => {
  test("a document deny refuses the confirmed cleanup before any write", () => {
    ingestFixture();
    writeDoc(
      "version: 1\ndefault_action: allow\nentries:\n  - id: freeze\n    agent: codex\n" +
        "    action: ingest\n    verdict: deny\n",
    );
    expect(() =>
      deleteBySource(vault, SOURCE, { confirm: true, subject: SUBJECT, now: NOW }),
    ).toThrow(WriteRefusedError);
    // Nothing deleted: the derived pages, the manifest entry and the
    // original are all still on disk, and no snapshot exists.
    expect(listEntities(vault, { category: "concept" })).toHaveLength(1);
    expect(existsSync(join(vault, SOURCE))).toBe(true);
    expect(readManifest(vault).entries[SOURCE]).toBeDefined();
    // No pre-deletion recovery point was taken for a run that destroyed
    // nothing (bootstrap creates the directory; a refused run archives
    // nothing into it).
    expect(readdirSync(join(vault, "Brain", ".snapshots"))).toEqual([]);
  });

  test("the refusal names the credential subject, the ingest action and the deciding rule", () => {
    ingestFixture();
    writeDoc(
      "version: 1\ndefault_action: allow\nentries:\n  - id: freeze\n    agent: codex\n" +
        "    action: ingest\n    verdict: deny\n",
    );
    try {
      deleteBySource(vault, SOURCE, { confirm: true, subject: SUBJECT, now: NOW });
      throw new Error("expected WriteRefusedError");
    } catch (err) {
      expect(err).toBeInstanceOf(WriteRefusedError);
      const refused = err as WriteRefusedError;
      expect(refused.agent).toBe("codex");
      expect(refused.via).toBe("token");
      expect(refused.action).toBe("ingest");
      expect(refused.rule).toBe("entry:freeze");
      expect(refused.target).toBe(SOURCE);
    }
  });

  test("a deny for another agent leaves the confirmed cleanup working", () => {
    ingestFixture();
    writeDoc(
      "version: 1\ndefault_action: allow\nentries:\n  - id: freeze-gemini\n    agent: gemini\n" +
        "    action: ingest\n    verdict: deny\n",
    );
    const plan = deleteBySource(vault, SOURCE, { confirm: true, subject: SUBJECT, now: NOW });
    expect(plan.deleted.length).toBeGreaterThan(0);
    expect(plan.manifestEntryRemoved).toBe(true);
  });

  test("a target-scoped deny names the deletion subject; other sources stay cleanable", () => {
    ingestFixture();
    const other = "Articles/other.md";
    writeDoc(
      "version: 1\ndefault_action: allow\nentries:\n  - id: guard-source\n    agent: codex\n" +
        `    action: ingest\n    target: ${SOURCE}\n    verdict: deny\n`,
    );
    expect(() =>
      deleteBySource(vault, SOURCE, { confirm: true, subject: SUBJECT, now: NOW }),
    ).toThrow(WriteRefusedError);
    // A source the rule does not name is still cleanable under the same document.
    ingestFixture(other);
    const plan = deleteBySource(vault, other, { confirm: true, subject: SUBJECT, now: NOW });
    expect(plan.deleted.length).toBeGreaterThan(0);
  });

  test("a dry run stays a read and is not gated", () => {
    ingestFixture();
    writeDoc("version: 1\ndefault_action: deny\n");
    const plan = deleteBySource(vault, SOURCE, { subject: SUBJECT, now: NOW });
    expect(plan.confirmed).toBe(false);
    expect(plan.deleted).toHaveLength(0);
    expect(plan.blastRadius).toBeGreaterThan(0);
  });

  test("an absent document keeps the confirmed cleanup byte-identical", () => {
    ingestFixture();
    const plan = deleteBySource(vault, SOURCE, { confirm: true, subject: SUBJECT, now: NOW });
    expect(plan.confirmed).toBe(true);
    expect(plan.manifestEntryRemoved).toBe(true);
    expect(listEntities(vault, { category: "concept" })).toHaveLength(0);
  });
});

describe("the schema-mutation lane owes the same consult", () => {
  /** One benign mutation, enough to prove an apply went through. */
  function batch(): Parameters<typeof applySchemaMutations>[1] {
    return [{ op: "add_type", category: "page_types", token: "dossier" }];
  }

  function brainYaml(): string {
    return readFileSync(join(vault, "Brain", "_brain.yaml"), "utf8");
  }

  test("a document deny refuses the apply before any write", async () => {
    writeDoc(
      "version: 1\ndefault_action: allow\nentries:\n  - id: freeze\n    agent: codex\n" +
        "    action: ingest\n    verdict: deny\n",
    );
    const before = brainYaml();
    await expect(
      applySchemaMutations(vault, batch(), { actor: "codex", subject: SUBJECT, now: NOW }),
    ).rejects.toThrow(WriteRefusedError);
    // The pack is untouched and no audit record was written for an apply
    // that mutated nothing.
    expect(brainYaml()).toBe(before);
    const auditDir = join(vault, "Brain", "log", "schema-mutations");
    expect(existsSync(auditDir) ? readdirSync(auditDir) : []).toEqual([]);
  });

  test("the refusal names the subject, the ingest action, the rule and the pack target", async () => {
    writeDoc(
      "version: 1\ndefault_action: allow\nentries:\n  - id: freeze\n    agent: codex\n" +
        "    action: ingest\n    verdict: deny\n",
    );
    try {
      await applySchemaMutations(vault, batch(), {
        actor: "codex",
        subject: SUBJECT,
        now: NOW,
      });
      throw new Error("expected WriteRefusedError");
    } catch (err) {
      expect(err).toBeInstanceOf(WriteRefusedError);
      const refused = err as WriteRefusedError;
      expect(refused.agent).toBe("codex");
      expect(refused.via).toBe("token");
      expect(refused.action).toBe("ingest");
      expect(refused.rule).toBe("entry:freeze");
      expect(refused.target).toBe("Brain/_brain.yaml");
    }
  });

  test("a deny for another agent leaves the schema mutation applying", async () => {
    writeDoc(
      "version: 1\ndefault_action: allow\nentries:\n  - id: freeze-gemini\n    agent: gemini\n" +
        "    action: ingest\n    verdict: deny\n",
    );
    const result = await applySchemaMutations(vault, batch(), {
      actor: "codex",
      subject: SUBJECT,
      now: NOW,
    });
    expect(result.applied).toBe(1);
    expect(result.pack.declarations.page_types).toContain("dossier");
  });

  test("an absent document keeps the apply byte-identical", async () => {
    const result = await applySchemaMutations(vault, batch(), {
      actor: "codex",
      subject: SUBJECT,
      now: NOW,
    });
    expect(result.applied).toBe(1);
    expect(result.pack.declarations.page_types).toContain("dossier");
  });

  test("a dry-run preview stays a read and is not gated", () => {
    writeDoc("version: 1\ndefault_action: deny\n");
    const preview = previewSchemaMutations(vault, batch());
    expect(preview.dry_run).toBe(true);
    expect(preview.would_apply).toBe(1);
    expect(preview.diff.length).toBeGreaterThan(0);
  });

  test("the doctor's deny-consulted finding names the schema lane", () => {
    writeDoc("version: 1\ndefault_action: deny\n");
    const out: DoctorFindings = { issues: [], uncertain: [] };
    denyConsultedLanesCheck.run(
      {
        vault,
        now: NOW,
        config: undefined,
        dbPath: undefined,
        configPath: undefined,
        knownBasenames: new Set(),
        idIndex: new Map(),
        preferences: [],
        logs: [],
      },
      out,
    );
    const findings = out.issues.filter((i) => i.code === DENY_CONSULTED_LANES_CODE);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("brain_schema_mutate");
    expect(findings[0]!.message).toContain("Brain/_brain.yaml");
  });
});

describe("the doctor reports the covered lanes", () => {
  function context(): DoctorCheckContext {
    return {
      vault,
      now: NOW,
      config: undefined,
      dbPath: undefined,
      configPath: undefined,
      knownBasenames: new Set(),
      idIndex: new Map(),
      preferences: [],
      logs: [],
    };
  }

  function run(): DoctorFindings {
    const out: DoctorFindings = { issues: [], uncertain: [] };
    denyConsultedLanesCheck.run(context(), out);
    return out;
  }

  function findings(): DoctorFindings["issues"] {
    return run().issues.filter((i) => i.code === DENY_CONSULTED_LANES_CODE);
  }

  test("a document whose ingest verdict denies the local agent names the covered lanes", () => {
    writeDoc("version: 1\ndefault_action: deny\n");
    const { issues } = run();
    const found = issues.filter((i) => i.code === DENY_CONSULTED_LANES_CODE);
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("warning");
    expect(found[0]!.message).toContain("delete_by_source");
    expect(found[0]!.message).toContain("o2b brain permissions show");
  });

  test("an allow or ask ingest verdict stays silent, as does an absent document", () => {
    writeDoc("version: 1\ndefault_action: allow\n");
    expect(run().issues).toEqual([]);
    writeDoc("version: 1\ndefault_action: ask\n");
    expect(run().issues).toEqual([]);
    rmSync(join(vault, "Brain", "_permissions.yaml"));
    expect(run().issues).toEqual([]);
  });

  test("the blanket finding registers the session lane's honest status", () => {
    writeDoc("version: 1\ndefault_action: deny\n");
    const found = findings();
    expect(found).toHaveLength(1);
    // write_session consults no permissions document today: the finding
    // says so instead of counting the lane as covered.
    expect(found[0]!.message).toContain("brain_write_session");
    expect(found[0]!.message).toContain("no permissions document");
  });

  test("a blanket deny stays one finding - the target scopes are implied", () => {
    writeDoc(
      "version: 1\ndefault_action: allow\nentries:\n  - id: guard-source\n    agent: codex\n" +
        `    action: ingest\n    target: ${SOURCE}\n    verdict: deny\n`,
    );
    writeDoc("version: 1\ndefault_action: deny\n");
    expect(findings()).toHaveLength(1);
  });

  test("a target-scoped deny on the schema pack names the schema lane", () => {
    // default allow, one target-scoped deny: the untargeted resolution
    // stayed silent here, yet every schema batch from this machine refuses.
    writeDoc(
      "version: 1\ndefault_action: allow\nentries:\n  - id: freeze-pack\n    agent: codex\n" +
        "    action: ingest\n    target: Brain/_brain.yaml\n    verdict: deny\n",
    );
    const found = findings();
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("warning");
    expect(found[0]!.path).toContain("_permissions.yaml");
    expect(found[0]!.message).toContain("brain_schema_mutate");
    expect(found[0]!.message).toContain("Brain/_brain.yaml");
    expect(found[0]!.message).toContain("entry:freeze-pack");
    expect(found[0]!.message).toContain("o2b brain permissions show");
  });

  test("a target-scoped deny on a source names the destructive cleanup", () => {
    writeDoc(
      "version: 1\ndefault_action: allow\nentries:\n  - id: guard-source\n    agent: codex\n" +
        `    action: ingest\n    target: ${SOURCE}\n    verdict: deny\n`,
    );
    const found = findings();
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("delete_by_source");
    expect(found[0]!.message).toContain(SOURCE);
    // The cleanup for OTHER sources still works - the finding names this
    // target's refusal, not a blanket closure.
    expect(found[0]!.message).not.toContain("every source");
  });

  test("a target-scoped deny for another agent stays silent", () => {
    writeDoc(
      "version: 1\ndefault_action: allow\nentries:\n  - id: guard-gemini\n    agent: gemini\n" +
        "    action: ingest\n    target: Brain/_brain.yaml\n    verdict: deny\n",
    );
    expect(run().issues).toEqual([]);
  });
});

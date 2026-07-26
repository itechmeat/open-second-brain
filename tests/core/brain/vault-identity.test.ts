/**
 * Unit J - guard against writes to an unexpected memory-store location.
 *
 * `resolveVault` returns a path from four branches with no existence
 * validation at all, and the first Brain write materializes whatever it
 * got. These tests pin the two halves of the answer: an unmarked root is
 * ambiguous and warns, a root whose recorded identity changed under a
 * live process is unambiguous and refuses.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, relative } from "node:path";

import { regenerateActive } from "../../../src/core/brain/active.ts";
import { refreshAnticipatoryCache } from "../../../src/core/brain/anticipatory-cache.ts";
import { ensureDefaultAttentionFlows } from "../../../src/core/brain/attention-flows.ts";
import { writeCaptureNote } from "../../../src/core/brain/capture/capture-note.ts";
import {
  appendContinuityRecord,
  appendContinuityRecords,
} from "../../../src/core/brain/continuity/store.ts";
import { recordDeadEnd } from "../../../src/core/brain/dead-ends.ts";
import { recordDecision } from "../../../src/core/brain/decisions/record.ts";
import { appendDecisionChangeReceipt } from "../../../src/core/brain/decisions/receipts.ts";
import { distillSource } from "../../../src/core/brain/distill/distill-source.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { upsertEntity } from "../../../src/core/brain/entities/registry.ts";
import { writeExactState, clearExactState } from "../../../src/core/brain/exact-state.ts";
import { collectExportRows } from "../../../src/core/brain/export.ts";
import {
  autoCloseRecalledGaps,
  promoteGapsToTasks,
} from "../../../src/core/brain/gaps/gap-loop.ts";
import { writeHandoffNote } from "../../../src/core/brain/handoff.ts";
import { appendEditHistory } from "../../../src/core/brain/health/edit-history.ts";
import { recordThesis } from "../../../src/core/brain/health/thesis.ts";
import { applyHygienePlan } from "../../../src/core/brain/hygiene/apply.ts";
import type { HygienePlan } from "../../../src/core/brain/hygiene/plan.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { setIntention } from "../../../src/core/brain/intentions.ts";
import { assignNoteLabel } from "../../../src/core/brain/labels.ts";
import { regenerateLessons } from "../../../src/core/brain/lessons.ts";
import { recordLineageObservation } from "../../../src/core/brain/lineage/ledger.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { createNote } from "../../../src/core/brain/notes/create-note.ts";
import { addObligation } from "../../../src/core/brain/obligations.ts";
import { brainDirs, brainDirsForWrite } from "../../../src/core/brain/paths.ts";
import {
  applyPending,
  listPending,
  rejectPending,
  stagePendingSignal,
} from "../../../src/core/brain/pending.ts";
import { setPinned } from "../../../src/core/brain/pin.ts";
import {
  appendPinnedContext,
  applyPinnedOperations,
  clearPinnedContext,
  writePinnedContext,
} from "../../../src/core/brain/pinned.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { appendPrefAudit } from "../../../src/core/brain/pref-audit.ts";
import type { RecallResultSet, RecallRetriever } from "../../../src/core/brain/recall-inject.ts";
import { archivePage } from "../../../src/core/brain/recompile.ts";
import { writeResearchReport } from "../../../src/core/brain/research/research.ts";
import { writeRollupLedger } from "../../../src/core/brain/rollup-ladder.ts";
import { parseSchemaPack } from "../../../src/core/brain/schema-pack.ts";
import { applySchemaMutations } from "../../../src/core/brain/schema-mutate.ts";
import {
  removeSecret,
  resolveSecretForExec,
  setSecret,
} from "../../../src/core/brain/secrets/store.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { retireSignal } from "../../../src/core/brain/signal-retire.ts";
import { learnSkillProposals } from "../../../src/core/brain/skill-proposals.ts";
import { pruneSnapshots } from "../../../src/core/brain/snapshot.ts";
import { computeBrainStatus } from "../../../src/core/brain/status.ts";
import { confirmTension, persistTension } from "../../../src/core/brain/tensions.ts";
import { createTriggers } from "../../../src/core/brain/triggers/store.ts";
import type { InsightCandidate } from "../../../src/core/brain/triggers/types.ts";
import { appendClaimEvent, writeTruthState } from "../../../src/core/brain/truth/store.ts";
import { TRUTH_SCHEMA_VERSION } from "../../../src/core/brain/truth/types.ts";
import { PREF_AUDIT_OP } from "../../../src/core/brain/types.ts";
import { runBrainWatchdog } from "../../../src/core/brain/watchdog.ts";
import { applyWriteBatch } from "../../../src/core/brain/write-batch.ts";
import { createWriteSession } from "../../../src/core/brain/write-session/store.ts";
import type { WriteSessionRecord } from "../../../src/core/brain/write-session/types.ts";
import {
  VaultIdentityMismatchError,
  readVaultIdentity,
  resetVaultIdentityPins,
  vaultIdentityPath,
  vaultMarkerAbsentNotice,
  writeVaultIdentity,
} from "../../../src/core/brain/vault-identity.ts";
import type { DegradationNotice } from "../../../src/core/integrity/degradation.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-vault-identity-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-vault-identity-cfg-"));
  configPath = join(configHome, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\n`, "utf8");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  resetVaultIdentityPins();
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  resetVaultIdentityPins();
});

/** One-finding hygiene plan that archives `page`. */
function archivePlan(page: string): HygienePlan {
  return {
    selected: [
      {
        id: "usefulness:guard",
        detector: "usefulness",
        severity: "action",
        title: "archive the guard page",
        targets: [page],
        proposed_action: "archive",
        evidence: {},
      },
    ],
    excluded_review: [],
    unknown_ids: [],
  };
}

describe("vault identity marker", () => {
  test("writing is idempotent and records no machine-local path", () => {
    const first = writeVaultIdentity(vault);
    const second = writeVaultIdentity(vault);
    expect(second.vault_id).toBe(first.vault_id);
    expect(readVaultIdentity(vault)?.vault_id).toBe(first.vault_id);
    // The marker travels with the vault across synced devices, so it must
    // carry no absolute path - a machine-local key is stale on every peer.
    expect(JSON.stringify(first)).not.toContain(vault);
    expect(first.schema_version).toBe(1);
  });

  test("an unreadable or malformed marker reads as absent, never as a mismatch", () => {
    writeFileSync(vaultIdentityPath(vault), "{ not json", "utf8");
    expect(readVaultIdentity(vault)).toBeNull();
  });
});

describe("brainDirsForWrite", () => {
  test("returns the same directories as brainDirs", () => {
    writeVaultIdentity(vault);
    expect(brainDirsForWrite(vault)).toEqual(brainDirs(vault));
  });

  test("an absent marker warns instead of refusing", () => {
    const notices: DegradationNotice[] = [];
    const dirs = brainDirsForWrite(vault, notices);
    expect(dirs.brain).toBe(brainDirs(vault).brain);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.code).toBe("vault-marker-absent");
    expect(notices[0]!.path).toBe(vault);
  });

  test("a marker that changed under a live process refuses the write", () => {
    writeVaultIdentity(vault);
    // First write pins what this process is writing to.
    brainDirsForWrite(vault);

    // The store at this path is now a different vault.
    rmSync(vaultIdentityPath(vault));
    const replacement = writeVaultIdentity(vault);

    let raised: unknown;
    try {
      brainDirsForWrite(vault);
    } catch (err) {
      raised = err;
    }
    expect(raised).toBeInstanceOf(VaultIdentityMismatchError);
    const error = raised as VaultIdentityMismatchError;
    expect(error.notice.code).toBe("vault-marker-mismatch");
    expect(error.message).toContain(replacement.vault_id);
    expect(error.message).toContain(vault);
  });

  test("a replacement marker of identical size is still caught", () => {
    // The guard memoizes (inode, size, mtime) so the hot write path costs
    // one stat instead of an open-read-parse. Two markers minted by
    // `writeVaultIdentity` serialize to the same byte length, so this
    // pins that the memo keys on more than size.
    const first = writeVaultIdentity(vault);
    brainDirsForWrite(vault);
    const firstBytes = readFileSync(vaultIdentityPath(vault)).length;

    rmSync(vaultIdentityPath(vault));
    const replacement = writeVaultIdentity(vault);
    expect(replacement.vault_id).not.toBe(first.vault_id);
    expect(readFileSync(vaultIdentityPath(vault)).length).toBe(firstBytes);

    expect(() => brainDirsForWrite(vault)).toThrow(VaultIdentityMismatchError);
  });

  test("a matching marker never refuses, however many writes follow", () => {
    writeVaultIdentity(vault);
    for (let i = 0; i < 3; i++) expect(() => brainDirsForWrite(vault)).not.toThrow();
  });
});

/**
 * The guard is only worth its docblock if it fires on the write paths
 * an operator actually drives, not just on the three call sites the
 * first cut converted. One row per representative Brain writer; adding
 * a writer that skips the guard makes its row fail.
 */
describe("the guard fires on Brain write paths", () => {
  interface WriteCase {
    readonly name: string;
    /** Bring the vault into the state the write needs. */
    readonly seed?: (vault: string) => void | Promise<void>;
    readonly write: (vault: string) => void | Promise<void>;
  }

  const SIGNAL_INPUT = {
    topic: "guard-topic",
    signal: "positive",
    agent: "test-agent",
    principle: "guard the write path",
    created_at: "2026-07-26T00:00:00Z",
    date: "2026-07-26",
    slug: "guard-topic",
  } as const;

  const NOW = new Date("2026-07-26T00:00:00Z");

  const PREF_INPUT = {
    slug: "guard-pref",
    topic: "guard-topic",
    principle: "guard the write path",
    created_at: "2026-07-26T00:00:00Z",
    unconfirmed_until: "2026-08-02T00:00:00Z",
    status: "unconfirmed",
    evidenced_by: [],
  } as const;

  const SECRET_INPUT = {
    name: "guard-secret",
    value: "s3cret-material",
    allow: ["echo *"],
    agent: "test-agent",
    now: NOW,
  } as const;

  const GUARD_PAGE_REL = posix.join("Brain", "notes", "guard-page.md");

  function guardPagePath(vaultRoot: string): string {
    return join(vaultRoot, "Brain", "notes", "guard-page.md");
  }

  function writeGuardPage(vaultRoot: string): void {
    mkdirSync(join(vaultRoot, "Brain", "notes"), { recursive: true });
    writeFileSync(guardPagePath(vaultRoot), "---\ntitle: Guard\n---\n\nGuarded page.\n", "utf8");
  }

  const TENSION_FINDING = {
    aId: "note-a",
    bId: "note-b",
    subject: "write guard",
    jaccard: 0.9,
    aSign: "positive",
    bSign: "negative",
    aQuote: "the guard covers writes",
    bQuote: "the guard does not cover writes",
    action: "ask_user",
  } as const;

  /** Slug the seeded tension landed under, captured for the transition. */
  let seededTensionSlug = "";

  function seedOpenGapTask(vaultRoot: string): void {
    const dir = join(vaultRoot, "Brain", "gap-tasks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "guard-gap.md"),
      [
        "---",
        "kind: brain-gap-task",
        "gap_key: guard-gap",
        "gap_topic: guard topic",
        "status: open",
        'occurrences: "3"',
        "created_at: 2026-07-26T00:00:00Z",
        "---",
        "",
        "Recurring recall gap.",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  const RECALL_RETRIEVER: RecallRetriever = () =>
    Promise.resolve({
      candidates: [
        {
          path: "Brain/x.md",
          title: "X",
          score: 0.92,
          searchType: "hybrid",
          startLine: 1,
          endLine: 2,
        },
      ],
      total: 1,
    } satisfies RecallResultSet);

  function seedSnapshotArchive(vaultRoot: string): void {
    const dir = join(vaultRoot, "Brain", ".snapshots");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-07-26T00-00-00Z.tar.zst"), "not a real archive", "utf8");
  }

  const WRITE_SESSION_NOW = "2026-07-26T00:00:00Z";

  function writeSessionRecord(id: string): WriteSessionRecord {
    return {
      id,
      kind: "artifact",
      status: "needs-llm-step",
      step: "artifact",
      agent: "test-agent",
      createdAt: WRITE_SESSION_NOW,
      updatedAt: WRITE_SESSION_NOW,
      expiresAt: "2026-07-27T00:00:00Z",
      attempts: 0,
      retryCap: 3,
      targetPath: "Brain/notes/guard-session.md",
      intent: "create",
      requireReview: false,
      prompt: "Guard the write path.",
      schemaType: null,
      topic: null,
      personas: [],
      responses: {},
      pendingArtifact: null,
      lastErrors: [],
      failReason: null,
    };
  }

  const TRIGGER_CANDIDATE: InsightCandidate = {
    kind: "contradiction",
    urgency: "high",
    reason: "pref-a contradicts pref-b on the same scope",
    suggestedAction: "Review both preferences and retire one",
    sourceArtifacts: ["[[pref-a]]", "[[pref-b]]"],
    contextSnippets: ["pref-a: do X", "pref-b: never do X"],
    cooldownKey: "contradiction:pref-a:pref-b",
  };

  const LABEL_PACK = parseSchemaPack(
    ["schema_version: 1", "schema:", "  labels:", "    - priority=high"].join("\n") + "\n",
  );

  const CASES: ReadonlyArray<WriteCase> = [
    {
      name: "writeSignal",
      write: (v) => void writeSignal(v, SIGNAL_INPUT),
    },
    {
      name: "appendLogEvent",
      write: (v) =>
        void appendLogEvent(v, {
          timestamp: "2026-07-26T00:00:00Z",
          eventType: "note",
          agent: "test-agent",
          body: { text: "guarded" },
        }),
    },
    {
      name: "retireSignal",
      seed: (v) => void writeSignal(v, SIGNAL_INPUT),
      write: (v) => void retireSignal(v, "sig-2026-07-26-guard-topic", { reason: "obsolete" }),
    },
    {
      name: "stagePendingSignal",
      write: (v) => void stagePendingSignal(v, SIGNAL_INPUT),
    },
    {
      name: "applyPending",
      seed: (v) => void stagePendingSignal(v, SIGNAL_INPUT),
      write: (v) => void applyPending(v, "sig-2026-07-26-guard-topic"),
    },
    {
      name: "rejectPending",
      seed: (v) => void stagePendingSignal(v, SIGNAL_INPUT),
      write: (v) => void rejectPending(v, "sig-2026-07-26-guard-topic", "not durable"),
    },
    {
      name: "regenerateActive",
      write: (v) => void regenerateActive(v),
    },
    {
      name: "regenerateLessons",
      write: (v) => void regenerateLessons(v),
    },
    {
      // Every watchdog run appends an audit record under `Brain/log/`,
      // so the probe form is a write path too - not only the remediating
      // one, which also creates and replaces directories.
      name: "runBrainWatchdog",
      write: (v) => void runBrainWatchdog(v, { remediate: true }),
    },

    // ----- Writers that reach the tree through a `paths.ts` builder -----
    //
    // These never touch `brainDirs`, so `brainDirsForWrite` cannot cover
    // them. `writePreference` is the headline: the single most important
    // writer in the system, and the one the first cut of the guard missed.
    {
      name: "writePreference",
      write: (v) => void writePreference(v, PREF_INPUT),
    },
    {
      name: "setPinned",
      seed: (v) => void writePreference(v, PREF_INPUT),
      write: (v) => void setPinned(v, `pref-${PREF_INPUT.slug}`, true),
    },
    {
      name: "appendPrefAudit",
      write: (v) =>
        void appendPrefAudit(v, {
          pref_id: `pref-${PREF_INPUT.slug}`,
          op: PREF_AUDIT_OP.create,
          agent: "test-agent",
          revision_before: null,
          revision_after: 1,
          hash_before: null,
          hash_after: "abc",
        }),
    },
    {
      name: "appendEditHistory",
      write: (v) =>
        void appendEditHistory(v, PREF_INPUT.slug, [
          {
            ts: "2026-07-26T00:00:00Z",
            agent: "test-agent",
            revision: 1,
            field: "principle",
            before: "a",
            after: "b",
          },
        ]),
    },
    {
      name: "writePinnedContext",
      write: (v) => void writePinnedContext(v, "guarded"),
    },
    {
      name: "appendPinnedContext",
      write: (v) => void appendPinnedContext(v, "guarded"),
    },
    {
      name: "clearPinnedContext",
      write: (v) => void clearPinnedContext(v),
    },
    {
      name: "writeExactState",
      write: (v) => void writeExactState(v, "guard-aspect", "value"),
    },
    {
      name: "clearExactState",
      seed: (v) => void writeExactState(v, "guard-aspect", "value"),
      write: (v) => void clearExactState(v, "guard-aspect"),
    },
    {
      name: "upsertEntity",
      write: (v) =>
        void upsertEntity(v, {
          category: "person",
          name: "Guard Subject",
          agent: "test-agent",
          now: NOW,
        }),
    },
    {
      name: "recordDecision",
      write: (v) =>
        void recordDecision(v, {
          title: "Guard the write path",
          chosen: "guard at the writer entry point",
          assumption: "the builders stay intent-neutral",
          reviewDate: "2026-08-26",
          agent: "test-agent",
          now: NOW,
        }),
    },
    {
      name: "recordThesis",
      write: (v) =>
        void recordThesis(v, {
          statement: "the write guard must cover the preference writer",
          agent: "test-agent",
          now: NOW,
        }),
    },
    {
      name: "addObligation",
      write: (v) =>
        void addObligation(v, {
          title: "Review the write guard",
          cadence: "monthly",
          agent: "test-agent",
          now: NOW,
        }),
    },
    {
      name: "persistTension",
      write: (v) =>
        void persistTension(
          v,
          {
            aId: "note-a",
            bId: "note-b",
            subject: "write guard",
            jaccard: 0.9,
            aSign: "positive",
            bSign: "negative",
            aQuote: "the guard covers writes",
            bQuote: "the guard does not cover writes",
            action: "ask_user",
          },
          { now: NOW },
        ),
    },
    {
      name: "writeResearchReport",
      write: (v) =>
        void writeResearchReport(
          v,
          {
            title: "Guarded report",
            findings: [{ statement: "the guard fires", sources: ["src-a"] }],
            sources: ["src-a"],
          },
          { agent: "test-agent", now: NOW },
        ),
    },
    {
      name: "distillSource",
      write: (v) =>
        void distillSource(
          v,
          {
            sourcePath: "sources/guard.md",
            claims: [{ text: "the guard fires" }],
          },
          { agent: "test-agent", now: NOW },
        ),
    },
    {
      name: "writeCaptureNote",
      write: (v) =>
        void writeCaptureNote(v, {
          body: "guarded capture",
          provenance: {
            source: "telegram",
            sender: "1",
            capturedAt: "2026-07-26T00:00:00Z",
          },
        }),
    },
    {
      name: "promoteGapsToTasks",
      write: (v) => void promoteGapsToTasks(v, { now: NOW }),
    },
    {
      name: "learnSkillProposals",
      write: (v) => void learnSkillProposals(v, { now: NOW }),
    },
    {
      name: "ensureDefaultAttentionFlows",
      write: (v) => void ensureDefaultAttentionFlows(v),
    },
    {
      name: "writeRollupLedger",
      write: (v) => void writeRollupLedger(v, { version: 1, baselines: {}, produced: {} }),
    },
    {
      name: "applyWriteBatch",
      write: (v) =>
        void applyWriteBatch(v, [
          { kind: "create_note", path: "guard-note.md", content: "guarded" },
        ]),
    },

    // ----- Writers whose only guard was a TRAILING audit append --------
    //
    // Every one of these put bytes on disk and raised the mismatch
    // afterwards. The secret custody store is the worst: the keyfile and
    // the encrypted store landed in the wrong vault, outside `Brain/`,
    // where the first cut of this harness could not even see them.
    {
      name: "setSecret",
      write: (v) => void setSecret(v, SECRET_INPUT),
    },
    {
      name: "removeSecret",
      seed: (v) => void setSecret(v, SECRET_INPUT),
      write: (v) => void removeSecret(v, SECRET_INPUT.name, { agent: "test-agent", now: NOW }),
    },
    {
      // The read-shaped surface that still writes: it stamps
      // `last_used_at` and appends a custody record.
      name: "resolveSecretForExec",
      seed: (v) => void setSecret(v, SECRET_INPUT),
      write: (v) =>
        void resolveSecretForExec(v, SECRET_INPUT.name, { agent: "test-agent", now: NOW }),
    },
    {
      name: "applySchemaMutations",
      write: async (v) => {
        await applySchemaMutations(v, [{ op: "add_link_type", token: "guards" }], {
          actor: "test-agent",
          now: NOW,
        });
      },
    },
    {
      name: "archivePage",
      seed: (v) => void writeGuardPage(v),
      write: (v) => void archivePage(v, guardPagePath(v), NOW),
    },
    {
      name: "applyHygienePlan",
      seed: (v) => void writeGuardPage(v),
      write: async (v) => {
        await applyHygienePlan(v, archivePlan(guardPagePath(v)), {
          agent: "test-agent",
          now: NOW,
        });
      },
    },

    // ----- Unguarded writers inside modules counted as guarded ---------
    //
    // `brain_pinned_context` refused a mismatched vault in single-op
    // mode and wrote to it in `operations` batch mode - same tool, same
    // file, same call.
    {
      name: "applyPinnedOperations",
      write: (v) => void applyPinnedOperations(v, [{ op: "write", content: "guarded" }]),
    },
    {
      name: "confirmTension",
      seed: (v) => {
        seededTensionSlug = persistTension(v, TENSION_FINDING, { now: NOW }).record.slug;
      },
      write: (v) => void confirmTension(v, seededTensionSlug, { now: NOW }),
    },
    {
      name: "autoCloseRecalledGaps",
      seed: (v) => void seedOpenGapTask(v),
      write: async (v) => {
        await autoCloseRecalledGaps(v, RECALL_RETRIEVER, { confidenceFloor: 0.5, now: NOW });
      },
    },
    {
      name: "pruneSnapshots",
      seed: (v) => void seedSnapshotArchive(v),
      write: (v) => void pruneSnapshots(v, 0),
    },

    // ----- High-traffic MCP-reachable writers with no guard at all -----
    {
      name: "createNote",
      write: (v) => void createNote(v, { path: "notes/guard-created.md", content: "x" }),
    },
    {
      name: "appendContinuityRecord",
      write: (v) =>
        void appendContinuityRecord(v, {
          kind: "session_turn",
          createdAt: "2026-07-26T00:00:00Z",
          payload: { session_id: "guard", turn_id: "t-1", role: "user", text: "guarded" },
        }),
    },
    {
      name: "appendContinuityRecords",
      write: (v) =>
        void appendContinuityRecords(v, [
          {
            kind: "session_turn",
            createdAt: "2026-07-26T00:00:00Z",
            payload: { session_id: "guard", turn_id: "t-2", role: "user", text: "guarded" },
          },
        ]),
    },
    {
      name: "recordDeadEnd",
      write: (v) =>
        void recordDeadEnd(v, {
          approach: "Trailing audit append as a write guard",
          reason: "the bytes land before the refusal",
          agent: "test-agent",
          now: NOW,
        }),
    },
    {
      name: "appendDecisionChangeReceipt",
      write: (v) =>
        void appendDecisionChangeReceipt(v, {
          ts: "2026-07-26T00:00:00Z",
          subject: "pref-guard-pref",
          before: "confidence:medium(0.55)",
          after: "confidence:high(0.88)",
          evidenceTriggers: [],
          confidenceDelta: 0.33,
          alternatives: [],
          actor: "test-agent",
          rationale: "guard the write path",
          reasonCode: "confidence-refresh",
        }),
    },
    {
      name: "createWriteSession",
      write: (v) => void createWriteSession(v, WRITE_SESSION_NOW, (id) => writeSessionRecord(id)),
    },
    {
      name: "appendClaimEvent",
      write: (v) =>
        void appendClaimEvent(v, {
          ts: "2026-07-26T00:00:00Z",
          agent: "test-agent",
          entity: "Guard Subject",
          aspect: "employer",
          value: "Anthropic",
          source: "[[Brain/notes/guard.md]]",
        }),
    },
    {
      name: "writeTruthState",
      write: (v) =>
        void writeTruthState(v, {
          version: TRUTH_SCHEMA_VERSION,
          events: 0,
          updatedAt: null,
          slots: [],
          conflicts: [],
        }),
    },
    {
      name: "setIntention",
      write: (v) =>
        void setIntention(v, {
          scope: "guard",
          text: "Guard the write path",
          agent: "test-agent",
          now: NOW,
        }),
    },
    {
      name: "createTriggers",
      write: (v) => void createTriggers(v, [TRIGGER_CANDIDATE], { now: NOW }),
    },
    {
      name: "assignNoteLabel",
      seed: (v) => void writeGuardPage(v),
      write: (v) =>
        void assignNoteLabel(v, GUARD_PAGE_REL, {
          dimension: "priority",
          value: "high",
          pack: LABEL_PACK,
          agent: "test-agent",
          now: NOW,
        }),
    },
    {
      name: "writeHandoffNote",
      write: (v) =>
        void writeHandoffNote(v, {
          turns: [
            {
              turnId: "t-1",
              timestamp: "2026-07-26T00:00:00Z",
              role: "user",
              text: "guard the write path",
            },
          ],
          sessionId: "guard-session",
          agent: "test-agent",
          now: NOW,
        }),
    },
    {
      name: "refreshAnticipatoryCache",
      seed: (v) =>
        void recordLineageObservation(v, {
          sessionId: "guard-child",
          at: NOW.toISOString(),
          event: "SessionStart",
          lineage: { rootId: "guard-root", parentId: "guard-root", depth: 1, source: "payload" },
        }),
      write: (v) =>
        void refreshAnticipatoryCache(v, {
          sessionId: "guard-child",
          signalText: "guarding the write path",
          now: NOW,
        }),
    },
  ];

  for (const testCase of CASES) {
    test(`${testCase.name} refuses a vault whose marker changed`, async () => {
      bootstrapBrain(vault, { configPath });
      await testCase.seed?.(vault);
      // Pin what this process has been writing to.
      brainDirsForWrite(vault);

      // The store under this path is now a different vault.
      rmSync(vaultIdentityPath(vault));
      writeVaultIdentity(vault);
      const before = snapshotVaultTree(vault);

      let raised: unknown;
      try {
        await testCase.write(vault);
      } catch (err) {
        raised = err;
      }
      // The byte assertion comes FIRST and deliberately so. Refusing
      // AFTER the bytes landed is not refusing: a writer that trips the
      // guard only on a downstream log append has already materialized a
      // page in the wrong store. Asserting the throw first would report
      // "it threw" and hide the bytes, which is exactly how this class of
      // defect survived the previous review.
      expect(snapshotVaultTree(vault)).toEqual(before);
      expect(raised).toBeInstanceOf(VaultIdentityMismatchError);
    });
  }
});

/**
 * Digest of EVERY file under the vault root, keyed by vault-relative
 * path, PLUS one entry per directory.
 *
 * The whole root, not just `Brain/`: the secret custody store lives in
 * `<vault>/.open-second-brain/secrets/` and `createNote` authors notes
 * anywhere the vault scope allows, so a `Brain/`-only walk cannot see
 * the bytes those writers land - which is precisely why the secrets
 * store shipped with its guard behind the first byte.
 *
 * Directories are recorded because a bare `mkdirSync` leaves no file
 * behind: `loadOrCreateKey` creates the 0700 secrets directory before it
 * writes anything, and a file-only digest would call that "no trace".
 * The identity marker is excluded because the harness rewrites it
 * between the snapshot and the call.
 */
function snapshotVaultTree(vaultRoot: string): Record<string, string> {
  const markerRel = relative(vaultRoot, vaultIdentityPath(vaultRoot));
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(vaultRoot, abs);
      if (entry.isDirectory()) {
        out[`${rel}/`] = "<dir>";
        walk(abs);
        continue;
      }
      if (rel === markerRel) continue;
      out[rel] = createHash("sha256").update(readFileSync(abs)).digest("hex");
    }
  };
  if (existsSync(vaultRoot)) walk(vaultRoot);
  return out;
}

/**
 * The other half of the contract: widening the guard onto read paths
 * would break the fail-open surfaces (`src/openclaw`, the hooks), so a
 * read must stay indifferent to the marker.
 */
describe("the guard stays off read paths", () => {
  const READS: ReadonlyArray<{ name: string; read: (vault: string) => void }> = [
    { name: "listPending", read: (v) => void listPending(v) },
    { name: "runDoctor", read: (v) => void runDoctor(v) },
    { name: "computeBrainStatus", read: (v) => void computeBrainStatus(v) },
    { name: "collectExportRows", read: (v) => void collectExportRows(v) },
  ];

  for (const testCase of READS) {
    test(`${testCase.name} is indifferent to a changed marker`, () => {
      bootstrapBrain(vault, { configPath });
      brainDirsForWrite(vault);
      rmSync(vaultIdentityPath(vault));
      writeVaultIdentity(vault);
      expect(() => testCase.read(vault)).not.toThrow();
    });
  }
});

/**
 * The absent-marker half used to be reachable only by passing an optional
 * sink no production call site passed, and the module docblock claimed the
 * doctor surfaced it while `runDoctor` imported nothing from here. These
 * pin the replacement: one exported check that reads the marker, and one
 * production channel that reports it.
 */
describe("vaultMarkerAbsentNotice", () => {
  test("names an unmarked root with the closed-vocabulary code", () => {
    const notice = vaultMarkerAbsentNotice(vault);
    expect(notice).not.toBeNull();
    expect(notice!.code).toBe("vault-marker-absent");
    expect(notice!.site).toBe("vault-identity");
    expect(notice!.path).toBe(vault);
  });

  test("is silent once the root carries a marker", () => {
    writeVaultIdentity(vault);
    expect(vaultMarkerAbsentNotice(vault)).toBeNull();
  });

  test("treats a malformed marker as absent, never as a mismatch", () => {
    writeFileSync(vaultIdentityPath(vault), "{ not json", "utf8");
    expect(vaultMarkerAbsentNotice(vault)?.code).toBe("vault-marker-absent");
  });

  test("is the same record the write-path sink receives", () => {
    const notices: DegradationNotice[] = [];
    brainDirsForWrite(vault, notices);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toEqual(vaultMarkerAbsentNotice(vault)!);
  });
});

/**
 * The honest limit of the mechanism, asserted rather than described: the
 * only reachable refusal is same-path, marker-changed, mid-process.
 */
describe("what the guard does NOT catch", () => {
  test("a cold-start mis-resolution proceeds and is reported, not refused", () => {
    // The reviewer's probe: a never-existent sibling root.
    const wrong = `${vault}t`;
    try {
      expect(() =>
        appendLogEvent(wrong, {
          timestamp: "2026-07-26T00:00:00Z",
          eventType: "note",
          agent: "test-agent",
          body: { text: "mis-resolved" },
        }),
      ).not.toThrow();
      // The bytes really did land under the wrong root - the guard has no
      // durable expectation to compare a cold start against.
      expect(existsSync(join(wrong, "Brain", "log"))).toBe(true);
      // What it gets instead is a named notice on that root.
      expect(vaultMarkerAbsentNotice(wrong)?.code).toBe("vault-marker-absent");
    } finally {
      rmSync(wrong, { recursive: true, force: true });
    }
  });

  test("two distinct roots in one process are independent", () => {
    const other = mkdtempSync(join(tmpdir(), "o2b-vault-identity-other-"));
    try {
      mkdirSync(join(other, "Brain"), { recursive: true });
      writeVaultIdentity(vault);
      writeVaultIdentity(other);
      expect(() => brainDirsForWrite(vault)).not.toThrow();
      expect(() => brainDirsForWrite(other)).not.toThrow();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("a deleted marker stops refusing rather than starting to", () => {
    writeVaultIdentity(vault);
    brainDirsForWrite(vault);
    rmSync(vaultIdentityPath(vault));
    expect(() => brainDirsForWrite(vault)).not.toThrow();
  });
});

describe("bootstrap path", () => {
  test("o2b brain init stamps the marker and never trips the guard", () => {
    expect(existsSync(vaultIdentityPath(vault))).toBe(false);
    expect(() => bootstrapBrain(vault, { configPath })).not.toThrow();
    const identity = readVaultIdentity(vault);
    expect(identity).not.toBeNull();

    // A second bootstrap keeps the identity it already established.
    bootstrapBrain(vault, { configPath });
    expect(readVaultIdentity(vault)!.vault_id).toBe(identity!.vault_id);

    const notices: DegradationNotice[] = [];
    expect(() => brainDirsForWrite(vault, notices)).not.toThrow();
    expect(notices).toHaveLength(0);
  });
});

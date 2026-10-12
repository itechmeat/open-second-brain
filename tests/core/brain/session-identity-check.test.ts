/**
 * The blank-session-identity check (t_22d58fa7), and the census that
 * keeps its kind classification honest.
 *
 * Readers across the continuity surface used to coerce a missing or
 * non-string `session_id` to "" - a phantom identity no writer ever
 * stamped. The readers now treat absence as no-session explicitly, and
 * this check is the vault-level mirror of that decision: it COUNTS the
 * records that name no session, one issue per affected kind, and does
 * nothing else. No `fix` field (a session no writer stamped cannot be
 * restored from the record, and the ledger is append-only history), no
 * payload rewrite, and an unreadable ledger is an uncertainty rather
 * than a clean bill.
 *
 * The census half exists because most of the ledger is sessionless BY
 * DESIGN: the telemetry lanes (`gate-telemetry.ts`, `recall-telemetry.ts`,
 * `observed-use.ts`, `recent-turns.ts`, `token-impact.ts`,
 * `context-pack-evidence.ts`, `context-pack-outcome.ts`,
 * `context-receipts.ts`) stamp the key only when their lane has a session
 * in scope, `appendContinuitySourceInvalidation` writes only `{reason}`,
 * and the remaining kinds correlate their session outside the payload key
 * entirely. Counting those put a permanent warning on every used vault
 * and made `--strict` unexitable, so the check counts only the kinds
 * whose writer stamps `session_id` unconditionally from a required
 * input. The census pins that classification three ways: every kind in
 * the `ContinuityRecordKind` union is classified exactly once, the named
 * sessionless writers' files stay out of the count (a behavioural case
 * per kind), and each kind's pinned writer file still has the stamp
 * shape its classification claims.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { lexSource } from "../../helpers/source-lexer.ts";
import { emitGateTelemetry } from "../../../src/core/brain/gate-telemetry.ts";
import {
  appendContinuityRecord,
  appendContinuitySourceInvalidation,
} from "../../../src/core/brain/continuity/store.ts";
import type {
  AppendContinuityRecordInput,
  ContinuityRecordKind,
} from "../../../src/core/brain/continuity/types.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import {
  SESSION_IDENTITY_CHECK_CODE,
  SESSION_IDENTITY_CHECKED_KINDS,
  sessionIdentityCheck,
} from "../../../src/core/brain/doctor/session-identity-check.ts";
import type { DoctorUncertainEntry } from "../../../src/core/brain/doctor/report.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import type { DoctorIssue } from "../../../src/core/brain/types.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-session-identity-"));
  vault = join(tmp, "vault");
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seed(
  payload: Record<string, unknown>,
  kind: AppendContinuityRecordInput["kind"] = "session_turn",
): void {
  appendContinuityRecord(vault, {
    kind,
    createdAt: "2026-06-01T00:00:00.000Z",
    payload,
  });
}

function findings(): { issues: DoctorIssue[]; uncertain: DoctorUncertainEntry[] } {
  const issues: DoctorIssue[] = [];
  const uncertain: DoctorUncertainEntry[] = [];
  sessionIdentityCheck.run(
    {
      vault,
      now: new Date("2026-06-02T00:00:00.000Z"),
      logs: [],
    } as unknown as Parameters<typeof sessionIdentityCheck.run>[0],
    { issues, uncertain },
  );
  return { issues, uncertain };
}

describe("blank-session-identity counts, and only counts", () => {
  test("one issue per affected kind, carrying the count, with no fix field", () => {
    seed({ turn_id: "t1", text: "names no session" });
    seed({ turn_id: "t2", text: "names no session either" });
    seed({ depth: 1, summary: "node names no session" }, "session_summary_node");
    seed({ session_id: "sess-real", turn_id: "t3", text: "attributed" });

    const { issues, uncertain } = findings();
    expect(uncertain).toEqual([]);
    expect(issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining("1 session_summary_node"),
      expect.stringContaining("2 session_turn"),
    ]);
    for (const issue of issues) {
      expect(issue.severity).toBe("warning");
      expect(issue.code).toBe(SESSION_IDENTITY_CHECK_CODE);
      expect("fix" in issue).toBe(false);
    }
  });

  test("an empty-string or non-string session_id counts as blank, never as an identity", () => {
    seed({ session_id: "", turn_id: "t1", text: "blank string" });
    seed({ session_id: 42, turn_id: "t2", text: "numeric" });

    const { issues } = findings();
    expect(issues.length).toBe(1);
    expect(issues[0]!.message).toContain("2 session_turn");
  });

  test("every kind whose writer stamps a session is counted when its id is blank", () => {
    // Regression: the census narrowed the count to the session-scoped
    // kinds; each of them must still count exactly as before, one issue
    // per kind, kinds in deterministic order.
    const checked: ReadonlyArray<AppendContinuityRecordInput["kind"]> = [
      "decision_model_extract_commit",
      "post_compact_audit",
      "pre_compact_extract",
      "session_summary_digest",
      "session_summary_node",
      "session_turn",
    ];
    for (const kind of checked) seed({}, kind);

    const { issues, uncertain } = findings();
    expect(uncertain).toEqual([]);
    expect(issues.length).toBe(checked.length);
    expect(issues.map((issue) => issue.message)).toEqual(
      [
        "1 decision_model_extract_commit",
        "1 post_compact_audit",
        "1 pre_compact_extract",
        "1 session_summary_digest",
        "1 session_summary_node",
        "1 session_turn",
      ].map((fragment) => expect.stringContaining(fragment)),
    );
  });

  test("a clean ledger is quiet", () => {
    seed({ session_id: "sess-a", turn_id: "t1", text: "attributed" });
    expect(findings().issues).toEqual([]);
  });

  test("an unreadable ledger is an uncertain stream outcome, never a throw or a finding", () => {
    // A regular file where the continuity directory belongs: the listing
    // fails for a reason that is not absence, which is precisely what the
    // uncertainty stream exists for.
    const continuity = join(vault, "Brain", "log", "continuity");
    mkdirSync(join(vault, "Brain", "log"), { recursive: true });
    writeFileSync(continuity, "not a directory\n");

    const { issues, uncertain } = findings();
    expect(issues).toEqual([]);
    expect(uncertain.length).toBe(1);
    expect(uncertain[0]!.code).toBe("vault-walk-entry-skipped");
  });

  test("an absent ledger is the ordinary quiet case, not uncertainty", () => {
    rmSync(join(vault, "Brain", "log", "continuity"), { recursive: true, force: true });
    const { issues, uncertain } = findings();
    expect(issues).toEqual([]);
    expect(uncertain).toEqual([]);
  });
});

describe("blank-session-identity skips the sessionless-by-design kinds", () => {
  test("sessionless gate telemetry and a source invalidation leave the check silent and the vault clean", () => {
    // The review's reproduction: a vault whose ONLY continuity records
    // are one gate decision written with no session in scope (exactly
    // what `emitGateTelemetry` does under the recall-gate opt-in) and
    // one source invalidation (which writes only `{reason}`). Both are
    // sessionless by design, so this check counts nothing, `brain
    // doctor` reads clean, and `--strict` (which exits 2 exactly when
    // the pass has warnings) exits 0.
    emitGateTelemetry(vault, {
      host: "cli",
      prompt: "what changed",
      retrieve: false,
      reason: "no-index",
    });
    appendContinuitySourceInvalidation(vault, {
      createdAt: "2026-06-01T00:00:00.000Z",
      source: { id: "src-1" },
      reason: "source deleted",
    });

    const { issues, uncertain } = findings();
    expect(uncertain).toEqual([]);
    expect(issues).toEqual([]);

    const result = runDoctor(vault);
    expect(result.warnings).toEqual([]);
  });

  test("every sessionless-by-design kind produces no issue, taken one record at a time", () => {
    // The behavioural half of the census: each kind classified
    // sessionless below (minus `source_invalidation`, covered above
    // through its writer) is seeded as the sessionless record its
    // writer legitimately produces, and the check must stay silent on
    // every one of them.
    const { sessionlessKinds } = classification();
    expect(sessionlessKinds.length).toBeGreaterThan(10);
    for (const kind of sessionlessKinds) {
      if (kind === "source_invalidation") continue; // writer-level case above
      appendContinuityRecord(vault, {
        kind: kind as AppendContinuityRecordInput["kind"],
        createdAt: "2026-06-01T00:00:00.000Z",
        payload: {},
      });
    }

    const { issues } = findings();
    expect(issues).toEqual([]);
  });
});

describe("blank-session-identity runs in the pass", () => {
  test("runDoctor reports the count with zero config", () => {
    seed({ turn_id: "t1", text: "names no session" });
    const result = runDoctor(vault);
    const warning = result.warnings.find((issue) => issue.code === SESSION_IDENTITY_CHECK_CODE);
    expect(warning).toBeDefined();
    expect(warning!.message).toContain("1 session_turn");
  });

  test("a clean vault stays clean", () => {
    const result = runDoctor(vault);
    expect(result.warnings.some((issue) => issue.code === SESSION_IDENTITY_CHECK_CODE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The classification census.
//
// Mirrors the sibling censuses: a lexed view of each module
// (`tests/helpers/source-lexer.ts`), so a kind discussed in a docblock is
// not a writer and a stamp named in a string literal is not a site.
// ---------------------------------------------------------------------------

const SRC_ROOT = join(import.meta.dir, "..", "..", "..", "src");

/** The store's append primitives - binding one is what makes a module a writer. */
const APPEND_PRIMITIVES: ReadonlyArray<string> = Object.freeze([
  "appendContinuityRecord",
  "appendContinuityRecords",
  "appendContinuitySourceInvalidation",
]);

/**
 * A payload stamp written unconditionally, from a required binding.
 * `session_id: sessionId`, `session_id: input.sessionId`, ...
 * (`session_id?: string` in an interface is not a stamp; a read of
 * `payload["session_id"]` is not one either.)
 */
const UNCONDITIONAL_STAMP_RE = /session_id: [A-Za-z$_]/;

/**
 * The conditional-spread shape the sessionless lanes stamp with:
 * `...(input.sessionId !== undefined ? { session_id: ... } : {})`, under
 * either spelling of the key.
 */
const CONDITIONAL_STAMP_RE = /\? \{ (?:\[CONTINUITY_SESSION_ID_KEY\]|session_id\b)/;

/**
 * Every kind the census classifies, with the module(s) whose code shapes
 * that kind's payload. The writers of `source_invalidation` all funnel
 * through `appendContinuitySourceInvalidation`, whose `{reason}` payload
 * is fixed at the store and whose input type carries no session field.
 */
const KIND_WRITERS: ReadonlyArray<{
  readonly kind: ContinuityRecordKind;
  /** Session-scoped: the writer stamps `session_id` unconditionally. */
  readonly sessionScoped: boolean;
  readonly writers: ReadonlyArray<string>;
}> = Object.freeze([
  { kind: "context_receipt", sessionScoped: false, writers: ["core/brain/context-receipts.ts"] },
  { kind: "recall_telemetry", sessionScoped: false, writers: ["core/brain/recall-telemetry.ts"] },
  { kind: "gate_telemetry", sessionScoped: false, writers: ["core/brain/gate-telemetry.ts"] },
  {
    kind: "pre_compact_extract",
    sessionScoped: true,
    writers: ["core/brain/pre-compact-extract.ts"],
  },
  {
    kind: "post_compact_audit",
    sessionScoped: true,
    writers: ["core/brain/post-compact-audit.ts"],
  },
  {
    kind: "session_turn",
    sessionScoped: true,
    writers: ["core/brain/session-recall.ts"],
  },
  { kind: "recent_turn", sessionScoped: false, writers: ["core/brain/recent-turns.ts"] },
  {
    kind: "session_summary_node",
    sessionScoped: true,
    writers: ["core/brain/session-recall.ts"],
  },
  {
    kind: "session_summary_digest",
    sessionScoped: true,
    writers: ["core/brain/session-summary.ts"],
  },
  {
    kind: "generation_report",
    sessionScoped: false,
    writers: ["core/brain/generation-reports.ts"],
  },
  { kind: "ingest_dedup", sessionScoped: false, writers: ["core/brain/dedup-telemetry.ts"] },
  { kind: "mcp_route_latency", sessionScoped: false, writers: ["core/brain/mcp-route-metrics.ts"] },
  { kind: "token_impact", sessionScoped: false, writers: ["core/brain/token-impact.ts"] },
  {
    kind: "token_impact_outcome",
    sessionScoped: false,
    writers: ["core/brain/token-impact.ts"],
  },
  {
    kind: "context_pack_outcome",
    sessionScoped: false,
    writers: ["core/brain/context-pack-outcome.ts"],
  },
  {
    kind: "context_pack_evidence",
    sessionScoped: false,
    writers: ["core/brain/context-pack-evidence.ts"],
  },
  { kind: "host_memory_write", sessionScoped: false, writers: ["core/brain/host-memory-write.ts"] },
  { kind: "recall_observed_use", sessionScoped: false, writers: ["core/brain/observed-use.ts"] },
  { kind: "skill_invoked", sessionScoped: false, writers: ["core/brain/sessions/import.ts"] },
  {
    kind: "source_invalidation",
    sessionScoped: false,
    writers: [
      "core/brain/continuity/store.ts",
      "core/brain/source-cleanup.ts",
      "core/brain/portability/knowledge-pack.ts",
    ],
  },
  { kind: "negative_recall", sessionScoped: false, writers: ["core/brain/gate-telemetry.ts"] },
  { kind: "decision_model_call", sessionScoped: false, writers: ["core/decision-model/record.ts"] },
  {
    kind: "decision_model_extract_commit",
    sessionScoped: true,
    writers: ["core/brain/extract-signals-prefilter.ts"],
  },
  {
    kind: "session_entity_mention",
    sessionScoped: false,
    writers: ["core/brain/link-graph/session-mining.ts"],
  },
]);

/**
 * A benchmark fixture writes throwaway ledgers for timing runs, not a
 * vault a doctor pass will ever examine. Named here so the writer
 * population below accounts for it by name rather than by silence.
 */
const FIXTURE_WRITER = "core/bench/fixture.ts";

/** Every .ts file under src, as POSIX paths relative to it, sorted. */
function srcModulePaths(): ReadonlyArray<string> {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).toSorted()) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      if (name.endsWith(".ts")) out.push(relative(SRC_ROOT, abs).split(sep).join("/"));
    }
  };
  walk(SRC_ROOT);
  return out;
}

/** The `ContinuityRecordKind` union, read out of `types.ts` at census time. */
function declaredKinds(): ReadonlyArray<string> {
  const view = lexSource(
    readFileSync(join(SRC_ROOT, "core", "brain", "continuity", "types.ts"), "utf8"),
  );
  const start = view.withoutComments.indexOf("export type ContinuityRecordKind");
  const end = view.withoutComments.indexOf(";", start);
  const union = view.withoutComments.slice(start, end);
  return [...union.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]!);
}

/** The census tables, checked for internal consistency once per run. */
function classification(): {
  readonly checkedKinds: ReadonlyArray<ContinuityRecordKind>;
  readonly sessionlessKinds: ReadonlyArray<ContinuityRecordKind>;
} {
  const checked = KIND_WRITERS.filter((row) => row.sessionScoped).map((row) => row.kind);
  const sessionless = KIND_WRITERS.filter((row) => !row.sessionScoped).map((row) => row.kind);
  return { checkedKinds: checked, sessionlessKinds: sessionless };
}

describe("blank-session-identity classification census", () => {
  test("the sweep sees the vault-facing src tree", () => {
    // A census over an empty sweep is a claim about a census; pin the
    // population's scale and a load-bearing member's presence.
    const paths = srcModulePaths();
    expect(paths.length).toBeGreaterThan(100);
    expect(paths).toContain("core/brain/continuity/types.ts");
  });

  test("the check's allowlist is exactly the session-scoped classification", () => {
    const { checkedKinds } = classification();
    expect([...SESSION_IDENTITY_CHECKED_KINDS].toSorted()).toEqual(checkedKinds.toSorted());
  });

  test("every declared kind is classified exactly once, session-scoped or sessionless by design", () => {
    const declared = declaredKinds();
    const { checkedKinds, sessionlessKinds } = classification();
    // The union parse must have read the real population, not a fragment.
    expect(declared.length).toBeGreaterThanOrEqual(20);
    expect(declared.toSorted()).toEqual([...checkedKinds, ...sessionlessKinds].toSorted());
    expect(new Set([...checkedKinds].filter((k) => sessionlessKinds.includes(k))).size).toBe(0);
  });

  test("each kind's writer files exist and carry the stamp shape its classification claims", () => {
    for (const row of KIND_WRITERS) {
      for (const writer of row.writers) {
        const view = lexSource(readFileSync(join(SRC_ROOT, writer), "utf8"));
        const stamps = UNCONDITIONAL_STAMP_RE.test(view.withoutComments);
        const conditional = CONDITIONAL_STAMP_RE.test(view.withoutComments);
        if (row.sessionScoped) {
          // A session-scoped writer stamps unconditionally and never
          // behind the conditional spread - otherwise a sessionless
          // lane could belong on this side of the census.
          expect(stamps, `${writer} should stamp session_id unconditionally`).toBe(true);
          expect(conditional, `${writer} should not stamp session_id conditionally`).toBe(false);
        } else {
          // A sessionless writer either stamps only conditionally or
          // never touches the payload key at all (its session
          // correlation lives elsewhere).
          expect(conditional || !stamps, `${writer} should be sessionless by design`).toBe(true);
        }
      }
    }
  });

  test("the writer population is exactly the classified writers plus the named fixture", () => {
    // Any module that binds an append primitive writes SOME kind's
    // payload; if it is not classified above, its kinds are counted (or
    // spared) by a writer this census never read. Exempted: the bench
    // fixture, which writes throwaway ledgers for timing runs.
    const writers = new Set(KIND_WRITERS.flatMap((row) => row.writers));
    const population = srcModulePaths().filter((path) => {
      const code = lexSource(readFileSync(join(SRC_ROOT, path), "utf8")).code;
      return APPEND_PRIMITIVES.some((primitive) => code.includes(primitive));
    });
    expect(population.toSorted()).toEqual([...writers, FIXTURE_WRITER].toSorted());
  });
});

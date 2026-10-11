/**
 * The hallways pass (recall-quality wave, Lane B / t_13a82a31).
 *
 * Sessions are the hallways: entities that keep turning up in the same
 * transcripts are related even when no vault page links them. The pass
 * reads ONLY the mined-mention ledger - never a vault page, and never
 * the vault-derived co-occurrence graph, which skips `Brain/` and has a
 * different reach by design - and scores key pairs with the SAME
 * pairwise-PMI math the co-occurrence pass uses over documents, with
 * sessions in the document role. Output is a derived, dataset-hashed,
 * fail-soft artifact plus a REVIEWABLE proposals file with persisted
 * dismissals (the bridges pattern). Nothing here promotes anything.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { appendContinuityRecord } from "../../../../src/core/brain/continuity/store.ts";
import {
  createSafeguard,
  SafeguardAbortError,
  type Safeguard,
} from "../../../../src/core/brain/safeguard.ts";
import { SESSION_ENTITY_MENTION_KIND } from "../../../../src/core/brain/link-graph/session-mining.ts";
import {
  DEFAULT_PROMOTION_MIN_SESSIONS,
  HALLWAYS_ARTIFACT_REL,
  HALLWAYS_DISMISSED_REL,
  HALLWAYS_PROPOSALS_REL,
  HALLWAYS_SCHEMA_VERSION,
  PAIRWISE_CHECKPOINT_EVERY,
  computeHallways,
  dismissHallwayKey,
  hallwaysKeyId,
  hallwaysPairKey,
  readDismissedHallwayKeys,
  readHallwaysArtifact,
  writeHallwaysArtifact,
  writeHallwaysProposals,
} from "../../../../src/core/brain/link-graph/hallways.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-hallways-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/** One mined-mention ledger row. */
function mention(
  family: string,
  key: string,
  sessionRef: string,
  opts: { readonly private?: boolean } = {},
): void {
  appendContinuityRecord(vault, {
    kind: SESSION_ENTITY_MENTION_KIND,
    createdAt: "2026-09-18T09:00:00Z",
    sourceRefs: [{ id: `${sessionRef}:u-0:${family}:${key}` }],
    ...(opts.private === true ? { private: true } : {}),
    payload: { family, key, session_ref: sessionRef, turn_id: "u-0" },
  });
}

describe("computeHallways - incidence and PMI", () => {
  test("two keys co-mentioned in enough sessions get one scored pair", () => {
    mention("symbol", "SessionStore", "s1.jsonl");
    mention("symbol", "PayloadRegistry", "s1.jsonl");
    mention("symbol", "SessionStore", "s2.jsonl");
    mention("symbol", "PayloadRegistry", "s2.jsonl");
    // A third session enlarges the universe and holds an unrelated key.
    mention("symbol", "Unrelated", "s3.jsonl");

    const result = computeHallways(vault, { minCoSessions: 2 });

    expect(result.sessionCount).toBe(3);
    const left = hallwaysKeyId("symbol", "PayloadRegistry");
    const right = hallwaysKeyId("symbol", "SessionStore");
    const pair = result.pairs.find((p) => p.left === left && p.right === right);
    expect(pair).toBeDefined();
    expect(pair!.coSessionCount).toBe(2);
    // The co-occurrence formula with sessions in the document role:
    // log2((co * N) / (dfA * dfB)) = log2(6 / 4).
    expect(pair!.score).toBe(0.584963);
  });

  test("a pair below the co-session floor stays out; a dismissed key drops from keys only", () => {
    mention("symbol", "SessionStore", "s1.jsonl");
    mention("symbol", "PayloadRegistry", "s1.jsonl");

    expect(computeHallways(vault, { minCoSessions: 2 }).pairs).toEqual([]);

    dismissHallwayKey(vault, "symbol", "SessionStore");
    const result = computeHallways(vault, {
      minCoSessions: 1,
      dismissed: readDismissedHallwayKeys(vault),
    });
    expect(result.keys.map((k) => k.key)).toEqual(["PayloadRegistry"]);
    // Pairs stay the pure derivation; dismissal silences proposals, not math.
    expect(result.pairs.length).toBe(1);
  });

  test("a mention row flagged private never reaches the incidence", () => {
    mention("symbol", "SessionStore", "s1.jsonl");
    mention("symbol", "SessionStore", "s2.jsonl", { private: true });

    const result = computeHallways(vault);
    expect(result.sessionCount).toBe(1);
    expect(result.keys.map((k) => k.sessionCount)).toEqual([1]);
  });

  test("duplicate ledger rows fold at (family, key, sessionRef)", () => {
    mention("symbol", "SessionStore", "s1.jsonl");
    mention("symbol", "SessionStore", "s1.jsonl");

    const result = computeHallways(vault);
    expect(result.keys).toEqual([{ family: "symbol", key: "SessionStore", sessionCount: 1 }]);
  });

  test("an empty ledger yields an empty derivation, not an error", () => {
    const result = computeHallways(vault);
    expect(result.sessionCount).toBe(0);
    expect(result.keys).toEqual([]);
    expect(result.pairs).toEqual([]);
  });
});

describe("the hallways artifact", () => {
  test("write then read round-trips through the derived-artifact rails", () => {
    mention("symbol", "SessionStore", "s1.jsonl");
    const result = computeHallways(vault);

    const path = writeHallwaysArtifact(vault, result, {
      generatedAt: "2026-09-18T10:00:00Z",
    });

    expect(path.endsWith(HALLWAYS_ARTIFACT_REL.split("\\").join("/"))).toBe(true);
    const raw = JSON.parse(
      readFileSync(join(vault, "Brain", "link-graph", "hallways.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(raw["schema"]).toBe(HALLWAYS_SCHEMA_VERSION);
    expect(HALLWAYS_SCHEMA_VERSION).toBe("o2b.hallways.v1");
    expect(typeof raw["dataset_hash"]).toBe("string");
    expect(readHallwaysArtifact(vault, result.datasetHash)).toEqual(result);
  });

  test("a torn artifact reads as null (fail-soft)", () => {
    mention("symbol", "SessionStore", "s1.jsonl");
    const result = computeHallways(vault);
    writeHallwaysArtifact(vault, result, { generatedAt: "2026-09-18T10:00:00Z" });

    writeFileSync(join(vault, "Brain", "link-graph", "hallways.json"), "{ torn", "utf8");

    expect(readHallwaysArtifact(vault, result.datasetHash)).toBeNull();
  });

  test("a schema mismatch reads as null", () => {
    mention("symbol", "SessionStore", "s1.jsonl");
    const result = computeHallways(vault);
    writeHallwaysArtifact(vault, result, { generatedAt: "2026-09-18T10:00:00Z" });

    const path = join(vault, "Brain", "link-graph", "hallways.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    raw["schema"] = "o2b.hallways.v999";
    writeFileSync(path, JSON.stringify(raw), "utf8");

    expect(readHallwaysArtifact(vault, result.datasetHash)).toBeNull();
  });

  test("a ledger that moved on expires the dataset hash: the stale artifact reads as null", () => {
    mention("symbol", "SessionStore", "s1.jsonl");
    const result = computeHallways(vault);
    writeHallwaysArtifact(vault, result, { generatedAt: "2026-09-18T10:00:00Z" });

    mention("symbol", "SessionStore", "s2.jsonl");
    // The reader derives its CURRENT input-set hash and asks with it; the
    // stored artifact was derived from the old set and fails the ask.
    const current = computeHallways(vault);
    expect(current.datasetHash).not.toBe(result.datasetHash);
    expect(readHallwaysArtifact(vault, current.datasetHash)).toBeNull();
    // Re-deriving heals the read.
    writeHallwaysArtifact(vault, current, { generatedAt: "2026-09-18T11:00:00Z" });
    expect(readHallwaysArtifact(vault, current.datasetHash)).not.toBeNull();
  });
});

describe("the proposals file and dismissals", () => {
  test("candidates at or above the threshold are listed for review", () => {
    mention("symbol", "SessionStore", "s1.jsonl");
    mention("symbol", "SessionStore", "s2.jsonl");
    mention("symbol", "SessionStore", "s3.jsonl");
    mention("symbol", "OnceOnly", "s1.jsonl");
    mention("symbol", "PayloadRegistry", "s1.jsonl");
    mention("symbol", "PayloadRegistry", "s2.jsonl");
    const result = computeHallways(vault);

    const path = writeHallwaysProposals(vault, result, {
      now: new Date("2026-09-18T10:00:00Z"),
    });

    expect(path.endsWith(HALLWAYS_PROPOSALS_REL.split("\\").join("/"))).toBe(true);
    const body = readFileSync(path, "utf8");
    expect(body).toContain("SessionStore");
    expect(body).toContain("PayloadRegistry");
    expect(body).not.toContain("OnceOnly");
    expect(DEFAULT_PROMOTION_MIN_SESSIONS).toBe(3);
  });

  test("a dismissal persists and silences the key across re-runs", () => {
    expect(dismissHallwayKey(vault, "symbol", "SessionStore")).toBe(true);
    expect(dismissHallwayKey(vault, "symbol", "SessionStore")).toBe(false);

    const dismissed = readDismissedHallwayKeys(vault);
    expect([...dismissed]).toEqual([hallwaysKeyId("symbol", "SessionStore")]);
    expect(existsSync(join(vault, "Brain", "proposals", "hallways-dismissed.json"))).toBe(true);
    expect(HALLWAYS_DISMISSED_REL.split("\\").join("/")).toBe(
      "Brain/proposals/hallways-dismissed.json",
    );
  });

  test("a dismissed key does not appear in a regenerated proposals file", () => {
    mention("symbol", "SessionStore", "s1.jsonl");
    mention("symbol", "SessionStore", "s2.jsonl");
    mention("symbol", "SessionStore", "s3.jsonl");
    dismissHallwayKey(vault, "symbol", "SessionStore");
    const result = computeHallways(vault, {
      dismissed: readDismissedHallwayKeys(vault),
    });

    const path = writeHallwaysProposals(vault, result, {
      now: new Date("2026-09-18T10:00:00Z"),
    });

    expect(readFileSync(path, "utf8")).not.toContain("SessionStore");
  });

  test("a key containing a pipe renders as an escaped cell, not a broken table", () => {
    // A URL key can legitimately carry a pipe (some APIs separate query
    // values with one). Rendered raw inside a Markdown table row it spawns
    // a phantom cell and corrupts every row after it.
    const pipedA = "https://x.example/?a=1|b=2";
    const pipedB = "https://x.example/?c=3|d=4";
    for (const session of ["s1.jsonl", "s2.jsonl", "s3.jsonl"]) {
      mention("url", pipedA, session);
      mention("url", pipedB, session);
    }
    const result = computeHallways(vault);

    const path = writeHallwaysProposals(vault, result, {
      now: new Date("2026-09-18T10:00:00Z"),
    });

    const body = readFileSync(path, "utf8");
    // The candidates table escapes the pipe; the raw form never appears.
    expect(body).toContain("a=1\\|b=2");
    expect(body).toContain("c=3\\|d=4");
    expect(body).not.toContain("a=1|b=2");
    expect(body).not.toContain("c=3|d=4");
    // The pairs table interpolates family-scoped ids, which embed the key:
    // its cells escape too.
    const pairRow = body.split("\n").find((line) => line.startsWith("| url:https"));
    expect(pairRow).toBeDefined();
    expect(pairRow).toContain("\\|");
    expect(pairRow).not.toMatch(/\| https:[^|]*\| https:/u);
  });

  test("a dismissal also silences the pair rows a dismissed key took part in", () => {
    mention("symbol", "SessionStore", "s1.jsonl");
    mention("symbol", "PayloadRegistry", "s1.jsonl");
    mention("symbol", "SessionStore", "s2.jsonl");
    mention("symbol", "PayloadRegistry", "s2.jsonl");
    mention("symbol", "SessionStore", "s3.jsonl");
    mention("symbol", "PayloadRegistry", "s3.jsonl");
    mention("symbol", "Unrelated", "s3.jsonl");
    dismissHallwayKey(vault, "symbol", "SessionStore");
    const result = computeHallways(vault, {
      dismissed: readDismissedHallwayKeys(vault),
    });
    // The math stays pure: the pair survives the derivation...
    expect(result.pairs.length).toBe(1);

    const path = writeHallwaysProposals(vault, result, {
      now: new Date("2026-09-18T10:00:00Z"),
      dismissed: readDismissedHallwayKeys(vault),
    });

    // ...but the reviewable file silences every row the dismissal took
    // part in, exactly like a silenced bridge pair stops reappearing.
    const body = readFileSync(path, "utf8");
    expect(body).not.toContain("SessionStore");
    // The surviving key still reviews as a promotion candidate; the pair
    // section is gone with its dismissed half.
    expect(body).toContain("PayloadRegistry");
    expect(body).not.toContain("Associated pairs");
  });
});

describe("the cooperative deadline", () => {
  test("an aborted safeguard aborts the pass between stages", () => {
    mention("symbol", "SessionStore", "s1.jsonl");
    const controller = new AbortController();
    controller.abort();
    const guard = createSafeguard({ operation: "sessions", signal: controller.signal });

    expect(() => computeHallways(vault, { safeguard: guard })).toThrow(SafeguardAbortError);
  });

  test("a large single-session fold checkpoints INSIDE the session and completes", () => {
    // One hostile session with far more keys than one checkpoint interval:
    // the pairwise fold is O(k^2) within a session, so a deadline checked
    // only between sessions could never stop it. The fold must yield at
    // every interval boundary and still complete over the whole session.
    const keys = PAIRWISE_CHECKPOINT_EVERY * 2 + 150;
    for (let i = 0; i < keys; i++) mention("symbol", `Checkpoint_key_${i}`, "hostile.jsonl");

    let checkpoints = 0;
    const counting: Safeguard = {
      checkpoint: () => {
        checkpoints++;
      },
      timeoutMs: null,
      operation: "sessions",
    };
    const result = computeHallways(vault, { safeguard: counting });

    expect(result.sessionCount).toBe(1);
    expect(result.keys.length).toBe(keys);
    // Strictly more than the one between-sessions checkpoint: the fold
    // yielded at least twice inside the single session.
    expect(checkpoints).toBeGreaterThanOrEqual(3);
  });
});

describe("separation from the vault-derived co-occurrence graph", () => {
  test("the pass reads only the ledger: co-mentioning vault pages mint no pairs", () => {
    writeFileSync(join(vault, "alpha.md"), "# Alpha\n\nSee [[beta]] and [[gamma]].\n", "utf8");
    writeFileSync(join(vault, "beta.md"), "# Beta\n\nAlso [[alpha]].\n", "utf8");

    const result = computeHallways(vault);
    expect(result.sessionCount).toBe(0);
    expect(result.pairs).toEqual([]);
  });

  test("mining writes its own artifact and never the co-occurrence one", () => {
    mention("symbol", "SessionStore", "s1.jsonl");
    const result = computeHallways(vault);
    writeHallwaysArtifact(vault, result, { generatedAt: "2026-09-18T10:00:00Z" });

    expect(existsSync(join(vault, "Brain", "link-graph", "hallways.json"))).toBe(true);
    expect(existsSync(join(vault, "Brain", "link-graph", "co-occurrence.json"))).toBe(false);
  });

  test("pair keys are the U+001F unordered form, never a merged co-occurrence key", () => {
    const a = hallwaysKeyId("symbol", "SessionStore");
    const b = hallwaysKeyId("symbol", "PayloadRegistry");
    expect(hallwaysPairKey(a, b)).toBe(hallwaysPairKey(b, a));
    expect(hallwaysPairKey(a, b)).toContain("\u001f");
  });
});

/**
 * The distilled and undistilled census (session-mining-economy,
 * t_0358af42).
 *
 * The import ledger knows what was imported; the mining ledger knows what
 * was mined and with what yield. The census joins the two on the portable
 * `sessionRefIdentity` basename - never on the import ledger's absolute
 * machine-local keys - and classifies every imported session:
 *
 *   - `distilled`: mined with accepted yield on the CURRENT turn material;
 *   - `known-nothing-new`: mined barren on the current material (a
 *     tombstone), which is a different state from backlog;
 *   - `undistilled`: never mined, or mined on material that has since
 *     changed;
 *   - refused: sessions the plan would refuse (boundary, zero imported
 *     turns, zero user turns) can never be distilled and are excluded from
 *     the backlog, because counting them would nag forever about
 *     unparsable material.
 *
 * Nothing here re-hashes a source log: the join is vault-side, over the
 * two ledgers plus the continuity turns the mining lane itself reads.
 * Nothing here writes either.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { brainConfigPath } from "../../../../src/core/brain/paths.ts";
import {
  commitExtractedSignals,
  planExtractSignals,
} from "../../../../src/core/brain/extract-signals.ts";
import {
  minedTurnsHash,
  sessionMiningLedgerPath,
} from "../../../../src/core/brain/session-mining-ledger.ts";
import { buildCaptureBoundary } from "../../../../src/core/brain/capture-boundary.ts";
import { listSessionRawTurns } from "../../../../src/core/brain/session-recall.ts";
import {
  recordSessionImports,
  sessionLedgerPath,
} from "../../../../src/core/brain/sessions/discover.ts";
import { buildMiningCensus } from "../../../../src/core/brain/sessions/mining-census.ts";
import { importSession } from "../../../../src/core/brain/sessions/import.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { SESSION_RUNTIME_ID } from "../../../../src/core/runtime/host-facts.ts";
import { DERIVED_STORE_DIR } from "../../../../src/core/brain/path-constants.ts";
import * as continuityStore from "../../../../src/core/brain/continuity/store.ts";
import type { AppendContinuityRecordInput } from "../../../../src/core/brain/continuity/types.ts";

let tmp: string;
let vault: string;
let sessionsDir: string;

const NOW = new Date("2026-09-18T10:00:00Z");

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mining-census-"));
  vault = join(tmp, "vault");
  sessionsDir = mkdtempSync(join(tmpdir(), "o2b-mining-census-sessions-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(sessionsDir, { recursive: true, force: true });
});

/** One Claude-format session file with the given turns. */
function writeSession(
  name: string,
  turns: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string }>,
): string {
  const lines = turns.map((turn, i) =>
    JSON.stringify({
      type: turn.role,
      parentUuid: null,
      entrypoint: "cli",
      sessionId: "s1",
      uuid: `u-${i}`,
      timestamp: "2026-09-18T09:00:00.000Z",
      message: { role: turn.role, content: [{ type: "text", text: turn.text }] },
    }),
  );
  const path = join(sessionsDir, name);
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  return path;
}

/** Import one log (with recall, so turns reach continuity) and record it. */
async function importOne(path: string): Promise<string> {
  await importSession(vault, path, { agent: "tester", now: NOW, recall: true });
  recordSessionImports(vault, [{ path, runtime: SESSION_RUNTIME_ID.claudeCode }]);
  return path;
}

/**
 * The mined turn material the plan would embed, derived exactly as
 * `planExtractSignals` derives it (user role, unsuppressed, trimmed,
 * non-empty) - the census must hash the same material the plan mines.
 */
function minedMaterial(sessionId: string): ReadonlyArray<{
  readonly turnId: string;
  readonly text: string;
  readonly timestamp: string;
}> {
  const boundary = buildCaptureBoundary(vault);
  return listSessionRawTurns(vault, sessionId)
    .filter((turn) => turn.role === "user")
    .filter((turn) => !boundary.suppressMessage(turn.text))
    .map((turn) => ({ turnId: turn.turn_id, text: turn.text.trim(), timestamp: turn.timestamp }))
    .filter((turn) => turn.text.length > 0);
}

/**
 * Mine one session through the REAL writer - a plan, then the commit that
 * answers it, attesting the plan's surveyed hash - with nothing accepted.
 * The zero-yield record the census reads as known-nothing-new is what that
 * commit actually writes.
 */
function mineBarren(sessionId: string): void {
  const plan = planExtractSignals(vault, sessionId, { now: NOW });
  commitExtractedSignals(
    vault,
    sessionId,
    { items: [] },
    { agent: "tester", now: NOW, surveyedTurnsHash: plan.surveyedTurnsHash },
  );
}

/**
 * Mine one session through the REAL writer to a written yield. The yield
 * record the census reads as distilled is what that commit actually
 * writes - no seeded hand-crafted ledger state.
 */
function mineYield(sessionId: string): void {
  const plan = planExtractSignals(vault, sessionId, { now: NOW });
  commitExtractedSignals(
    vault,
    sessionId,
    {
      items: [
        {
          topic: `rule-of-${sessionId.replace(/\.jsonl$/, "")}`,
          signal: "positive",
          principle: "Ship the parser before the next release.",
          confidence: 0.9,
        },
      ],
    },
    { agent: "tester", now: NOW, surveyedTurnsHash: plan.surveyedTurnsHash },
  );
}

describe("buildMiningCensus", () => {
  test("a vault that imported nothing reports zero everywhere", () => {
    const census = buildMiningCensus(vault);
    expect(census.imported).toBe(0);
    expect(census.distilled).toBe(0);
    expect(census.knownNothingNew).toBe(0);
    expect(census.undistilled).toBe(0);
    expect(census.refused).toBe(0);
    expect(census.byRuntime).toEqual([]);
  });

  test("an imported, never-mined session is undistilled", async () => {
    await importOne(writeSession("alpha.jsonl", [{ role: "user", text: "ship the parser" }]));
    const census = buildMiningCensus(vault);
    expect(census.imported).toBe(1);
    expect(census.undistilled).toBe(1);
    expect(census.distilled).toBe(0);
    expect(census.knownNothingNew).toBe(0);
    expect(census.refused).toBe(0);
    expect(census.byRuntime[0]?.runtime).toBe(SESSION_RUNTIME_ID.claudeCode);
    expect(census.byRuntime[0]?.undistilledSessionIds).toEqual(["alpha.jsonl"]);
  });

  test("a mined session with accepted yield on current content is distilled", async () => {
    await importOne(writeSession("alpha.jsonl", [{ role: "user", text: "ship the parser" }]));
    mineYield("alpha.jsonl");
    const census = buildMiningCensus(vault);
    expect(census.distilled).toBe(1);
    expect(census.undistilled).toBe(0);
    expect(census.knownNothingNew).toBe(0);
  });

  test("a mined session that yielded nothing accepted is known-nothing-new, not undistilled", async () => {
    await importOne(writeSession("alpha.jsonl", [{ role: "user", text: "ship the parser" }]));
    mineBarren("alpha.jsonl");
    const census = buildMiningCensus(vault);
    expect(census.knownNothingNew).toBe(1);
    expect(census.undistilled).toBe(0);
    expect(census.distilled).toBe(0);
  });

  test("a re-import that changes the turns re-opens the session", async () => {
    const path = writeSession("alpha.jsonl", [{ role: "user", text: "ship the parser" }]);
    await importOne(path);
    mineYield("alpha.jsonl");
    expect(buildMiningCensus(vault).distilled).toBe(1);

    // A second turn lands in the same log (an edit, or a resume), and the
    // session is re-imported: the mined material grows, the recorded hash
    // no longer matches, and the session is backlog again.
    writeFileSync(
      path,
      readFileSync(path, "utf8") +
        JSON.stringify({
          type: "user",
          parentUuid: null,
          entrypoint: "cli",
          sessionId: "s1",
          uuid: "u-9",
          timestamp: "2026-09-18T09:30:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "also add tests" }] },
        }) +
        "\n",
      "utf8",
    );
    await importOne(path);
    expect(minedMaterial("alpha.jsonl").length).toBe(2);

    const census = buildMiningCensus(vault);
    expect(census.undistilled).toBe(1);
    expect(census.distilled).toBe(0);
  });

  test("a session the capture boundary refuses is excluded from the backlog", async () => {
    const config = brainConfigPath(vault);
    atomicWriteFileSync(
      config,
      readFileSync(config, "utf8") + '\nsessions:\n  ignore_patterns:\n    - "*blocked-*"\n',
    );
    const path = writeSession("blocked-one.jsonl", [{ role: "user", text: "ship the parser" }]);
    recordSessionImports(vault, [{ path, runtime: SESSION_RUNTIME_ID.claudeCode }]);
    const census = buildMiningCensus(vault);
    expect(census.imported).toBe(1);
    expect(census.refused).toBe(1);
    expect(census.undistilled).toBe(0);
  });

  test("a ledger entry whose session has no imported turns is excluded", async () => {
    const path = writeSession("never-imported.jsonl", [{ role: "user", text: "ship the parser" }]);
    recordSessionImports(vault, [{ path, runtime: SESSION_RUNTIME_ID.claudeCode }]);
    const census = buildMiningCensus(vault);
    expect(census.imported).toBe(1);
    expect(census.refused).toBe(1);
    expect(census.undistilled).toBe(0);
  });

  test("a session with imported turns but no user turns is excluded", async () => {
    await importOne(
      writeSession("assistant-only.jsonl", [{ role: "assistant", text: "build done" }]),
    );
    const census = buildMiningCensus(vault);
    expect(census.refused).toBe(1);
    expect(census.undistilled).toBe(0);
  });

  test("a message the boundary suppresses is not part of the mined material", async () => {
    const config = brainConfigPath(vault);
    atomicWriteFileSync(
      config,
      readFileSync(config, "utf8") +
        '\nsessions:\n  ignore_message_patterns:\n    - "noise-turn-present"\n',
    );
    await importOne(
      writeSession("alpha.jsonl", [
        { role: "user", text: "ship the parser" },
        { role: "user", text: "noise-turn-present" },
      ]),
    );
    // The real writer plans over the reduced material (the boundary
    // suppresses the noise turn before the plan embeds anything), attests
    // that hash, and the commit records it - so the census must hash the
    // same reduced material the plan mines for the session to be
    // distilled.
    mineYield("alpha.jsonl");
    const reduced = minedTurnsHash(
      minedMaterial("alpha.jsonl").filter((turn) => !turn.text.includes("noise-turn-present")),
    );
    expect(minedMaterial("alpha.jsonl").length).toBe(1);
    const ledger = JSON.parse(
      readFileSync(join(vault, DERIVED_STORE_DIR, "session-mining-ledger.json"), "utf8"),
    ) as { entries: Record<string, { minedContentHash: string }> };
    expect(ledger.entries["alpha.jsonl"]?.minedContentHash).toBe(reduced);
    expect(buildMiningCensus(vault).distilled).toBe(1);
  });

  test("the join keys on the portable basename, not the absolute path", async () => {
    const first = await importOne(
      writeSession("alpha.jsonl", [{ role: "user", text: "ship the parser" }]),
    );
    mineYield("alpha.jsonl");
    expect(buildMiningCensus(vault).distilled).toBe(1);

    // The log moves (a rotated store, another machine's layout): the import
    // ledger re-records it under the new absolute path, and the vanished
    // old path is pruned by the same write. The basename - the identity the
    // mining lane holds - still joins.
    const movedDir = join(tmp, "elsewhere");
    mkdirSync(movedDir, { recursive: true });
    const moved = join(movedDir, "alpha.jsonl");
    renameSync(first, moved);
    recordSessionImports(vault, [{ path: moved, runtime: SESSION_RUNTIME_ID.claudeCode }]);

    const census = buildMiningCensus(vault);
    expect(census.imported).toBe(1);
    expect(census.distilled).toBe(1);
  });

  test("an import under an explicit recall id joins on that id, not the basename", async () => {
    // --recall-session-id files the turns and every mining record under
    // the pinned id; the census must follow it rather than read the log's
    // basename as a session the plan would refuse.
    const path = writeSession("pinned.jsonl", [{ role: "user", text: "ship the parser" }]);
    await importSession(vault, path, {
      agent: "tester",
      now: NOW,
      recall: true,
      recallSessionId: "pinned-session",
    });
    recordSessionImports(vault, [
      { path, runtime: SESSION_RUNTIME_ID.claudeCode, sessionId: "pinned-session" },
    ]);
    expect(buildMiningCensus(vault)).toMatchObject({ undistilled: 1, refused: 0 });

    mineYield("pinned-session");
    expect(buildMiningCensus(vault)).toMatchObject({ distilled: 1, undistilled: 0, refused: 0 });
  });

  test("counts are aggregated per runtime, by the ledger's own label", async () => {
    await importOne(writeSession("alpha.jsonl", [{ role: "user", text: "ship the parser" }]));
    const beta = writeSession("beta.jsonl", [{ role: "user", text: "write the docs" }]);
    await importOne(beta);
    mineYield("beta.jsonl");
    // The census trusts the runtime the import ledger recorded, the same
    // way `--status` reports per-runtime coverage; re-labelling the second
    // entry proves the rows split rather than merge.
    recordSessionImports(vault, [{ path: beta, runtime: SESSION_RUNTIME_ID.codex }]);

    const census = buildMiningCensus(vault);
    expect(census.imported).toBe(2);
    expect(census.undistilled).toBe(1);
    expect(census.distilled).toBe(1);
    const claude = census.byRuntime.find((r) => r.runtime === SESSION_RUNTIME_ID.claudeCode);
    const codex = census.byRuntime.find((r) => r.runtime === SESSION_RUNTIME_ID.codex);
    expect(claude?.undistilled).toBe(1);
    expect(claude?.undistilledSessionIds).toEqual(["alpha.jsonl"]);
    expect(codex?.distilled).toBe(1);
    expect(codex?.undistilled).toBe(0);
  });

  test("a corrupt mining record refuses by name", () => {
    const dir = join(vault, DERIVED_STORE_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(sessionMiningLedgerPath(vault), "{ this is not json", "utf8");
    expect(() => buildMiningCensus(vault)).toThrow(/session mining ledger is corrupted JSON/);
  });

  test("an unknown mining-record schema version refuses by name", () => {
    const dir = join(vault, DERIVED_STORE_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      sessionMiningLedgerPath(vault),
      JSON.stringify({ schema_version: 99, entries: {} }),
      "utf8",
    );
    expect(() => buildMiningCensus(vault)).toThrow(/schema_version 99 not supported/);
  });

  test("a corrupt import ledger refuses by name", () => {
    const dir = join(vault, DERIVED_STORE_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(sessionLedgerPath(vault), "{ this is not json", "utf8");
    expect(() => buildMiningCensus(vault)).toThrow(/session import ledger is corrupted JSON/);
  });

  test("the census reads the continuity store a fixed number of times, whatever the backlog size", () => {
    // A census that re-read the store once per imported session costs
    // sessions x store - quadratic in the backlog - and spends the whole
    // SessionStart hook budget on a realistic sweep. Seed a few sessions
    // and a few hundred, and pin that the store reads do not grow.
    const seed = (count: number, offset: number): void => {
      const paths: string[] = [];
      const turns: AppendContinuityRecordInput[] = [];
      for (let i = offset; i < offset + count; i++) {
        const name = `scale-${i}.jsonl`;
        const path = join(sessionsDir, name);
        writeFileSync(path, "{}\n", "utf8");
        paths.push(path);
        for (let t = 0; t < 3; t++) {
          turns.push({
            kind: "session_turn",
            createdAt: "2026-09-18T09:00:00Z",
            payload: {
              session_id: name,
              turn_id: `t-${t}`,
              timestamp: "2026-09-18T09:00:00Z",
              role: t % 2 === 0 ? "user" : "assistant",
              text: `turn ${t} of session ${i}`,
            },
          });
        }
      }
      continuityStore.appendContinuityRecords(vault, turns);
      recordSessionImports(
        vault,
        paths.map((path) => ({ path, runtime: SESSION_RUNTIME_ID.claudeCode })),
        NOW,
      );
    };
    // The spied reader is the continuity store's full listing - the one
    // whole-store read the census is allowed to make, once per build.
    const storeReads = (): number => {
      const spy = spyOn(continuityStore, "listContinuityRecords");
      try {
        buildMiningCensus(vault);
        return spy.mock.calls.length;
      } finally {
        spy.mockRestore();
      }
    };

    seed(3, 0);
    const small = storeReads();
    // A census that stopped reading the store would pass the equality
    // below vacuously at zero.
    expect(small).toBeGreaterThan(0);
    expect(buildMiningCensus(vault).undistilled).toBe(3);
    seed(300, 3);
    const large = storeReads();
    expect(buildMiningCensus(vault).undistilled).toBe(303);
    expect(large).toBe(small);
  });
});

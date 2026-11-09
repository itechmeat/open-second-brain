/**
 * The last writers under `Brain/log/` and `Brain/search/` on a store-only
 * machine (task 2.10, design D14 items 1, 6 and 11): a dream pass, recall
 * feedback and a secret custody event write no byte anywhere under the
 * vault. Each goes where the migration maps its surface: dream workruns
 * and the learned-weights cache to device-local state, feedback events to
 * the `search-feedback` ledger, the secret custody audit to the
 * `reliability-audit` ledger, and the secrets themselves to device-local
 * state. Unswitched, the same calls keep their vault files.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";

import { SECRET_CUSTODY_AUDIT_DIR } from "../../../../src/core/brain/audit-dirs.ts";
import { compiledDigestPath } from "../../../../src/core/brain/compiled-digest-path.ts";
import { dream } from "../../../../src/core/brain/dream.ts";
import { workrunDir } from "../../../../src/core/brain/dream-workrun.ts";
import { dreamRunsDir } from "../../../../src/core/brain/paths.ts";
import { machineStatePath } from "../../../../src/core/state/machine-state.ts";
import { setSecret } from "../../../../src/core/brain/secrets/store.ts";
import { writeSignal } from "../../../../src/core/brain/signal.ts";
import { resetVaultIdentityPins } from "../../../../src/core/brain/vault-identity.ts";
import {
  feedbackDir,
  learnedWeightsFile,
  learnedWeightsPath,
  readLearnedWeights,
  recordRecallFeedback,
  type RecallFeedbackEvent,
} from "../../../../src/core/search/feedback.ts";
import { treeEntries, digestVaultTree } from "../../../helpers/vault-digest.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";
import { ledgerRows, switchDevice } from "./fixtures.ts";

let env: StoreEnv | undefined;

afterEach(() => {
  env?.cleanup();
  env = undefined;
  resetVaultIdentityPins();
});

const NOW = new Date("2026-11-06T10:00:00Z");

const EVENT: RecallFeedbackEvent = {
  ts: NOW.getTime(),
  queryHash: "0badc0de",
  resultPath: "notes/alpha.md",
  verdict: "up",
  contributions: { keyword: 0.5, semantic: 0.25, entity: 0, recency: 0.25 },
};

function switchedEnv(): StoreEnv {
  const e = makeStoreEnv("osb-wp7a-brain-log-", { dualWrite: false });
  switchDevice(e.storeRoot);
  return e;
}

function rows(e: StoreEnv, ledger: string): unknown[] {
  return [
    ...ledgerRows(e.storeRoot, "shared", ledger),
    ...ledgerRows(e.storeRoot, "private", ledger),
  ];
}

/** The vault paths that differ between two per-file digests. */
function changed(before: Map<string, string>, after: Map<string, string>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((k) => before.get(k) !== after.get(k)).toSorted();
}

/** Whether `path` lies inside `dir`. */
function isWithin(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Three same-sign signals on one topic: enough for a pass that changes something. */
function seedPromotion(vault: string): void {
  for (const [i, date] of ["2026-11-03", "2026-11-04", "2026-11-05"].entries()) {
    writeSignal(vault, {
      topic: "brain-log-leftovers",
      signal: "positive",
      agent: "claude",
      principle: "Keep the vault free of machine data.",
      created_at: `${date}T10:00:00Z`,
      date,
      slug: `keep-vault-free-${i}`,
      scope: "coding",
    });
  }
}

describe("a switched machine writes nothing under the vault", () => {
  test("a dream pass", () => {
    // The signals go through the real writer after the switch, so they are
    // store records the dream scan reads from the signal fold.
    env = switchedEnv();
    const before = treeEntries(env.vault);
    seedPromotion(env.vault);
    expect(changed(before, treeEntries(env.vault))).toEqual([]);
    const summary = dream(env.vault, { now: NOW });
    expect(summary.changed).toBe(true);
    expect(changed(before, treeEntries(env.vault))).toEqual([]);
    expect(existsSync(dreamRunsDir(env.vault))).toBe(false);
    // The digests are rendered on demand (D14 item 7): the pass warms the
    // device-local cache, never `Brain/active.md` or `Brain/lessons.md`.
    for (const digest of ["active", "lessons"] as const) {
      const cached = compiledDigestPath(env.vault, digest);
      expect(isWithin(env.vault, cached)).toBe(false);
      expect(existsSync(cached)).toBe(true);
    }
  });

  test("recall feedback and the learned weights", () => {
    env = switchedEnv();
    const before = digestVaultTree(env.vault);
    recordRecallFeedback(env.vault, EVENT);
    expect(digestVaultTree(env.vault)).toBe(before);
    expect(rows(env, "search-feedback")).toEqual([EVENT]);
    expect(readLearnedWeights(env.vault)?.events).toBe(1);
    expect(existsSync(feedbackDir(env.vault))).toBe(false);
    expect(existsSync(learnedWeightsPath(env.vault))).toBe(false);
  });

  test("a secret custody event", () => {
    env = switchedEnv();
    const before = digestVaultTree(env.vault);
    setSecret(env.vault, { name: "api_key", value: "s3cret", agent: "tester", now: NOW });
    expect(digestVaultTree(env.vault)).toBe(before);
    const audit = rows(env, "reliability-audit") as Array<{
      audit_dir: string;
      record: { action: string; target: string };
    }>;
    expect(audit.map((r) => [r.audit_dir, r.record.action, r.record.target])).toEqual([
      [SECRET_CUSTODY_AUDIT_DIR, "secret_set", "api_key"],
    ]);
  });
});

describe("the device-local surfaces live in the machine state", () => {
  test("a switched machine keeps the learned weights and the workruns under machineStatePath", () => {
    env = switchedEnv();
    recordRecallFeedback(env.vault, EVENT);
    expect(learnedWeightsFile(env.vault)).toBe(
      machineStatePath(env.vault, "Brain", "search", "learned-weights.json"),
    );
    expect(existsSync(learnedWeightsFile(env.vault))).toBe(true);
    expect(workrunDir(env.vault)).toBe(machineStatePath(env.vault, "Brain", "log", "dream-runs"));
    expect(isWithin(env.vault, workrunDir(env.vault))).toBe(false);
  });

  test("a bare vault (no Brain/) gets nothing written into it", () => {
    env = makeStoreEnv("osb-wp7b-bare-vault-", { dualWrite: false, legacyTree: false });
    const before = digestVaultTree(env.vault);
    seedPromotion(env.vault);
    recordRecallFeedback(env.vault, EVENT);
    setSecret(env.vault, { name: "api_key", value: "s3cret", agent: "tester", now: NOW });
    expect(dream(env.vault, { now: NOW }).changed).toBe(true);
    expect(digestVaultTree(env.vault)).toBe(before);
    expect(existsSync(join(env.vault, "Brain"))).toBe(false);
    expect(existsSync(join(env.vault, ".open-second-brain"))).toBe(false);
  });
});

describe("an unswitched machine keeps its vault files", () => {
  test("feedback, learned weights and the secret custody trail", () => {
    env = makeStoreEnv("osb-wp7a-brain-log-legacy-", { dualWrite: false });
    recordRecallFeedback(env.vault, EVENT);
    expect(readdirSync(feedbackDir(env.vault))).toHaveLength(1);
    expect(existsSync(learnedWeightsPath(env.vault))).toBe(true);
    setSecret(env.vault, { name: "api_key", value: "s3cret", agent: "tester", now: NOW });
    expect(
      readdirSync(join(env.vault, "Brain", "log", SECRET_CUSTODY_AUDIT_DIR)).length,
    ).toBeGreaterThan(0);
    expect(rows(env, "reliability-audit")).toEqual([]);
  });

  test("a dream pass keeps its workrun under the Brain log", () => {
    env = makeStoreEnv("osb-wp7a-brain-log-legacy-dream-", { dualWrite: false });
    seedPromotion(env.vault);
    expect(dream(env.vault, { now: NOW }).changed).toBe(true);
    expect(readdirSync(dreamRunsDir(env.vault)).length).toBeGreaterThan(0);
  });
});

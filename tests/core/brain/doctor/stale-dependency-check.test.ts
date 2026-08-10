/**
 * U3 - the reverse stale-dependency audit.
 *
 * The join is the whole feature, so the assertions are about the four
 * ways it could be wrong: reporting a consumer that postdates the change,
 * missing one that predates it because the identifier is spelled
 * differently on each side, flagging history for agreeing with itself,
 * and - the wave's own failure mode - reporting a store nobody measured
 * as a store with nothing wrong with it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitContextReceipt } from "../../../../src/core/brain/context-receipts.ts";
import {
  appendDecisionChangeReceipt,
  readDecisionChangeReceipts,
  receiptsDir,
  ReceiptError,
} from "../../../../src/core/brain/decisions/receipts.ts";
import { DIAGNOSTIC_SIGNALS } from "../../../../src/core/brain/diagnostics.ts";
import { runDoctor } from "../../../../src/core/brain/doctor.ts";
import type { DoctorCheckContext } from "../../../../src/core/brain/doctor/check.ts";
import type { DoctorUncertainEntry } from "../../../../src/core/brain/doctor/report.ts";
import type { DoctorIssue } from "../../../../src/core/brain/types.ts";
import {
  joinStaleDependencies,
  makeStaleDependencyCheck,
  STALE_DEPENDENCY_CODE,
  STALE_DEPENDENCY_CONSUMER,
  STALE_DEPENDENCY_STATE,
  type StaleDependencyCitation,
  type StaleDependencyState,
} from "../../../../src/core/brain/doctor/stale-dependency-check.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { appendLogEvent } from "../../../../src/core/brain/log.ts";
import { brainDirs, preferencePath, retiredPath } from "../../../../src/core/brain/paths.ts";
import { moveToRetired, writePreference } from "../../../../src/core/brain/preference.ts";
import { auditStaleDependencies } from "../../../../src/core/brain/stale-dependency.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-stale-dep-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-stale-dep-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  const truth = receiptsDir(vault);
  try {
    chmodSync(truth, 0o700);
  } catch {
    // The directory may never have been created; nothing to restore.
  }
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

// ----- helpers --------------------------------------------------------------

/** A preference whose `evidenced_by` cites `cites` by wikilink. */
function seedPreference(slug: string, createdAt: string, cites: ReadonlyArray<string> = []): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `rule ${slug}`,
    created_at: createdAt,
    unconfirmed_until: "2030-01-01T00:00:00Z",
    status: "confirmed",
    evidenced_by: cites.map((target) => `[[${target}]]`),
  });
}

function retire(slug: string, at: string): void {
  moveToRetired(vault, preferencePath(vault, slug), "rebutted", {
    now: new Date(at),
    retired_by: `[[Brain/log/${at.slice(0, 10)}]]`,
  });
}

/** Emit one context receipt naming `ids` at `createdAt`. */
function seedReceipt(createdAt: string, ids: ReadonlyArray<string>): void {
  emitContextReceipt(vault, {
    options: { host: "unit-test", trigger: "context_pack", createdAt },
    items: ids.map((id) => ({ id })),
    finalText: ids.join("|"),
  });
}

/** Pin a file's last-write instant, which is the consumer clock. */
function setWriteInstant(path: string, at: string): void {
  const seconds = new Date(at).getTime() / 1000;
  utimesSync(path, seconds, seconds);
}

const NOW = new Date("2026-06-01T00:00:00Z");

/** A window wide enough that no assertion below depends on its width. */
const WIDE_LOOKBACK_DAYS = 3650;

function audit(overrides: { readonly maxConsumersPerState?: number } = {}) {
  return auditStaleDependencies(vault, {
    now: NOW,
    lookbackDays: WIDE_LOOKBACK_DAYS,
    ...overrides,
  });
}

function state(key: string, changedAt: string): StaleDependencyState {
  return {
    key,
    kind: STALE_DEPENDENCY_STATE.retired,
    path: `/vault/Brain/retired/ret-${key}.md`,
    changed_at: changedAt,
    changed_at_ms: Date.parse(changedAt),
  };
}

function citation(
  id: string,
  writtenAt: string,
  cites: ReadonlyArray<string>,
  live = true,
): StaleDependencyCitation {
  return {
    kind: STALE_DEPENDENCY_CONSUMER.contextReceipt,
    id,
    written_at: writtenAt,
    written_at_ms: Date.parse(writtenAt),
    live,
    cites,
  };
}

// ----- the pure join --------------------------------------------------------

describe("joinStaleDependencies", () => {
  test("reports a consumer written before the change and not one written after", () => {
    const rows = joinStaleDependencies({
      states: [state("alpha", "2026-03-01T00:00:00Z")],
      citations: [
        citation("before", "2026-02-01T00:00:00Z", ["alpha"]),
        citation("after", "2026-04-01T00:00:00Z", ["alpha"]),
      ],
      maxConsumersPerState: 10,
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.consumers.map((c) => c.id)).toEqual(["before"]);
  });

  test("the comparison is strict: a consumer written at the change instant is current", () => {
    const rows = joinStaleDependencies({
      states: [state("alpha", "2026-03-01T00:00:00Z")],
      citations: [citation("simultaneous", "2026-03-01T00:00:00Z", ["alpha"])],
      maxConsumersPerState: 10,
    });
    expect(rows).toEqual([]);
  });

  test("a consumer that is no longer live is not a dependency anybody is standing on", () => {
    const rows = joinStaleDependencies({
      states: [state("alpha", "2026-03-01T00:00:00Z")],
      citations: [citation("retired-citer", "2026-02-01T00:00:00Z", ["alpha"], false)],
      maxConsumersPerState: 10,
    });
    expect(rows).toEqual([]);
  });

  test("two states folding to one key keep the earliest instant", () => {
    const later: StaleDependencyState = {
      ...state("alpha", "2026-05-01T00:00:00Z"),
      kind: STALE_DEPENDENCY_STATE.tombstoned,
    };
    const rows = joinStaleDependencies({
      states: [later, state("alpha", "2026-03-01T00:00:00Z")],
      citations: [citation("between", "2026-04-01T00:00:00Z", ["alpha"])],
      maxConsumersPerState: 10,
    });
    // Written after the retirement, so it is NOT stale even though the
    // tombstone came later; the earliest change is the honest boundary.
    expect(rows).toEqual([]);
  });

  test("the cap bounds what is listed and the row still reports the true total", () => {
    const rows = joinStaleDependencies({
      states: [state("alpha", "2026-03-01T00:00:00Z")],
      citations: [
        citation("c1", "2026-01-01T00:00:00Z", ["alpha"]),
        citation("c2", "2026-01-02T00:00:00Z", ["alpha"]),
        citation("c3", "2026-01-03T00:00:00Z", ["alpha"]),
        citation("c4", "2026-01-04T00:00:00Z", ["alpha"]),
      ],
      maxConsumersPerState: 2,
    });
    expect(rows[0]!.consumers.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(rows[0]!.consumer_total).toBe(4);
  });
});

// ----- the collector over a real vault --------------------------------------

describe("auditStaleDependencies", () => {
  test("a receipt naming the pre-retirement id joins the retired record", () => {
    seedPreference("alpha", "2026-01-01T00:00:00Z");
    seedReceipt("2026-02-01T00:00:00Z", ["pref-alpha"]);
    retire("alpha", "2026-03-01T00:00:00Z");

    const report = audit();
    expect(report.receipts_recorded).toBe(true);
    expect(report.rows.length).toBe(1);
    const row = report.rows[0]!;
    expect(row.state).toBe("alpha");
    expect(row.state_kind).toBe(STALE_DEPENDENCY_STATE.retired);
    expect(row.state_path).toBe(retiredPath(vault, "alpha"));
    expect(row.changed_at).toBe("2026-03-01T00:00:00.000Z");
    expect(row.consumers.map((c) => c.kind)).toEqual([STALE_DEPENDENCY_CONSUMER.contextReceipt]);
  });

  test("bare, wikilink and note-path spellings of one subject fold to one row", () => {
    seedPreference("alpha", "2026-01-01T00:00:00Z");
    seedReceipt("2026-02-01T00:00:00Z", ["alpha"]);
    seedReceipt("2026-02-02T00:00:00Z", ["[[pref-alpha]]"]);
    seedReceipt("2026-02-03T00:00:00Z", ["Brain/retired/ret-alpha.md"]);
    retire("alpha", "2026-03-01T00:00:00Z");

    const report = audit();
    expect(report.rows.length).toBe(1);
    expect(report.rows[0]!.state).toBe("alpha");
    expect(report.rows[0]!.consumer_total).toBe(3);
  });

  test("a decision-change receipt whose evidence cited the rule is a consumer", () => {
    seedPreference("alpha", "2026-01-01T00:00:00Z");
    appendDecisionChangeReceipt(vault, {
      subject: "[[decision-adopt-bun]]",
      before: "undecided",
      after: "adopted",
      evidenceTriggers: ["[[pref-alpha]]"],
      actor: "unit-test",
      reasonCode: "decision-record",
      ts: "2026-02-01T00:00:00Z",
      configPath,
    });
    retire("alpha", "2026-03-01T00:00:00Z");

    const report = audit();
    expect(report.receipts_recorded).toBe(true);
    expect(report.rows.length).toBe(1);
    const consumer = report.rows[0]!.consumers[0]!;
    expect(consumer.kind).toBe(STALE_DEPENDENCY_CONSUMER.decisionChange);
    // Folded by the existing subject normalizer, not by a second copy.
    expect(consumer.id).toBe("decision-adopt-bun");
  });

  test("a live artifact citing the rule is reported and a retired one is not", () => {
    seedPreference("alpha", "2026-01-01T00:00:00Z");
    seedPreference("beta", "2026-01-01T00:00:00Z", ["pref-alpha"]);
    seedPreference("gamma", "2026-01-01T00:00:00Z", ["pref-alpha"]);
    seedReceipt("2026-02-01T00:00:00Z", ["pref-alpha"]);
    retire("beta", "2026-02-10T00:00:00Z");
    retire("alpha", "2026-03-01T00:00:00Z");
    // Both citers last written well before the retirement, so only
    // liveness can separate them.
    setWriteInstant(retiredPath(vault, "beta"), "2026-01-05T00:00:00Z");
    setWriteInstant(preferencePath(vault, "gamma"), "2026-01-05T00:00:00Z");

    const report = audit();
    const row = report.rows.find((r) => r.state === "alpha")!;
    const artifacts = row.consumers.filter(
      (c) => c.kind === STALE_DEPENDENCY_CONSUMER.brainArtifact,
    );
    expect(artifacts.map((c) => c.id)).toEqual(["pref-gamma"]);
  });

  test("the retirement's own log entry and back-pointer do not self-flag", () => {
    seedPreference("alpha", "2026-01-01T00:00:00Z");
    // A log entry naming the rule, written before the retirement: the
    // append-only log is the record THAT the state changed, never a
    // consumer resting on it having not changed.
    appendLogEvent(vault, {
      timestamp: "2026-02-01T00:00:00Z",
      eventType: BRAIN_LOG_EVENT_KIND.retire,
      body: { preference: "[[pref-alpha]]", agent: "unit-test" },
    });
    retire("alpha", "2026-03-01T00:00:00Z");
    // The retired file carries `pref-alpha` in its own `aliases:`, so a
    // naive reverse lookup would resolve it onto itself.
    setWriteInstant(retiredPath(vault, "alpha"), "2026-01-05T00:00:00Z");
    // Something unrelated has to be measured, or the report is
    // not-recorded and proves nothing about the join.
    seedReceipt("2026-02-01T00:00:00Z", ["pref-unrelated"]);

    expect(audit().rows).toEqual([]);
  });

  test("a receipt-less vault still reports the citations that need no receipts", () => {
    seedPreference("alpha", "2026-01-01T00:00:00Z");
    seedPreference("beta", "2026-01-01T00:00:00Z", ["pref-alpha"]);
    retire("alpha", "2026-03-01T00:00:00Z");
    setWriteInstant(preferencePath(vault, "beta"), "2026-01-05T00:00:00Z");

    const report = audit();
    // The backlink evidence is on disk and costs no telemetry, so the live
    // record citing a rule retired under it is a finding either way. What
    // the absent receipt trail costs is the OTHER half - packs and
    // decisions - and that is all the flag claims.
    expect(report.receipts_recorded).toBe(false);
    expect(report.rows.length).toBe(1);
    expect(report.rows[0]!.state).toBe("alpha");
    expect(report.rows[0]!.consumers.map((consumer) => consumer.kind)).toEqual([
      STALE_DEPENDENCY_CONSUMER.brainArtifact,
    ]);
    expect(report.lookback_days).toBe(WIDE_LOOKBACK_DAYS);
    expect(report.window_since < NOW.toISOString()).toBe(true);
  });

  test("a vault where nothing ever changed reports no rows and nothing unmeasured", () => {
    // The other shape of a quiet answer, and the one that must stay quiet:
    // no state stopped being current, so no consumer of one can be stale
    // and an absent receipt trail costs this vault nothing.
    seedPreference("alpha", "2026-01-01T00:00:00Z");
    seedPreference("beta", "2026-01-01T00:00:00Z", ["pref-alpha"]);

    const report = audit();
    expect(report.receipts_recorded).toBe(false);
    expect(report.rows).toEqual([]);
    expect(report.states_changed).toBe(0);
  });

  test("an unmeasured receipt trail is named without suppressing what was computed", () => {
    // Two things have to be true at once here. The half that needed a
    // receipt is named as unmeasured, because an empty issue list would
    // read as a clean bill of health for consumers nobody looked at - and
    // the half that needed nothing but the backlink graph is still
    // reported, because withholding a computed finding to say "nothing is
    // known" would be the same false silence pointed the other way.
    seedPreference("alpha", "2026-01-01T00:00:00Z");
    seedPreference("beta", "2026-01-01T00:00:00Z", ["pref-alpha"]);
    retire("alpha", "2026-03-01T00:00:00Z");
    setWriteInstant(preferencePath(vault, "beta"), "2026-01-05T00:00:00Z");

    const issues: DoctorIssue[] = [];
    const uncertain: DoctorUncertainEntry[] = [];
    makeStaleDependencyCheck((v, opts) =>
      auditStaleDependencies(v, { ...opts, lookbackDays: WIDE_LOOKBACK_DAYS }),
    ).run({ vault, now: NOW } as unknown as DoctorCheckContext, { issues, uncertain });

    // The computed half reaches the issue stream...
    expect(issues.map((issue) => issue.target)).toEqual(["alpha"]);
    // ...and the unmeasured half is named rather than implied by silence,
    // scoped to the consumers a receipt would have carried.
    const entry = uncertain.find((item) => item.code === STALE_DEPENDENCY_CODE);
    expect(entry).toBeDefined();
    expect(entry!.message).toContain("were not measured");
    expect(entry!.message).toContain("reported above");
  });

  test("a measured vault records no uncertainty", () => {
    seedPreference("alpha", "2026-01-01T00:00:00Z");
    seedReceipt("2026-02-01T00:00:00Z", ["pref-alpha"]);
    retire("alpha", "2026-03-01T00:00:00Z");

    const issues: DoctorIssue[] = [];
    const uncertain: DoctorUncertainEntry[] = [];
    makeStaleDependencyCheck((v, opts) =>
      auditStaleDependencies(v, { ...opts, lookbackDays: WIDE_LOOKBACK_DAYS }),
    ).run({ vault, now: NOW } as unknown as DoctorCheckContext, { issues, uncertain });

    expect(uncertain.filter((item) => item.code === STALE_DEPENDENCY_CODE)).toEqual([]);
    expect(issues.length).toBeGreaterThan(0);
  });

  test("the per-state cap reports the true total rather than a silent prefix", () => {
    seedPreference("alpha", "2026-01-01T00:00:00Z");
    for (const day of ["01", "02", "03", "04", "05"]) {
      seedReceipt(`2026-02-${day}T00:00:00Z`, ["pref-alpha"]);
    }
    retire("alpha", "2026-03-01T00:00:00Z");

    const report = audit({ maxConsumersPerState: 2 });
    expect(report.rows[0]!.consumers.length).toBe(2);
    expect(report.rows[0]!.consumer_total).toBe(5);
  });
});

// ----- the doctor check -----------------------------------------------------

describe("staleDependencyCheck inside the doctor pass", () => {
  test("a receipt-less vault still warns about the citation it could compute", () => {
    seedPreference("alpha", "2026-01-01T00:00:00Z");
    seedPreference("beta", "2026-01-01T00:00:00Z", ["pref-alpha"]);
    retire("alpha", "2026-03-01T00:00:00Z");
    setWriteInstant(preferencePath(vault, "beta"), "2026-01-05T00:00:00Z");

    const result = runDoctor(vault, { now: NOW });
    const found = result.warnings.filter((w) => w.code === STALE_DEPENDENCY_CODE);
    expect(found.length).toBe(1);
    expect(found[0]!.target).toBe("alpha");
  });

  test("a vault where nothing ever changed stays silent on both channels", () => {
    // The permanent-notice trap: warning whenever a receipt trail is absent
    // would put this line on every clean vault, which is how a real signal
    // stops being read.
    seedPreference("alpha", "2026-01-01T00:00:00Z");
    seedPreference("beta", "2026-01-01T00:00:00Z", ["pref-alpha"]);

    const result = runDoctor(vault, { now: NOW });
    expect(result.warnings.filter((w) => w.code === STALE_DEPENDENCY_CODE)).toEqual([]);
    expect((result.uncertain ?? []).filter((u) => u.code === STALE_DEPENDENCY_CODE)).toEqual([]);
  });

  test("a measured vault surfaces one warning naming the true consumer total", () => {
    seedPreference("alpha", "2026-01-01T00:00:00Z");
    seedReceipt(new Date(NOW.getTime() - 86_400_000).toISOString(), ["pref-alpha"]);
    retire("alpha", NOW.toISOString());

    const found = runDoctor(vault, { now: NOW }).warnings.filter(
      (w) => w.code === STALE_DEPENDENCY_CODE,
    );
    expect(found.length).toBe(1);
    expect(found[0]!.target).toBe("alpha");
    expect(found[0]!.message).toContain("1 consumer(s) written before that still rest on it");
  });

  test("an unreadable continuity directory surfaces uncertainty and spares the other checks", () => {
    seedPreference("alpha", "2026-01-01T00:00:00Z");
    retire("alpha", "2026-03-01T00:00:00Z");
    // A dangling reference, so another check has something to report and
    // the assertion below is not vacuous.
    seedPreference("dangling", "2026-01-01T00:00:00Z", ["sig-2026-01-01-nowhere"]);
    // A regular file where the continuity shard directory belongs: the
    // store exists and cannot be listed, on every host and every uid.
    writeFileSync(join(brainDirs(vault).log, "continuity"), "not a directory\n", "utf8");

    const result = runDoctor(vault, { now: NOW });
    const others = result.warnings.filter((w) => w.code !== STALE_DEPENDENCY_CODE);
    expect(others.length).toBeGreaterThan(0);
    const uncertain = result.uncertain ?? [];
    const entry = uncertain.find((u) => u.message.includes("continuity record read failed"));
    expect(entry).toBeDefined();
    expect(entry!.message).toContain("resting on a retired");
  });

  test("the issue code resolves to a registered next command", () => {
    const signal = DIAGNOSTIC_SIGNALS.get(STALE_DEPENDENCY_CODE);
    expect(signal).toBeDefined();
    expect(signal!.nextCommand.length).toBeGreaterThan(0);
  });
});

// ----- the defect in the blast radius ---------------------------------------

describe("readDecisionChangeReceipts separates an absent store from an unreadable one", () => {
  test("a store that was never created reports no decisions", () => {
    expect(readDecisionChangeReceipts(vault)).toEqual({ receipts: [], warnings: [] });
  });

  test("a store that cannot be listed raises instead of reporting no decisions", () => {
    mkdirSync(receiptsDir(vault), { recursive: true });
    chmodSync(receiptsDir(vault), 0o300);
    expect(() => readDecisionChangeReceipts(vault)).toThrow(ReceiptError);
  });

  test("an append whose idempotency probe cannot read the store refuses to duplicate", () => {
    const input = {
      subject: "Brain/decisions/decision-adopt-bun.md",
      before: "undecided",
      after: "adopted",
      actor: "unit-test",
      reasonCode: "decision-record",
      ts: "2026-02-01T00:00:00Z",
      configPath,
    };
    expect(appendDecisionChangeReceipt(vault, input).appended).toBe(true);

    // Writable, not listable: exactly the state in which the duplicate
    // guard used to read "no prior receipt" and append a second copy.
    chmodSync(receiptsDir(vault), 0o300);
    expect(() => appendDecisionChangeReceipt(vault, input)).toThrow(ReceiptError);

    chmodSync(receiptsDir(vault), 0o700);
    expect(readDecisionChangeReceipts(vault).receipts.length).toBe(1);
  });
});

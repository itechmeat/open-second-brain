/**
 * The whole state space of the automatic migration's worker claim (change
 * auto-store-migration, design D2), against one oracle stated as
 * invariants. `decideClaim` is pure: each row gives it the claim file, its
 * holder as the asker's judgement sees it, the mutex and the asker.
 *
 * State:
 *  - the claim file: absent; unreadable (a read error other than its
 *    absence); empty or torn, young (inside the grace a claim being
 *    written gets) or old; valid; valid with an mtime in the future;
 *  - its holder (valid files): provably dead; alive with the recorded
 *    identity, young or past a day; alive with another identity (a reused
 *    pid), young or past a day; alive and unknown (no identity recorded),
 *    young or past the hour;
 *  - who asks: a start claiming (cheap), a worker claiming exactly (a
 *    self-claim worker, a second worker), a hand-over (the asker's own
 *    claim or not; to the pid the claim names or another; with an
 *    identity or none), a release (own or not), a reader judging exactly
 *    (the manual verb, the doctor) or cheaply (the session notices);
 *  - the mutex: free, busy.
 *
 * Impossible combinations, left out: a hand-over or a release of the
 * asker's own claim when the file holds no valid record (an own claim is
 * a record with the asker's token).
 *
 * The holder as seen: the cheap judgement sees only the pid (a live pid is
 * `unknown`), the exact one the identity too (a reused pid is `dead`).
 *
 * Invariants (the oracle):
 *  1. Never two holders: a new claim is made only over no claim, or over
 *     one whose holder is gone (dead, a reused pid seen exactly, a torn
 *     file past its grace); the one documented exception is the exact
 *     judgement's age rule: a holder that cannot be told (no identity)
 *     past the hour, or with an mtime in the future.
 *  2. A live holder's claim is never removed or replaced by anyone else.
 *  3. A dead holder's claim never blocks the next claimer: the exact
 *     claimer takes it over; a start, which sees only the pid, takes over
 *     a gone pid and hands a live pid past its ceiling to an exact worker.
 *  4. A release removes only the releaser's own claim.
 *  5. A hand-over changes only the asker's own claim, and never replaces a
 *     recorded identity of the same pid with none.
 *  6. A busy mutex never yields a claim, a stamp or a removal.
 *  7. The reader and the claimer of the same judgement agree: a reader
 *     says a worker runs exactly when that claimer would leave the claim.
 *  8. A claim whose file cannot be read is never removed.
 *
 * Not in this table: what a worker taken over after its last ownership
 * check writes before it holds the migration gate. Those writes are
 * idempotent (the store's format notes and held-partition list, the
 * opening of a gate whose run is gone), and the vault identity marker is
 * read, or written when missing, only under the gate, so the id a run
 * records is the one on disk. `worker-claim-writes.test.ts` holds that
 * boundary case.
 */
import { describe, expect, test } from "bun:test";

import {
  decideClaim,
  type ClaimAsker,
  type ClaimDecision,
  type ClaimFile,
  type ClaimHolderSeen,
} from "../../../src/core/store-migration/auto-state.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const YOUNG = 5 * MIN;
const OLD = 2 * DAY;

/** The truth about a valid claim's holder, which the oracle judges by. */
const HOLDERS = [
  "dead",
  "alive-young",
  "alive-old",
  "reused-young",
  "reused-old",
  "unknown-young",
  "unknown-old",
] as const;
type Holder = (typeof HOLDERS)[number];

/** The holder mark of the asker's own claim, and of a claim someone else holds. */
const OWN_MARK = "mine";
const OTHER_MARK = "theirs";
const PID = 4242;

interface FileCase {
  readonly name: string;
  readonly file: ClaimFile;
  /** The holder truth of a valid claim, else null. */
  readonly holder: Holder | null;
}

function validFile(holder: Holder, future: boolean, token: string): ClaimFile {
  const age = future ? -OLD : holder.endsWith("-old") ? OLD : YOUNG;
  return {
    kind: "valid",
    ageMs: age,
    token,
    pid: PID,
    started: holder.startsWith("unknown") ? null : "S",
    since: "2026-11-17T10:00:00.000Z",
  };
}

function fileCases(token: string): FileCase[] {
  const out: FileCase[] = [
    { name: "absent", file: { kind: "absent" }, holder: null },
    { name: "unreadable", file: { kind: "unreadable", ageMs: YOUNG }, holder: null },
    { name: "torn-young", file: { kind: "torn", ageMs: 2000 }, holder: null },
    { name: "torn-old", file: { kind: "torn", ageMs: YOUNG }, holder: null },
  ];
  for (const holder of HOLDERS) {
    out.push({ name: `valid/${holder}`, file: validFile(holder, false, token), holder });
    out.push({ name: `future/${holder}`, file: validFile(holder, true, token), holder });
  }
  return out;
}

/** The holder as a judgement sees it. */
function seen(holder: Holder | null, judge: "cheap" | "exact"): ClaimHolderSeen {
  if (holder === null) return "unknown";
  if (holder === "dead") return "dead";
  if (judge === "cheap") return "unknown";
  if (holder.startsWith("alive")) return "alive";
  if (holder.startsWith("reused")) return "dead";
  return "unknown";
}

interface AskerCase {
  readonly name: string;
  readonly asker: ClaimAsker;
  /** Whether the asker's token is the claim's (hand-over and release). */
  readonly own: boolean | null;
}

function askerCases(): AskerCase[] {
  const out: AskerCase[] = [
    { name: "start", asker: { who: "start" }, own: null },
    { name: "claim", asker: { who: "claim" }, own: null },
    { name: "read-exact", asker: { who: "read", judge: "exact" }, own: null },
    { name: "read-cheap", asker: { who: "read", judge: "cheap" }, own: null },
  ];
  for (const own of [true, false]) {
    for (const samePid of [true, false]) {
      for (const started of ["S2", null]) {
        out.push({
          name: `hand-over/${own ? "own" : "other"}/${samePid ? "same-pid" : "other-pid"}/${started ?? "no-identity"}`,
          asker: {
            who: "hand-over",
            token: own ? OWN_MARK : "x",
            pid: samePid ? PID : 7,
            started,
          },
          own,
        });
      }
    }
    out.push({
      name: `release/${own ? "own" : "other"}`,
      asker: { who: "release", token: own ? OWN_MARK : "x" },
      own,
    });
  }
  return out;
}

interface Row {
  readonly name: string;
  readonly fileCase: FileCase;
  readonly askerCase: AskerCase;
  readonly mutex: "free" | "busy";
}

function rows(): Row[] {
  const out: Row[] = [];
  for (const askerCase of askerCases()) {
    for (const fileCase of fileCases(OWN_MARK)) {
      const holdsRecord = fileCase.file.kind === "valid";
      // Impossible: an own claim the file holds no record of.
      if (askerCase.own === true && !holdsRecord) continue;
      // Not the asker's: a valid record under another token.
      const fc =
        askerCase.own === false && holdsRecord
          ? { ...fileCase, file: { ...fileCase.file, token: OTHER_MARK } as ClaimFile }
          : fileCase;
      for (const mutex of ["free", "busy"] as const) {
        out.push({
          name: `${askerCase.name} ${fc.name} mutex-${mutex}`,
          fileCase: fc,
          askerCase,
          mutex,
        });
      }
    }
  }
  return out;
}

function judgeOf(asker: ClaimAsker): "cheap" | "exact" {
  if (asker.who === "start") return "cheap";
  if (asker.who === "read") return asker.judge;
  return "exact";
}

function decide(row: Row, asker: ClaimAsker = row.askerCase.asker): ClaimDecision {
  return decideClaim({
    file: row.fileCase.file,
    holder: seen(row.fileCase.holder, judgeOf(asker)),
    mutex: row.mutex,
    asker,
  });
}

/** Whether the claim there may belong to a process that still runs. */
function possiblyLive(fc: FileCase): boolean {
  switch (fc.file.kind) {
    case "absent":
      return false;
    case "unreadable":
      return true;
    case "torn":
      return fc.file.ageMs <= 10_000;
    case "valid":
      return fc.holder!.startsWith("alive") || fc.holder!.startsWith("unknown");
  }
}

/** The exact judgement's documented age rule: a holder it cannot tell, past the hour or dated ahead. */
function ageRule(fc: FileCase): boolean {
  return (
    fc.file.kind === "valid" &&
    fc.holder!.startsWith("unknown") &&
    (fc.file.ageMs > 60 * MIN || fc.file.ageMs < -MIN)
  );
}

function violations(row: Row): string[] {
  const out: string[] = [];
  const { fileCase: fc, askerCase: ac, mutex } = row;
  const d = decide(row);
  const judge = judgeOf(ac.asker);
  const changes = d.act === "claim" || d.act === "stamp" || d.act === "remove";
  if (mutex === "busy" && changes) out.push("6: a busy mutex yielded a change");
  if (d.act === "claim" && possiblyLive(fc) && !(judge === "exact" && ageRule(fc))) {
    out.push("1: a claim over a holder that may still run");
  }
  const live = fc.holder !== null && fc.holder.startsWith("alive");
  if (live && (d.act === "claim" || (d.act === "remove" && ac.own !== true))) {
    out.push("2: a live holder's claim removed or replaced");
  }
  if (fc.file.kind === "unreadable" && (d.act === "claim" || d.act === "remove")) {
    out.push("8: a claim that cannot be read was removed");
  }
  if (mutex === "free" && (ac.asker.who === "start" || ac.asker.who === "claim")) {
    const gone =
      fc.file.kind === "absent" ||
      (fc.file.kind === "torn" && !possiblyLive(fc)) ||
      fc.holder === "dead" ||
      (judge === "exact" && fc.holder !== null && fc.holder.startsWith("reused"));
    if (gone && d.act !== "claim") out.push("3: a gone holder's claim blocked the claimer");
    const pastCeiling = fc.file.kind === "valid" && (fc.file.ageMs > DAY || fc.file.ageMs < -MIN);
    if (
      judge === "cheap" &&
      fc.holder !== null &&
      fc.holder !== "dead" &&
      pastCeiling &&
      d.act !== "undecided"
    ) {
      out.push("3: a live pid past its ceiling was not handed to an exact worker");
    }
  }
  if (d.act === "remove" && ac.own !== true) out.push("4: a release removed another's claim");
  if (ac.asker.who === "hand-over") {
    if ((d.act === "stamp" || d.act === "kept") && ac.own !== true) {
      out.push("5: a hand-over changed another's claim");
    }
    const keepsIdentity =
      fc.file.kind === "valid" &&
      fc.file.pid === ac.asker.pid &&
      fc.file.started !== null &&
      ac.asker.started === null;
    if (keepsIdentity && d.act === "stamp") out.push("5: a recorded identity lost to none");
  }
  if (ac.asker.who === "read" && mutex === "free") {
    const claimer: ClaimAsker = judge === "cheap" ? { who: "start" } : { who: "claim" };
    const leaves = decide(row, claimer).act !== "claim";
    if ((d.act === "running") !== leaves) out.push("7: the reader and the claimer disagree");
  }
  return out;
}

describe("the worker claim, over its whole state space", () => {
  const all = rows();

  test("covers every row", () => {
    // 4 judging askers x 18 files, 4 own hand-overs + own release x 14
    // valid files, 4 other hand-overs + other release x 18 files; x 2 mutex.
    expect(all.length).toBe((4 * 18 + 5 * 14 + 5 * 18) * 2);
  });

  test("keeps every invariant in every row", () => {
    const broken = all.flatMap((row) => violations(row).map((v) => `${row.name}: ${v}`));
    expect(broken).toEqual([]);
  });
});

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
 *  - whether a start handed the claim to a spawned worker: not handed
 *    (a start's own claim, a self-claiming worker's, the manual verb's),
 *    handed and awaiting the worker's confirmation, or confirmed by the
 *    worker's own stamp;
 *  - who asks: a start claiming (cheap), a worker claiming exactly (a
 *    self-claim worker, a second worker), a hand-over (the asker's own
 *    claim or not; to the pid the claim names or another; with an
 *    identity or none; the parent's, or the worker's own confirming
 *    stamp), a release (own or not), the start that spawned a worker
 *    seeing it exit (own claim or not; that worker's pid or another), a
 *    reader judging exactly (the manual verb, the doctor) or cheaply (the
 *    session notices);
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
 *  9. A worker is lost exactly when its claim was handed to it, it never
 *     confirmed it, and its process is gone: a start, a claimer and a
 *     reader see that (the holder seen dead), and so does the start that
 *     spawned it when it saw that pid exit on its own claim. The claimer
 *     that replaces such a claim is told, the reader reports it, the
 *     spawner records it and removes the claim; a claim never handed, a
 *     confirmed one, or one whose holder may run is never lost.
 * 10. A parent's hand-over never turns a confirmed claim of the same pid
 *     back into an awaited one, and a worker's own stamp always leaves its
 *     claim confirmed.
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

const WORKERS = [null, "awaited", "confirmed"] as const;
type Worker = (typeof WORKERS)[number];

function validFile(holder: Holder, future: boolean, token: string, worker: Worker): ClaimFile {
  const age = future ? -OLD : holder.endsWith("-old") ? OLD : YOUNG;
  return {
    kind: "valid",
    ageMs: age,
    token,
    pid: PID,
    started: holder.startsWith("unknown") ? null : "S",
    since: "2026-11-17T10:00:00.000Z",
    worker,
  };
}

function fileCases(token: string): FileCase[] {
  const out: FileCase[] = [
    { name: "absent", file: { kind: "absent" }, holder: null },
    { name: "unreadable", file: { kind: "unreadable", ageMs: YOUNG }, holder: null },
    { name: "torn-young", file: { kind: "torn", ageMs: 2000 }, holder: null },
    { name: "torn-old", file: { kind: "torn", ageMs: YOUNG }, holder: null },
  ];
  for (const worker of WORKERS) {
    for (const holder of HOLDERS) {
      const w = worker ?? "not-handed";
      out.push({
        name: `valid/${holder}/${w}`,
        file: validFile(holder, false, token, worker),
        holder,
      });
      out.push({
        name: `future/${holder}/${w}`,
        file: validFile(holder, true, token, worker),
        holder,
      });
    }
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
        for (const confirms of [false, true]) {
          out.push({
            name: `hand-over/${own ? "own" : "other"}/${samePid ? "same-pid" : "other-pid"}/${started ?? "no-identity"}/${confirms ? "worker" : "parent"}`,
            asker: {
              who: "hand-over",
              token: own ? OWN_MARK : "x",
              pid: samePid ? PID : 7,
              started,
              confirms,
            },
            own,
          });
        }
      }
      out.push({
        name: `exited/${own ? "own" : "other"}/${samePid ? "same-pid" : "other-pid"}`,
        asker: { who: "exited", token: own ? OWN_MARK : "x", pid: samePid ? PID : 7 },
        own,
      });
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
    if (keepsIdentity && d.act === "stamp" && d.started === null) {
      out.push("5: a recorded identity lost to none");
    }
  }
  // 9: lost exactly when handed, never confirmed, and gone.
  const handedAndGone =
    fc.file.kind === "valid" &&
    fc.file.worker === "awaited" &&
    (ac.asker.who === "exited"
      ? ac.own === true && fc.file.pid === ac.asker.pid
      : fc.holder !== null && seen(fc.holder, judge) === "dead");
  const judging = ac.asker.who === "start" || ac.asker.who === "claim" || ac.asker.who === "read";
  const toldLost = d.act === "worker-lost" || (d.act === "claim" && d.lost !== null);
  if (toldLost && !handedAndGone) out.push("9: a worker reported lost that is not");
  if (mutex === "free" && (judging || ac.asker.who === "exited") && handedAndGone && !toldLost) {
    out.push("9: a lost worker went unreported");
  }
  if (d.act === "claim" && d.lost !== null && !d.replace) out.push("9: a lost claim not replaced");
  if (ac.asker.who === "hand-over" && fc.file.kind === "valid") {
    const samePid = fc.file.pid === ac.asker.pid;
    if (d.act === "stamp" && !ac.asker.confirms && samePid && fc.file.worker === "confirmed") {
      out.push("10: a parent's hand-over undid the worker's confirmation");
    }
    if (
      ac.asker.confirms &&
      ac.own === true &&
      mutex === "free" &&
      !(d.act === "stamp" || (d.act === "kept" && fc.file.worker === "confirmed"))
    ) {
      out.push("10: a worker's own stamp left its claim unconfirmed");
    }
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
    // 46 files: 4 without a record, 42 valid (14 holders and dates x 3
    // hand-over states). 4 judging askers x 46 files; 8 own hand-overs, the
    // own release and 2 own exits x 42 valid files; as many askers that do
    // not own the claim x 46 files; x 2 mutex.
    expect(all.length).toBe((4 * 46 + 11 * 42 + 11 * 46) * 2);
  });

  test("keeps every invariant in every row", () => {
    const broken = all.flatMap((row) => violations(row).map((v) => `${row.name}: ${v}`));
    expect(broken).toEqual([]);
  });
});

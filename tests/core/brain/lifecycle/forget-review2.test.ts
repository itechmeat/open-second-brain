/**
 * Review round 2 (CodeRabbit) on the forget verbs: each case reproduces one
 * finding, verb by verb, on the layout it concerns.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { correct } from "../../../../src/core/brain/lifecycle/correction.ts";
import { temporalReplace } from "../../../../src/core/brain/lifecycle/temporal-replace.ts";
import {
  resolveChainTipInVault,
  tombstone,
  TombstoneError,
} from "../../../../src/core/brain/lifecycle/tombstone.ts";
import { setExpiration } from "../../../../src/core/brain/expiration-set.ts";
import {
  loadPreference,
  preferenceStoreRecords,
  writePreference,
} from "../../../../src/core/brain/preference.ts";
import { retireSignal } from "../../../../src/core/brain/signal-retire.ts";
import { writeSignal } from "../../../../src/core/brain/signal.ts";
import { appendClaimEvent, readClaimEvents } from "../../../../src/core/brain/truth/store.ts";
import { writeFrontmatter } from "../../../../src/core/vault.ts";
import { appendRecord } from "../../../../src/core/store/appender.ts";
import type { StoreRecord } from "../../../../src/core/store/envelope.ts";
import { readLanePage, writeLanePage } from "../../../../src/core/store/lane-pages.ts";
import { readSignals } from "../../../../src/core/store/read/signals.ts";
import { openStore } from "../../../../src/core/store/store-open.ts";
import { storeWrite } from "../../../../src/core/store/store-write.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";
import { partitionRecords, switchDevice } from "../store-only/fixtures.ts";

let env: StoreEnv | undefined;
const extra: string[] = [];
afterEach(() => {
  env?.cleanup();
  env = undefined;
  for (const dir of extra.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-11-21T12:00:00Z");

const signalInput = (slug: string) => ({
  topic: `topic ${slug}`,
  signal: "positive" as const,
  agent: "claude",
  principle: `Principle of ${slug}`,
  created_at: "2026-11-20T10:00:00Z",
  date: "2026-11-20",
  slug,
});

const prefInput = (slug: string) => ({
  slug,
  topic: slug,
  principle: `principle ${slug}`,
  created_at: "2026-11-01T00:00:00Z",
  unconfirmed_until: "2026-11-02T00:00:00Z",
  confirmed_at: "2026-11-02T00:00:00Z",
  status: "confirmed" as const,
  evidenced_by: [],
});

function records(
  e: StoreEnv,
  kind?: string,
): Array<StoreRecord & { readonly partition: "shared" | "private" }> {
  return (["shared", "private"] as const)
    .flatMap((p) => partitionRecords(e.storeRoot, p).map((r) => ({ ...r, partition: p })))
    .filter((r) => kind === undefined || r.kind === kind);
}

function switchedNoTree(prefix: string): StoreEnv {
  const e = makeStoreEnv(prefix, { dualWrite: true });
  env = e;
  switchDevice(e.storeRoot);
  rmSync(join(e.vault, "Brain"), { recursive: true, force: true });
  return e;
}

function frontmatter(e: StoreEnv, id: string): Record<string, unknown> | undefined {
  return readSignals({ vault: e.vault }, { states: "all" }).find((s) => s.id === id)?.frontmatter;
}

/** The id of the capture record of signal `id`. */
function captureRecordId(e: StoreEnv, id: string): string {
  const rec = records(e, "signal").find((r) => r.body["id"] === id);
  if (rec === undefined) throw new Error(`no capture of ${id}`);
  return rec.id;
}

describe("4650588369: retire and expire resolve a store record address to its entity", () => {
  test("signal retire and expire by .brain-store/<partition>/<record id> and store:<partition>/<record id>", () => {
    const e = switchedNoTree("osb-cr2-addr-");
    const a = writeSignal(e.vault, signalInput("addr-retire"));
    const b = writeSignal(e.vault, signalInput("addr-expire"));
    retireSignal(e.vault, `.brain-store/shared/${captureRecordId(e, a.id)}`, {
      reason: "old",
      now: NOW,
    });
    expect(
      readSignals({ vault: e.vault }, { states: "all" }).find((s) => s.id === a.id)?.state,
    ).toBe("retired");
    setExpiration(e.vault, `store:shared/${captureRecordId(e, b.id)}`, "2026-12-01");
    expect(frontmatter(e, b.id)?.["expiration_date"]).toBe("2026-12-01");
  });
});

describe("4650588445: a path names its own record, never another by its basename", () => {
  test("signal retire of Notes/<id>.md does not retire the inbox signal of that id", () => {
    const e = makeStoreEnv("osb-cr2-retire-path-", { dualWrite: true });
    env = e;
    const sig = writeSignal(e.vault, signalInput("same-name"));
    mkdirSync(join(e.vault, "Notes"), { recursive: true });
    writeFileSync(join(e.vault, "Notes", `${sig.id}.md`), "a note\n");
    expect(() => retireSignal(e.vault, `Notes/${sig.id}.md`, { reason: "x", now: NOW })).toThrow();
    expect(existsSync(sig.path)).toBe(true);
    // The id and the signal's own page path still resolve.
    retireSignal(e.vault, `Brain/inbox/${sig.id}.md`, { reason: "x", now: NOW });
    expect(existsSync(sig.path)).toBe(false);
  });
});

/** The reach of a caller that may not read `Brain/pledges/`. */
const notPledges = (rel: string): boolean => !rel.startsWith("Brain/pledges/");

describe("4650588385: an ambiguity names only records the caller may read", () => {
  test("a withheld lane entry sharing the name neither blocks nor appears", () => {
    const e = switchedNoTree("osb-cr2-ambig-");
    for (const lane of ["dead-ends", "pledges"]) {
      writeLanePage(e.vault, join(e.vault, "Brain", lane, "twin.md"), { kind: "x" }, "Body.\n");
    }
    const res = tombstone({ vault: e.vault, path: "twin", reason: "r", readable: notPledges });
    expect(res.path).toBe("Brain/dead-ends/twin.md");
    expect(
      readLanePage(e.vault, join(e.vault, "Brain", "pledges", "twin.md"))?.frontmatter["_status"],
    ).toBeUndefined();
    try {
      tombstone({ vault: e.vault, path: "twin", reason: "r", readable: () => true });
    } catch (err) {
      expect((err as Error).message).toContain("Brain/pledges/twin.md");
    }
  });

  test("on an unswitched vault the withheld page is not named either", () => {
    const e = makeStoreEnv("osb-cr2-ambig-legacy-", { dualWrite: false });
    env = e;
    for (const lane of ["dead-ends", "pledges"]) {
      const page = join(e.vault, "Brain", lane, "twin.md");
      mkdirSync(join(e.vault, "Brain", lane), { recursive: true });
      writeFrontmatter(page, { kind: "x" }, "Body.");
    }
    const res = tombstone({ vault: e.vault, path: "twin", reason: "r", readable: notPledges });
    expect(res.path).toBe("Brain/dead-ends/twin.md");
  });
});

describe("4650588389: a fenced store address and a ULID-shaped page name", () => {
  test("[[store:shared/<record id>]] resolves on an unswitched vault", () => {
    const e = makeStoreEnv("osb-cr2-fence-", { dualWrite: true });
    env = e;
    const sig = writeSignal(e.vault, signalInput("fenced"));
    const res = tombstone({
      vault: e.vault,
      path: `[[store:shared/${captureRecordId(e, sig.id)}]]`,
      reason: "r",
    });
    expect(res.path).toBe(`Brain/inbox/${sig.id}.md`);
  });

  test("a legacy page whose name has the shape of a record id is found by that name", () => {
    const e = makeStoreEnv("osb-cr2-ulid-name-", { dualWrite: false });
    env = e;
    const name = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    mkdirSync(join(e.vault, "Brain", "dead-ends"), { recursive: true });
    writeFrontmatter(join(e.vault, "Brain", "dead-ends", `${name}.md`), { kind: "x" }, "Body.");
    expect(tombstone({ vault: e.vault, path: name, reason: "r" }).path).toBe(
      `Brain/dead-ends/${name}.md`,
    );
  });
});

describe("4650588394 and 4650588398: canonical vault root and containment", () => {
  test("a vault reached through a link classifies its page by the vault-relative path", () => {
    const e = makeStoreEnv("osb-cr2-linked-vault-", { dualWrite: true });
    env = e;
    const sig = writeSignal(e.vault, signalInput("linked-vault"));
    const link = join(e.parent, "vault-link");
    symlinkSync(e.vault, link, "junction");
    const res = tombstone({ vault: link, path: `Brain/inbox/${sig.id}.md`, reason: "r" });
    expect(res.path).toBe(`Brain/inbox/${sig.id}.md`);
    // Classified as the signal it is: its record is dual-written.
    expect(records(e, "signal-state").some((r) => r.body["signal"] === sig.id)).toBe(true);
  });

  test("a bare id whose page links outside the vault is refused and the outside file is untouched", () => {
    const e = makeStoreEnv("osb-cr2-escape-", { dualWrite: false });
    env = e;
    const outside = mkdtempSync(join(tmpdir(), "osb-cr2-outside-"));
    extra.push(outside);
    const target = join(outside, "secret.md");
    writeFileSync(target, "---\nkind: brain-signal\nid: sig-2026-11-20-escape\n---\nsecret\n");
    try {
      symlinkSync(target, join(e.vault, "Brain", "inbox", "sig-2026-11-20-escape.md"), "file");
    } catch {
      return; // no right to create a file link on this machine
    }
    expect(() => tombstone({ vault: e.vault, path: "sig-2026-11-20-escape", reason: "r" })).toThrow(
      TombstoneError,
    );
    expect(readFileSync(target, "utf8")).not.toContain("tombstoned");
  });
});

describe("4650588402: a lane entry keeps the partition it lives in", () => {
  test("tombstoning a shared source-archive entry writes its record to shared", () => {
    const e = switchedNoTree("osb-cr2-located-");
    appendRecord(openStore({ root: e.storeRoot, device: "dev-a" }), {
      partition: "shared",
      stream: "events",
      kind: "lane-entry",
      agent: "t",
      body: {
        authority: "agent",
        lane: "source-archive",
        entry: "abc.txt",
        fields: {},
        text: "archived source text",
      },
    });
    tombstone({ vault: e.vault, path: "Brain/.archives/abc.txt", reason: "r" });
    const latest = records(e, "lane-entry").filter((r) => r.body["entry"] === "abc.txt");
    expect(latest.map((r) => r.partition)).toEqual(["shared", "shared"]);
  });
});

describe("4650588425 and 4650588432: temporal-replace is all or none", () => {
  test("a stored predecessor with a vault-note successor is refused before either is written", () => {
    const e = switchedNoTree("osb-cr2-mixed-");
    const a = writeSignal(e.vault, signalInput("mixed-pred"));
    mkdirSync(join(e.vault, "Notes"), { recursive: true });
    const note = join(e.vault, "Notes", "fact.md");
    writeFrontmatter(note, { kind: "note" }, "Fact.");
    const before = readFileSync(note, "utf8");
    expect(() =>
      temporalReplace({
        vault: e.vault,
        predecessor: a.id,
        successor: "Notes/fact.md",
        at: "2026-11-21",
      }),
    ).toThrow();
    expect(frontmatter(e, a.id)?.["valid_until"]).toBeUndefined();
    expect(readFileSync(note, "utf8")).toBe(before);
  });

  test("an outranked predecessor leaves the successor unchanged", () => {
    const e = switchedNoTree("osb-cr2-outranked-pair-");
    writePreference(e.vault, prefInput("pred-rule"), { authority: "agent" });
    writePreference(e.vault, prefInput("succ-rule"), { authority: "agent" });
    storeWrite(
      () =>
        preferenceStoreRecords("pref-pred-rule", { valid_until: "2027-01-01" }, "human", false, [
          "valid_until",
        ]) ?? [],
      { vault: e.vault },
    );
    const sets = records(e, "preference-set").length;
    expect(() =>
      temporalReplace({
        vault: e.vault,
        predecessor: "pref-pred-rule",
        successor: "pref-succ-rule",
        at: "2026-11-21",
      }),
    ).toThrow(/not be applied|not applied/);
    expect(records(e, "preference-set")).toHaveLength(sets);
    expect(loadPreference(e.vault, "succ-rule")?.valid_from ?? null).toBeNull();
  });
});

describe("4650588377: correct appends no claim for a retirement that would not apply", () => {
  test("an outranked flatly-wrong correction is refused before the ledger, and a retry appends nothing", () => {
    const e = switchedNoTree("osb-cr2-correct-ledger-");
    writePreference(e.vault, prefInput("claimed-rule"), { authority: "agent" });
    storeWrite(
      () =>
        preferenceStoreRecords("pref-claimed-rule", { status: "confirmed" }, "human", false, [
          "status",
        ]) ?? [],
      { vault: e.vault },
    );
    appendClaimEvent(e.vault, {
      ts: "2026-11-20T10:00:00Z",
      agent: "t",
      entity: "release",
      aspect: "format",
      value: "one page",
      source: "Brain/preferences/pref-claimed-rule.md",
    });
    const claims = readClaimEvents(e.vault).events.length;
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() =>
        correct({
          vault: e.vault,
          target: "pref-claimed-rule",
          value: "two pages",
          flatlyWrong: true,
          dryRun: false,
          now: NOW,
        }),
      ).toThrow(/not be applied|not applied/);
    }
    expect(readClaimEvents(e.vault).events).toHaveLength(claims);
  });
});

describe("4650588450: tip takes a fenced store address", () => {
  test("[[store:<id>]] resolves the chain like store:<id>", () => {
    const e = switchedNoTree("osb-cr2-tip-");
    const a = writeSignal(e.vault, signalInput("tip-start"));
    expect(resolveChainTipInVault(e.vault, `[[store:${a.id}]]`).resolvedAll).toBe(true);
  });
});

describe("4650588455: an impossible calendar date is refused", () => {
  test("temporal-replace at 2026-13-01 writes nothing", () => {
    const e = switchedNoTree("osb-cr2-date-");
    const a = writeSignal(e.vault, signalInput("date-pred"));
    const b = writeSignal(e.vault, signalInput("date-succ"));
    for (const at of ["2026-13-01", "2026-02-30"]) {
      expect(() =>
        temporalReplace({ vault: e.vault, predecessor: a.id, successor: b.id, at }),
      ).toThrow();
    }
    expect(frontmatter(e, a.id)?.["valid_until"]).toBeUndefined();
    expect(frontmatter(e, b.id)?.["valid_from"]).toBeUndefined();
    // A valid date keeps its spelling.
    temporalReplace({ vault: e.vault, predecessor: a.id, successor: b.id, at: "2026-02-28" });
    expect(frontmatter(e, a.id)?.["valid_until"]).toBe("2026-02-28");
  });
});

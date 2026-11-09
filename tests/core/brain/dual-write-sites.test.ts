/**
 * What the legacy writers hand the brain store under dual writes (task
 * 1.11), site by site: which partition a row goes to, which scope and
 * authority it carries, and which vault and config it is checked against.
 *
 * Every test runs against its own temp HOME, state base, vault and store
 * root under one named parent, removed in teardown. The origin channel is
 * cleared after each test, so an operator-channel test cannot leak into
 * the next one.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendApplyEvidence } from "../../../src/core/brain/apply-evidence.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { mergePreferences } from "../../../src/core/brain/merge.ts";
import { stagePendingSignal } from "../../../src/core/brain/pending.ts";
import { setPinned } from "../../../src/core/brain/pin.ts";
import { moveToRetired, writePreference } from "../../../src/core/brain/preference.ts";
import { writePreferenceTxn } from "../../../src/core/brain/preference-txn.ts";
import { appendClaimEvent } from "../../../src/core/brain/truth/store.ts";
import { clearOriginChannel, setOriginChannel } from "../../../src/core/origin-channel.ts";
import { appendAuditRecord } from "../../../src/core/reliability/audit.ts";
import {
  LEDGER_ROW_KIND,
  LOG_EVENT_KIND,
  PREFERENCE_EVIDENCE_KIND,
  PREFERENCE_SET_KIND,
  SIGNAL_KIND,
  STORE_DUAL_WRITE_ENV,
  STORE_ROOT_ENV,
} from "../../../src/core/store/constants.ts";
import { readDualWriteStatus } from "../../../src/core/store/dual-write.ts";
import type { StoreRecord } from "../../../src/core/store/envelope.ts";
import { foldPreferences } from "../../../src/core/store/fold-preferences.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { ensureStore } from "../store/fixtures/temp-store.ts";
import { makeTestVault } from "../../helpers/test-vault.ts";
import { neverHeld } from "../../helpers/held-partitions.ts";

const ENV_KEYS = [
  STORE_DUAL_WRITE_ENV,
  STORE_ROOT_ENV,
  "O2B_DEVICE_ID",
  "HOME",
  "XDG_STATE_HOME",
  "LOCALAPPDATA",
] as const;

let parent: string;
let vault: string;
let storeRoot: string;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  parent = mkdtempSync(join(tmpdir(), "osb-dual-write-sites-"));
  vault = join(parent, "vault");
  storeRoot = join(parent, "store");
  mkdirSync(vault, { recursive: true });
  bootstrapBrain(vault);
  process.env["HOME"] = join(parent, "home");
  process.env["XDG_STATE_HOME"] = join(parent, "state");
  process.env["LOCALAPPDATA"] = join(parent, "state");
  process.env[STORE_ROOT_ENV] = storeRoot;
  process.env["O2B_DEVICE_ID"] = "dev-a";
  process.env[STORE_DUAL_WRITE_ENV] = "1";
  // Writers never create a store; `o2b store init` does.
  ensureStore(storeRoot);
});

afterEach(() => {
  clearOriginChannel();
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function storeRecords(partition: "shared" | "private" = "shared"): StoreRecord[] {
  const dir = join(storeRoot, partition);
  return existsSync(dir) ? readPartition(dir).flatMap((shard) => shard.records) : [];
}

function ledgerRows(ledger: string, partition: "shared" | "private" = "shared"): StoreRecord[] {
  const dir = join(storeRoot, partition);
  if (!existsSync(dir)) return [];
  return readPartition(dir)
    .filter((shard) => shard.rel.startsWith(`ledgers/${ledger}/`))
    .flatMap((shard) => shard.records)
    .filter((r) => r.kind === LEDGER_ROW_KIND);
}

function preferenceInput(slug: string, extra: Record<string, unknown> = {}) {
  return {
    slug,
    topic: slug,
    principle: `principle ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-30T00:00:00Z",
    status: "unconfirmed" as const,
    evidenced_by: [],
    ...extra,
  };
}

describe("signals", () => {
  test("a signal staged into Brain/pending is recorded as staged", () => {
    stagePendingSignal(vault, {
      topic: "staged",
      signal: "positive",
      agent: "claude",
      principle: "Stage it for review",
      created_at: "2026-11-06T10:00:00Z",
      date: "2026-11-06",
      slug: "staged",
    });
    const record = storeRecords().find((r) => r.kind === SIGNAL_KIND);
    expect(record?.body["staged"]).toBe(true);
    expect(String(record?.body["path"])).toStartWith("Brain/pending/");
  });
});

describe("a private preference keeps its trail in the private partition", () => {
  test("the audit rows of its create and retire", () => {
    const written = writePreferenceTxn(
      vault,
      preferenceInput("hidden", { visibility: ["private"] }),
      [],
      {},
      undefined,
      { agent: "claude" },
    );
    moveToRetired(vault, written.path, "user-rejected", {
      now: new Date("2026-11-06T12:00:00Z"),
      retired_by: "[[operator]]",
      audit: { agent: "claude" },
    });
    expect(ledgerRows("preference-audit", "shared")).toEqual([]);
    const ops = ledgerRows("preference-audit", "private").map(
      (r) => (r.body["row"] as Record<string, unknown>)["op"],
    );
    expect(ops).toEqual(["create", "retire"]);
  });

  test("a private write lands exactly its preference-set record and its audit row in private", () => {
    writePreferenceTxn(
      vault,
      preferenceInput("hidden-count", { visibility: ["private"] }),
      [],
      {},
      undefined,
      { agent: "claude" },
    );
    expect(
      storeRecords("private")
        .map((r) => r.kind)
        .toSorted(),
    ).toEqual([LEDGER_ROW_KIND, PREFERENCE_SET_KIND].toSorted());
    expect(storeRecords("shared")).toEqual([]);
  });

  test("on a machine without the private partition its audit rows never reach shared", () => {
    dropPrivatePartition();
    writePreferenceTxn(
      vault,
      preferenceInput("hidden-here", { visibility: ["private"] }),
      [],
      {},
      undefined,
      { agent: "claude" },
    );
    expect(ledgerRows("preference-audit", "shared")).toEqual([]);
    // The appender refused the private row, which counts as a failure.
    // Exactly the two private records of the write were refused: its
    // preference-set record and its audit row (the control above lands
    // the same two in `private`).
    expect(readDualWriteStatus().failures).toBe(2);
  });

  test("its evidence", () => {
    writePreference(vault, preferenceInput("hidden-ev", { visibility: ["private"] }));
    appendApplyEvidence(vault, {
      pref_id: "pref-hidden-ev",
      artifact: "[[note]]",
      result: "applied",
      agent: "claude",
    });
    expect(storeRecords("shared").filter((r) => r.kind === PREFERENCE_EVIDENCE_KIND)).toEqual([]);
    expect(storeRecords("private").filter((r) => r.kind === PREFERENCE_EVIDENCE_KIND).length).toBe(
      1,
    );
  });
});

/** Add an informal privacy marker to a page, as a hand edit would. */
function markByHand(path: string, marker: string): void {
  const text = readFileSync(path, "utf8");
  writeFileSync(path, text.replace(/^---\r?\n/, `---\n${marker}\n`));
}

const evidenceOrEvent = (r: StoreRecord) =>
  r.kind === PREFERENCE_EVIDENCE_KIND || r.kind === LOG_EVENT_KIND;

const isPin = (r: StoreRecord) =>
  r.kind === PREFERENCE_SET_KIND && Object.keys(r.body["fields"] as object).join() === "pinned";

const retireSets = (partition: "shared" | "private") =>
  storeRecords(partition).filter(
    (r) =>
      r.kind === PREFERENCE_SET_KIND &&
      (r.body["fields"] as Record<string, unknown>)["status"] === "retired",
  );

const auditOps = (partition: "shared" | "private") =>
  ledgerRows("preference-audit", partition).map(
    (r) => (r.body["row"] as Record<string, unknown>)["op"],
  );

const mergeRows = (partition: "shared" | "private") =>
  ledgerRows("preference-audit", partition).filter(
    (r) => (r.body["row"] as Record<string, unknown>)["op"] === "merge",
  );

describe("an informal privacy marker on disk decides the partition at every site", () => {
  // The same rule search and remote reads use: `access: private`,
  // `confidentiality: secret` and `sensitivity: confidential` reserve a
  // page as private just like `visibility: private`.
  test("evidence and its log event", () => {
    const { path } = writePreference(vault, preferenceInput("by-hand-ev"));
    markByHand(path, "access: private");
    appendApplyEvidence(vault, {
      pref_id: "pref-by-hand-ev",
      artifact: "[[note]]",
      result: "applied",
      agent: "claude",
    });
    expect(storeRecords("shared").filter(evidenceOrEvent)).toEqual([]);
    expect(
      storeRecords("private")
        .filter(evidenceOrEvent)
        .map((r) => r.kind)
        .toSorted(),
    ).toEqual([LOG_EVENT_KIND, PREFERENCE_EVIDENCE_KIND].toSorted());
  });

  test("a pin", () => {
    const { path } = writePreference(vault, preferenceInput("by-hand-pin"));
    markByHand(path, "confidentiality: secret");
    setPinned(vault, "pref-by-hand-pin", true);
    expect(storeRecords("shared").filter(isPin)).toEqual([]);
    expect(storeRecords("private").filter(isPin).length).toBe(1);
  });

  test("a retire and its audit row", () => {
    const written = writePreferenceTxn(vault, preferenceInput("by-hand-ret"), [], {}, undefined, {
      agent: "claude",
    });
    markByHand(written.path, "sensitivity: confidential");
    moveToRetired(vault, written.path, "user-rejected", {
      now: new Date("2026-11-06T12:00:00Z"),
      retired_by: "[[operator]]",
      audit: { agent: "claude" },
    });
    expect(retireSets("shared")).toEqual([]);
    expect(retireSets("private").length).toBeGreaterThan(0);
    // The create happened before the hand edit; the retire follows the marker.
    expect(auditOps("shared")).not.toContain("retire");
    expect(auditOps("private")).toContain("retire");
  });

  test("the merge audit row of a hand-marked keep", () => {
    for (const slug of ["keep-mark", "drop-mark"]) {
      writePreferenceTxn(
        vault,
        preferenceInput(slug, {
          topic: "shared-topic",
          status: "confirmed",
          confirmed_at: "2026-05-02T00:00:00Z",
        }),
        [],
        {},
        undefined,
        { agent: "claude" },
      );
    }
    markByHand(join(vault, "Brain", "preferences", "pref-keep-mark.md"), "access: private");
    mergePreferences(vault, "pref-keep-mark", "pref-drop-mark", {
      now: new Date("2026-11-06T12:00:00Z"),
      agentName: "operator",
    });
    expect(mergeRows("shared")).toEqual([]);
    expect(mergeRows("private").length).toBe(1);
  });

  test("an unmarked page with an unrelated access value stays shared", () => {
    const { path } = writePreference(vault, preferenceInput("by-hand-team"));
    markByHand(path, "access: team");
    appendApplyEvidence(vault, {
      pref_id: "pref-by-hand-team",
      artifact: "[[note]]",
      result: "applied",
      agent: "claude",
    });
    expect(storeRecords("private").filter((r) => r.kind === PREFERENCE_EVIDENCE_KIND)).toEqual([]);
    expect(storeRecords("shared").filter((r) => r.kind === PREFERENCE_EVIDENCE_KIND).length).toBe(
      1,
    );
  });
});

describe("authority of preference fields", () => {
  test("an operator write leaves the derived fields to the dream pass", () => {
    setOriginChannel("cli");
    writePreference(vault, preferenceInput("by-operator", { scope: "coding" }));
    clearOriginChannel();
    // The dream pass later promotes it, at agent authority.
    writePreference(
      vault,
      preferenceInput("by-operator", {
        scope: "coding",
        status: "confirmed",
        confirmed_at: "2026-05-02T00:00:00Z",
      }),
      { overwrite: true, authority: "agent" },
    );
    const state = foldPreferences(storeRecords()).preferences.get("pref-by-operator")!;
    expect(state.fields["status"]).toBe("confirmed");
    expect(state.fields["principle"]).toBe("principle by-operator");
    // The operator's own fields stay human; every record keeps the scope.
    const sets = storeRecords().filter((r) => r.kind === PREFERENCE_SET_KIND);
    const human = sets.find((r) => r.body["authority"] === "human")!;
    expect(Object.keys(human.body["fields"] as object)).toContain("principle");
    expect(Object.keys(human.body["fields"] as object)).not.toContain("status");
    expect(sets.every((r) => r.scope === "coding")).toBe(true);
  });

  test("an operator retire decides the status and keeps the preference's identity", () => {
    const { path } = writePreference(vault, preferenceInput("rejected"));
    setOriginChannel("cli");
    moveToRetired(vault, path, "user-rejected", {
      now: new Date("2026-11-06T12:00:00Z"),
      retired_by: "[[operator]]",
    });
    clearOriginChannel();
    const state = foldPreferences(storeRecords()).preferences.get("pref-rejected")!;
    expect(state.fields["status"]).toBe("retired");
    expect(state.fields["id"]).toBe("pref-rejected");
    expect(state.fields["kind"]).not.toBe("brain-retired");
    const humanStatus = storeRecords().find(
      (r) =>
        r.kind === PREFERENCE_SET_KIND &&
        r.body["authority"] === "human" &&
        "status" in (r.body["fields"] as object),
    );
    expect(humanStatus).toBeDefined();
  });

  test("a pin carries the preference's scope", () => {
    writePreference(vault, preferenceInput("scoped", { scope: "writing" }));
    setPinned(vault, "pref-scoped", true);
    const pin = storeRecords()
      .filter((r) => r.kind === PREFERENCE_SET_KIND)
      .find((r) => Object.keys(r.body["fields"] as object).join() === "pinned");
    expect(pin).toBeDefined();
    expect(pin!.scope).toBe("writing");
  });
});

describe("the vault and config a dual write is checked against", () => {
  test("a store root inside the vault being written is refused, the legacy write kept", () => {
    // The configured vault (the suite's default) is another directory, so
    // only the vault actually written can catch this root.
    const inside = join(vault, "store");
    process.env[STORE_ROOT_ENV] = inside;
    appendLogEvent(vault, {
      timestamp: "2026-11-06T10:01:00Z",
      eventType: "note",
      agent: "claude",
      body: { text: "kept" },
    });
    expect(existsSync(inside)).toBe(false);
    expect(readDualWriteStatus().failures).toBe(1);
  });

  test("an audit row checks the store root against the vault it belongs to", () => {
    const inside = join(vault, "store");
    process.env[STORE_ROOT_ENV] = inside;
    appendAuditRecord(
      join(vault, "Brain", "log", "hygiene"),
      {
        timestamp: "2026-11-06T10:00:00Z",
        actor: "claude",
        action: "apply",
        target: "note",
        ok: true,
      },
      vault,
    );
    expect(existsSync(inside)).toBe(false);
    expect(readDualWriteStatus().failures).toBe(1);
  });

  test("the flag is read from the config the caller names", () => {
    delete process.env[STORE_DUAL_WRITE_ENV];
    const configPath = join(parent, "config.yaml");
    writeFileSync(configPath, `vault: ${vault}\nstore_dual_write: "true"\n`);
    appendClaimEvent(
      vault,
      {
        ts: "2026-06-01T10:00:00Z",
        agent: "claude",
        entity: "Alice Mason",
        aspect: "employer",
        value: "Google",
        source: "[[Brain/notes/standup.md]]",
      },
      { configPath },
    );
    expect(ledgerRows("truth-claims", "private").length).toBe(1);
  });
});

/** This machine holds only `shared`, as after `o2b store init --partitions shared`. */
function dropPrivatePartition(): void {
  neverHeld(storeRoot);
}

function auditTrailRow(
  trail: string,
  extra: { target?: string; details?: Record<string, unknown> } = {},
  rowVault: string | null = vault,
): void {
  appendAuditRecord(
    join(vault, "Brain", "log", trail),
    {
      timestamp: "2026-11-06T10:00:00Z",
      actor: "claude",
      action: "apply",
      target: extra.target ?? "note",
      ok: true,
      ...(extra.details !== undefined ? { details: extra.details } : {}),
    },
    rowVault ?? undefined,
  );
}

const logEvents = (partition: "shared" | "private") =>
  storeRecords(partition).filter((r) => r.kind === LOG_EVENT_KIND);

function writeNote(rel: string, frontmatter: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, `---\n${frontmatter}\n---\n\n# Note\n`);
}

function claimFrom(source: string): void {
  appendClaimEvent(vault, {
    ts: "2026-06-01T10:00:00Z",
    agent: "claude",
    entity: "Alice Mason",
    aspect: "employer",
    value: "Google",
    source,
  });
}

/** Two preferences on one topic, the one to drop marked private by hand, then merged. */
function mergeWithPrivateDrop(holdPrivate: boolean): void {
  for (const slug of ["keep-open", "drop-secret"]) {
    writePreferenceTxn(
      vault,
      preferenceInput(slug, {
        topic: "merged-topic",
        status: "confirmed",
        confirmed_at: "2026-05-02T00:00:00Z",
      }),
      [],
      {},
      undefined,
      { agent: "claude" },
    );
  }
  markByHand(join(vault, "Brain", "preferences", "pref-drop-secret.md"), "access: private");
  if (!holdPrivate) dropPrivatePartition();
  mergePreferences(vault, "pref-keep-open", "pref-drop-secret", {
    now: new Date("2026-11-06T12:00:00Z"),
    agentName: "operator",
  });
}

describe("a log event that names a private page stays out of shared", () => {
  test("the log event of a pin on a private preference", () => {
    writePreference(vault, preferenceInput("pinned-secret", { visibility: ["private"] }));
    setPinned(vault, "pref-pinned-secret", true);
    expect(logEvents("shared")).toEqual([]);
    expect(logEvents("private").length).toBeGreaterThan(0);
  });

  /**
   * Records of the merge that name the private preference, refused on a
   * shared-only machine: the dropped preference's retiring preference-set
   * record and its retire audit row, the merge audit row and the merge log
   * event.
   */
  const MERGE_PRIVATE_RECORDS = 4;

  test("a merge whose dropped preference is private lands its rows in private", () => {
    mergeWithPrivateDrop(true);
    expect(mergeRows("private")).toHaveLength(1);
    expect(logEvents("private").filter((r) => r.body["event_type"] === "merge")).toHaveLength(1);
    expect(mergeRows("shared")).toEqual([]);
    expect(readDualWriteStatus().failures).toBe(0);
  });

  test("a merge whose dropped preference is private, with its audit row", () => {
    mergeWithPrivateDrop(false);
    expect(mergeRows("shared")).toEqual([]);
    expect(logEvents("shared").filter((r) => r.body["event_type"] === "merge")).toEqual([]);
    // Every record the control lands in private was refused here, not skipped.
    expect(readDualWriteStatus().failures).toBe(MERGE_PRIVATE_RECORDS);
  });

  test("on a machine without the private partition it is refused and counted", () => {
    writePreference(vault, preferenceInput("named-secret", { visibility: ["private"] }));
    dropPrivatePartition();
    appendLogEvent(vault, {
      timestamp: "2026-11-06T10:00:00Z",
      eventType: "note",
      agent: "claude",
      body: {
        text: "about [[pref-named-secret|principle named-secret]]",
        rule: "[[pref-named-secret]]",
      },
    });
    expect(logEvents("shared")).toEqual([]);
    expect(readDualWriteStatus().failures).toBe(1);
  });

  test("a note page reserved as private, named by its path", () => {
    writeNote("notes/diary.md", "visibility: private");
    appendLogEvent(vault, {
      timestamp: "2026-11-06T10:00:00Z",
      eventType: "note",
      agent: "claude",
      body: { text: "edited", target: "[[notes/diary]]" },
    });
    expect(logEvents("shared")).toEqual([]);
    expect(logEvents("private").length).toBe(1);
  });

  test("a preference id with no page on disk cannot be judged and counts as private", () => {
    appendLogEvent(vault, {
      timestamp: "2026-11-06T10:00:00Z",
      eventType: "note",
      agent: "claude",
      body: { rule: "[[pref-gone]]" },
    });
    expect(logEvents("shared")).toEqual([]);
    expect(logEvents("private").length).toBe(1);
  });

  test("a private page named by its absolute path stays out of shared", () => {
    writeNote("notes/diary.md", "visibility: private");
    appendLogEvent(vault, {
      timestamp: "2026-11-06T10:00:00Z",
      eventType: "note",
      agent: "claude",
      body: { text: "edited", target: join(vault, "notes", "diary.md") },
    });
    expect(logEvents("shared")).toEqual([]);
    expect(logEvents("private").length).toBe(1);
  });

  test("an absolute path outside the vault names no page anyone may be shown", () => {
    appendLogEvent(vault, {
      timestamp: "2026-11-06T10:00:00Z",
      eventType: "note",
      agent: "claude",
      body: { text: "read", target: join(parent, "elsewhere.md") },
    });
    expect(logEvents("shared")).toEqual([]);
    expect(logEvents("private").length).toBe(1);
  });

  test("a reconcile event naming its topic's missing preference by id is not spared", () => {
    appendLogEvent(vault, {
      timestamp: "2026-11-06T10:00:00Z",
      eventType: "reconcile",
      agent: "claude",
      body: { topic: "gone-topic", preference: "pref-gone-topic" },
    });
    expect(logEvents("shared")).toEqual([]);
    expect(logEvents("private").length).toBe(1);
  });

  test("a reconcile event's topic guess alone does not make it private", () => {
    appendLogEvent(vault, {
      timestamp: "2026-11-06T10:00:00Z",
      eventType: "reconcile",
      agent: "claude",
      body: { topic: "gone-topic" },
    });
    expect(logEvents("private")).toEqual([]);
    expect(logEvents("shared").length).toBe(1);
  });

  test("an event naming open pages and non-page artifacts stays shared", () => {
    writePreference(vault, preferenceInput("open-rule"));
    writeNote("notes/open.md", "tags: [x]");
    appendLogEvent(vault, {
      timestamp: "2026-11-06T10:00:00Z",
      eventType: "note",
      agent: "claude",
      body: {
        rule: "[[pref-open-rule]]",
        page: "[[notes/open]]",
        artifact: "[[src/cli/main.ts:120-145]]",
        text: "free text",
      },
    });
    expect(logEvents("private")).toEqual([]);
    expect(logEvents("shared").length).toBe(1);
  });
});

describe("a truth claim taken from a private page stays out of shared", () => {
  test("a private source goes to private", () => {
    writeNote("notes/standup.md", "access: private");
    claimFrom("[[notes/standup]]");
    expect(ledgerRows("truth-claims", "shared")).toEqual([]);
    expect(ledgerRows("truth-claims", "private").length).toBe(1);
  });

  test("a private source on a machine without the private partition is refused", () => {
    writeNote("notes/standup.md", "visibility: private");
    dropPrivatePartition();
    claimFrom("[[notes/standup.md]]");
    expect(ledgerRows("truth-claims", "shared")).toEqual([]);
    expect(readDualWriteStatus().failures).toBe(1);
  });

  test("a linked source that resolves to no page is refused on a shared-only machine", () => {
    dropPrivatePartition();
    claimFrom("[[notes/not-synced-yet]]");
    expect(ledgerRows("truth-claims", "shared")).toEqual([]);
    expect(readDualWriteStatus().failures).toBe(1);
  });

  test("an open source or a non-page source reaches shared on a shared-only machine", () => {
    writeNote("notes/open.md", "tags: [x]");
    dropPrivatePartition();
    claimFrom("[[notes/open]]");
    claimFrom("https://example.com/about");
    expect(ledgerRows("truth-claims", "shared").length).toBe(2);
    expect(readDualWriteStatus().failures).toBe(0);
  });
});

describe("audit rows go to private when this machine holds it, else shared", () => {
  test("a preference-audit row of an open preference", () => {
    writePreferenceTxn(vault, preferenceInput("open"), [], {}, undefined, { agent: "claude" });
    expect(ledgerRows("preference-audit", "private").length).toBe(1);
    expect(ledgerRows("preference-audit", "shared")).toEqual([]);
  });

  test("a preference-audit row of an open preference on a shared-only machine", () => {
    dropPrivatePartition();
    writePreferenceTxn(vault, preferenceInput("open"), [], {}, undefined, { agent: "claude" });
    expect(ledgerRows("preference-audit", "shared").length).toBe(1);
    expect(readDualWriteStatus().failures).toBe(0);
  });

  test.each(["hygiene", "secret-custody"])("a reliability-audit row of the %s trail", (trail) => {
    auditTrailRow(trail);
    expect(ledgerRows("reliability-audit", "shared")).toEqual([]);
    const rows = ledgerRows("reliability-audit", "private");
    expect(rows.length).toBe(1);
    const row = rows[0]!.body["row"] as Record<string, unknown>;
    expect(row["audit_dir"]).toBe(trail);
    expect((row["record"] as Record<string, unknown>)["action"]).toBe("apply");
  });

  test.each(["hygiene", "secret-custody"])(
    "a reliability-audit row of the %s trail on a shared-only machine",
    (trail) => {
      dropPrivatePartition();
      auditTrailRow(trail);
      expect(ledgerRows("reliability-audit", "shared").length).toBe(1);
      expect(readDualWriteStatus().failures).toBe(0);
    },
  );

  test("a reliability-audit row carries its actor as the record's agent", () => {
    auditTrailRow("hygiene");
    expect(ledgerRows("reliability-audit", "private")[0]!.agent).toBe("claude");
  });

  test.each([
    ["target", { target: "notes/diary.md" }],
    ["details", { details: { pages: ["[[notes/diary]]"] } }],
  ] as const)(
    "a reliability-audit row naming a private page in its %s is private only",
    (_, extra) => {
      writeNote("notes/diary.md", "visibility: private");
      auditTrailRow("hygiene", extra);
      expect(ledgerRows("reliability-audit", "private").length).toBe(1);
      dropPrivatePartition();
      auditTrailRow("hygiene", extra);
      expect(ledgerRows("reliability-audit", "shared")).toEqual([]);
      expect(readDualWriteStatus().failures).toBe(1);
    },
  );

  test("a reliability-audit row written without its vault cannot be judged and is private only", () => {
    // Without a vault argument the machine's configured vault decides the
    // mode: configure a legacy one, so the machine is unswitched.
    const configured = makeTestVault();
    try {
      dropPrivatePartition();
      auditTrailRow("hygiene", {}, null);
      expect(ledgerRows("reliability-audit", "shared")).toEqual([]);
      expect(readDualWriteStatus().failures).toBe(1);
    } finally {
      configured.cleanup();
    }
  });
});

/**
 * Dual writes (task 1.11): with the flag on, the legacy writers also append
 * the equivalent store record; with it off the store is never touched; a
 * store failure never fails the legacy write.
 *
 * Every test runs against its own temp HOME, state base, vault and store
 * root under one named parent, removed in teardown.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendApplyEvidence } from "../../../src/core/brain/apply-evidence.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { readLogDay } from "../../../src/core/brain/log-jsonl.ts";
import {
  appendPinnedContext,
  clearPinnedContext,
  readPinnedContext,
  writePinnedContext,
} from "../../../src/core/brain/pinned.ts";
import {
  moveToRetired,
  normalizeDerivedKeys,
  preferencePrivacy,
  writePreference,
} from "../../../src/core/brain/preference.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { clearOriginChannel, setOriginChannel } from "../../../src/core/origin-channel.ts";
import { parseFrontmatter } from "../../../src/core/vault.ts";
import {
  appendContinuityRecord,
  appendContinuitySourceInvalidation,
} from "../../../src/core/brain/continuity/store.ts";
import { appendDecisionChangeReceipt } from "../../../src/core/brain/decisions/receipts.ts";
import { appendDecisionLedger } from "../../../src/core/brain/permissions/ledger.ts";
import { recordQueryDemand } from "../../../src/core/brain/query-demand.ts";
import { readVaultIdentity } from "../../../src/core/brain/vault-identity.ts";
import { brainPinnedPath } from "../../../src/core/brain/paths.ts";
import {
  LEDGER_ROW_KIND,
  LOG_EVENT_KIND,
  SIGNAL_KIND,
  STORE_DUAL_WRITE_ENV,
  STORE_ROOT_ENV,
} from "../../../src/core/store/constants.ts";
import { readDualWriteStatus } from "../../../src/core/store/dual-write.ts";
import { initStore } from "../../../src/core/store/store-init.ts";
import { appendClaimEvent } from "../../../src/core/brain/truth/store.ts";
import {
  preferenceFields,
  isPrivateFrontmatter,
  isPrivatePageFile,
} from "../../../src/core/store/dual-write-records.ts";
import type { StoreRecord } from "../../../src/core/store/envelope.ts";
import { foldPinned } from "../../../src/core/store/fold-pinned.ts";
import { foldPreferences } from "../../../src/core/store/fold-preferences.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { deviceStateDirFor, dualWriteStatusPath } from "../../../src/core/store/store-paths.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";
import { forgetHeldPartitions, moveNeverHeld, neverHeld } from "../../helpers/held-partitions.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

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
  parent = mkdtempSync(join(tmpdir(), "osb-dual-write-"));
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
  // As `o2b store init` would on this machine; writers never create a store.
  initStore({ root: storeRoot });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A frontmatter value as the legacy text parser reads it back. */
function asText(value: unknown): unknown {
  return Array.isArray(value) ? value.map((v) => String(v)) : String(value);
}

function storeRecords(partition: "shared" | "private" = "shared"): StoreRecord[] {
  return readPartition(join(storeRoot, partition)).flatMap((shard) => shard.records);
}

function seedPreference(slug: string, extra: Record<string, unknown> = {}): string {
  return writePreference(vault, {
    slug,
    topic: slug,
    principle: `principle ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-30T00:00:00Z",
    status: "confirmed",
    confirmed_at: "2026-05-02T00:00:00Z",
    evidenced_by: [],
    confidence: "high",
    ...extra,
  }).path;
}

function writeSampleSignal(): { path: string; id: string } {
  return writeSignal(vault, {
    topic: "dual-write",
    signal: "positive",
    agent: "claude",
    principle: "Write both trees while the trial runs",
    created_at: "2026-11-06T10:00:00Z",
    date: "2026-11-06",
    slug: "dual-write",
    scope: "coding",
    raw: "the user said so",
  });
}

function writeSampleLogEvent(): void {
  appendLogEvent(vault, {
    timestamp: "2026-11-06T10:01:00Z",
    eventType: "note",
    agent: "claude",
    body: { text: "a milestone" },
  });
}

describe("flag on: each legacy write lands in both places with matching content", () => {
  test("a signal", () => {
    const { path, id } = writeSampleSignal();
    const record = storeRecords().find((r) => r.kind === SIGNAL_KIND);
    expect(record).toBeDefined();
    const [frontmatter] = parseFrontmatter(path);
    expect(record!.body["id"]).toBe(id);
    expect(record!.body["path"]).toBe(`Brain/inbox/${id}.md`);
    expect(record!.body["frontmatter"]).toEqual(JSON.parse(JSON.stringify(frontmatter)));
    expect(record!.body["raw"]).toBe("the user said so");
    expect(record!.agent).toBe("claude");
    expect(record!.scope).toBe("coding");
    expect(record!.device).toBe("dev-a");
  });

  test("a log event", () => {
    writeSampleLogEvent();
    const legacy = readLogDay(vault, "2026-11-06").entries;
    expect(legacy.length).toBe(1);
    const records = storeRecords().filter((r) => r.kind === LOG_EVENT_KIND);
    expect(records.length).toBe(1);
    expect(records[0]!.body).toEqual({
      timestamp: legacy[0]!.timestamp,
      event_type: legacy[0]!.eventType,
      body: JSON.parse(JSON.stringify(legacy[0]!.body)),
      vault_id: readVaultIdentity(vault)!.vault_id,
    });
  });

  test("pinned context folds to the legacy file through write, append and clear", () => {
    writePinnedContext(vault, "first");
    appendPinnedContext(vault, "second");
    expect(foldPinned(storeRecords("private")).content).toBe(readPinnedContext(vault).content);
    expect(foldPinned(storeRecords("private")).content).toBe("first\n\nsecond");
    clearPinnedContext(vault);
    const fold = foldPinned(storeRecords("private"));
    expect(fold.cleared).toBe(true);
    expect(fold.content ?? "").toBe(readPinnedContext(vault).content);
    expect(fold.rejected).toEqual([]);
  });

  test("a preference write, evidence and a retire fold to the legacy state", () => {
    const path = seedPreference("alpha");
    let fold = foldPreferences(storeRecords());
    const state = fold.preferences.get("pref-alpha")!;
    expect(state.exists).toBe(true);
    // The legacy file is read back as text values with `_`-prefixed derived
    // keys; the store keeps the writer's typed values under the plain names.
    // Every field matches once both are spelled the same way.
    const legacy = preferenceFields(normalizeDerivedKeys(parseFrontmatter(path)[0]));
    expect(Object.keys(state.fields)).toEqual(Object.keys(legacy).toSorted());
    for (const [name, value] of Object.entries(legacy)) {
      expect(asText(state.fields[name])).toEqual(asText(value));
    }
    expect(fold.rejected).toEqual([]);

    appendApplyEvidence(vault, {
      pref_id: "pref-alpha",
      artifact: "[[some-note]]",
      result: "applied",
      agent: "claude",
    });
    fold = foldPreferences(storeRecords());
    expect(fold.preferences.get("pref-alpha")!.counters.applied_count).toBe(1);
    // The evidence is also a log event, exactly as in the legacy log.
    expect(storeRecords().filter((r) => r.kind === LOG_EVENT_KIND).length).toBe(1);

    const retired = moveToRetired(vault, path, "user-rejected", {
      now: new Date("2026-11-06T12:00:00Z"),
      retired_by: "[[operator]]",
    });
    fold = foldPreferences(storeRecords());
    const after = fold.preferences.get("pref-alpha")!;
    expect(after.fields["status"]).toBe("retired");
    expect(after.fields["status"]).toBe(parseFrontmatter(retired.path)[0]["_status"]);
  });

  test("authority follows the origin: an operator command is human, an agent call is agent", () => {
    setOriginChannel("cli");
    try {
      seedPreference("by-operator");
    } finally {
      clearOriginChannel();
    }
    const records = storeRecords().filter((r) => r.kind === "preference-set");
    // The operator decides the fields it wrote; the derived fields the dream
    // pass owns go out beside them at agent authority.
    expect(records.map((r) => r.body["authority"])).toEqual(["human", "agent"]);
  });

  test("an unclaimed or agent process writes agent authority, and the caller can override it", () => {
    seedPreference("by-agent");
    writePreference(
      vault,
      {
        slug: "by-model",
        topic: "by-model",
        principle: "principle by-model",
        created_at: "2026-05-01T00:00:00Z",
        unconfirmed_until: "2026-05-30T00:00:00Z",
        status: "unconfirmed",
        evidenced_by: [],
      },
      { authority: "model" },
    );
    const byId = new Map(
      storeRecords()
        .filter((r) => r.kind === "preference-set")
        .map((r) => [r.body["preference"], r.body["authority"]]),
    );
    expect(byId.get("pref-by-agent")).toBe("agent");
    expect(byId.get("pref-by-model")).toBe("model");
  });

  test("a private preference goes to the private partition", () => {
    seedPreference("secret", { visibility: ["private"] });
    expect(storeRecords("shared").filter((r) => r.kind === "preference-set")).toEqual([]);
    expect(storeRecords("private").filter((r) => r.kind === "preference-set").length).toBe(1);
  });

  test("an informal privacy marker routes a record to the private partition", () => {
    // Hand-edited pages carry these; the legacy writers keep what is on disk.
    for (const marker of [
      { access: "private" },
      { Confidentiality: "Secret" },
      { sensitivity: ["confidential"] },
    ]) {
      expect(isPrivateFrontmatter({ topic: "x", ...marker })).toBe(true);
      expect(preferencePrivacy(vault, { topic: "x", ...marker })()).toBe(true);
    }
    expect(preferencePrivacy(vault, { topic: "y", access: "team" })()).toBe(false);
  });

  test("a page file decides privacy by the same markers, and an unreadable one is private", () => {
    const page = join(vault, "page.md");
    writeFileSync(page, "---\nconfidentiality: secret\n---\nbody\n");
    expect(isPrivatePageFile(page)).toBe(true);
    writeFileSync(page, "---\ntopic: x\n---\nbody\n");
    expect(isPrivatePageFile(page)).toBe(false);
    // A directory where the page should be cannot be read as a page.
    const unreadable = join(vault, "folder.md");
    mkdirSync(unreadable);
    expect(isPrivatePageFile(unreadable)).toBe(true);
  });

  test("evidence on a private preference keeps its log event and ledger rows out of shared", () => {
    seedPreference("hush", { visibility: ["private"] });
    appendApplyEvidence(vault, {
      pref_id: "pref-hush",
      artifact: "[[some-note]]",
      result: "applied",
      agent: "claude",
    });
    const shared = storeRecords("shared").map((r) => JSON.stringify(r));
    expect(shared.filter((line) => line.includes("hush"))).toEqual([]);
    const kinds = storeRecords("private").map((r) => r.kind);
    expect(kinds).toContain(LOG_EVENT_KIND);
    expect(kinds).toContain("preference-evidence");
  });

  test("a partition that arrives after the first write is used without a restart", () => {
    seedPreference("first"); // opens and caches the store with both partitions
    const parked = join(parent, "private-parked");
    moveNeverHeld(storeRoot, parked);
    seedPreference("while-away", { visibility: ["private"] });
    expect(readDualWriteStatus().failures).toBe(1);
    renameSync(parked, join(storeRoot, "private")); // the sync delivers it again
    seedPreference("after-sync", { visibility: ["private"] });
    expect(readDualWriteStatus().failures).toBe(1);
    const ids = storeRecords("private").map((r) => r.body["preference"]);
    expect(ids).toContain("pref-after-sync");
  });

  test("a different store created at the same root is used with its own device-local state", () => {
    seedPreference("first"); // opens and caches the first store
    rmSync(storeRoot, { recursive: true, force: true });
    const { storeId } = initStore({ root: storeRoot });
    seedPreference("second");
    expect(storeRecords("shared").map((r) => r.body["preference"])).toEqual(["pref-second"]);
    // The clock and the locks of the write came from the new store's state.
    expect(existsSync(deviceStateDirFor(storeId))).toBe(true);
  });

  test("a per-device ledger row lands under ledgers/<name>", () => {
    const row = appendContinuitySourceInvalidation(vault, {
      createdAt: "2026-11-06T10:00:00Z",
      source: { id: "src-1" },
      reason: "test",
    });
    const shards = readPartition(join(storeRoot, "shared")).filter((s) =>
      s.rel.startsWith("ledgers/continuity/dev-a/"),
    );
    const records = shards.flatMap((s) => s.records);
    expect(records.length).toBe(1);
    expect(records[0]!.kind).toBe(LEDGER_ROW_KIND);
    expect(records[0]!.body["row"]).toEqual(JSON.parse(JSON.stringify(row)));
  });
});

describe("flag off", () => {
  test("writes nothing to the store and leaves no status file", () => {
    delete process.env[STORE_DUAL_WRITE_ENV];
    writeSampleSignal();
    writeSampleLogEvent();
    writePinnedContext(vault, "pinned");
    seedPreference("off");
    expect(storeRecords("shared")).toEqual([]);
    expect(storeRecords("private")).toEqual([]);
    expect(existsSync(dualWriteStatusPath())).toBe(false);
    expect(readLogDay(vault, "2026-11-06").entries.length).toBe(1);
  });
});

const WORKER = join(import.meta.dir, "fixtures", "dual-write-worker.ts");

/** Run `count` log appends in a fresh process; its stderr. */
async function appendInChild(count: number): Promise<string> {
  const child = Bun.spawn([process.execPath, WORKER, vault, String(count)], {
    env: { ...process.env },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code).toBe(0);
  return stderr;
}

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

describe("store failures never fail the legacy write", () => {
  test("an unusable store root keeps every legacy write, counts the failures and warns once", () => {
    // A regular file where the store root should be: the store cannot open.
    rmSync(storeRoot, { recursive: true, force: true });
    writeFileSync(storeRoot, "not a directory");
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      writeSampleLogEvent();
      writePinnedContext(vault, "kept");
      const pref = seedPreference("kept");
      expect(readLogDay(vault, "2026-11-06").entries.length).toBe(1);
      expect(readPinnedContext(vault).content).toBe("kept");
      expect(existsSync(pref)).toBe(true);
    } finally {
      stderr.mockRestore();
    }
    const status = readDualWriteStatus();
    expect(status.failures).toBe(3);
    expect(status.last_error).not.toBeNull();
  });

  test("a process prints the failure warning exactly once", async () => {
    rmSync(storeRoot, { recursive: true, force: true });
    writeFileSync(storeRoot, "not a directory");
    const stderr = await appendInChild(3);
    expect(occurrences(stderr, "brain store dual write failed")).toBe(1);
    expect(readDualWriteStatus().failures).toBe(3);
  });

  test("a process prints the missing device id warning exactly once", async () => {
    process.env["O2B_DEVICE_ID"] = "";
    const stderr = await appendInChild(2);
    expect(occurrences(stderr, "no device id")).toBe(1);
    expect(readDualWriteStatus().skipped_no_device).toBe(2);
  });

  test("a private record on a machine without the private partition is refused, the legacy write kept", () => {
    seedPreference("open"); // opens the store with both partitions
    neverHeld(storeRoot);
    const path = seedPreference("hidden", { visibility: ["private"] });
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(storeRoot, "private"))).toBe(false);
    expect(readDualWriteStatus().failures).toBe(1);
  });

  test("an empty device id skips the dual writes and counts the skip", () => {
    process.env["O2B_DEVICE_ID"] = "";
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      writeSampleLogEvent();
      writeSampleLogEvent();
    } finally {
      stderr.mockRestore();
    }
    expect(readLogDay(vault, "2026-11-06").entries.length).toBe(2);
    expect(storeRecords("shared")).toEqual([]);
    expect(readDualWriteStatus().skipped_no_device).toBe(2);
  });
});

describe("a torn identity file under a running process", () => {
  test("the write is refused and counted, the legacy write kept, and the next one lands", () => {
    seedPreference("first"); // opens and caches the store
    const identityFile = join(storeRoot, "shared", "store.json");
    const intact = readFileSync(identityFile, "utf8");
    writeFileSync(identityFile, intact.slice(0, 5)); // a sync tool mid-copy
    const path = seedPreference("during");
    expect(existsSync(path)).toBe(true);
    expect(readDualWriteStatus().failures).toBe(1);
    expect(readDualWriteStatus().last_error).toContain("store.json");
    writeFileSync(identityFile, intact);
    seedPreference("after");
    const ids = storeRecords("shared").map((r) => r.body["preference"]);
    expect(ids).toEqual(["pref-first", "pref-after"]);
  });
});

describe("no store yet", () => {
  // A machine that never had a store: the root and its list of held partitions are gone.
  beforeEach(forgetHeldPartitions);

  test("dual writes never create a store: they are skipped and counted, the legacy writes kept", () => {
    rmSync(storeRoot, { recursive: true, force: true });
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      writeSampleLogEvent();
      const pref = seedPreference("no-store");
      expect(existsSync(pref)).toBe(true);
    } finally {
      stderr.mockRestore();
    }
    expect(readLogDay(vault, "2026-11-06").entries.length).toBe(1);
    expect(existsSync(storeRoot)).toBe(false);
    const status = readDualWriteStatus();
    expect(status.skipped_no_store).toBe(2);
    expect(status.failures).toBe(0);
  });

  test("a process prints the no-store warning exactly once, naming the init command", async () => {
    rmSync(storeRoot, { recursive: true, force: true });
    const stderr = await appendInChild(3);
    expect(occurrences(stderr, "o2b store init")).toBe(1);
    expect(readDualWriteStatus().skipped_no_store).toBe(3);
  });

  test("once the store is created, the next write lands in it", () => {
    rmSync(storeRoot, { recursive: true, force: true });
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      seedPreference("before-init");
    } finally {
      stderr.mockRestore();
    }
    initStore({ root: storeRoot });
    seedPreference("after-init");
    const ids = storeRecords("shared").map((r) => r.body["preference"]);
    expect(ids).toEqual(["pref-after-init"]);
  });
});

function appendSampleClaim(): void {
  appendClaimEvent(vault, {
    ts: "2026-06-01T10:00:00Z",
    agent: "claude",
    entity: "Alice Mason",
    aspect: "employer",
    value: "Acme",
    source: "[[Brain/notes/standup.md]]",
  });
}

function claimRows(partition: "shared" | "private"): StoreRecord[] {
  return storeRecords(partition).filter((r) => r.kind === LEDGER_ROW_KIND);
}

describe("truth claims", () => {
  test("go to private when this machine holds the private partition", () => {
    appendSampleClaim();
    expect(claimRows("private").length).toBe(1);
    expect(claimRows("shared")).toEqual([]);
  });

  test("from an open page go to shared on a machine without the private partition", () => {
    neverHeld(storeRoot);
    mkdirSync(join(vault, "Brain", "notes"), { recursive: true });
    writeFileSync(join(vault, "Brain", "notes", "standup.md"), "# Standup\n");
    appendSampleClaim();
    expect(claimRows("shared").length).toBe(1);
    expect(readDualWriteStatus().failures).toBe(0);
  });
});

function ledgerRows(partition: "shared" | "private", ledger: string): StoreRecord[] {
  return readPartition(join(storeRoot, partition))
    .filter((s) => s.rel.startsWith(`ledgers/${ledger}/`))
    .flatMap((s) => s.records);
}

function dropPrivatePartition(): void {
  neverHeld(storeRoot);
}

function appendTurn(text: string): void {
  appendContinuityRecord(vault, {
    kind: "session_turn",
    createdAt: "2026-11-06T10:00:00.000Z",
    payload: { text },
  });
}

function appendReceipt(subject: string): void {
  appendDecisionChangeReceipt(vault, {
    subject,
    before: "a",
    after: "b",
    actor: "claude",
    reasonCode: "test",
    ts: "2026-11-06T10:00:00Z",
  });
}

function receiptSubjects(partition: "shared" | "private"): unknown[] {
  return ledgerRows(partition, "decision-receipts").map(
    (r) => (r.body["row"] as Record<string, unknown>)["subject"],
  );
}

describe("privacy of ledger rows and pinned context", () => {
  test("a continuity record flagged private lands in private, an open one in shared", () => {
    appendTurn("open turn");
    appendTurn("before <private>a secret</private> after");
    expect(ledgerRows("shared", "continuity").map((r) => r.body["row"])).toEqual([
      expect.objectContaining({ private: false }),
    ]);
    expect(ledgerRows("private", "continuity").map((r) => r.body["row"])).toEqual([
      expect.objectContaining({ private: true }),
    ]);
  });

  test("a private continuity record is refused when this machine does not hold private", () => {
    dropPrivatePartition();
    appendTurn("before <private>a secret</private> after");
    expect(ledgerRows("shared", "continuity")).toEqual([]);
    expect(readDualWriteStatus().failures).toBe(1);
  });

  test("a decision receipt about a private preference stays out of shared", () => {
    seedPreference("hush", { visibility: ["private"] });
    seedPreference("open");
    appendReceipt("pref-hush");
    appendReceipt("pref-open");
    expect(receiptSubjects("shared")).toEqual(["pref-open"]);
    expect(receiptSubjects("private")).toEqual(["pref-hush"]);
  });

  test("search terms go to private when this machine holds it, else to shared", () => {
    recordQueryDemand(vault, { query: "salary negotiation", resultCount: 1 });
    expect(ledgerRows("private", "query-demand").length).toBe(1);
    expect(ledgerRows("shared", "query-demand")).toEqual([]);
    dropPrivatePartition();
    recordQueryDemand(vault, { query: "salary negotiation", resultCount: 1 });
    expect(ledgerRows("shared", "query-demand").length).toBe(1);
  });

  test("permission decisions go to private when this machine holds it, else to shared", () => {
    const row = {
      ts: "2026-11-06T12:00:00Z",
      actor: "agent",
      via: "mcp",
      action: "write" as const,
      target: "Notes/salary.md",
      verdict: "allow",
      source: "default",
      reason: "test",
    };
    appendDecisionLedger(vault, row);
    expect(ledgerRows("private", "permissions").length).toBe(1);
    expect(ledgerRows("shared", "permissions")).toEqual([]);
    dropPrivatePartition();
    appendDecisionLedger(vault, row);
    expect(ledgerRows("shared", "permissions").length).toBe(1);
  });

  test("pinned text with a private region or a link to a private page is private only", () => {
    seedPreference("hush", { visibility: ["private"] });
    dropPrivatePartition();
    writePinnedContext(vault, "plain facts");
    writePinnedContext(vault, "facts <private>secret</private>");
    writePinnedContext(vault, "see [[pref-hush]]");
    const contents = storeRecords("shared").map((r) => r.body["content"]);
    expect(contents).toEqual(["plain facts"]);
    expect(readDualWriteStatus().failures).toBe(2);
  });

  test("a pinned clear goes where a set of the text it clears goes", () => {
    writePinnedContext(vault, "facts <private>secret</private>");
    clearPinnedContext(vault);
    expect(storeRecords("private").map((r) => r.kind)).toEqual(["pinned-set", "pinned-clear"]);

    dropPrivatePartition();
    writePinnedContext(vault, "plain facts");
    clearPinnedContext(vault);
    expect(storeRecords("shared").map((r) => r.kind)).toEqual(["pinned-set", "pinned-clear"]);
    writePinnedContext(vault, "facts <private>secret</private>");
    clearPinnedContext(vault);
    expect(storeRecords("shared").map((r) => r.kind)).toEqual(["pinned-set", "pinned-clear"]);
    expect(readDualWriteStatus().failures).toBe(2);
  });

  // POSIX modes only, and root reads a 0000 file anyway.
  test.skipIf(CHMOD_CANNOT_DENY)(
    "a pinned clear whose old text cannot be read is judged private",
    () => {
      dropPrivatePartition();
      writePinnedContext(vault, "plain facts");
      chmodSync(brainPinnedPath(vault), 0o000);
      clearPinnedContext(vault);
      expect(readFileSync(brainPinnedPath(vault), "utf8")).toBe("");
      expect(storeRecords("shared").map((r) => r.kind)).toEqual(["pinned-set"]);
      expect(readDualWriteStatus().failures).toBe(1);
    },
  );
});

describe("vault identity", () => {
  test("every dual-written record carries the writing vault's id", () => {
    const id = readVaultIdentity(vault)!.vault_id;
    writeSampleSignal();
    writeSampleLogEvent();
    writePinnedContext(vault, "facts");
    const all = [...storeRecords("shared"), ...storeRecords("private")];
    expect(all.length).toBeGreaterThan(2);
    for (const record of all) expect(record.body["vault_id"]).toBe(id);
  });
});

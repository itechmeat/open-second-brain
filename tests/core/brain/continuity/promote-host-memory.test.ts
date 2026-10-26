/**
 * `promoteHostMemory` - the host-memory readback path (issue #277):
 * continuity `host_memory_write` records re-rendered as unconfirmed
 * preference pages, dry-run first, sealed with an approval digest.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendContinuityRecord } from "../../../../src/core/brain/continuity/store.ts";
import {
  PromoteApprovalDigestError,
  PromoteConflictsError,
  PromoteManifestCorruptError,
  promoteHostMemory,
} from "../../../../src/core/brain/continuity/promote-host-memory.ts";
import { REDACTION_PLACEHOLDER, redactStructured } from "../../../../src/core/redactor.ts";
import { loadPromotionsManifest } from "../../../../src/core/brain/host-memory-promotions.ts";
import {
  HOST_MEMORY_WRITE_KIND,
  recordHostMemoryWrite,
} from "../../../../src/core/brain/host-memory-write.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { brainConfigPath, preferencePath, retiredPath } from "../../../../src/core/brain/paths.ts";
import { loadBrainConfig } from "../../../../src/core/brain/policy.ts";
import { resolvedOwnerFor } from "../../../../src/core/brain/preference.ts";
import { isoSecond } from "../../../../src/core/brain/time.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { sha256Hex } from "../../../../src/core/integrity/digest.ts";
import {
  FAKE_PROVIDER_KEY,
  FAKE_VENDOR_KEY,
  fakeCredential,
} from "../../../helpers/fake-credentials.ts";

let vault: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-promote-host-memory-"));
  bootstrapBrain(vault);
  savedEnv = { VAULT_AGENT_NAME: process.env["VAULT_AGENT_NAME"] };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const NOW = new Date("2026-07-01T12:00:00Z");
const promotionsJson = () => join(vault, "Brain", ".imports", "host-memory-promotions.json");

/** A private-page fixture body: the text lives only inside the private region. */
const PRIVATE_BODY = "quiet retirement plan";

function hostRef(recordId: string): string {
  return `hostmem-${recordId.slice(-12).toLowerCase()}`;
}

/** Snapshot archives this feature has taken, by run-id prefix. */
function promoteSnapshots(): string[] {
  return readdirSync(join(vault, "Brain", ".snapshots"))
    .filter((name) => name.startsWith("promote-host-memory-"))
    .toSorted();
}

function writeHostMemory(content: string, createdAt = "2026-06-20T10:00:00Z") {
  return recordHostMemoryWrite(vault, { action: "add", target: "user", content, createdAt });
}

/**
 * Seed a ledger row with an exact id, bypassing the store's content-hash
 * dedup - the only way to pin a slug-tail collision fixture.
 */
function writeRawHostRecord(id: string, content: string, createdAt = "2026-06-20T10:00:00Z") {
  const dir = join(vault, "Brain", "log", "continuity");
  mkdirSync(dir, { recursive: true });
  const row = {
    schema: "o2b.continuity.v1",
    id,
    kind: "host_memory_write",
    createdAt,
    sourceRefs: [],
    payload: { action: "add", target: "user", content },
    private: false,
    redacted: false,
  };
  writeFileSync(join(dir, "2026-06.jsonl"), `${JSON.stringify(row)}\n`, { flag: "a" });
}

function writeRawHostRecordWithCreatedAt(id: string, content: string, createdAt: string) {
  writeRawHostRecord(id, content, createdAt);
}

function promotionOf(recordId: string) {
  return loadPromotionsManifest(vault).promotions[recordId];
}

describe("promoteHostMemory", () => {
  test("dry-run plans and writes nothing", () => {
    const record = writeHostMemory("User prefers dark mode");
    const res = promoteHostMemory({ vault, mode: "dry-run", now: NOW });

    expect(res.mode).toBe("dry-run");
    expect(res.total).toBe(1);
    expect(res.plans.map((p) => p.action)).toEqual(["CREATE"]);
    expect(res.plans[0]!.basename).toBe(record.id);
    expect(res.plans[0]!.prefId).toBe(`pref-${hostRef(record.id)}`);
    expect(res.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(preferencePath(vault, hostRef(record.id)))).toBe(false);
    expect(existsSync(promotionsJson())).toBe(false);
    expect(promoteSnapshots()).toEqual([]);
  });

  test("apply creates a page under the trial window with ledger provenance", () => {
    const record = writeHostMemory("User prefers dark mode");
    const windowDays = loadBrainConfig(vault).dream.unconfirmed_window_days;
    const expectedUntil = isoSecond(new Date(NOW.getTime() + windowDays * 24 * 60 * 60 * 1000));
    const owner = resolvedOwnerFor(
      vault,
      preferencePath(vault, hostRef(record.id)),
      undefined,
      undefined,
    );

    const res = promoteHostMemory({ vault, mode: "apply", now: NOW });
    expect(res.applied).toHaveLength(1);
    expect(res.snapshotRunId).not.toBeNull();

    // The target page is named for the record, and the renderer derives
    // the frontmatter id and topic from the SAME record-derived identity,
    // so an id-keyed lookup lands on the file that exists.
    const page = readFileSync(preferencePath(vault, hostRef(record.id)), "utf8");
    expect(page).toContain(`id: pref-${hostRef(record.id)}`);
    expect(page).toContain(`unconfirmed_until: "${expectedUntil}"`);
    expect(page).toContain("_status: unconfirmed");
    // Provenance names the ledger shard and the record id itself.
    expect(page).toContain('_imported_from: "Brain/log/continuity/2026-06.jsonl"');
    expect(page).toContain(`host memory write \`${record.id}\``);
    expect(page).toContain("User prefers dark mode");
    // Owner wiring follows the shared resolver: a line when the gate
    // stamps one, none when it is off.
    if (owner === undefined) expect(page).not.toContain("owner:");
    else expect(page).toContain(`owner: ${owner}`);

    const manifest = promotionOf(record.id);
    expect(manifest?.pref_id).toBe(res.plans[0]!.prefId);
    expect(manifest?.sha256).toBe(sha256Hex("User prefers dark mode"));
    expect(manifest?.promoted_at).toBe("2026-07-01T12:00:00Z");
  });

  test("the trial window reads the vault config", () => {
    const record = writeHostMemory("User prefers dark mode");
    atomicWriteFileSync(
      brainConfigPath(vault),
      "schema_version: 1\ndream:\n  unconfirmed_window_days: 3\n",
    );
    promoteHostMemory({ vault, mode: "apply", now: NOW });
    const page = readFileSync(preferencePath(vault, hostRef(record.id)), "utf8");
    expect(page).toContain('unconfirmed_until: "2026-07-04T12:00:00Z"');
  });

  test("the owner stamp lands when the delivery gate is on", () => {
    process.env["VAULT_AGENT_NAME"] = "promote-agent";
    atomicWriteFileSync(
      brainConfigPath(vault),
      "schema_version: 1\nintegrity:\n  owner_scope_delivery: warn\n",
    );
    const record = writeHostMemory("User prefers dark mode");
    promoteHostMemory({ vault, mode: "apply", now: NOW });
    const page = readFileSync(preferencePath(vault, hostRef(record.id)), "utf8");
    expect(page).toContain("owner: promote-agent");
  });

  test("a second run over unchanged content plans SKIP_UNCHANGED and writes nothing", () => {
    const record = writeHostMemory("User prefers dark mode");
    promoteHostMemory({ vault, mode: "apply", now: NOW });
    const prefFile = preferencePath(vault, hostRef(record.id));
    const pageBefore = readFileSync(prefFile, "utf8");

    const second = promoteHostMemory({
      vault,
      mode: "apply",
      now: new Date("2026-07-02T12:00:00Z"),
    });
    expect(second.plans.map((p) => p.action)).toEqual(["SKIP_UNCHANGED"]);
    expect(second.applied).toHaveLength(0);
    expect(second.skippedUnchanged).toHaveLength(1);
    expect(second.snapshotRunId).toBeNull();

    expect(readFileSync(prefFile, "utf8")).toBe(pageBefore);
    // The sidecar records the FIRST landing; a no-op run does not touch it.
    expect(promotionOf(record.id)?.promoted_at).toBe("2026-07-01T12:00:00Z");
  });

  test("a page on disk with no promotion history plans CONFLICT; apply still lands the rest", () => {
    const first = writeHostMemory("User prefers dark mode", "2026-06-20T10:00:00Z");
    const second = writeHostMemory("User signs commits", "2026-06-21T10:00:00Z");
    // The conflict fixture: the second page exists with no sidecar entry
    // behind it, as if written by another writer.
    writeFileSync(
      preferencePath(vault, hostRef(second.id)),
      "---\nkind: brain-preference\n---\n\nhand-written\n",
      "utf8",
    );

    let thrown: PromoteConflictsError | undefined;
    try {
      promoteHostMemory({ vault, mode: "apply", now: NOW });
    } catch (err) {
      if (err instanceof PromoteConflictsError) thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.conflicts.map((c) => c.basename)).toEqual([second.id]);
    expect(thrown!.partial).not.toBeNull();
    expect(thrown!.partial!.applied.map((p) => p.basename)).toEqual([first.id]);
    expect(existsSync(preferencePath(vault, hostRef(first.id)))).toBe(true);
    // The conflicting page is left exactly as it was found.
    expect(readFileSync(preferencePath(vault, hostRef(second.id)), "utf8")).toContain(
      "hand-written",
    );
  });

  test("UPDATE re-renders the page and preserves accumulated evidence fields", () => {
    const record = writeHostMemory("User prefers dark mode");
    promoteHostMemory({ vault, mode: "apply", now: NOW });
    const prefFile = preferencePath(vault, hostRef(record.id));

    // Simulate accumulated evidence.
    const pref = readFileSync(prefFile, "utf8");
    writeFileSync(
      prefFile,
      pref
        .replace("_applied_count: 0", "_applied_count: 7")
        .replace("_evidenced_by: []", "_evidenced_by: ['[[a.md]]']"),
      "utf8",
    );

    // The ledger is append-only and a record id is derived from its
    // content, so content for an existing id cannot honestly change. The
    // reachable UPDATE is a stale sidecar sha - a manifest hand-merged
    // across devices - which is exactly the drift the branch exists for.
    const manifest = JSON.parse(readFileSync(promotionsJson(), "utf8")) as {
      promotions: Record<string, { sha256: string }>;
    };
    manifest.promotions[record.id]!.sha256 = sha256Hex("stale");
    atomicWriteFileSync(promotionsJson(), JSON.stringify(manifest, null, 2) + "\n");

    const res = promoteHostMemory({ vault, mode: "apply", now: new Date("2026-07-01T12:00:01Z") });
    expect(res.plans.map((p) => p.action)).toEqual(["UPDATE"]);
    const after = readFileSync(prefFile, "utf8");
    expect(after).toContain("_applied_count: 7");
    expect(after).toContain("_evidenced_by: ['[[a.md]]']");
    expect(after).toContain("User prefers dark mode");
  });

  test("private records never promote and are counted through the store door", () => {
    writeHostMemory(`note <private>${PRIVATE_BODY}</private> end`);
    const res = promoteHostMemory({ vault, mode: "dry-run", now: NOW });

    expect(res.total).toBe(1);
    expect(res.privateCount).toBe(1);
    expect(res.plans).toHaveLength(0);
    expect(res.skipped).toHaveLength(0);
    expect(JSON.stringify(res)).not.toContain(PRIVATE_BODY);
    // Nothing landed: the preferences directory holds no hostmem page.
    expect(
      readdirSync(join(vault, "Brain", "preferences")).filter((name) =>
        name.startsWith("pref-hostmem-"),
      ),
    ).toEqual([]);
  });

  test("a redacted record promotes its masked text and is counted", () => {
    // Write-time redaction (the redactor's default options) masks a
    // key=value credential shape; a bare vendor token is NOT masked at
    // write time - that tighter pass is the export boundary's, per the
    // export verb's own docblock.
    const record = writeHostMemory(`token=${FAKE_PROVIDER_KEY} for the staging deploy`);
    expect(record.redacted).toBe(true);
    expect(record.private).toBe(false);

    const res = promoteHostMemory({ vault, mode: "apply", now: NOW });
    expect(res.redactedCount).toBe(1);
    expect(res.applied).toHaveLength(1);
    const page = readFileSync(preferencePath(vault, hostRef(record.id)), "utf8");
    expect(page).toContain("token=***REDACTED***");
    expect(page).not.toContain(FAKE_PROVIDER_KEY);
  });

  test("empty content is skipped by name", () => {
    const record = appendContinuityRecord(vault, {
      kind: HOST_MEMORY_WRITE_KIND,
      createdAt: "2026-06-20T10:00:00Z",
      payload: { action: "add", target: "user", content: "   " },
    });
    const res = promoteHostMemory({ vault, mode: "dry-run", now: NOW });
    expect(res.skipped).toEqual([{ id: record.id, reason: "empty content" }]);
    expect(res.plans).toHaveLength(0);
  });

  test("--month selects exactly the month's window", () => {
    writeHostMemory("June fact", "2026-06-20T10:00:00Z");
    const july = writeHostMemory("July fact", "2026-07-01T09:00:00Z");
    const privateJuly = appendContinuityRecord(vault, {
      kind: HOST_MEMORY_WRITE_KIND,
      createdAt: "2026-07-02T09:00:00Z",
      payload: { action: "add", target: "user", content: `x <private>${PRIVATE_BODY}</private>` },
    });

    const res = promoteHostMemory({ vault, mode: "dry-run", month: "2026-06", now: NOW });
    expect(res.total).toBe(1);
    expect(res.plans).toHaveLength(1);
    expect(res.plans.map((p) => p.basename)).not.toContain(july.id);
    expect(res.plans.map((p) => p.basename)).not.toContain(privateJuly.id);
    expect(res.privateCount).toBe(0);
  });

  test("an approval digest mismatch throws and writes nothing", () => {
    const record = writeHostMemory("User prefers dark mode");
    const dry = promoteHostMemory({ vault, mode: "dry-run", now: NOW });
    // The ledger moves between the approved dry run and the apply.
    writeHostMemory("A later fact", "2026-06-21T10:00:00Z");

    expect(() =>
      promoteHostMemory({ vault, mode: "apply", approvalDigest: dry.digest, now: NOW }),
    ).toThrow(PromoteApprovalDigestError);
    try {
      promoteHostMemory({ vault, mode: "apply", approvalDigest: dry.digest, now: NOW });
    } catch (err) {
      // The remedy must be a command that exists: the verb has no
      // --dry-run flag, the default IS the dry run (M5).
      expect((err as Error).message).toContain("(the default is the dry run)");
      expect((err as Error).message).not.toContain("--dry-run");
    }
    expect(existsSync(preferencePath(vault, hostRef(record.id)))).toBe(false);
    expect(promoteSnapshots()).toEqual([]);
    expect(promotionOf(record.id)).toBeUndefined();

    // The fresh digest the new dry run prints is what the next apply takes.
    const fresh = promoteHostMemory({ vault, mode: "dry-run", now: NOW });
    expect(fresh.digest).not.toBe(dry.digest);
    const applied = promoteHostMemory({
      vault,
      mode: "apply",
      approvalDigest: fresh.digest,
      now: NOW,
    });
    expect(applied.applied).toHaveLength(2);
  });

  test("apply without a digest works - the interactive path", () => {
    writeHostMemory("User prefers dark mode");
    const res = promoteHostMemory({ vault, mode: "apply", now: NOW });
    expect(res.applied).toHaveLength(1);
    expect(existsSync(preferencePath(vault, hostRef(res.applied[0]!.basename)))).toBe(true);
  });

  test("a purely numeric first line still lands - the record-derived identity carries the tag rule", () => {
    // Obsidian tags may carry digits but may not be ONLY digits. The
    // page's topic comes from the record id, never the display text, so
    // a numeric first line cannot break the tag rule; it rides along as
    // the `principle` display text.
    writeHostMemory("42");
    const res = promoteHostMemory({ vault, mode: "dry-run", now: NOW });
    expect(res.plans.map((p) => p.action)).toEqual(["CREATE"]);
    expect(res.skipped).toHaveLength(0);
    const recordId = res.plans[0]!.basename;
    promoteHostMemory({ vault, mode: "apply", now: NOW });
    const page = readFileSync(preferencePath(vault, hostRef(recordId)), "utf8");
    expect(page).toContain(`topic: ${hostRef(recordId)}`);
    expect(page).toContain('principle: "42"');
  });

  test("two records whose hash tails collide plan onto one named skip, not one overwrite", () => {
    // The store derives ids from content, so the collision fixture seeds
    // raw ledger rows whose ids deliberately share a 12-character tail.
    const shared = "aaaaaaaaaaaaaaaa";
    writeRawHostRecord(`ctn_20260620000000_${shared}`, "First fact");
    writeRawHostRecord(`ctn_20260621000000_${shared}`, "Second fact");
    const res = promoteHostMemory({ vault, mode: "dry-run", now: NOW });
    expect(res.plans).toHaveLength(1);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]!.reason).toContain("already claimed by record");
  });

  test("a retired page is never resurrected by a re-run", () => {
    const record = writeHostMemory("User prefers dark mode");
    promoteHostMemory({ vault, mode: "apply", now: NOW });
    // The operator (or the dream pass) retires the promoted page.
    renameSync(preferencePath(vault, hostRef(record.id)), retiredPath(vault, hostRef(record.id)));

    const res = promoteHostMemory({ vault, mode: "dry-run", now: NOW });
    expect(res.plans).toHaveLength(0);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]!.reason).toContain("retired copy exists");
    expect(existsSync(preferencePath(vault, hostRef(record.id)))).toBe(false);
  });

  test("apply writes the promote-host-memory snapshot and log event", () => {
    writeHostMemory("User prefers dark mode");
    const res = promoteHostMemory({ vault, mode: "apply", now: NOW });

    expect(res.snapshotRunId).not.toBeNull();
    expect(res.snapshotRunId!).toStartWith("promote-host-memory-");
    const snapshots = readdirSync(join(vault, "Brain", ".snapshots"));
    expect(snapshots.some((name) => name.startsWith("promote-host-memory-"))).toBe(true);

    const log = readFileSync(join(vault, "Brain", "log", `${res.localDate}.md`), "utf8");
    expect(log).toContain("promote-host-memory");
    expect(log).toContain("created: 1");
    expect(log).toContain("private_dropped: 0");
    expect(log).toContain("redacted: 0");
  });

  test("credential-shaped content is re-scanned and lands masked (review H1)", () => {
    const urlCred = `postgres://deploy:${fakeCredential("Hunter2", "-Fake")}@db.example.test:5432/app`;
    const content = `DB is ${urlCred} and the key is ${FAKE_VENDOR_KEY}`;
    const record = writeHostMemory(content);
    const res = promoteHostMemory({ vault, mode: "apply", now: NOW });

    // The write-time flag stays false (the ledger redacts under the loose
    // defaults), and the strict re-scan is what caught these.
    expect(record.redacted).toBe(false);
    expect(res.redactedCount).toBe(1);

    const masked = redactStructured(content, {
      redactTokens: true,
      redactUrlCredentials: true,
    }).value as string;
    const page = readFileSync(preferencePath(vault, hostRef(record.id)), "utf8");
    expect(page).not.toContain(FAKE_VENDOR_KEY);
    expect(page).not.toContain("Hunter2-Fake");
    expect(page).toContain(REDACTION_PLACEHOLDER);
    // The plan binding covers the masked text: the sidecar's sha is the
    // sha of what landed, so a re-run stays idempotent.
    expect(promotionOf(record.id)?.sha256).toBe(sha256Hex(masked));
    expect(page).toContain(masked.split("\n")[0]!.slice(0, 20));
  });

  test("a malformed row skips by name and never aborts the run (review M1)", () => {
    const good = writeHostMemory("User prefers dark mode", "2026-06-20T10:00:00Z");
    writeRawHostRecordWithCreatedAt(
      "ctn_20260622000000_feeddadfeeddad0",
      "Bad date row",
      "June 23",
    );
    writeRawHostRecord("ctn_20260623!:000000_feeddadfeeddad1", "Bad id row");
    const res = promoteHostMemory({ vault, mode: "dry-run", now: NOW });
    expect(res.plans.map((p) => p.action)).toEqual(["CREATE"]);
    expect(res.plans[0]!.basename).toBe(good.id);
    const reasons = res.skipped.map((s) => s.reason).toSorted();
    expect(reasons).toEqual(["non-canonical createdAt", "non-canonical record id"]);
  });

  test("a corrupt promotion manifest is reported on dry run and refused on apply (review M3)", () => {
    writeHostMemory("User prefers dark mode");
    mkdirSync(join(vault, "Brain", ".imports"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", ".imports", "host-memory-promotions.json"),
      '{"version": 1, "promotions": {"ctn_2026',
      "utf8",
    );
    const dry = promoteHostMemory({ vault, mode: "dry-run", now: NOW });
    expect(dry.manifestCorrupt).toBe(true);
    // The plan computed against the empty history names the loss: the
    // landed page (none here) would show CONFLICT, the row plans CREATE.
    expect(dry.plans.map((p) => p.action)).toEqual(["CREATE"]);

    expect(() => promoteHostMemory({ vault, mode: "apply", now: NOW })).toThrow(
      PromoteManifestCorruptError,
    );
    expect(promoteSnapshots()).toEqual([]);
    // The garbage file is not flattened to an empty set by the run.
    expect(
      readFileSync(join(vault, "Brain", ".imports", "host-memory-promotions.json"), "utf8"),
    ).toBe('{"version": 1, "promotions": {"ctn_2026');
  });

  test("identical content from repeated writes promotes once (review M4)", () => {
    writeHostMemory("User prefers dark mode", "2026-06-20T10:00:00Z");
    writeHostMemory("User prefers dark mode", "2026-06-21T10:00:00Z");
    writeHostMemory("User prefers dark mode", "2026-06-22T10:00:00Z");
    const res = promoteHostMemory({ vault, mode: "apply", now: NOW });
    expect(res.plans).toHaveLength(1);
    expect(res.skipped).toHaveLength(2);
    for (const skip of res.skipped) {
      expect(skip.reason).toMatch(/^same content as record ctn_/);
    }
    const pages = readdirSync(join(vault, "Brain", "preferences")).filter((name) =>
      name.startsWith("pref-hostmem-"),
    );
    expect(pages).toHaveLength(1);
  });

  test("the same content seals identically across runs - the approval binds the plan", () => {
    writeHostMemory("User prefers dark mode");
    const first = promoteHostMemory({ vault, mode: "dry-run", now: NOW });
    const second = promoteHostMemory({
      vault,
      mode: "dry-run",
      now: new Date("2026-08-15T08:30:00Z"),
    });
    expect(second.digest).toBe(first.digest);
    expect(second.localDate).toBe("2026-08-15");
  });
});

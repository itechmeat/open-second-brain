/**
 * Payload registry, end to end (t_35440e83): session import externalizes
 * oversized content before the continuity row is written, the exact
 * stored bytes page back, redaction and private regions never reach a
 * payload file, the inventory finds orphans and missing refs, the gc
 * removes only what nothing references behind a recovery point that
 * holds the store, and the doctor reports all three conditions.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_BRAIN_CONFIG_YAML } from "../../../src/core/brain/config-template.ts";
import { appendContinuityRecord } from "../../../src/core/brain/continuity/store.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { brainDirs, payloadPath, payloadsDir } from "../../../src/core/brain/paths.ts";
import {
  buildPayloadInventory,
  collectPayloadGarbage,
} from "../../../src/core/brain/payload-inventory.ts";
import {
  PAYLOAD_GC_GRACE_MS,
  PayloadNotFoundError,
  PayloadRefError,
  PayloadRegistry,
} from "../../../src/core/brain/payload-registry.ts";
import {
  importSessionRecall,
  searchSessionRecall,
} from "../../../src/core/brain/session-recall.ts";
import { exportBankBundle } from "../../../src/core/brain/portability/bundle.ts";
import { buildOkfBundle } from "../../../src/core/brain/portability/okf.ts";
import { importSession } from "../../../src/core/brain/sessions/import.ts";
import { admitToIndex } from "../../../src/core/vault-scope/index-admission.ts";
import { listSnapshotArchive } from "../../helpers/snapshot-archive.ts";

let vault: string;

/** 2,000 chars of the base64 alphabet: well past the 512-char default. */
const BLOB = "QUJD".repeat(500);

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-payload-registry-"));
  const dirs = brainDirs(vault);
  for (const dir of [dirs.brain, dirs.inbox, dirs.processed, dirs.preferences, dirs.log]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(dirs.brain, "_brain.yaml"), DEFAULT_BRAIN_CONFIG_YAML);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/** Every continuity shard, concatenated as it sits on disk. */
function continuityText(): string {
  const dir = join(vault, "Brain", "log", "continuity");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("");
}

function continuityRows(): Array<Record<string, unknown>> {
  return continuityText()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function refsIn(text: string): string[] {
  return [...text.matchAll(/osb-payload:\/\/[a-f0-9]{64}/g)].map((m) => m[0]);
}

/** Read a payload back page by page and join the pages. */
function readAll(ref: string, pageChars: number): string {
  const registry = new PayloadRegistry({ vault, maxInlineChars: 1 });
  let out = "";
  let offset: number | null = 0;
  while (offset !== null) {
    const page = registry.get(ref, { offset, limit: pageChars });
    out += page.content;
    offset = page.nextOffset;
  }
  return out;
}

function withSessionConfig(block: string): void {
  writeFileSync(
    join(vault, "Brain", "_brain.yaml"),
    `${DEFAULT_BRAIN_CONFIG_YAML}\nsessions:\n${block}`,
  );
}

describe("session import externalizes before the row is written", () => {
  test("a long base64 run becomes a placeholder in continuity and in recall search", async () => {
    const transcript = join(vault, "transcript.jsonl");
    writeFileSync(
      transcript,
      `${JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        type: "user",
        uuid: "turn-1",
        timestamp: "2026-09-20T10:00:00.000Z",
        sessionId: "s-1",
        message: { role: "user", content: `screenshot follows ${BLOB} end of paste` },
      })}\n`,
    );

    const result = await importSession(vault, transcript, {
      agent: "test",
      recall: true,
      recallSessionId: "payload-session",
      format: "claude",
    });
    expect(result.recall_turns_imported).toBe(1);

    const ledger = continuityText();
    expect(ledger).not.toContain(BLOB);
    expect(ledger).toContain("[payload: osb-payload://");

    const hits = searchSessionRecall(vault, { query: "screenshot follows" }).hits;
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(hit.snippet).not.toContain(BLOB.slice(0, 200));
    expect(searchSessionRecall(vault, { query: BLOB.slice(0, 120) }).hits).toHaveLength(0);

    const [ref] = refsIn(ledger);
    expect(readAll(ref!, 333)).toBe(BLOB);
  });

  test("an oversized plain tool output keeps a bounded preview and pages back exactly", () => {
    withSessionConfig("  payload_max_text_chars: 4000\n");
    const lines = Array.from({ length: 2000 }, (_, i) => `build step ${i} ok`);
    const output = `${lines.join("\n")}\n${BLOB}\n`;

    importSessionRecall(vault, {
      sessionId: "tool-session",
      createdAt: "2026-09-20T10:00:00.000Z",
      turns: [{ turnId: "t1", role: "tool", timestamp: "2026-09-20T10:00:01.000Z", text: output }],
    });

    const row = continuityRows().find((r) => r["kind"] === "session_turn")!;
    const text = (row["payload"] as Record<string, unknown>)["text"] as string;
    expect(text.length).toBeLessThan(1_200);
    expect(text.startsWith("build step 0 ok")).toBe(true);
    const refs = (row["payload"] as Record<string, unknown>)["payload_refs"] as string[];
    // The blob moved first, then the remaining text as a whole.
    expect(refs).toHaveLength(2);
    const whole = readAll(refs[1]!, 1_000);
    expect(whole).toContain("build step 1999 ok");
    expect(whole).not.toContain(BLOB);
    expect(whole).toContain(refs[0]!);
    expect(readAll(refs[0]!, 500)).toBe(BLOB);
    // The blob is live through the whole-text payload that names it.
    expect(buildPayloadInventory(vault).orphans).toHaveLength(0);
  });

  test("an ordinary turn is stored byte-identically, with no payload", () => {
    importSessionRecall(vault, {
      sessionId: "plain",
      createdAt: "2026-09-20T10:00:00.000Z",
      turns: [{ turnId: "t1", role: "user", timestamp: "2026-09-20T10:00:01.000Z", text: "hi" }],
    });
    const row = continuityRows().find((r) => r["kind"] === "session_turn")!;
    expect((row["payload"] as Record<string, unknown>)["text"]).toBe("hi");
    expect((row["payload"] as Record<string, unknown>)["payload_refs"]).toBeUndefined();
    expect(buildPayloadInventory(vault).stored).toHaveLength(0);
  });

  test("secrets are redacted and private regions stripped before a payload file is written", () => {
    withSessionConfig("  payload_max_text_chars: 1000\n");
    const text =
      `${"plain words ".repeat(100)}\npassword=hunter2secret\n` +
      "<private>my home address</private>\ntrailing";

    importSessionRecall(vault, {
      sessionId: "secret-session",
      createdAt: "2026-09-20T10:00:00.000Z",
      turns: [{ turnId: "t1", role: "tool", timestamp: "2026-09-20T10:00:01.000Z", text }],
    });

    const stored = readdirSync(payloadsDir(vault)).map((name) =>
      readFileSync(join(payloadsDir(vault), name), "utf8"),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toContain("hunter2secret");
    expect(stored[0]).not.toContain("my home address");
    expect(stored[0]).toContain("***REDACTED***");
    const row = continuityRows().find((r) => r["kind"] === "session_turn")!;
    expect(row["private"]).toBe(true);
  });
});

describe("refs are validated before any path is built", () => {
  test("traversal and malformed refs are refused", () => {
    const registry = new PayloadRegistry({ vault, maxInlineChars: 1 });
    for (const ref of [
      "osb-payload://../../etc/passwd",
      `osb-payload://${"A".repeat(64)}`,
      `osb-payload://${"a".repeat(63)}`,
      `file:///${"a".repeat(64)}`,
    ]) {
      expect(() => registry.get(ref, { offset: 0, limit: 10 })).toThrow(PayloadRefError);
    }
    expect(() => payloadPath(vault, "../escape")).toThrow();
    expect(() => registry.get(`osb-payload://${"a".repeat(64)}`, { offset: 0, limit: 1 })).toThrow(
      PayloadNotFoundError,
    );
  });

  test("the store is refused by the index admission predicate", () => {
    expect(admitToIndex(`Brain/.payloads/${"a".repeat(64)}.txt`)).toEqual({
      admit: false,
      reason: "payload-store",
    });
    expect(admitToIndex("Brain/payloads-notes.md").admit).toBe(true);
  });
});

describe("inventory, gc and doctor", () => {
  /** One live payload (imported), one orphan, one missing ref in a note. */
  function seed(): { live: string; orphan: string; missing: string } {
    importSessionRecall(vault, {
      sessionId: "gc-session",
      createdAt: "2026-09-20T10:00:00.000Z",
      turns: [
        { turnId: "t1", role: "user", timestamp: "2026-09-20T10:00:01.000Z", text: `a ${BLOB}` },
      ],
    });
    const live = refsIn(continuityText())[0]!;
    // Externalized but never written anywhere: nothing references it.
    const orphan = new PayloadRegistry({ vault, maxInlineChars: 10 }).externalizeOversized(
      `b ${"QkNE".repeat(300)}`,
    ).payloads[0]!.ref;
    const missing = `osb-payload://${"c".repeat(64)}`;
    writeFileSync(join(vault, "note.md"), `# Note\n\nSee [payload: ${missing} chars=5]\n`);
    return { live, orphan, missing };
  }

  test("the inventory separates live, orphaned and missing payloads", () => {
    const { live, orphan, missing } = seed();
    const inventory = buildPayloadInventory(vault);
    expect(inventory.stored.map((e) => e.ref).toSorted()).toEqual([live, orphan].toSorted());
    expect(inventory.orphans.map((e) => e.ref)).toEqual([orphan]);
    expect(inventory.missing.map((e) => e.ref)).toEqual([missing]);
    expect(inventory.missing[0]!.referrers.map((r) => r.path)).toEqual(["note.md"]);
  });

  test("gc is a dry run by default and removes only orphans behind a snapshot on apply", () => {
    const { live, orphan } = seed();
    const orphanFile = payloadPath(vault, orphan.slice("osb-payload://".length));
    const liveFile = payloadPath(vault, live.slice("osb-payload://".length));

    ageFile(orphanFile);

    const dry = collectPayloadGarbage(vault, { apply: false });
    expect(dry.applied).toBe(false);
    expect(dry.orphans.map((e) => e.ref)).toEqual([orphan]);
    expect(dry.snapshot).toBeNull();
    expect(readdirSync(payloadsDir(vault))).toHaveLength(2);

    const applied = collectPayloadGarbage(vault, { apply: true });
    expect(applied.removed).toEqual([
      `Brain/.payloads/${orphan.slice("osb-payload://".length)}.txt`,
    ]);
    expect(applied.snapshot?.runId.startsWith("payload-gc-")).toBe(true);
    expect(() => readFileSync(orphanFile)).toThrow();
    expect(readFileSync(liveFile, "utf8")).toBe(BLOB);
    // The recovery point holds the store, so a restore resolves both refs.
    const listing = listSnapshotArchive(applied.snapshot!.path);
    expect(listing).toContain(`.payloads/${orphan.slice("osb-payload://".length)}.txt`);
    expect(listing).toContain(`.payloads/${live.slice("osb-payload://".length)}.txt`);
  });

  test("gc leaves an orphan inside the grace period for a later pass", () => {
    const { orphan } = seed();
    const orphanFile = payloadPath(vault, orphan.slice("osb-payload://".length));
    const now = new Date("2026-09-26T12:00:00.000Z");
    setMtime(orphanFile, now.getTime() - PAYLOAD_GC_GRACE_MS + 60_000);

    const young = collectPayloadGarbage(vault, { apply: true, now });
    expect(young.orphans).toEqual([]);
    expect(young.deferred.map((e) => e.ref)).toEqual([orphan]);
    expect(young.removed).toEqual([]);
    expect(existsSync(orphanFile)).toBe(true);

    setMtime(orphanFile, now.getTime() - PAYLOAD_GC_GRACE_MS - 1);
    const old = collectPayloadGarbage(vault, { apply: true, now });
    expect(old.removed).toEqual([`Brain/.payloads/${orphan.slice("osb-payload://".length)}.txt`]);
    expect(existsSync(orphanFile)).toBe(false);
  });

  test("a put that finds the payload already stored makes it young again", () => {
    const registry = new PayloadRegistry({ vault, maxInlineChars: 10 });
    const blob = `b ${"QkNE".repeat(300)}`;
    const ref = registry.externalizeOversized(blob).payloads[0]!.ref;
    const file = payloadPath(vault, ref.slice("osb-payload://".length));
    ageFile(file);
    const before = Date.now();
    registry.externalizeOversized(blob);
    expect(lstatMtime(file)).toBeGreaterThanOrEqual(before - 1000);
    expect(collectPayloadGarbage(vault, { apply: false }).deferred.map((e) => e.ref)).toEqual([
      ref,
    ]);
  });

  test(
    "gc apply and an externalizing import both wait on the payload store lock",
    () => {
      const { orphan } = seed();
      const orphanFile = payloadPath(vault, orphan.slice("osb-payload://".length));
      ageFile(orphanFile);
      const lockFile = `${payloadsDir(vault)}.lock`;
      const turn = (turnId: string, text: string) => ({
        sessionId: "lock-session",
        createdAt: "2026-09-20T10:00:00.000Z",
        turns: [{ turnId, role: "user" as const, timestamp: "2026-09-20T10:00:01.000Z", text }],
      });

      // Another holder has the store: the gc's removal pass and an import
      // with a payload to write both refuse once their wait runs out, and
      // nothing is removed or half-imported.
      writeFileSync(lockFile, "held by another writer\n");
      try {
        expect(() => collectPayloadGarbage(vault, { apply: true })).toThrow(/lock busy/);
        expect(existsSync(orphanFile)).toBe(true);
        expect(() => importSessionRecall(vault, turn("t9", `c ${"QUJE".repeat(400)}`))).toThrow(
          /lock busy/,
        );
        // A turn with nothing to externalize never touches the lock.
        expect(importSessionRecall(vault, turn("t10", "short")).rawTurns).toHaveLength(1);
      } finally {
        rmSync(lockFile, { force: true });
      }

      // Released, both run, and neither leaves the lock behind.
      expect(
        importSessionRecall(vault, turn("t9", `c ${"QUJE".repeat(400)}`)).rawTurns,
      ).toHaveLength(1);
      expect(collectPayloadGarbage(vault, { apply: true }).removed).toHaveLength(1);
      expect(existsSync(lockFile)).toBe(false);
    },
    { timeout: 20_000 },
  );

  test("doctor reports orphans, missing payloads and oversized continuity rows", () => {
    const { orphan, missing } = seed();
    // A row written before the registry bounded session text.
    appendContinuityRecord(vault, {
      kind: "session_turn",
      createdAt: "2026-09-20T10:00:00.000Z",
      payload: { session_id: "old", turn_id: "t0", text: "y".repeat(80_000) },
    });

    const issues = runDoctor(vault).warnings;
    const byCode = (code: string) => issues.filter((issue) => issue.code === code);
    expect(
      byCode("payload-orphan")
        .map((i) => i.message)
        .join("\n"),
    ).toContain(orphan);
    expect(
      byCode("payload-missing")
        .map((i) => i.message)
        .join("\n"),
    ).toContain(missing);
    expect(byCode("continuity-row-oversized")).toHaveLength(1);
  });
});

describe("export policy", () => {
  test("bank and OKF exports carry the placeholder, never the payload bytes", () => {
    const registry = new PayloadRegistry({ vault, maxInlineChars: 10 });
    const { text } = registry.externalizeOversized(`attachment ${BLOB}`);
    mkdirSync(join(vault, "Brain", "reports"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", "reports", "2026-09-20-attachment.md"),
      `---\ntitle: Attachment\n---\n\n${text}\n`,
    );

    for (const exported of [
      JSON.stringify(exportBankBundle(vault)),
      JSON.stringify(buildOkfBundle(vault)),
    ]) {
      expect(exported).not.toContain(BLOB.slice(0, 200));
    }
    expect(JSON.stringify(buildOkfBundle(vault))).toContain("osb-payload://");
  });
});

function setMtime(file: string, ms: number): void {
  const at = new Date(ms);
  utimesSync(file, at, at);
}

/** Put `file` well past the gc grace period. */
function ageFile(file: string): void {
  setMtime(file, Date.now() - PAYLOAD_GC_GRACE_MS - 60_000);
}

function lstatMtime(file: string): number {
  return statSync(file).mtimeMs;
}

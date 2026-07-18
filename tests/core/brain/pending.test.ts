/**
 * A3 (t_e540b093): opt-in write-approval pending queue.
 *
 * With write_approval enabled, extracted signals are STAGED into
 * Brain/pending/ with byte-identical frontmatter (default off preserves the
 * direct-to-inbox path byte-for-byte). apply moves a staged file into
 * Brain/inbox/ unchanged (anchors + dedup hash preserved); reject moves it to
 * Brain/retired/ with retire-shaped frontmatter. Applying or rejecting a
 * missing / already-processed id is a typed error, never a silent no-op.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { parseFrontmatter } from "../../../src/core/vault.ts";
import { routeExtractedFacts, type ExtractedFact } from "../../../src/core/brain/fact-extract.ts";
import {
  applyPending,
  listPending,
  PendingSignalNotFoundError,
  rejectPending,
  stagePendingSignal,
} from "../../../src/core/brain/pending.ts";
import type { DedupIndexEntry } from "../../../src/core/brain/dedup-hash.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-07-18T12:00:00Z");

function makeVault(): string {
  const v = mkdtempSync(join(tmpdir(), "o2b-pending-vault-"));
  const cfg = mkdtempSync(join(tmpdir(), "o2b-pending-cfg-"));
  const configPath = join(cfg, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${v}\n`);
  bootstrapBrain(v, { configPath });
  toCleanup.push(v, cfg);
  return v;
}

const toCleanup: string[] = [];

beforeEach(() => {
  vault = makeVault();
  configHome = "";
});

afterEach(() => {
  for (const p of toCleanup.splice(0)) rmSync(p, { recursive: true, force: true });
  void configHome;
});

function names(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith("sig-") && f.endsWith(".md"))
    .toSorted();
}

const URL_FACT: ExtractedFact = { family: "url", text: "https://techmeat.dev", line: 1 };

describe("routeExtractedFacts staging decision", () => {
  test("write_approval disabled writes to inbox (no pending dir touched)", () => {
    const res = routeExtractedFacts(vault, {
      facts: [URL_FACT],
      agent: "claude-dev-agent",
      now: NOW,
      sessionRef: "s#1",
      dedup: new Map<string, DedupIndexEntry>(),
      writeApprovalEnabled: false,
    });
    expect(res.created).toBe(1);
    expect(names(brainDirs(vault).inbox).length).toBe(1);
    expect(names(brainDirs(vault).pending).length).toBe(0);
  });

  test("write_approval enabled stages to pending, inbox stays empty", () => {
    const res = routeExtractedFacts(vault, {
      facts: [URL_FACT],
      agent: "claude-dev-agent",
      now: NOW,
      sessionRef: "s#1",
      dedup: new Map<string, DedupIndexEntry>(),
      writeApprovalEnabled: true,
    });
    expect(res.created).toBe(1);
    expect(names(brainDirs(vault).pending).length).toBe(1);
    expect(names(brainDirs(vault).inbox).length).toBe(0);
  });

  test("staged pending doc is byte-for-byte identical to the inbox doc", () => {
    // Same input routed to two fresh vaults: one to inbox (disabled), one to
    // pending (enabled). The documents must be identical byte-for-byte.
    const inboxVault = makeVault();
    routeExtractedFacts(inboxVault, {
      facts: [URL_FACT],
      agent: "claude-dev-agent",
      now: NOW,
      sessionRef: "s#1",
      dedup: new Map(),
      writeApprovalEnabled: false,
    });
    routeExtractedFacts(vault, {
      facts: [URL_FACT],
      agent: "claude-dev-agent",
      now: NOW,
      sessionRef: "s#1",
      dedup: new Map(),
      writeApprovalEnabled: true,
    });
    const inboxName = names(brainDirs(inboxVault).inbox)[0]!;
    const pendingName = names(brainDirs(vault).pending)[0]!;
    expect(pendingName).toBe(inboxName);
    const inboxDoc = readFileSync(join(brainDirs(inboxVault).inbox, inboxName), "utf8");
    const pendingDoc = readFileSync(join(brainDirs(vault).pending, pendingName), "utf8");
    expect(pendingDoc).toBe(inboxDoc);
  });
});

describe("stagePendingSignal", () => {
  test("writes the identical frontmatter document into Brain/pending/", () => {
    const res = stagePendingSignal(vault, {
      topic: "fact-url",
      signal: "positive",
      agent: "claude-dev-agent",
      principle: "https://techmeat.dev",
      created_at: "2026-07-18T12:00:00Z",
      date: "2026-07-18",
      slug: "fact-url",
      source_type: "extracted",
      dedup_hash: "abc123",
    });
    expect(res.id).toBe("sig-2026-07-18-fact-url");
    expect(existsSync(res.path)).toBe(true);
    expect(res.path.startsWith(brainDirs(vault).pending)).toBe(true);
  });
});

describe("listPending", () => {
  test("returns the staged signals with their coordinates", () => {
    stagePendingSignal(vault, {
      topic: "fact-url",
      signal: "positive",
      agent: "claude-dev-agent",
      principle: "https://techmeat.dev",
      created_at: "2026-07-18T12:00:00Z",
      date: "2026-07-18",
      slug: "fact-url",
      source_type: "extracted",
      dedup_hash: "abc123",
    });
    const items = listPending(vault);
    expect(items.length).toBe(1);
    expect(items[0]!.id).toBe("sig-2026-07-18-fact-url");
    expect(items[0]!.signal.principle).toBe("https://techmeat.dev");
  });

  test("empty (or absent) pending dir lists nothing", () => {
    expect(listPending(vault)).toEqual([]);
  });
});

describe("applyPending", () => {
  test("moves a staged signal into inbox unchanged (anchors + dedup hash)", () => {
    // Stage a signal carrying an entity anchor body + dedup hash.
    const staged = stagePendingSignal(vault, {
      topic: "fact-url",
      signal: "positive",
      agent: "claude-dev-agent",
      principle: "https://techmeat.dev",
      created_at: "2026-07-18T12:00:00Z",
      date: "2026-07-18",
      slug: "fact-url",
      source_type: "extracted",
      dedup_hash: "hash-xyz",
      raw: "entities: ent-projects-techmeat",
    });
    const before = readFileSync(staged.path, "utf8");

    const applied = applyPending(vault, staged.id);
    expect(applied.id).toBe(staged.id);
    expect(applied.path.startsWith(brainDirs(vault).inbox)).toBe(true);

    // Pending file gone, inbox file present, bytes preserved verbatim.
    expect(existsSync(staged.path)).toBe(false);
    const after = readFileSync(applied.path, "utf8");
    expect(after).toBe(before);
    expect(after).toContain("dedup_hash: hash-xyz");
    expect(after).toContain("entities: ent-projects-techmeat");
  });

  test("applying a missing id is a typed error, not a no-op", () => {
    expect(() => applyPending(vault, "sig-2026-07-18-nope")).toThrow(PendingSignalNotFoundError);
  });

  test("applying twice is a typed error the second time", () => {
    const staged = stagePendingSignal(vault, {
      topic: "fact-url",
      signal: "positive",
      agent: "claude-dev-agent",
      principle: "https://techmeat.dev",
      created_at: "2026-07-18T12:00:00Z",
      date: "2026-07-18",
      slug: "fact-url",
    });
    applyPending(vault, staged.id);
    expect(() => applyPending(vault, staged.id)).toThrow(PendingSignalNotFoundError);
  });
});

describe("rejectPending", () => {
  test("moves a staged signal to retired with retire-shaped frontmatter", () => {
    const staged = stagePendingSignal(vault, {
      topic: "fact-url",
      signal: "positive",
      agent: "claude-dev-agent",
      principle: "https://techmeat.dev",
      created_at: "2026-07-18T12:00:00Z",
      date: "2026-07-18",
      slug: "fact-url",
    });
    const rejected = rejectPending(vault, staged.id, "not useful", { now: NOW });
    expect(existsSync(staged.path)).toBe(false);
    expect(rejected.path.startsWith(brainDirs(vault).retired)).toBe(true);

    const [meta] = parseFrontmatter(rejected.path);
    expect(meta["_status"]).toBe("retired");
    expect(meta["retired_at"]).toBe(NOW.toISOString());
    expect(meta["retired_reason"]).toBe("not useful");
    // The original signal content is preserved for the audit trail.
    expect(meta["principle"]).toBe("https://techmeat.dev");
  });

  test("rejecting a missing id is a typed error", () => {
    expect(() => rejectPending(vault, "sig-2026-07-18-nope", "x")).toThrow(
      PendingSignalNotFoundError,
    );
  });
});

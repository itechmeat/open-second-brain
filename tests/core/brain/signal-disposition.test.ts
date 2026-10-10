/**
 * The signal lane's write disposition (write-side trust, Task 12 over
 * the signals chokepoint).
 *
 * `writeSignal`'s ungated path resolves through the same disposition
 * resolver every other writer answers to: with no permissions document
 * the `write_approval.*` toggle decides exactly as before; with one, the
 * document is the ONLY gate - a deny refuses as a typed WriteRefusedError
 * before any byte exists, with exactly one ledger row behind it, an ask
 * stages into the signals queue with byte-identical bytes, and an allow
 * publishes. The credential-minted subject the caller threads wins over
 * the config identity, an unreadable document fails closed by name, and
 * the staging path (`targetDir` set) never re-enters the gate it feeds.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { PermissionsDocumentError } from "../../../src/core/brain/permissions/document.ts";
import { queryDecisionLedger } from "../../../src/core/brain/permissions/ledger.ts";
import { stagePendingSignal } from "../../../src/core/brain/pending.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { WriteRefusedError } from "../../../src/core/brain/write-disposition.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-signal-disposition-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const INPUT = {
  topic: "prefer tests",
  signal: "positive" as const,
  agent: "claude",
  principle: "always test first",
  created_at: "2026-06-01T10:00:00Z",
  date: "2026-06-01",
  slug: "prefer-tests",
};

const TARGET = "Brain/inbox/sig-2026-06-01-prefer-tests.md";

function writeDoc(text: string): void {
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_permissions.yaml"), text, "utf8");
}

function inboxFiles(): string[] {
  const dir = join(vault, "Brain", "inbox");
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".md")) : [];
}

describe("writeSignal under a permissions document", () => {
  test("a deny refuses by name before any byte, one ledger row behind it", () => {
    writeDoc("version: 1\ndefault_action: deny\n");
    let refused: WriteRefusedError | undefined;
    try {
      writeSignal(vault, INPUT);
    } catch (err) {
      refused = err instanceof WriteRefusedError ? err : undefined;
    }
    expect(refused).toBeInstanceOf(WriteRefusedError);
    expect(refused?.agent).toBe("claude");
    expect(refused?.via).toBe("config");
    expect(refused?.action).toBe("write");
    expect(refused?.rule).toBe("default");
    // The consulted target is the inbox path the write intent asked for.
    expect(refused?.target).toBe(TARGET);
    expect(inboxFiles()).toEqual([]);
    const rows = queryDecisionLedger(vault, { verdict: "deny" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: "claude",
      via: "config",
      action: "write",
      target: TARGET,
      source: "default",
    });
  });

  test("the threaded subject wins over the config identity", () => {
    writeDoc(
      "version: 1\ndefault_action: allow\nagents:\n  claude:\n    write: allow\n  bob:\n    write: deny\n",
    );
    // The config identity is allowed: the signal publishes.
    const res = writeSignal(vault, INPUT);
    expect(res.staged).toBe(false);
    expect(res.path.replaceAll("\\", "/")).toContain("Brain/inbox");
    // A credential-minted subject the document denies is refused with the
    // same typed refusal, one row naming ITS agent.
    let refused: WriteRefusedError | undefined;
    try {
      writeSignal(
        vault,
        { ...INPUT, slug: "prefer-tests-bob" },
        {
          subject: { agent: "bob", via: "token" },
        },
      );
    } catch (err) {
      refused = err instanceof WriteRefusedError ? err : undefined;
    }
    expect(refused).toBeInstanceOf(WriteRefusedError);
    expect(refused?.agent).toBe("bob");
    expect(refused?.via).toBe("token");
    const rows = queryDecisionLedger(vault, { verdict: "deny" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: "bob", via: "token", source: "agent:bob" });
  });

  test("an ask stages into the signals queue with one row naming the publish target", () => {
    writeDoc("version: 1\ndefault_action: ask\n");
    const res = writeSignal(vault, INPUT);
    expect(res.staged).toBe(true);
    expect(res.path.replaceAll("\\", "/")).toContain("Brain/pending");
    expect(existsSync(res.path)).toBe(true);
    expect(inboxFiles()).toEqual([]);
    const rows = queryDecisionLedger(vault, { verdict: "ask" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: "claude",
      via: "config",
      action: "write",
      target: TARGET,
      source: "default",
    });
  });

  test("an allow publishes with no row unless record_allows asks for one", () => {
    writeDoc("version: 1\ndefault_action: allow\n");
    const res = writeSignal(vault, INPUT);
    expect(res.staged).toBe(false);
    expect(res.path.replaceAll("\\", "/")).toContain("Brain/inbox");
    expect(queryDecisionLedger(vault)).toEqual([]);
    writeDoc("version: 1\ndefault_action: allow\nledger:\n  record_allows: true\n");
    const second = writeSignal(vault, { ...INPUT, slug: "prefer-tests-2" });
    expect(second.staged).toBe(false);
    const rows = queryDecisionLedger(vault, { verdict: "allow" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: "claude",
      action: "write",
      target: "Brain/inbox/sig-2026-06-01-prefer-tests-2.md",
      source: "default",
    });
  });

  test("an unreadable document fails closed by name", () => {
    writeDoc("version: 1\ndefault_action: nonsense\n");
    expect(() => writeSignal(vault, INPUT)).toThrow(PermissionsDocumentError);
    expect(inboxFiles()).toEqual([]);
  });

  test("the staging path never re-enters the gate it feeds", () => {
    writeDoc("version: 1\ndefault_action: deny\n");
    const res = stagePendingSignal(vault, INPUT);
    // The queue's own staging write lands even though the document denies
    // every write: the caller that feeds the queue is not re-gated by it.
    expect(existsSync(res.path)).toBe(true);
    expect(queryDecisionLedger(vault)).toEqual([]);
  });
});

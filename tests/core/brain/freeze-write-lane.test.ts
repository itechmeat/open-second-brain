/**
 * What a freeze actually holds, and the one thing it deliberately does
 * not (who-wrote-what, Task C).
 *
 * The freeze lives inside `assertVaultIdentityForWrite`, which every
 * content writer in `src/core/brain/` already passes. These tests drive
 * the real writers rather than the guard, because "the guard throws" is
 * a property of one function and "a frozen vault refuses note writes" is
 * the property the feature claims. The audit lane is asserted the same
 * way: `appendLogEvent` must still land, or the freeze erases the record
 * of itself.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { freezeVault } from "../../../src/core/brain/freeze.ts";
import {
  VaultFrozenError,
  WRITE_LANE,
  resetFreezeMarkerCache,
} from "../../../src/core/brain/freeze-marker.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { createNote } from "../../../src/core/brain/notes/create-note.ts";
import { brainDirs, brainDirsForWrite } from "../../../src/core/brain/paths.ts";
import { appendPrefAudit } from "../../../src/core/brain/pref-audit.ts";
import { restoreSnapshot } from "../../../src/core/brain/snapshot.ts";
import { applyWriteBatch } from "../../../src/core/brain/write-batch.ts";
import { resetVaultIdentityPins } from "../../../src/core/brain/vault-identity.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-freeze-lane-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  resetFreezeMarkerCache();
  resetVaultIdentityPins();
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  resetFreezeMarkerCache();
  resetVaultIdentityPins();
});

function freeze(): void {
  freezeVault(vault, { agent: "@operator", reason: "migrating the fleet" });
}

describe("the content lane while frozen", () => {
  test("brainDirsForWrite refuses, naming the freeze and the way out", () => {
    freeze();
    let raised: unknown;
    try {
      brainDirsForWrite(vault);
    } catch (exc) {
      raised = exc;
    }
    expect(raised).toBeInstanceOf(VaultFrozenError);
    const err = raised as VaultFrozenError;
    expect(err.reason).toBe("migrating the fleet");
    expect(err.by).toBe("@operator");
    expect(err.frozen_at).not.toBe("");
    expect(err.next_command).toBe("o2b brain unfreeze");
  });

  test("createNote refuses and leaves no file behind", () => {
    freeze();
    expect(() => createNote(vault, { path: "notes/frozen.md", content: "body" })).toThrow(
      VaultFrozenError,
    );
    expect(existsSync(join(vault, "notes", "frozen.md"))).toBe(false);
  });

  test("applyWriteBatch refuses before it reads its operations", () => {
    freeze();
    expect(() =>
      applyWriteBatch(vault, [{ kind: "create_note", path: "notes/batch.md", content: "body" }]),
    ).toThrow(VaultFrozenError);
    expect(existsSync(join(vault, "notes", "batch.md"))).toBe(false);
  });

  test("appendPrefAudit refuses", () => {
    freeze();
    expect(() =>
      appendPrefAudit(vault, {
        pref_id: "pref-frozen",
        op: "create",
        agent: "@agent",
        revision_before: null,
        revision_after: 1,
        hash_before: null,
        hash_after: "abc",
      }),
    ).toThrow(VaultFrozenError);
  });

  test("restoreSnapshot refuses by name, before it looks the run id up", () => {
    freeze();
    // The run id does not exist. A vault that was NOT frozen would fail
    // with a missing-snapshot error; the freeze has to win, or an
    // operator recovering a frozen vault would silently move bytes.
    let raised: unknown;
    try {
      restoreSnapshot(vault, "20260101T000000Z-abcdef");
    } catch (exc) {
      raised = exc;
    }
    expect(raised).toBeInstanceOf(VaultFrozenError);
  });

  test("the refusal lifts the moment the marker goes", () => {
    freeze();
    expect(() => brainDirsForWrite(vault)).toThrow(VaultFrozenError);
    rmSync(join(vault, "Brain", ".state", "frozen.json"));
    expect(brainDirsForWrite(vault)).toEqual(brainDirs(vault));
  });
});

describe("the audit lane while frozen", () => {
  test("appendLogEvent still lands, so the freeze does not erase its own record", () => {
    freeze();
    const result = appendLogEvent(
      vault,
      {
        timestamp: "2026-09-10T09:00:00Z",
        eventType: "write-refused",
        body: { tool: "brain_create_note", agent: "@agent" },
      },
      { deviceId: "" },
    );
    expect(existsSync(result.logPath)).toBe(true);
    expect(readFileSync(result.logPath, "utf8")).toContain("write-refused");
  });
});

/**
 * The audit lane is an exemption from the freeze, and an exemption
 * spreads by being convenient. This is the bound: two modules ask for it,
 * both of them are the record-keeping the freeze cannot silence, and a
 * third asking is a decision somebody has to make in front of this test.
 */
describe("the audit lane's blast radius", () => {
  const ALLOWED = new Set(["src/core/brain/log.ts", "src/core/brain/freeze.ts"]);

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sourceFiles(abs));
      else if (entry.name.endsWith(".ts")) out.push(abs);
    }
    return out;
  }

  test("WRITE_LANE.audit is requested from the record-keeping modules and nowhere else", () => {
    const requesting = sourceFiles(join(REPO_ROOT, "src"))
      .filter((abs) => /WRITE_LANE\.audit\b/.test(readFileSync(abs, "utf8")))
      .map((abs) => relative(REPO_ROOT, abs).split("\\").join("/"));
    expect(requesting.toSorted()).toEqual([...ALLOWED].toSorted());
  });

  test("the lane vocabulary is what the pin is written against", () => {
    expect(WRITE_LANE.audit).toBe("audit");
  });
});

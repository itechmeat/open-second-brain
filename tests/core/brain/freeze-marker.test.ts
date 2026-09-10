/**
 * Fleet freeze, read side (who-wrote-what, Task C).
 *
 * The marker is the whole mechanism: a file every device sees through
 * Syncthing, read in front of every content write. These tests pin the
 * four states it can be in - absent, present, unreadable, replaced - and
 * the one asymmetry that makes the freeze trustworthy: a marker nobody
 * can parse freezes the vault rather than reopening it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import {
  FREEZE_MARKER_SCHEMA_VERSION,
  FREEZE_MARKER_UNREADABLE_REASON,
  FREEZE_NEXT_COMMAND,
  VaultFrozenError,
  WRITE_LANE,
  assertVaultNotFrozen,
  freezeMarkerReloadCount,
  frozenMarkerPath,
  readFreezeMarker,
  resetFreezeMarkerCache,
} from "../../../src/core/brain/freeze-marker.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-freeze-marker-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  resetFreezeMarkerCache();
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  resetFreezeMarkerCache();
});

/** Write a well-formed marker the way `freezeVault` does. */
function writeMarker(reason: string): void {
  atomicWriteFileSync(
    frozenMarkerPath(vault),
    `${JSON.stringify(
      {
        schema: FREEZE_MARKER_SCHEMA_VERSION,
        frozen_at: "2026-09-10T08:00:00Z",
        by: "@operator",
        device_id: "laptop",
        reason,
      },
      null,
      2,
    )}\n`,
  );
}

describe("the freeze marker's location", () => {
  test("sits in the internal state directory, inside the vault", () => {
    expect(frozenMarkerPath(vault)).toBe(join(vault, "Brain", ".state", "frozen.json"));
  });
});

describe("reading the marker", () => {
  test("an absent marker is an absence, and nothing is refused", () => {
    expect(readFreezeMarker(vault)).toBeNull();
    expect(() => assertVaultNotFrozen(vault)).not.toThrow();
  });

  test("a present marker is read field for field", () => {
    writeMarker("migrating the laptop");
    const marker = readFreezeMarker(vault);
    expect(marker).not.toBeNull();
    expect(marker!.frozen_at).toBe("2026-09-10T08:00:00Z");
    expect(marker!.by).toBe("@operator");
    expect(marker!.device_id).toBe("laptop");
    expect(marker!.reason).toBe("migrating the laptop");
  });

  test("a malformed marker IS a freeze, named as unreadable rather than absent", () => {
    mkdirSync(join(vault, "Brain", ".state"), { recursive: true });
    writeFileSync(frozenMarkerPath(vault), "{ not json", "utf8");
    const marker = readFreezeMarker(vault);
    expect(marker).not.toBeNull();
    expect(marker!.reason).toBe(FREEZE_MARKER_UNREADABLE_REASON);
    expect(() => assertVaultNotFrozen(vault)).toThrow(VaultFrozenError);
  });

  test("a marker missing its timestamp is unreadable too, never a half-freeze", () => {
    mkdirSync(join(vault, "Brain", ".state"), { recursive: true });
    writeFileSync(frozenMarkerPath(vault), JSON.stringify({ schema: 1, by: "@x" }), "utf8");
    expect(readFreezeMarker(vault)!.reason).toBe(FREEZE_MARKER_UNREADABLE_REASON);
  });
});

describe("the refusal", () => {
  test("names when, who, why, and the way out", () => {
    writeMarker("migrating the laptop");
    let raised: unknown;
    try {
      assertVaultNotFrozen(vault);
    } catch (exc) {
      raised = exc;
    }
    expect(raised).toBeInstanceOf(VaultFrozenError);
    const err = raised as VaultFrozenError;
    expect(err.frozen_at).toBe("2026-09-10T08:00:00Z");
    expect(err.by).toBe("@operator");
    expect(err.reason).toBe("migrating the laptop");
    expect(err.next_command).toBe(FREEZE_NEXT_COMMAND);
    expect(err.notice.code).toBe("vault-frozen");
    expect(err.message).toContain(FREEZE_NEXT_COMMAND);
  });
});

describe("the per-process cache", () => {
  test("re-reads only when the file on disk is not the one already parsed", () => {
    writeMarker("first");
    expect(readFreezeMarker(vault)!.reason).toBe("first");
    const afterFirst = freezeMarkerReloadCount();
    // Same bytes, same inode: the cached parse answers.
    expect(readFreezeMarker(vault)!.reason).toBe("first");
    expect(freezeMarkerReloadCount()).toBe(afterFirst);

    // `atomicWriteFileSync` renames a temp file into place, so a replaced
    // marker always arrives with a new inode.
    writeMarker("second");
    expect(readFreezeMarker(vault)!.reason).toBe("second");
    expect(freezeMarkerReloadCount()).toBe(afterFirst + 1);
  });

  test("an unfreeze is visible to a process that had the freeze cached", () => {
    writeMarker("first");
    expect(readFreezeMarker(vault)).not.toBeNull();
    rmSync(frozenMarkerPath(vault));
    expect(readFreezeMarker(vault)).toBeNull();
  });
});

describe("the write lanes", () => {
  test("are a closed pair, so a third lane cannot be invented at a call site", () => {
    expect(Object.values(WRITE_LANE).toSorted()).toEqual(["audit", "content"]);
  });
});

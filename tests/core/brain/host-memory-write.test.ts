import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  continuityLogPath,
  listContinuityRecords,
} from "../../../src/core/brain/continuity/store.ts";
import {
  HOST_MEMORY_WRITE_KIND,
  HostMemoryWriteError,
  recordHostMemoryWrite,
  recordHostMemoryWrites,
} from "../../../src/core/brain/host-memory-write.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-host-memory-write-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("recordHostMemoryWrite", () => {
  test("persists a host write as a host_memory_write continuity record", () => {
    const record = recordHostMemoryWrite(vault, {
      action: "add",
      target: "user",
      content: "User prefers dark mode",
      metadata: { write_origin: "tool", session_id: "sess-1" },
      createdAt: "2026-06-20T10:00:00Z",
    });

    expect(record.kind).toBe(HOST_MEMORY_WRITE_KIND);
    expect(record.payload).toEqual({
      action: "add",
      target: "user",
      content: "User prefers dark mode",
      metadata: { write_origin: "tool", session_id: "sess-1" },
    });

    const listed = listContinuityRecords(vault, { kind: HOST_MEMORY_WRITE_KIND });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(record.id);
  });

  test("omits metadata from the payload when none is supplied", () => {
    const record = recordHostMemoryWrite(vault, {
      action: "replace",
      target: "memory",
      content: "observed fact",
      createdAt: "2026-06-20T10:00:00Z",
    });
    expect(record.payload).toEqual({
      action: "replace",
      target: "memory",
      content: "observed fact",
    });
  });

  test("redacts secrets in content via the continuity payload sanitiser", () => {
    const record = recordHostMemoryWrite(vault, {
      action: "add",
      target: "memory",
      content: "token=secret-value and <private>hide me</private>",
      createdAt: "2026-06-20T10:00:00Z",
    });
    expect(JSON.stringify(record.payload)).not.toContain("secret-value");
    expect(JSON.stringify(record.payload)).not.toContain("hide me");
    expect(record.redacted).toBe(true);
    expect(record.private).toBe(true);
  });

  test("rejects a non-bridged action and writes nothing", () => {
    expect(() =>
      recordHostMemoryWrite(vault, { action: "remove", target: "user", content: "x" }),
    ).toThrow(HostMemoryWriteError);
    try {
      recordHostMemoryWrite(vault, { action: "remove", target: "user", content: "x" });
    } catch (err) {
      expect((err as HostMemoryWriteError).code).toBe("invalid_action");
    }
    expect(listContinuityRecords(vault, { kind: HOST_MEMORY_WRITE_KIND })).toHaveLength(0);
  });

  test("rejects an unknown target", () => {
    try {
      recordHostMemoryWrite(vault, { action: "add", target: "scratchpad", content: "x" });
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(HostMemoryWriteError);
      expect((err as HostMemoryWriteError).code).toBe("invalid_target");
    }
  });

  test("rejects empty content", () => {
    try {
      recordHostMemoryWrite(vault, { action: "add", target: "user", content: "   " });
      throw new Error("expected rejection");
    } catch (err) {
      expect((err as HostMemoryWriteError).code).toBe("empty_content");
    }
  });
});

describe("recordHostMemoryWrites (batch substrate)", () => {
  test("appends a same-month batch atomically", () => {
    const records = recordHostMemoryWrites(vault, [
      { action: "add", target: "user", content: "fact one", createdAt: "2026-06-20T10:00:00Z" },
      {
        action: "replace",
        target: "memory",
        content: "fact two",
        createdAt: "2026-06-20T10:01:00Z",
      },
    ]);
    expect(records).toHaveLength(2);
    expect(listContinuityRecords(vault, { kind: HOST_MEMORY_WRITE_KIND })).toHaveLength(2);
  });

  test("a malformed entry aborts the whole batch with zero writes", () => {
    const path = continuityLogPath(vault, "2026-06");
    expect(existsSync(path)).toBe(false);
    expect(() =>
      recordHostMemoryWrites(vault, [
        { action: "add", target: "user", content: "ok", createdAt: "2026-06-20T10:00:00Z" },
        { action: "remove", target: "user", content: "bad", createdAt: "2026-06-20T10:01:00Z" },
      ]),
    ).toThrow(HostMemoryWriteError);
    // Validation happens before any write: the log was never created.
    expect(existsSync(path)).toBe(false);
    expect(listContinuityRecords(vault, { kind: HOST_MEMORY_WRITE_KIND })).toHaveLength(0);
  });
});

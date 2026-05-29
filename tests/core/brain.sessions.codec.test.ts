/**
 * Opt-in session codec integration (Vault portability suite, Feature 1
 * Task 7). With `rawCodec`, writeSignal stores the raw body compressed
 * and stamps a `_raw_codec` marker; parseSignal expands it on read.
 * Without the flag (default) the body is verbatim and the read path is
 * byte-identical to pre-suite.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeSignal, parseSignal } from "../../src/core/brain/signal.ts";

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-sig-codec-"));
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

// Whitespace-heavy body so the codec's body savings exceed the fixed
// `_raw_codec` marker-line overhead, making the on-disk file shorter.
const RAW =
  "Observed run:\n\n```bash\ngit status\n```\n\nThen a note." +
  "\n".repeat(60) +
  "Tail after a long blank run.";

function write(rawCodec: boolean): string {
  return writeSignal(vault, {
    topic: "obs",
    signal: "positive",
    agent: "claude",
    principle: "capture the observation",
    created_at: "2026-05-29T10:00:00Z",
    date: "2026-05-29",
    slug: "obs",
    raw: RAW,
    ...(rawCodec ? { rawCodec: true } : {}),
  }).path;
}

describe("signal raw codec", () => {
  test("with rawCodec: stamps the marker and round-trips the raw on read", () => {
    const path = write(true);
    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).toContain("_raw_codec");
    expect(parseSignal(path).raw).toBe(RAW);
  });

  test("with rawCodec: the stored body is shorter than verbatim", () => {
    const compressed = readFileSync(write(true), "utf8").length;
    const verbatim = readFileSync(write(false), "utf8").length;
    expect(compressed).toBeLessThan(verbatim);
  });

  test("without rawCodec (default): no marker, raw stored verbatim", () => {
    const path = write(false);
    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).not.toContain("_raw_codec");
    expect(onDisk).toContain("Tail after a long blank run.");
    expect(parseSignal(path).raw).toBe(RAW);
  });
});

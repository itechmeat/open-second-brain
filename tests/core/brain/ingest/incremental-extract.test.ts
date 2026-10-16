/**
 * Incremental extraction plumbing (Lane 5, Task 5.5, t_a9cd4221).
 *
 * An ingest whose manifest record carries the extraction watermark reports
 * the APPENDED delta on the result and stamps the watermark beside the
 * digest; the CLI extract preview reports the appended slice metadata for a
 * previously-extracted source. The pinned protocol:
 *
 *   - a first ingest stamps the FULL current size as the watermark (the
 *     ingest contract is a whole-source extraction) and reports no delta;
 *   - an appended source reports exactly the bytes appended since the
 *     watermark, boundary-safe ({@link ./tail-read.ts}), and two appends
 *     yield two deltas that never overlap;
 *   - a REWRITTEN source - even one that grew - classifies modified and
 *     reprocesses fully, resetting the watermark, because the recorded
 *     digest no longer describes the leading bytes;
 *   - a PROVEN append whose tail passes the delta cap answers the named
 *     `appended-over-cap` outcome carrying the whole appended range - never
 *     silently the same answer as a rewrite (review L3); the run stays a
 *     whole-source pass, so the stamp still covers the full current file;
 *   - EXTRACT_CONTRACT_VERSION stays at 2: the watermark changes what is
 *     REPORTED, not what extraction produces, so no contract bump and no
 *     one-time mass reprocess is owed.
 */

import * as fsNamespace from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, appendFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Positioned-read observer for the delta pass. The ONLY positioned readSync
// reachable from ingestSource is the append-proof snapshot's byte walk; the
// trust and archive lanes read with a null position and the in-lock stamp
// hashes through readFileSync. Counting positioned bytes against the source's
// inode therefore measures exactly the delta pass, with no behavior change
// (every call is forwarded untouched). Same forwarding-mock idiom as
// digest-actions.test.ts: capture the originals BEFORE the mock.
const realReadSync = fsNamespace.readSync;
const realFstatSync = fsNamespace.fstatSync;
let positionedReadTarget: { readonly dev: number; readonly ino: number } | undefined;
let positionedReadBytes = 0;

mock.module("node:fs", () => ({
  ...fsNamespace,
  readSync(
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ): number {
    const count = realReadSync(fd, buffer, offset, length, position);
    if (positionedReadTarget !== undefined && typeof position === "number" && count > 0) {
      try {
        const st = realFstatSync(fd);
        if (st.dev === positionedReadTarget.dev && st.ino === positionedReadTarget.ino) {
          positionedReadBytes += count;
        }
      } catch {
        // An unstattable fd is not the observed read; the count stays.
      }
    }
    return count;
  },
}));

import { runCli } from "../../../helpers/run-cli.ts";
import { EXTRACT_CONTRACT_VERSION } from "../../../../src/core/brain/ingest/contract.ts";
import {
  classifyPaths,
  hashBytes,
  hashFile,
  readManifest,
} from "../../../../src/core/brain/ingest/content-manifest.ts";
import { planBatches } from "../../../../src/core/brain/ingest/batch-plan.ts";
import { IS_WINDOWS } from "../../../helpers/platform.ts";
import { ingestSource } from "../../../../src/core/brain/ingest/ingest.ts";
import { PRE_EXTRACT_MAX_SOURCE_BYTES } from "../../../../src/core/brain/ingest/source-read.ts";

let tmp: string;
let vault: string;

const NOW = new Date("2026-06-13T12:00:00Z");
const SOURCE = "imports/chat-log.md";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-incremental-extract-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "imports"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeSource(contents: string): void {
  writeFileSync(join(vault, SOURCE), contents, "utf8");
}

const INPUT = { sourcePath: SOURCE, summary: "A chat log summary.", extraction: { entities: [] } };
const OPTS = { agent: "tester", now: NOW };

describe("ingestSource watermark stamping", () => {
  test("a first ingest stamps the full size and reports no delta", () => {
    writeSource("one\ntwo\n");
    const res = ingestSource(vault, INPUT, OPTS);
    expect(res.extractionDelta).toBeUndefined();

    const entry = readManifest(vault).entries[SOURCE]!;
    expect(entry.extracted_bytes).toBe(8);
    expect(entry.extracted_at).toBe("2026-06-13T12:00:00Z");
    expect(entry.sha256).toBe(hashFile(join(vault, SOURCE)));
  });

  test("a first ingest issues no positioned read against the source", () => {
    // Several positioned-read chunks wide, so a wasted whole-source walk
    // would show up in the counter; a skipped one does not.
    writeSource("first-ingest line of a larger source\n".repeat(5000));
    const size = statSync(join(vault, SOURCE)).size;

    const sourceStat = statSync(join(vault, SOURCE));
    positionedReadTarget = { dev: sourceStat.dev, ino: sourceStat.ino };
    const before = positionedReadBytes;
    let res: ReturnType<typeof ingestSource>;
    try {
      res = ingestSource(vault, INPUT, OPTS);
    } finally {
      positionedReadTarget = undefined;
    }
    // With no watermark nothing can be proven and no tail can exist, so the
    // append-proof machinery has no byte of the source to read: the run's
    // only whole-source pass is the in-lock stamp hash (readFileSync,
    // invisible to this counter).
    expect(positionedReadBytes - before).toBe(0);
    // The observable answers the skip must preserve: no delta, and the
    // full-size in-lock stamp exactly as before.
    expect(res.extractionDelta).toBeUndefined();
    const entry = readManifest(vault).entries[SOURCE]!;
    expect(entry.extracted_bytes).toBe(size);
    expect(entry.sha256).toBe(hashFile(join(vault, SOURCE)));
  });

  test("an appended source reports the appended delta and advances the watermark", () => {
    writeSource("one\ntwo\n");
    ingestSource(vault, INPUT, OPTS);

    appendFileSync(join(vault, SOURCE), "three\n", "utf8");
    // Positive control for the positioned-read counter the first-ingest
    // test asserts against: the append path really does read the delta
    // through a positioned read, so a silently broken mock shows up here
    // instead of passing both tests vacuously.
    const sourceStat = statSync(join(vault, SOURCE));
    positionedReadTarget = { dev: sourceStat.dev, ino: sourceStat.ino };
    let res: ReturnType<typeof ingestSource>;
    try {
      res = ingestSource(vault, INPUT, OPTS);
    } finally {
      positionedReadTarget = undefined;
    }
    expect(positionedReadBytes).toBeGreaterThan(0);

    expect(res.extractionDelta).toEqual({ kind: "appended", fromByte: 8, toByte: 14 });
    const entry = readManifest(vault).entries[SOURCE]!;
    expect(entry.extracted_bytes).toBe(14);
    expect(entry.sha256).toBe(hashFile(join(vault, SOURCE)));
  });

  test("two appends yield two correct deltas with no overlap", () => {
    writeSource("one\ntwo\n");
    ingestSource(vault, INPUT, OPTS);
    appendFileSync(join(vault, SOURCE), "three\n", "utf8");
    const second = ingestSource(vault, INPUT, OPTS);
    appendFileSync(join(vault, SOURCE), "four\n", "utf8");
    const third = ingestSource(vault, INPUT, OPTS);

    expect(second.extractionDelta).toEqual({ kind: "appended", fromByte: 8, toByte: 14 });
    expect(third.extractionDelta).toEqual({ kind: "appended", fromByte: 14, toByte: 19 });
    // The watermarks advanced stepwise; no delta covers another's bytes.
    expect(readManifest(vault).entries[SOURCE]!.extracted_bytes).toBe(19);
  });

  test("a rewritten source classifies modified, reprocesses fully, resets the watermark", () => {
    writeSource("one\ntwo\n");
    ingestSource(vault, INPUT, OPTS);
    appendFileSync(join(vault, SOURCE), "three\n", "utf8");
    ingestSource(vault, INPUT, OPTS);
    expect(readManifest(vault).entries[SOURCE]!.extracted_bytes).toBe(14);

    // A rewrite that HAPPENS TO GROW: the leading bytes no longer match the
    // recorded digest, so this is modified, never an append.
    writeSource("an entirely different document\n");
    const res = ingestSource(vault, INPUT, OPTS);

    expect(res.extractionDelta).toBeUndefined();
    const entry = readManifest(vault).entries[SOURCE]!;
    expect(entry.extracted_bytes).toBe(31);
    expect(entry.sha256).toBe(hashFile(join(vault, SOURCE)));
  });

  test("an appended tail with no complete line reports an empty delta and leaves the watermark", () => {
    writeSource("one\ntwo\n");
    ingestSource(vault, INPUT, OPTS);
    appendFileSync(join(vault, SOURCE), "half a line", "utf8");

    const res = ingestSource(vault, INPUT, OPTS);
    expect(res.extractionDelta).toEqual({ kind: "appended", fromByte: 8, toByte: 8 });
    // The stamp covers exactly the announced prefix (review M15): the
    // unterminated fragment stays unstamped, and the next append's delta
    // starts AT it instead of past it.
    const entry = readManifest(vault).entries[SOURCE]!;
    expect(entry.extracted_bytes).toBe(8);
    expect(entry.sha256).toBe(hashBytes(new Uint8Array(Buffer.from("one\ntwo\n", "utf8"))));
  });

  test("a fragment stamp keeps the prefix proof consistent and the next delta stitches the fragment", () => {
    // The review's M15 probe: the delta cut ends at the last complete
    // newline, so the stamp must land there - at the bytes the delta
    // series actually announced - and never at the raw file size.
    writeSource("base\n");
    ingestSource(vault, INPUT, OPTS);
    expect(readManifest(vault).entries[SOURCE]!.extracted_bytes).toBe(5);

    appendFileSync(join(vault, SOURCE), "line1\nline2-part", "utf8");
    const second = ingestSource(vault, INPUT, OPTS);
    expect(second.extractionDelta).toEqual({ kind: "appended", fromByte: 5, toByte: 11 });

    // The stamp lands at the announced boundary (11), NOT at the file
    // size (21), and the digest describes exactly those leading bytes.
    const stamped = readManifest(vault).entries[SOURCE]!;
    expect(stamped.extracted_bytes).toBe(11);
    expect(stamped.sha256).toBe(hashBytes(new Uint8Array(Buffer.from("base\nline1\n", "utf8"))));

    // Accepted consequence (review M15): with the stamp behind EOF the
    // file classifies modified until the fragment is terminated - one
    // reclassification, never a stale skip.
    expect(classifyPaths(vault, [SOURCE], readManifest(vault)).modified).toEqual([SOURCE]);

    appendFileSync(join(vault, SOURCE), "-rest\nline3\n", "utf8");
    const third = ingestSource(vault, INPUT, OPTS);
    // The fragment rides the next delta instead of falling out of the
    // delta series for good.
    expect(third.extractionDelta).toEqual({ kind: "appended", fromByte: 11, toByte: 33 });
    const healed = readManifest(vault).entries[SOURCE]!;
    expect(healed.extracted_bytes).toBe(33);
    // The boundary is back at EOF, so the digest is a whole-file digest
    // again and the unchanged classification holds.
    expect(healed.sha256).toBe(hashFile(join(vault, SOURCE)));
    expect(classifyPaths(vault, [SOURCE], readManifest(vault)).unchanged).toEqual([SOURCE]);
  });
});

describe("the watermark never moves the extraction contract", () => {
  test("EXTRACT_CONTRACT_VERSION stays at 2 and a watermarked source reprocesses nothing", () => {
    expect(EXTRACT_CONTRACT_VERSION).toBe(2);

    writeSource("one\ntwo\n");
    ingestSource(vault, INPUT, OPTS);

    // Byte-identical and contract-current: the planner plans nothing for it.
    const plan = planBatches(vault, "imports", { maxBatchBytes: 10_000, maxBatchFiles: 100 });
    expect(plan.contractChanged).toBe(false);
    const planned = plan.batches.flatMap((b) => b.files).map((f) => f.path);
    expect(planned).toEqual([]);

    // And classification still answers unchanged - the additive fields never
    // touched the byte question.
    const res = classifyPaths(vault, [SOURCE], readManifest(vault));
    expect(res.unchanged).toEqual([SOURCE]);
  });
});

describe("the CLI extract preview reports the appended slice", () => {
  test("a previously-extracted source answers its appended byte range", async () => {
    writeSource("one\ntwo\n");
    ingestSource(vault, INPUT, OPTS);
    appendFileSync(join(vault, SOURCE), "three\n", "utf8");

    const res = await runCli(["brain", "extract", join(vault, SOURCE), "--json", "--vault", vault]);
    expect(res.returncode).toBe(0);
    const payload = JSON.parse(res.stdout) as {
      extracted: boolean;
      appended?: { from_byte: number; to_byte: number };
    };
    expect(payload.appended).toEqual({ from_byte: 8, to_byte: 14 });
  });

  test("a source with no recorded watermark answers without an appended section", async () => {
    writeSource("plain note\n");
    const res = await runCli(["brain", "extract", join(vault, SOURCE), "--json", "--vault", vault]);
    expect(res.returncode).toBe(0);
    const payload = JSON.parse(res.stdout) as { appended?: unknown };
    expect(payload.appended).toBeUndefined();
  });

  test("an append between the two caps answers without a section, like the pipeline", async () => {
    // The appended tail sits past the ingest delta cap (1 MiB) but under
    // the HTML whole-source cap (8 MiB): reprocess-scale for a delta,
    // ordinary for a whole read.
    writeSource("one\ntwo\n");
    ingestSource(vault, INPUT, OPTS);
    appendFileSync(
      join(vault, SOURCE),
      `${"x".repeat(PRE_EXTRACT_MAX_SOURCE_BYTES)}\nmore tail\n`,
      "utf8",
    );

    const res = await runCli(["brain", "extract", join(vault, SOURCE), "--json", "--vault", vault]);
    expect(res.returncode).toBe(0);
    const payload = JSON.parse(res.stdout) as { appended?: unknown };
    // The preview refuses exactly what the pipeline refuses to render: it
    // must never report a slice the delta pass would not accept.
    expect(payload.appended).toBeUndefined();
    const second = ingestSource(vault, INPUT, OPTS);
    // The pipeline itself names the over-cap append instead of answering
    // the same shape a rewrite gets (review L3): the whole appended range,
    // no text.
    const size = statSync(join(vault, SOURCE)).size;
    expect(second.extractionDelta).toEqual({
      kind: "appended-over-cap",
      fromByte: 8,
      toByte: size,
    });
    // The run stayed a whole-source pass: the stamp covers the full
    // current file, digest included.
    const entry = readManifest(vault).entries[SOURCE]!;
    expect(entry.extracted_bytes).toBe(size);
    expect(entry.sha256).toBe(hashFile(join(vault, SOURCE)));
  });

  test("a rewritten source that grew answers without a section, like the pipeline", async () => {
    writeSource("one\ntwo\n");
    ingestSource(vault, INPUT, OPTS);
    // Bigger than the watermark, but the leading bytes no longer match the
    // recorded digest: the pipeline classifies this modified and reports no
    // delta, so the preview must not label it an append either.
    writeSource("ONE\nTWO\nTHREE\n");
    const res = await runCli(["brain", "extract", join(vault, SOURCE), "--json", "--vault", vault]);
    expect(res.returncode).toBe(0);
    const payload = JSON.parse(res.stdout) as { appended?: unknown };
    expect(payload.appended).toBeUndefined();
    const second = ingestSource(vault, INPUT, OPTS);
    expect(second.extractionDelta).toBeUndefined();
  });
});

describe("a source that changes kind mid-run degrades fail-safe", () => {
  // The injection unlinks the just-written source file and replaces it with a
  // directory mid-run; Windows can deny that unlink while the writer's handle
  // is still live (EBUSY/EPERM), so the swap never lands there.
  test.skipIf(IS_WINDOWS)(
    "a source swapped for a directory after classification reprocesses with no crash",
    () => {
      writeSource("one\ntwo\n");
      const first = ingestSource(vault, INPUT, OPTS);

      // The caller's reach predicate is asked about the summary page only
      // after the intake has already classified the source trusted (its stat
      // saw a regular file) and just before the manifest stamp, so swapping
      // the source for a directory inside the callback lands the change in
      // the window between the classification stat and the single-pass
      // append snapshot. Opening a directory refuses (EISDIR), and the ONE
      // descriptor the pass reads answers for both the delta and the stamp:
      // no provable append is reported, and no stamp lands that the pass
      // could not also verify - the last good entry stands, and the source
      // reprocesses when its real bytes return.
      let swapped = false;
      const second = ingestSource(vault, INPUT, {
        ...OPTS,
        readable: (rel) => {
          if (rel === first.summaryPath && !swapped) {
            swapped = true;
            rmSync(join(vault, SOURCE));
            mkdirSync(join(vault, SOURCE));
          }
          return true;
        },
      });

      expect(swapped).toBe(true);
      // No crash: the run answers, and a source that cannot be read as a
      // file reports no append.
      expect(second.summaryPath).toBe(first.summaryPath);
      expect(second.extractionDelta).toBeUndefined();
      // The manifest keeps describing the last read the pipeline could
      // actually take - the file as it stood at the first ingest.
      const entry = readManifest(vault).entries[SOURCE]!;
      expect(entry.sha256).toBe(hashBytes(new Uint8Array(Buffer.from("one\ntwo\n", "utf8"))));
      expect(entry.extracted_bytes).toBe(8);

      // The restored file is byte-identical to that standing stamp: it
      // classifies unchanged, and no delta is reported.
      rmSync(join(vault, SOURCE), { recursive: true });
      writeSource("one\ntwo\n");
      const third = ingestSource(vault, INPUT, OPTS);
      expect(third.extractionDelta).toBeUndefined();
      expect(readManifest(vault).entries[SOURCE]!.extracted_bytes).toBe(8);
    },
  );
});

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
 *   - EXTRACT_CONTRACT_VERSION stays at 2: the watermark changes what is
 *     REPORTED, not what extraction produces, so no contract bump and no
 *     one-time mass reprocess is owed.
 */

import { mkdirSync, mkdtempSync, rmSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runCli } from "../../../helpers/run-cli.ts";
import { EXTRACT_CONTRACT_VERSION } from "../../../../src/core/brain/ingest/contract.ts";
import {
  classifyPaths,
  hashFile,
  hashPath,
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

  test("an appended source reports the appended delta and advances the watermark", () => {
    writeSource("one\ntwo\n");
    ingestSource(vault, INPUT, OPTS);

    appendFileSync(join(vault, SOURCE), "three\n", "utf8");
    const res = ingestSource(vault, INPUT, OPTS);

    expect(res.extractionDelta).toEqual({ fromByte: 8, toByte: 14 });
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

    expect(second.extractionDelta).toEqual({ fromByte: 8, toByte: 14 });
    expect(third.extractionDelta).toEqual({ fromByte: 14, toByte: 19 });
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

  test("an appended tail with no complete line reports an empty delta at the watermark", () => {
    writeSource("one\ntwo\n");
    ingestSource(vault, INPUT, OPTS);
    appendFileSync(join(vault, SOURCE), "half a line", "utf8");

    const res = ingestSource(vault, INPUT, OPTS);
    expect(res.extractionDelta).toEqual({ fromByte: 8, toByte: 8 });
    // The run still covered the whole current source, so the stamp is full.
    expect(readManifest(vault).entries[SOURCE]!.extracted_bytes).toBe(19);
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
    // The preview refuses exactly what the pipeline refuses: it must
    // never report a slice the delta pass would not accept.
    expect(payload.appended).toBeUndefined();
    const second = ingestSource(vault, INPUT, OPTS);
    expect(second.extractionDelta).toBeUndefined();
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
      // the window between the classification stat and the pre-stamp reads.
      // The stamp block then stats a directory whose size sits past the
      // recorded watermark, and the append-proof read used to die on EISDIR -
      // after the summary pages were written, losing the run's result. The
      // sibling ENOENT window (the source deleted inside the same span,
      // between the block's existsSync and the stat/hash reads) is answered
      // by the same fail-safe catch; it has no deterministic public-API hook.
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
      // No crash: the run answers, and a source that cannot be read as a file
      // reports no append.
      expect(second.summaryPath).toBe(first.summaryPath);
      expect(second.extractionDelta).toBeUndefined();
      // The stamp that landed describes the directory as it now is, so the
      // next classification sees a changed source and reprocesses fully
      // rather than trusting a stale file digest.
      const entry = readManifest(vault).entries[SOURCE]!;
      expect(entry.sha256).toBe(hashPath(join(vault, SOURCE)));
      expect(entry.extracted_bytes).toBeGreaterThan(0);

      // The restored file is not an append against that stamp: the source
      // reprocesses fully, and the stamp lands on the real file again.
      rmSync(join(vault, SOURCE), { recursive: true });
      writeSource("one\ntwo\n");
      const third = ingestSource(vault, INPUT, OPTS);
      expect(third.extractionDelta).toBeUndefined();
      expect(readManifest(vault).entries[SOURCE]!.extracted_bytes).toBe(8);
    },
  );
});

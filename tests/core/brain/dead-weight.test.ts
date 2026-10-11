/**
 * Dead-weight utilization fold (recall-quality, t_1ee67e5b / task D3).
 *
 * The complement of retrieval: full set = the vault walk's included
 * `.md` pages (the population recall can currently return), retrieved
 * set = the union of `recall_telemetry` top-artifact paths and
 * `recall_observed_use` source-ref paths, and everything in the full set
 * that no record ever surfaced is dead weight. Three honesty rules are
 * pinned here:
 *
 *   - a vanished page (deleted on disk, still in some stale index) is
 *     never reported: the denominator is the LIVE walk, so a deletion
 *     cannot masquerade as dead weight, and a vanished path inside a
 *     record neither counts as retrieved nor leaks;
 *   - the observation window is stated from the records themselves (the
 *     earliest and latest matching `createdAt`), never from the clock;
 *   - the fold is read-only and deterministic: no emit, no mutation, and
 *     two runs over the same inputs agree exactly.
 *
 * "Dead" therefore means "never surfaced in recorded telemetry history
 * within the window" - telemetry is opt-in and records only the surfaced
 * top rows, so the report carries the caveat verbatim rather than a
 * stronger claim it cannot prove.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitRecallTelemetry, RECALL_CHANNEL } from "../../../src/core/brain/recall-telemetry.ts";
import { emitObservedUse } from "../../../src/core/brain/observed-use.ts";
import { computeDeadWeight } from "../../../src/core/brain/dead-weight.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-dead-weight-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeMd("a.md", "# A\n\nalpha beta gamma.\n");
  writeMd("b.md", "# B\n\nalpha beta delta.\n");
  writeMd("c.md", "# C\n\nalpha epsilon zeta.\n");
  writeMd("sub/d.md", "# D\n\neta theta iota.\n");
  // Not a page: the walk counts it, the fold must not.
  writeFileSync(join(vault, "notes.txt"), "plain text attachment\n");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writeMd(relPath: string, content: string): void {
  const abs = join(vault, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

describe("computeDeadWeight", () => {
  test("reports the complement of recorded retrieval", () => {
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T16:00:00.000Z",
      host: "fold-test",
      channel: RECALL_CHANNEL.cli,
      mode: "search",
      status: "ok",
      durationMs: 5,
      resultCount: 2,
      topArtifacts: [
        { id: "doc-a:0", path: "a.md" },
        { id: "doc-b:0", path: "b.md" },
      ],
    });
    emitObservedUse(vault, {
      createdAt: "2026-05-21T09:00:00.000Z",
      host: "fold-test",
      entries: [{ id: "doc-c:0", path: "c.md", verdict: "USED" }],
    });

    const report = computeDeadWeight(vault);
    expect(report.pages_total).toBe(4);
    expect(report.pages_retrieved).toBe(3);
    expect(report.dead_count).toBe(1);
    expect(report.dead).toEqual([{ path: "sub/d.md" }]);
    // The window is the records' own span, not the wall clock.
    expect(report.window.since).toBe("2026-05-20T16:00:00.000Z");
    expect(report.window.until).toBe("2026-05-21T09:00:00.000Z");
  });

  test("a vanished page is never reported, from either side of the fold", () => {
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T16:00:00.000Z",
      host: "fold-test",
      channel: RECALL_CHANNEL.cli,
      mode: "search",
      status: "ok",
      durationMs: 5,
      resultCount: 1,
      topArtifacts: [
        { id: "gone:0", path: "gone.md" },
        { id: "doc-a:0", path: "a.md" },
      ],
    });

    const report = computeDeadWeight(vault);
    expect(report.pages_total).toBe(4);
    // The vanished path was surfaced once, but it is not a page the vault
    // can return any more: it neither counts as retrieved nor appears as
    // dead weight (deleting a page is not what dead weight measures).
    expect(report.pages_retrieved).toBe(1);
    expect(report.dead.map((d) => d.path)).toEqual(["b.md", "c.md", "sub/d.md"]);
    expect(report.dead_count).toBe(3);
  });

  test("since and until bound the records folded, and the window follows", () => {
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T16:00:00.000Z",
      host: "fold-test",
      channel: RECALL_CHANNEL.cli,
      mode: "search",
      status: "ok",
      durationMs: 5,
      resultCount: 1,
      topArtifacts: [{ id: "doc-a:0", path: "a.md" }],
    });
    emitObservedUse(vault, {
      createdAt: "2026-05-21T09:00:00.000Z",
      host: "fold-test",
      entries: [{ id: "doc-c:0", path: "c.md", verdict: "USED" }],
    });

    const onlyLate = computeDeadWeight(vault, { since: "2026-05-21T00:00:00.000Z" });
    expect(onlyLate.pages_retrieved).toBe(1);
    expect(onlyLate.dead.map((d) => d.path)).toEqual(["a.md", "b.md", "sub/d.md"]);
    expect(onlyLate.window.since).toBe("2026-05-21T09:00:00.000Z");

    const onlyEarly = computeDeadWeight(vault, { until: "2026-05-21T00:00:00.000Z" });
    expect(onlyEarly.pages_retrieved).toBe(1);
    expect(onlyEarly.window.until).toBe("2026-05-20T16:00:00.000Z");
  });

  test("hidden-page-only telemetry never widens or shifts the window at remote reach", () => {
    // The caller's reach: everything under sub/ is hidden to this view,
    // exactly the predicate the surfaces compose from requestRefView and
    // the gated owner scope.
    const view = (rel: string) => !rel.startsWith("sub/");
    // A hidden-only record BEFORE the visible one, the visible one, and a
    // hidden-only record AFTER it: only the visible record may shape the
    // remote window, from either side.
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-01T00:00:00.000Z",
      host: "fold-test",
      channel: RECALL_CHANNEL.cli,
      mode: "search",
      status: "ok",
      durationMs: 5,
      resultCount: 1,
      topArtifacts: [{ id: "doc-d:0", path: "sub/d.md" }],
    });
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T16:00:00.000Z",
      host: "fold-test",
      channel: RECALL_CHANNEL.cli,
      mode: "search",
      status: "ok",
      durationMs: 5,
      resultCount: 1,
      topArtifacts: [{ id: "doc-a:0", path: "a.md" }],
    });
    emitObservedUse(vault, {
      createdAt: "2026-05-25T23:59:00.000Z",
      host: "fold-test",
      entries: [{ id: "doc-d:1", path: "sub/d.md", verdict: "USED" }],
    });

    const remote = computeDeadWeight(vault, { includePath: view });
    // Counts were already clean: the hidden page drops before totals.
    expect(remote.pages_total).toBe(3);
    expect(remote.pages_retrieved).toBe(1);
    expect(remote.dead.map((d) => d.path)).toEqual(["b.md", "c.md"]);
    // The window rides the same view: the hidden-page records' earlier and
    // later timestamps must not widen or shift it.
    expect(remote.window.since).toBe("2026-05-20T16:00:00.000Z");
    expect(remote.window.until).toBe("2026-05-20T16:00:00.000Z");

    // Owner reach filters nothing, so the owner still sees the full span.
    const owner = computeDeadWeight(vault);
    expect(owner.pages_total).toBe(4);
    expect(owner.window.since).toBe("2026-05-01T00:00:00.000Z");
    expect(owner.window.until).toBe("2026-05-25T23:59:00.000Z");
  });

  test("a vault with no records reports an empty window and everything dead", () => {
    const report = computeDeadWeight(vault);
    expect(report.pages_total).toBe(4);
    expect(report.pages_retrieved).toBe(0);
    expect(report.dead_count).toBe(4);
    expect(report.window.since).toBeNull();
    expect(report.window.until).toBeNull();
    expect(report.gate_caveat.length).toBeGreaterThan(0);
  });

  test("the dead preview is capped while dead_count stays exact", () => {
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T16:00:00.000Z",
      host: "fold-test",
      channel: RECALL_CHANNEL.cli,
      mode: "search",
      status: "ok",
      durationMs: 5,
      resultCount: 1,
      topArtifacts: [{ id: "doc-a:0", path: "a.md" }],
    });
    const report = computeDeadWeight(vault, { deadLimit: 2 });
    expect(report.dead_count).toBe(3);
    expect(report.dead).toEqual([{ path: "b.md" }, { path: "c.md" }]);
  });

  test("the fold is deterministic and emits nothing", () => {
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T16:00:00.000Z",
      host: "fold-test",
      channel: RECALL_CHANNEL.cli,
      mode: "search",
      status: "ok",
      durationMs: 5,
      resultCount: 1,
      topArtifacts: [{ id: "doc-b:0", path: "b.md" }],
    });
    const logBefore = readdirSync(join(vault, "Brain", "log"), {
      recursive: true,
    }).toSorted();
    const first = computeDeadWeight(vault);
    const second = computeDeadWeight(vault);
    expect(second).toEqual(first);
    expect(readdirSync(join(vault, "Brain", "log"), { recursive: true }).toSorted()).toEqual(
      logBefore,
    );
  });
});

/**
 * The emitters spell surfaced pages in more than the vault-relative way
 * the fold originally compared (PR #248 review M10): context packs record
 * `join(dir, name)` - absolute - and a Windows writer leaves backslashes
 * in the spelling; pre-compress records the active page as an absolute
 * path and its preference items as ids only. Every spelling names a page
 * the walk holds, so every one must count as retrieved; an id that names
 * no walked page counts as neither retrieved nor dead and lands in the
 * `unresolved_ids` bucket instead of vanishing.
 */
describe("surfaced spellings beyond the relative one", () => {
  test("a page a context pack surfaces by absolute path is not dead weight", () => {
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T16:00:00.000Z",
      host: "fold-test",
      channel: RECALL_CHANNEL.cli,
      mode: "context_pack",
      status: "ok",
      durationMs: 5,
      resultCount: 1,
      // The shape context-pack.ts emits: `path` is the absolute file path.
      topArtifacts: [{ id: "pref-a:0", path: join(vault, "a.md") }],
    });
    const report = computeDeadWeight(vault);
    expect(report.pages_retrieved).toBe(1);
    expect(report.dead.map((d) => d.path)).toEqual(["b.md", "c.md", "sub/d.md"]);
    expect(report.unresolved_ids).toBe(0);
  });

  test("a backslash-spelled relative path matches the walked page", () => {
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T16:00:00.000Z",
      host: "fold-test",
      channel: RECALL_CHANNEL.cli,
      mode: "search",
      status: "ok",
      durationMs: 5,
      resultCount: 1,
      topArtifacts: [{ id: "doc-d:0", path: "sub\\d.md" }],
    });
    const report = computeDeadWeight(vault);
    expect(report.pages_retrieved).toBe(1);
    expect(report.dead.map((d) => d.path)).toEqual(["a.md", "b.md", "c.md"]);
  });

  test("pre-compress records: the active page by absolute path, items by id", () => {
    writeMd("Brain/active.md", "# Active\n\nthe digest page\n");
    writeMd("Brain/preferences/pref-keep-short.md", "# Keep it short\n\nstatus: confirmed\n");
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T16:00:00.000Z",
      host: "fold-test",
      channel: RECALL_CHANNEL.hook,
      mode: "pre_compress",
      status: "ok",
      durationMs: 5,
      resultCount: 2,
      // The shape pre-compress-pack.ts emits: the active head as an
      // absolute path, each ranked preference item as its id only.
      topArtifacts: [
        { id: "__active__", path: join(vault, "Brain", "active.md") },
        { id: "pref-keep-short" },
      ],
    });
    const report = computeDeadWeight(vault);
    // The walk now holds six pages; the two the pack surfaced count as
    // retrieved, resolved from the absolute path and from the id.
    expect(report.pages_total).toBe(6);
    expect(report.pages_retrieved).toBe(2);
    expect(report.dead.map((d) => d.path)).toEqual(["a.md", "b.md", "c.md", "sub/d.md"]);
    expect(report.unresolved_ids).toBe(0);
  });

  test("an id that names no walked page counts in the unresolved bucket", () => {
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T16:00:00.000Z",
      host: "fold-test",
      channel: RECALL_CHANNEL.hook,
      mode: "pre_compress",
      status: "ok",
      durationMs: 5,
      resultCount: 1,
      topArtifacts: [{ id: "pref-gone" }],
    });
    const report = computeDeadWeight(vault);
    expect(report.pages_retrieved).toBe(0);
    expect(report.dead_count).toBe(4);
    expect(report.unresolved_ids).toBe(1);
  });

  test("an ambiguous stem is unresolved, never a guess between two pages", () => {
    writeMd("sub/a.md", "# A again\n");
    emitRecallTelemetry(vault, {
      createdAt: "2026-05-20T16:00:00.000Z",
      host: "fold-test",
      channel: RECALL_CHANNEL.hook,
      mode: "pre_compress",
      status: "ok",
      durationMs: 5,
      resultCount: 1,
      topArtifacts: [{ id: "a" }],
    });
    const report = computeDeadWeight(vault);
    // Both `a.md` and `sub/a.md` stay dead: the fold does not pick one.
    expect(report.pages_retrieved).toBe(0);
    expect(report.dead_count).toBe(5);
    expect(report.unresolved_ids).toBe(1);
  });
});

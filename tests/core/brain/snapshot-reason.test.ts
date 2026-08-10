/**
 * U7: the typed snapshot reason and the log event that records it.
 *
 * Two histories existed in this codebase and did not join. The Brain
 * event log is richly typed and records a `rollback`; the snapshot family
 * is the only revertible history and every entry in it was an opaque run
 * id plus an mtime. This file pins the join: the reason reaches the
 * sidecar, one `snapshot` event per created recovery point carries it, and
 * the two failure modes that would quietly re-open the gap are refused -
 * a log failure must not cost a recovery point, and an absent reason must
 * not be reconstructed from the run-id prefix that happens to spell it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { createSnapshot, listSnapshots } from "../../../src/core/brain/snapshot.ts";
import { manifestSidecarPath, readManifestSidecar } from "../../../src/core/brain/manifest.ts";
import { readLogDay } from "../../../src/core/brain/log-jsonl.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { BRAIN_LOG_EVENT_KIND, BRAIN_SNAPSHOT_REASON } from "../../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-snap-reason-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-snap-reason-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });

  writeFileSync(
    join(brainDirs(vault).preferences, "pref-foo.md"),
    "---\nkind: brain-preference\n---\n\n## Principle\n\nseed\n",
  );
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/** Every `snapshot` event logged today, across every device shard. */
function loggedSnapshotEvents(): ReadonlyArray<Record<string, unknown>> {
  const today = new Date().toISOString().slice(0, 10);
  return readLogDay(vault, today)
    .entries.filter((e) => e.eventType === BRAIN_LOG_EVENT_KIND.snapshot)
    .map((e) => e.body as Record<string, unknown>);
}

describe("createSnapshot stamps the reason into the sidecar", () => {
  test("the reason reaches the manifest and the listing reads it back", () => {
    const runId = "entity-prune-2026-08-10-070000";
    createSnapshot(vault, runId, { reason: BRAIN_SNAPSHOT_REASON.entityPrune });

    expect(readManifestSidecar(vault, runId)?.snapshot_reason).toBe(
      BRAIN_SNAPSHOT_REASON.entityPrune,
    );
    const listed = listSnapshots(vault).find((s) => s.run_id === runId);
    expect(listed?.reason).toBe(BRAIN_SNAPSHOT_REASON.entityPrune);
  });

  test("every registered reason survives the round trip", () => {
    // Including the three with no producer in this release: the manifest
    // has to be able to read a reason a later release writes, because the
    // snapshots directory replicates to peers running older builds.
    for (const reason of Object.values(BRAIN_SNAPSHOT_REASON)) {
      const runId = `${reason}-roundtrip`;
      createSnapshot(vault, runId, { reason });
      expect(`${reason}: ${readManifestSidecar(vault, runId)?.snapshot_reason}`).toBe(
        `${reason}: ${reason}`,
      );
    }
  });

  test("a sidecar with no reason reads as null, not as the run-id prefix", () => {
    const runId = "dream-2026-08-10-070000";
    createSnapshot(vault, runId, { reason: BRAIN_SNAPSHOT_REASON.dream });
    // Remove the sidecar entirely: the archive now looks exactly like one
    // written before the reason existed, and its run id still begins with
    // a registered reason. Guessing from that prefix would report `dream`
    // for provenance nothing recorded.
    unlinkSync(manifestSidecarPath(vault, runId));

    const listed = listSnapshots(vault).find((s) => s.run_id === runId);
    expect(listed).toBeDefined();
    expect(listed!.reason).toBeNull();
    expect(listed!.manifest_path).toBeNull();
  });

  test("an unregistered reason keeps the record that drift detection needs", () => {
    const runId = "dream-tampered";
    createSnapshot(vault, runId, { reason: BRAIN_SNAPSHOT_REASON.dream });
    const sidecar = manifestSidecarPath(vault, runId);
    const parsed = JSON.parse(readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    writeFileSync(sidecar, JSON.stringify({ ...parsed, snapshot_reason: "spring-cleaning" }));

    // A reason this build does not register is what a LATER build writes,
    // and the vault replicates between machines that need not run the same
    // one. Refusing the whole record would discard the file map with it and
    // send rollback down its no-drift-check path - the silent-overwrite
    // route, reached by a different door. The provenance is unusable and
    // says so; the comparison the rest of the record supports is intact.
    const manifest = readManifestSidecar(vault, runId);
    expect(manifest).not.toBeNull();
    expect(manifest!.snapshot_reason).toBeUndefined();
    expect(manifest!.snapshot_reason_unreadable).toBe(true);
    expect(Object.keys(manifest!.files).length).toBeGreaterThan(0);
    // The listing still refuses to name a provenance it cannot read.
    expect(listSnapshots(vault).find((s) => s.run_id === runId)!.reason).toBeNull();
  });
});

describe("createSnapshot emits exactly one snapshot log event", () => {
  test("the event carries the run id, the reason and the archive size", () => {
    const runId = "upgrade-2026-08-10-070000";
    const res = createSnapshot(vault, runId, { reason: BRAIN_SNAPSHOT_REASON.upgrade });

    const events = loggedSnapshotEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!["run_id"]).toBe(runId);
    expect(events[0]!["reason"]).toBe(BRAIN_SNAPSHOT_REASON.upgrade);
    expect(events[0]!["size_bytes"]).toBe(String(statSync(res.path).size));
  });

  test("two snapshots produce two events, one each", () => {
    createSnapshot(vault, "dream-one", { reason: BRAIN_SNAPSHOT_REASON.dream });
    createSnapshot(vault, "manual-two", { reason: BRAIN_SNAPSHOT_REASON.manual });
    const events = loggedSnapshotEvents();
    expect(events.map((e) => e["run_id"]).toSorted()).toEqual(["dream-one", "manual-two"]);
    expect(events.map((e) => e["reason"]).toSorted()).toEqual(["dream", "manual"]);
  });

  test("a failing log append does not fail the snapshot", () => {
    // Replace the log directory with a regular file so the append cannot
    // create it. The recovery point is the load-bearing artifact and the
    // destructive operation it guards must not be aborted over an audit
    // line, so the failure is a warning and the archive stands.
    const dirs = brainDirs(vault);
    rmSync(dirs.log, { recursive: true, force: true });
    writeFileSync(dirs.log, "not a directory\n");

    const runId = "delete-by-source-logless";
    const res = createSnapshot(vault, runId, { reason: BRAIN_SNAPSHOT_REASON.deleteBySource });

    expect(existsSync(res.path)).toBe(true);
    // The reason still made it into the sidecar: only the audit line was
    // lost, and the manifest is written on its own best-effort path.
    expect(readManifestSidecar(vault, runId)?.snapshot_reason).toBe(
      BRAIN_SNAPSHOT_REASON.deleteBySource,
    );
  });
});

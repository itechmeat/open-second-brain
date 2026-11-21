/**
 * The orphan-session check and `o2b brain orphan-repair` on a switched
 * vault with no `Brain/` tree. The session universe was already read from
 * the store; the signal half walked the legacy inbox folders, so on such a
 * vault it found no observation and the check and the repair answered
 * "nothing orphaned". The signals are store records there: the scan reads
 * them from the signal fold and the repair detaches the reference with a
 * `signal-state` field change, never a file under `Brain/`.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  ORPHAN_SESSION_REF_CODE,
  orphanSessionCheck,
} from "../../../../src/core/brain/doctor/orphan-session-check.ts";
import type { DoctorUncertainEntry } from "../../../../src/core/brain/doctor/report.ts";
import { appendLogEvent } from "../../../../src/core/brain/log.ts";
import {
  detachStoreSessionRef,
  ORPHAN_REPAIR_CONFIRM_PHRASE,
  OrphanRepairStoreUnreadableError,
  runOrphanRepair,
} from "../../../../src/core/brain/link-graph/orphan-repair.ts";
import { writeSignal } from "../../../../src/core/brain/signal.ts";
import { storeSignal } from "../../../../src/core/brain/signal-state.ts";
import type { DoctorIssue } from "../../../../src/core/brain/types.ts";
import { appendRecord } from "../../../../src/core/store/appender.ts";
import { SIGNAL_STATE_KIND } from "../../../../src/core/store/fold-signals.ts";
import { openStore } from "../../../../src/core/store/store-open.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

function observe(vault: string, slug: string, sessionRef: string): string {
  return writeSignal(vault, {
    topic: slug,
    signal: "positive",
    agent: "tester",
    principle: `observation ${slug} keeps its provenance`,
    created_at: "2026-06-01T00:00:00Z",
    date: "2026-06-01",
    slug,
    source_type: "session",
    session_ref: sessionRef,
    raw: "the observation body survives any repair",
  }).id;
}

function orphanIssues(vault: string): DoctorIssue[] {
  const issues: DoctorIssue[] = [];
  const uncertain: DoctorUncertainEntry[] = [];
  orphanSessionCheck.run(
    { vault, now: new Date("2026-06-02T00:00:00Z"), logs: [] } as unknown as Parameters<
      typeof orphanSessionCheck.run
    >[0],
    { issues, uncertain },
  );
  expect(uncertain).toEqual([]);
  return issues.filter((issue) => issue.code === ORPHAN_SESSION_REF_CODE);
}

test("the check names and the repair detaches an orphaned store signal on a vault with no Brain/", () => {
  env = makeStoreEnv("osb-orphan-store-", { legacyTree: false });
  appendLogEvent(env.vault, {
    timestamp: "2026-06-01T10:00:00Z",
    eventType: "session-lifecycle",
    body: { agent: "@tester", event: "SessionStart", session_id: "sess-live" },
  });
  const orphan = observe(env.vault, "orphan-lane", "session:sess-gone#turn-1");
  observe(env.vault, "live-lane", "session:sess-live#turn-1");
  expect(existsSync(join(env.vault, "Brain"))).toBe(false);

  const issues = orphanIssues(env.vault);
  expect(issues.map((issue) => issue.message)).toEqual([
    expect.stringContaining("session:sess-gone#turn-1"),
  ]);

  const plan = runOrphanRepair(env.vault);
  expect(plan.decisions.map((d) => [d.session_ref, d.action])).toEqual([
    ["session:sess-gone#turn-1", "detach"],
  ]);
  const applied = runOrphanRepair(env.vault, {
    apply: true,
    confirm: ORPHAN_REPAIR_CONFIRM_PHRASE,
  });
  expect(applied.detached).toBe(1);
  const kept = storeSignal(orphan);
  expect(kept?.frontmatter["session_ref"]).toBeUndefined();
  expect(kept?.frontmatter["topic"]).toBe("orphan-lane");
  expect(orphanIssues(env.vault)).toEqual([]);
  expect(runOrphanRepair(env.vault).decisions).toEqual([]);
  expect(existsSync(join(env.vault, "Brain"))).toBe(false);
});

test("the repair detaches nothing while a signal lifecycle shard cannot be read", () => {
  env = makeStoreEnv("osb-orphan-store-unseen-", { legacyTree: false });
  appendLogEvent(env.vault, {
    timestamp: "2026-06-01T10:00:00Z",
    eventType: "session-lifecycle",
    body: { agent: "@tester", event: "SessionStart", session_id: "sess-live" },
  });
  const id = observe(env.vault, "relinked-lane", "session:sess-gone#turn-1");
  // A peer relinked the observation to a session that exists.
  const shard = appendRecord(openStore({ root: env.storeRoot, device: "dev-b" }), {
    partition: "shared",
    stream: "events",
    kind: SIGNAL_STATE_KIND,
    agent: "u",
    body: { authority: "human", signal: id, fields: { session_ref: "session:sess-live#turn-2" } },
  }).path;
  expect(storeSignal(id)?.frontmatter["session_ref"]).toBe("session:sess-live#turn-2");
  expect(orphanIssues(env.vault)).toEqual([]);

  // The peer's shard goes missing: the fold shows the older, orphaned
  // reference, so the scan is no proof the reference dangles.
  rmSync(shard);
  const issues: DoctorIssue[] = [];
  const uncertain: DoctorUncertainEntry[] = [];
  orphanSessionCheck.run(
    { vault: env.vault, now: new Date("2026-06-02T00:00:00Z"), logs: [] } as unknown as Parameters<
      typeof orphanSessionCheck.run
    >[0],
    { issues, uncertain },
  );
  expect(issues.filter((issue) => issue.code === ORPHAN_SESSION_REF_CODE)).toEqual([]);
  expect(uncertain.length).toBeGreaterThan(0);
  expect(() =>
    runOrphanRepair(env!.vault, { apply: true, confirm: ORPHAN_REPAIR_CONFIRM_PHRASE }),
  ).toThrow(OrphanRepairStoreUnreadableError);
  expect(storeSignal(id)?.frontmatter["session_ref"]).toBe("session:sess-gone#turn-1");
});

test("the detach writes nothing while the signal fold is incomplete at write time", () => {
  env = makeStoreEnv("osb-orphan-store-detach-", { legacyTree: false });
  const id = observe(env.vault, "gone-lane", "session:sess-gone#turn-1");
  const other = observe(env.vault, "other-lane", "session:sess-gone#turn-2");
  // A peer's lifecycle shard, read once, then gone: whatever it held about
  // this signal is unknown at the moment of the write.
  const shard = appendRecord(openStore({ root: env.storeRoot, device: "dev-b" }), {
    partition: "shared",
    stream: "events",
    kind: SIGNAL_STATE_KIND,
    agent: "u",
    body: { authority: "human", signal: other, fields: { topic: "other-lane" } },
  }).path;
  expect(storeSignal(other)?.frontmatter["topic"]).toBe("other-lane");
  rmSync(shard);

  expect(detachStoreSessionRef(env.vault, id, "session:sess-gone#turn-1")).toBe("skip-incomplete");
  expect(storeSignal(id)?.frontmatter["session_ref"]).toBe("session:sess-gone#turn-1");
});

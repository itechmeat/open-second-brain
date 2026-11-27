/**
 * A write-session open or commit on a switched machine judges a target
 * the store held from the store entry, never from a file left at that
 * path (change `lane-reach-residuals`, package 3, design R3, sequence A9
 * item 1): a remote open answers nothing of a frozen file at a target a
 * private removal removed, and a local `create` or `merge` commit at a
 * removed target neither refuses as an existing target nor carries the
 * file's bytes. An open on a shared entry whose legacy file differs
 * describes the store entry, at either reach: the case only the
 * `validate.ts` edit of package 3 fixes, since the reach guard of package
 * 5 refuses the open at a private removal before the target is described.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { LANE_ENTRY_REMOVE_KIND } from "../../src/core/store/lane-records.ts";
import {
  laneEntryInPrivate,
  lanePageExists,
  readLaneText,
  removeLanePage,
  writeLanePage,
} from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  REGION,
  call,
  callJson,
  localServer,
  server,
} from "./lane-private-partition-reach-writes-fixture.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

function env(): LaneEnv {
  lane = makeLaneEnv("store", "osb-lane-session-target-");
  return lane;
}

const TARGET = "Brain/reports/zqsessiontarget.md";
const FROZEN = "---\nkind: note\n---\n\n# zqfrozenheading\n\nzqfrozenbody of the legacy file.\n";
const ARTIFACT = "---\nkind: note\n---\n\n# zqcommitted\n\nzqcommittedbody.\n";

/**
 * The store entry at `TARGET` is written (held in `private` when
 * `privately`), then removed by a local caller, and a legacy file is left
 * at that path.
 */
function frozenAtRemovedTarget(e: LaneEnv, privately: boolean): void {
  const path = join(e.vault, TARGET);
  writeLanePage(
    e.vault,
    path,
    { kind: "note" },
    privately ? `# held\n\n${REGION}\n` : "# shared\n\nOpen text.\n",
  );
  expect(laneEntryInPrivate(e.vault, path)).toBe(privately);
  removeLanePage(e.vault, path);
  expect(lanePageExists(e.vault, path)).toBe(false);
  const removals = e
    .laneRecords(privately ? "private" : "shared")
    .filter((r) => r.kind === LANE_ENTRY_REMOVE_KIND);
  expect(removals.length).toBeGreaterThan(0);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, FROZEN, "utf8");
}

/** A file left at `TARGET`, a lane path the store has never held a record for. */
function fileAtNeverHeldTarget(e: LaneEnv): void {
  const path = join(e.vault, TARGET);
  expect(e.laneRecords().some((r) => String(r.body["entry"]).includes("zqsessiontarget"))).toBe(
    false,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, FROZEN, "utf8");
}

/**
 * A shared store entry at `TARGET`, written by a local caller, and a
 * legacy file with other text left at that path. Answers the entry's text
 * as the store answers it.
 */
function frozenAtSharedTarget(e: LaneEnv): string {
  const path = join(e.vault, TARGET);
  writeLanePage(e.vault, path, { kind: "note" }, "# zqentryheading\n\nzqentrybody.\n");
  expect(laneEntryInPrivate(e.vault, path)).toBe(false);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, FROZEN, "utf8");
  const text = readLaneText(e.vault, path);
  expect(text).not.toBeNull();
  expect(text).not.toBe(FROZEN);
  return text!;
}

/** The `existing` metadata an open answers for a target whose text is `text`. */
function describedAs(text: string): Record<string, unknown> {
  return {
    bytes: Buffer.byteLength(text, "utf8"),
    content_hash: createHash("sha256").update(text, "utf8").digest("hex"),
    first_heading: "zqentryheading",
  };
}

/** The marks of the frozen file an answer must not carry. */
const FROZEN_MARKS = {
  heading: "zqfrozenheading",
  hash: createHash("sha256").update(FROZEN, "utf8").digest("hex"),
  bytes: `"bytes":${Buffer.byteLength(FROZEN, "utf8")}`,
};

describe("a frozen file at a removed target", () => {
  test("a remote open at a target a private removal removed does not describe the file", async () => {
    const e = env();
    frozenAtRemovedTarget(e, true);
    const answer = await call(server(e), "brain_write_session", {
      op: "open",
      kind: "artifact",
      target: TARGET,
      prompt: "zqremote prompt",
    });
    const flat = answer.replaceAll("\\", "");
    expect(
      Object.entries(FROZEN_MARKS)
        .filter(([, mark]) => flat.includes(mark))
        .map(([k]) => k),
    ).toEqual([]);
  });

  test("a remote open on a shared entry whose legacy file differs describes the entry", async () => {
    const e = env();
    const text = frozenAtSharedTarget(e);
    const opened = await callJson(server(e), "brain_write_session", {
      op: "open",
      kind: "artifact",
      target: TARGET,
      prompt: "zqremote prompt",
    });
    expect(String(opened["session_id"] ?? "")).not.toBe("");
    expect(opened["existing"]).toEqual(describedAs(text));
  });

  test("a local open on a shared entry whose legacy file differs describes the entry", async () => {
    const e = env();
    const text = frozenAtSharedTarget(e);
    const opened = await callJson(localServer(e), "brain_write_session", {
      op: "open",
      kind: "artifact",
      target: TARGET,
      prompt: "zqlocal prompt",
    });
    expect(String(opened["session_id"] ?? "")).not.toBe("");
    expect(opened["existing"]).toEqual(describedAs(text));
  });

  async function commitLocally(e: LaneEnv, intent: "create" | "merge") {
    const local = localServer(e);
    const opened = await callJson(local, "brain_write_session", {
      op: "open",
      kind: "artifact",
      target: TARGET,
      intent,
      prompt: "zqlocal prompt",
    });
    const session = String(opened["session_id"] ?? "");
    expect(session).not.toBe("");
    const submitted = await callJson(local, "brain_write_session", {
      op: "submit",
      session_id: session,
      text: ARTIFACT,
    });
    const committed =
      submitted["status"] === "needs-review"
        ? await callJson(local, "brain_write_session", { op: "approve", session_id: session })
        : submitted;
    const file = existsSync(join(e.vault, TARGET))
      ? readFileSync(join(e.vault, TARGET), "utf8")
      : null;
    const entry = readLaneText(e.vault, join(e.vault, TARGET));
    return { committed, file, entry };
  }

  test("a local create commit at a removed target is not refused as an existing target", async () => {
    const e = env();
    frozenAtRemovedTarget(e, false);
    const { committed, file, entry } = await commitLocally(e, "create");
    process.stdout.write(
      `create commit: status=${String(committed["status"])} file=${JSON.stringify(file)} entry=${JSON.stringify(entry)}\n`,
    );
    expect({
      status: committed["status"],
      refused: JSON.stringify(committed).includes("target-exists"),
    }).toEqual({ status: "done", refused: false });
  });

  test("a local merge commit at a removed target carries none of the file's bytes", async () => {
    const e = env();
    frozenAtRemovedTarget(e, false);
    const { committed, file, entry } = await commitLocally(e, "merge");
    process.stdout.write(
      `merge commit: status=${String(committed["status"])} file=${JSON.stringify(file)} entry=${JSON.stringify(entry)}\n`,
    );
    expect(committed["status"]).toBe("done");
    const written = file === FROZEN ? (entry ?? "") : `${file ?? ""}\n${entry ?? ""}`;
    expect({
      body: written.includes("zqfrozenbody"),
      heading: written.includes("zqfrozenheading"),
      committed: written.includes("zqcommittedbody"),
    }).toEqual({ body: false, heading: false, committed: true });
  });

  test("a local create commit at a target the store never held, over a file left there, is refused as existing", async () => {
    const e = env();
    fileAtNeverHeldTarget(e);
    const { committed, file } = await commitLocally(e, "create");
    expect({
      refused: JSON.stringify(committed).includes("target-exists"),
      file,
    }).toEqual({ refused: true, file: FROZEN });
  });

  test("a local merge commit at a target the store never held merges onto the file left there", async () => {
    const e = env();
    fileAtNeverHeldTarget(e);
    const { committed, file } = await commitLocally(e, "merge");
    expect(committed["status"]).toBe("done");
    expect({
      kept: (file ?? "").includes("zqfrozenbody"),
      marker: (file ?? "").includes("o2b:ws-merge"),
      committed: (file ?? "").includes("zqcommittedbody"),
    }).toEqual({ kept: true, marker: true, committed: true });
  });

  test("local control: a local open at a removed target with no file left opens", async () => {
    const e = env();
    const path = join(e.vault, TARGET);
    writeLanePage(e.vault, path, { kind: "note" }, "# shared\n\nOpen text.\n");
    removeLanePage(e.vault, path);
    const opened = await callJson(localServer(e), "brain_write_session", {
      op: "open",
      kind: "artifact",
      target: TARGET,
      prompt: "zqlocal prompt",
    });
    expect(String(opened["session_id"] ?? "")).not.toBe("");
    expect(JSON.stringify(opened)).not.toContain("zqfrozenheading");
  });
});

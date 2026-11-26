/**
 * Machine maintenance a remote call triggers (prove-lessons): a
 * `resources/read` of `osb://lessons` below local reach with a private
 * dead end and a cold digest cache (claim 13).
 *
 * The test seeds a private dead end and a shared one, removes the cached
 * lessons digest, reads the resource below local reach, and compares: the
 * remote answer carries nothing of the private dead end, and the machine's
 * shared `lessons.md` afterwards still contains its lesson for a local
 * reader. A local read on a twin store is the control.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { compiledDigestPath } from "../../src/core/brain/compiled-digest-path.ts";
import { laneEntryInPrivate, writeLaneText } from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  callJson,
  localServer,
  server,
  AGENT,
  REGION,
} from "./lane-private-partition-reach-writes-fixture.ts";

const PRIVATE_ID = "de-2099-01-01-zqprove-held";
const HELD_APPROACH = "zqprove held approach";
const SHARED_APPROACH = "zqprove shared approach";
const URI = "osb://lessons";

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

async function seeded(prefix: string): Promise<LaneEnv> {
  const e = makeLaneEnv("store", `osb-lane-prove-lessons-${prefix}-`);
  lanes.push(e);
  writeLaneText(
    e.vault,
    join(e.vault, "Brain", "dead-ends", `${PRIVATE_ID}.md`),
    [
      "---",
      "kind: brain-dead-end",
      `id: ${PRIVATE_ID}`,
      "created_at: 2099-01-01T00:00:00Z",
      `agent: ${AGENT}`,
      `approach: ${HELD_APPROACH}`,
      "tags:",
      "  - brain",
      "  - brain/dead-end",
      "---",
      "",
      "## Why it failed",
      "",
      `zqprove held reason ${REGION}`,
      "",
    ].join("\n"),
  );
  const held = join(e.vault, "Brain", "dead-ends", `${PRIVATE_ID}.md`);
  expect(laneEntryInPrivate(e.vault, held)).toBe(true);
  const recorded = await callJson(localServer(e), "brain_dead_ends", {
    operation: "record",
    approach: SHARED_APPROACH,
    reason: "zqprove shared reason",
  });
  expect(recorded["error"]).toBeUndefined();
  return e;
}

/** The cached lessons digest, removed: the next read finds it cold. */
function coolCache(e: LaneEnv): string {
  const path = compiledDigestPath(e.vault, "lessons", e.env.configPath);
  rmSync(path, { force: true });
  expect(existsSync(path)).toBe(false);
  return path;
}

/** The text of a `resources/read` of `URI` on `s`. */
async function read(s: ReturnType<typeof server>): Promise<string> {
  const answer = await s.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "resources/read",
    params: { uri: URI },
  });
  if (answer === null) throw new Error("resources/read gave no answer");
  expect(answer.error).toBeUndefined();
  return String((answer.result as { contents: [{ text: string }] }).contents[0]!.text);
}

describe("a lessons read below local reach with a private dead end and a cold cache", () => {
  test("a remote lessons read carries nothing of the private dead end and the shared digest keeps its lesson", async () => {
    const e = await seeded("remote");
    const cache = coolCache(e);

    const text = await read(server(e));

    const shared = readFileSync(cache, "utf8");
    expect({
      remote_has_shared_lesson: text.includes(SHARED_APPROACH),
      remote_has_held_approach: text.includes(HELD_APPROACH),
      remote_has_held_reason: text.includes(REGION),
      remote_has_held_id: text.includes(PRIVATE_ID),
      cache_written: existsSync(cache),
      cache_has_shared_lesson: shared.includes(SHARED_APPROACH),
      cache_has_held_lesson: shared.includes(HELD_APPROACH),
      cache_has_held_reason: shared.includes(REGION),
    }).toEqual({
      remote_has_shared_lesson: true,
      remote_has_held_approach: false,
      remote_has_held_reason: false,
      remote_has_held_id: false,
      cache_written: true,
      cache_has_shared_lesson: true,
      cache_has_held_lesson: true,
      cache_has_held_reason: false,
    });
  });

  test("a local lessons read carries both lessons", async () => {
    const e = await seeded("local");
    coolCache(e);

    const text = await read(localServer(e));

    expect({
      local_has_shared_lesson: text.includes(SHARED_APPROACH),
      local_has_held_lesson: text.includes(HELD_APPROACH),
    }).toEqual({ local_has_shared_lesson: true, local_has_held_lesson: true });
  });
});

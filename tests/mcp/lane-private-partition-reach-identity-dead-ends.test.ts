/**
 * The trim of the active dead ends below local reach (identity-dead-ends).
 *
 * The lane keeps at most a fixed number of active entries; a record past
 * it archives the oldest ones it may. The trim is maintenance of the lane,
 * so it counts the entries on the fold of every partition whatever the
 * caller's reach, as a local record does; an overflow entry the remote
 * caller cannot read stays where it is, and the remote answer names no
 * archived id. The test seeds a private entry (the newest) and a shared
 * active set one below the cap, then runs one `record` below local reach
 * and the same `record` at local reach on a twin store. The shared set is
 * seeded in one store write, as the records `record` writes; only the
 * calls the assertions are about go through the tool.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { DEAD_END_MAX_ACTIVE, deadEndsDir } from "../../src/core/brain/dead-ends.ts";
import { resolveAgentName } from "../../src/core/config.ts";
import { appendStoreRecords } from "../../src/core/store/dual-write.ts";
import { entryRecord } from "../../src/core/store/lane-entry-store.ts";
import { wholeLaneStoreFold } from "../../src/core/store/lane-fold-cache.ts";
import { laneEntryInPrivate, writeLaneText } from "../../src/core/store/lane-pages.ts";
import { openStore } from "../../src/core/store/store-open.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  callJson,
  localServer,
  server,
  AGENT,
  REGION,
} from "./lane-private-partition-reach-writes-fixture.ts";

const PRIVATE_ID = "de-2099-01-01-zqidentity-newest";

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

async function seeded(): Promise<LaneEnv> {
  const e = makeLaneEnv("store", "osb-lane-identity-dead-ends-");
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
      "approach: zqidentity newest held approach",
      "tags:",
      "  - brain",
      "  - brain/dead-end",
      "---",
      "",
      "## Why it failed",
      "",
      `zqidentity newest held reason ${REGION}`,
      "",
    ].join("\n"),
  );
  expect(laneEntryInPrivate(e.vault, join(e.vault, "Brain", "dead-ends", `${PRIVATE_ID}.md`))).toBe(
    true,
  );
  // The active set is exactly at the cap, the private entry its newest member.
  seedSharedBelowCap(e);
  const listed = await callJson(localServer(e), "brain_dead_ends", { operation: "list" });
  expect({
    error: listed["error"] ?? null,
    entries: (listed["entries"] as unknown[]).length,
    warnings: listed["warnings"],
  }).toEqual({ error: null, entries: DEAD_END_MAX_ACTIVE, warnings: [] });
  return e;
}

/**
 * The shared active set one below the cap, in one store write: the lane
 * records a local `record` writes for each entry (its page, its fields and
 * body, built by the same record builder), one a day from 2020-01-01, so
 * the oldest entry is also the first by id.
 */
function seedSharedBelowCap(e: LaneEnv): void {
  const agent = resolveAgentName(e.env.configPath);
  const records = Array.from({ length: DEAD_END_MAX_ACTIVE - 1 }, (_, i) => {
    const date = new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
    const id = `de-${date}-zqidentity-approach-${i}`;
    const approach = `zqidentity approach ${i}`;
    return entryRecord(
      e.vault,
      join(deadEndsDir(e.vault), `${id}.md`),
      {
        kind: "brain-dead-end",
        id,
        created_at: `${date}T00:00:00Z`,
        agent,
        approach,
        tags: ["brain", "brain/dead-end"],
      },
      `## Approach\n\n${approach}\n\n` +
        `## Why it failed\n\nzqidentity reason ${i}\n\n` +
        `## Context\n\n_(not provided)_\n`,
      false,
    );
  });
  appendStoreRecords(openStore({ root: e.env.storeRoot, device: "dev-a" }), records, {
    vault: e.vault,
    configPath: e.env.configPath,
  });
}

/** Where the dead-end entries sit: the active folder, or its archive, by partition. */
function placement(_e: LaneEnv): Record<string, string[]> {
  const fold = wholeLaneStoreFold();
  const out: Record<string, string[]> = {
    "shared:active": [],
    "shared:archive": [],
    "private:active": [],
    "private:archive": [],
  };
  for (const [key, value] of fold.entries) {
    if (value.lane !== "dead-ends") continue;
    const partition = fold.privateKeys.has(key) ? "private" : "shared";
    const place = value.entry.startsWith("archive/") ? "archive" : "active";
    out[`${partition}:${place}`]!.push(value.entry.replace(/^archive\//, "").replace(/\.md$/, ""));
  }
  for (const key of Object.keys(out)) out[key]!.sort();
  return out;
}

const RECORD = {
  operation: "record",
  approach: "zqidentity newest approach",
  reason: "zqidentity newest reason",
};

/** The id of the oldest shared active entry. */
function oldestShared(_e: LaneEnv): string {
  const fold = wholeLaneStoreFold();
  const shared = [...fold.entries]
    .filter(([key, value]) => value.lane === "dead-ends" && !fold.privateKeys.has(key))
    .map(([, value]) => value.entry.replace(/\.md$/, ""))
    .filter((entry) => !entry.startsWith("archive/"))
    .toSorted();
  return shared[0]!;
}

describe("a record past the cap with a private active entry", () => {
  test("a remote record counts every partition, archives the readable overflow and names nothing", async () => {
    const e = await seeded();
    const oldest = oldestShared(e);
    const privatePath = join(e.vault, "Brain", "dead-ends", `${PRIVATE_ID}.md`);
    const privateBefore = e.laneRecords("private").map((r) => JSON.stringify(r));
    const answer = await callJson(server(e), "brain_dead_ends", RECORD);
    const after = placement(e);
    expect({
      error: answer["error"] ?? null,
      archived_in_answer: "archived" in answer,
      shared_archive: after["shared:archive"],
      shared_active: after["shared:active"]!.length,
      private_active: after["private:active"],
      private_kept: laneEntryInPrivate(e.vault, privatePath),
      private_records: e.laneRecords("private").map((r) => JSON.stringify(r)),
    }).toEqual({
      error: null,
      archived_in_answer: false,
      shared_archive: [oldest],
      shared_active: DEAD_END_MAX_ACTIVE - 1,
      private_active: [PRIVATE_ID],
      private_kept: true,
      private_records: privateBefore,
    });
  });

  test("a local record archives the same oldest entry", async () => {
    const e = await seeded();
    const oldest = oldestShared(e);
    const answer = await callJson(localServer(e), "brain_dead_ends", RECORD);
    const after = placement(e);
    expect({
      error: answer["error"] ?? null,
      archived: answer["archived"] ?? null,
      shared_archive: after["shared:archive"],
      private_active: after["private:active"],
    }).toEqual({
      error: null,
      archived: [oldest],
      shared_archive: [oldest],
      private_active: [PRIVATE_ID],
    });
  });
});

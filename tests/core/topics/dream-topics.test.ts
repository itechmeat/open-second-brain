/**
 * The dream pass runs topic planning before its render (task 3.4): on the
 * view writer the summary lists the topic it created with the command
 * that undoes it, and the render that follows writes the topic's page.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dream } from "../../../src/core/brain/dream.ts";
import { withTopicPass } from "../../../src/core/brain/dream-tail.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { STORE_ROOT_ENV } from "../../../src/core/store/constants.ts";
import type { StoreHandle } from "../../../src/core/store/store-open.ts";
import {
  AUTO_NOW,
  makeAutoViewEnv,
  makeLegacyDreamVault,
  seedWriterStore,
  type AutoViewEnv,
} from "../view/fixtures/auto-env.ts";

let env: AutoViewEnv;
let vault: string;
let store: StoreHandle;

beforeEach(() => {
  env = makeAutoViewEnv("o2b-topics-dream-");
  vault = makeLegacyDreamVault(env.parent);
  store = seedWriterStore(env.root);
});
afterEach(() => env.cleanup());

function seedCluster(on: StoreHandle): void {
  ["s1", "s1", "s2", "s2", "s2"].forEach((session, i) => {
    appendRecord(
      on,
      {
        partition: "shared",
        stream: "events",
        kind: "signal",
        agent: "agent-1",
        body: {
          id: `sig-2026-11-06-c${i}`,
          path: `Brain/inbox/c${i}.md`,
          staged: false,
          frontmatter: {
            principle: `Release notes list every migration step ${i}`,
            project: "o2b",
            session,
          },
          raw: null,
          raw_shape: "bare",
        },
      },
      { now: () => AUTO_NOW - 5_000 + i },
    );
  });
}

describe("topic planning in a dream pass", () => {
  test("the summary lists the created topic with its undo command, and the render writes its page", () => {
    seedCluster(store);
    // The first pass after the claim only waits, in planning and in the
    // render; the second plans, and its render writes the page.
    expect(dream(vault).topics?.report.status).toBe("waiting-for-claim");
    const first = dream(vault);
    const report = first.topics?.report;
    expect(report?.status).toBe("planned");
    if (report?.status !== "planned") return;
    expect(report.created.map((c) => [c.title, c.undo])).toEqual([
      ["Release notes list", `o2b topic undo ${report.created[0]!.record}`],
    ]);
    expect(first.topics?.summary).toContain("1 topic(s) created");
    expect(readdirSync(join(env.view, "topics"))).toHaveLength(1);
  });

  test("the pass reports the change it made, and plans in the store its config names", () => {
    // The store is named by the config file only, not by the environment.
    delete process.env[STORE_ROOT_ENV];
    const config = join(env.parent, "config.yaml");
    writeFileSync(config, `store_root: ${env.root}\n`);
    seedCluster(store);
    expect(dream(vault, { configPath: config }).topics?.report.status).toBe("waiting-for-claim");
    const second = dream(vault, { configPath: config });
    expect(second.topics?.report.status).toBe("planned");
    expect(second.changed).toBe(true);
  });

  test("a pass whose deadline has passed plans no topic", () => {
    seedCluster(store);
    dream(vault); // the claim's wait
    const stub = dream(vault, { dryRun: true });
    const expired = {
      operation: "dream",
      timeoutMs: 1,
      checkpoint: () => {
        throw new Error("deadline passed");
      },
    };
    const out = withTopicPass(stub, { safeguard: expired });
    expect(out.topics).toBeUndefined();
    const records = readPartition(join(env.root, "shared")).flatMap((s) => s.records);
    expect(records.some((r) => r.kind === "topic-create")).toBe(false);
  });

  test("a pass whose deadline passes while it waits for the planning lock writes no topic", () => {
    seedCluster(store);
    dream(vault); // the claim's wait
    const stub = dream(vault, { dryRun: true });
    let asked = 0;
    const expiring = {
      operation: "dream",
      timeoutMs: 1,
      // In time before the lock, past the deadline under it.
      checkpoint: () => {
        asked += 1;
        if (asked > 1) throw new Error("deadline passed");
      },
    };
    const out = withTopicPass(stub, { safeguard: expiring });
    expect(asked).toBe(2);
    expect(out.topics?.report.status).toBe("deferred");
    expect(out.changed).toBe(stub.changed);
    const records = readPartition(join(env.root, "shared")).flatMap((s) => s.records);
    expect(records.some((r) => r.kind === "topic-create")).toBe(false);
  });

  test("the pass plans on the run's own clock: a topic quiet by that date is offered", () => {
    seedCluster(store);
    dream(vault); // the claim's wait
    const first = dream(vault).topics?.report;
    if (first?.status !== "planned") throw new Error(String(first?.status));
    const topic = first.created[0]!.topic;
    const later = new Date(Date.now() + 40 * 86_400_000);
    const out = withTopicPass(dream(vault, { dryRun: true }), { now: later });
    const report = out.topics?.report;
    if (report?.status !== "planned") throw new Error(String(report?.status));
    expect(report.quiet.map((q) => q.topic)).toEqual([topic]);
  });

  test("every undo command names the config the pass ran with", () => {
    delete process.env[STORE_ROOT_ENV];
    const config = join(env.parent, "my config.yaml");
    writeFileSync(config, `store_root: ${env.root}\n`);
    seedCluster(store);
    dream(vault, { configPath: config }); // the claim's wait
    const report = dream(vault, { configPath: config }).topics?.report;
    if (report?.status !== "planned") throw new Error(String(report?.status));
    expect(report.created.map((c) => c.undo)).toEqual([
      `o2b topic undo ${report.created[0]!.record} --config '${config}'`,
    ]);
  });
});

/**
 * Text work and drafts (change `dream-launched-agent`, design D6, D7;
 * spec "Text work is done only by the launched agent", "Text written by a
 * model is a draft until it is applied"; task 5.1).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  answerWork,
  applyAccepted,
  approveWork,
  dreamQueueOn,
  queueStatusAt,
  rejectWork,
  takeWork,
  type DreamQueue,
} from "../../../../src/core/brain/dream-queue/queue.ts";
import { ROLLUP_SUMMARY_OPERATION } from "../../../../src/core/brain/dream-queue/rollup-work.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { appendRecord } from "../../../../src/core/store/appender.ts";
import { SETTING_SET_KIND } from "../../../../src/core/store/constants.ts";
import { shardLockTarget } from "../../../../src/core/store/store-paths.ts";
import { readTopicQuestionState } from "../../../../src/core/topics/decide-operations.ts";
import { produceTopicQuestions } from "../../../../src/core/topics/decide-produce.ts";
import {
  TOPIC_WORDING_OPERATION,
  wordingRejection,
} from "../../../../src/core/topics/wording-operation.ts";
import { parseFrontmatterText } from "../../../../src/core/vault.ts";
import { homeEnv } from "../../../helpers/platform.ts";
import { closedFixture, type ClosedFixture } from "../../topics/fixtures/closed-fixture.ts";
import { agentFixture, type AgentFixture } from "./fixture.ts";
import { readdirSync, statSync } from "node:fs";

let x: AgentFixture;
let f: ClosedFixture;
let q: DreamQueue;

beforeEach(() => {
  x = agentFixture();
  f = x.f;
  bootstrapBrain(f.vault);
  q = dreamQueueOn(f.a, { vault: f.vault, writer: "o2b", now: f.still });
});

afterEach(() => {
  x.cleanup();
});

const NOTE = "---\nkind: rollup\n---\nThe week in one paragraph.\n";

function answerText(subject: string, text: string) {
  const id = x.text(subject);
  const taken = takeWork(q, { run: "t", filter: (i) => i.id === id });
  return {
    id,
    result: answerWork(q, {
      item: id,
      generation: taken.item!.generation,
      lease_token: taken.item!.lease_token,
      text,
      agent: "claude",
      model: "agent-model-1",
    }),
  };
}

function item(id: string) {
  return f.items().find((i) => i.id === id)!;
}

function setDrafts(value: "auto" | "review"): void {
  appendRecord(
    f.a,
    {
      partition: "shared",
      stream: "settings",
      kind: SETTING_SET_KIND,
      agent: "o2b",
      body: { authority: "human", key: "dream.apply_drafts", value },
    },
    { now: f.now },
  );
}

function notePath(subject: string): string {
  return join(f.vault, `Brain/rollups/month/${subject}.md`);
}

describe("the rollup summary", () => {
  test("applied: the note is written with its author; a second apply writes nothing", () => {
    const { id, result } = answerText("w1", NOTE);
    expect(result.status).toBe("accepted");
    expect(applyAccepted(q)).toEqual({ applied: [id], failed: [] });
    const [frontmatter, body] = parseFrontmatterText(readFileSync(notePath("w1"), "utf8"));
    expect(frontmatter).toMatchObject({
      kind: "rollup",
      written_by: "claude",
      written_by_model: "agent-model-1",
      written_by_item: id,
    });
    expect(body).toContain("The week in one paragraph.");
    expect(item(id).applied?.effects).toEqual(["Brain/rollups/month/w1.md"]);
    // A crash between the note and the applied record: the next apply finds it.
    const operation = item(id);
    const before = statSync(notePath("w1")).mtimeMs;
    expect(operation.state).toBe("finished");
    expect(applyAccepted(q).applied).toEqual([]);
    expect(statSync(notePath("w1")).mtimeMs).toBe(before);
  });

  for (const [name, text, reason] of [
    ["no kind", "---\ntitle: x\n---\nBody.\n", "the frontmatter must carry a `kind` key"],
    ["no frontmatter", "Just text.", "the note must open with a YAML frontmatter block"],
    ["an empty body", "---\nkind: rollup\n---\n\n", "the note has no body"],
    ["over the size bound", `---\nkind: rollup\n---\n${"x".repeat(70_000)}\n`, "longer than"],
  ] as const) {
    test(`a note with ${name} is a failed attempt`, () => {
      const { id, result } = answerText(`bad-${name.replaceAll(" ", "-")}`, text);
      expect(result.status).toBe("failed");
      if (result.status === "failed") expect(result.reason).toContain(reason);
      expect(item(id).attempts).toBe(1);
    });
  }

  test("the apply completes while another process holds the store's shard locks", async () => {
    // Warm: one note, so the shards the note creation path appends to exist.
    answerText("warm", NOTE);
    applyAccepted(q);
    const { id } = answerText("w2", NOTE);
    const targets: string[] = [];
    for (const partition of ["shared", "private"] as const) {
      const dir = join(f.a.root, partition);
      const walk = (rel: string): void => {
        for (const name of readdirSync(join(dir, rel))) {
          const path = rel === "" ? name : `${rel}/${name}`;
          if (statSync(join(dir, path)).isDirectory()) walk(path);
          else if (name.endsWith(".jsonl") && !path.startsWith("dream-work")) {
            targets.push(shardLockTarget(f.a.deviceStateDir, partition, path));
          }
        }
      };
      walk("");
    }
    expect(targets.length).toBeGreaterThan(0);
    const holder = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { acquireDirLock } = await import(${JSON.stringify(join(import.meta.dir, "../../../../src/core/store/local-lock.ts"))});
         const { mkdirSync } = await import("node:fs");
         const { dirname } = await import("node:path");
         const targets = ${JSON.stringify(targets)};
         const releases = targets.map((t) => { mkdirSync(dirname(t), { recursive: true }); return acquireDirLock(t, { staleMs: 60000, budgetMs: 5000, label: "test", remedy: "" }); });
         console.log("held");
         await Bun.sleep(1500);
         for (const r of releases) r();`,
      ],
      {
        stdout: "pipe",
        stderr: "inherit",
        env: {
          ...process.env,
          ...homeEnv(join(f.m.parent, "home", "text-work")),
          XDG_CONFIG_HOME: join(f.m.parent, "config"),
          XDG_DATA_HOME: join(f.m.parent, "data"),
          XDG_STATE_HOME: join(f.m.parent, "state", "dev-a"),
          XDG_CACHE_HOME: join(f.m.parent, "cache"),
          LOCALAPPDATA: join(f.m.parent, "state", "dev-a"),
          OPEN_SECOND_BRAIN_CONFIG: f.configPath,
          OPEN_SECOND_BRAIN_STORE_ROOT: f.a.root,
          VAULT_DIR: f.vault,
        },
      },
    );
    const reader = holder.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("held");
    expect(applyAccepted(q).applied).toEqual([id]);
    await holder.exited;
    expect(existsSync(notePath("w2"))).toBe(true);
  }, 30_000);
});

describe("drafts", () => {
  test("auto: a text answer is applied by the next pass", () => {
    setDrafts("auto");
    const { id } = answerText("a1", NOTE);
    expect(item(id).state).toBe("accepted");
    applyAccepted(q);
    expect(item(id).state).toBe("finished");
  });

  test("review: it waits, the listing shows its text, approve applies it", () => {
    setDrafts("review");
    const { id } = answerText("r1", NOTE);
    expect(item(id).state).toBe("awaiting-review");
    expect(applyAccepted(q).applied).toEqual([]);
    expect(existsSync(notePath("r1"))).toBe(false);
    const status = queueStatusAt(f.a.root);
    if (!status.available) throw new Error("no queue");
    expect(status.counts["awaiting-review"]).toBe(1);
    expect(status.items.find((i) => i.id === id)).toMatchObject({
      state: "awaiting-review",
      text: NOTE,
      author: { agent: "claude", model: "agent-model-1" },
    });
    approveWork(q, id);
    expect(item(id).state).toBe("accepted");
    expect(applyAccepted(q).applied).toEqual([id]);
    const [frontmatter] = parseFrontmatterText(readFileSync(notePath("r1"), "utf8"));
    expect(frontmatter["written_by"]).toBe("claude");
  });

  test("review: reject closes the item with the reason and writes nothing", () => {
    setDrafts("review");
    const { id } = answerText("r2", NOTE);
    rejectWork(q, id, "not what happened");
    expect(item(id).state).toBe("closed");
    expect(item(id).closed?.note).toBe("rejected: not what happened");
    applyAccepted(q);
    expect(existsSync(notePath("r2"))).toBe(false);
  });

  test("a closed answer is never held for review", () => {
    setDrafts("review");
    f.seedTopic("Shard compaction keeps monthly shard files small");
    f.signal("Shard compaction thresholds were tuned today");
    produceTopicQuestions(f.queue, readTopicQuestionState(f.a, f.still())!, {
      until: Number.POSITIVE_INFINITY,
      clock: f.still,
    });
    const taken = takeWork(f.queue, {
      run: "t",
      filter: (i) => i.body.operation === "topic-route",
    });
    const options = taken.item!.answer_schema["options"] as string[];
    answerWork(f.queue, {
      item: taken.item!.id,
      generation: taken.item!.generation,
      lease_token: taken.item!.lease_token,
      value: { choice: options[0], confidence: 0.9, provider: "p", model: "m" },
      agent: "decision-model",
      model: "m",
    });
    expect(f.items("topic-route")[0]!.state).toBe("accepted");
  });
});

describe("the wording of a new topic", () => {
  function garden(n: number): string[] {
    return Array.from({ length: n }, (_, i) =>
      f.signal(`Alley garden beds watering notes from meeting ${i}`, { session: `s${i % 2}` }),
    );
  }

  test("produced for every qualifying group, with its topic-new item and after it", () => {
    garden(5);
    produceTopicQuestions(f.queue, readTopicQuestionState(f.a, f.still())!, {
      until: Number.POSITIVE_INFINITY,
      clock: f.still,
    });
    const fresh = f.items("topic-new");
    const wording = f.items(TOPIC_WORDING_OPERATION);
    expect(fresh).toHaveLength(1);
    expect(wording).toHaveLength(1);
    expect(wording[0]!.body.subject).toBe(fresh[0]!.body.subject);
    expect(wording[0]!.body.after).toEqual([fresh[0]!.id]);
    expect(wording[0]!.ready).toBe(false);
    expect(wording[0]!.body.payload["members"]).toHaveLength(5);
    expect(wording[0]!.body.payload["title"]).toBeUndefined();
  });

  test("an answer is a title on one line and a goal, within their bounds", () => {
    expect(wordingRejection({ title: "Alley garden", goal: "Keep the beds watered." })).toBeNull();
    expect(wordingRejection({ title: "", goal: "g" })).not.toBeNull();
    expect(wordingRejection({ title: "a\nb", goal: "g" })).not.toBeNull();
    expect(wordingRejection({ title: "x".repeat(201), goal: "g" })).not.toBeNull();
    expect(wordingRejection({ title: "t", goal: "" })).not.toBeNull();
    expect(wordingRejection({ title: "t", goal: "g".repeat(1001) })).not.toBeNull();
    expect(wordingRejection("Alley garden")).not.toBeNull();
  });

  test("a group that changes supersedes its wording item; one that is gone cancels it", () => {
    const members = garden(5);
    produceTopicQuestions(f.queue, readTopicQuestionState(f.a, f.still())!, {
      until: Number.POSITIVE_INFINITY,
      clock: f.still,
    });
    void members;
    f.signal("Alley garden beds watering notes from meeting six", { session: "s1" });
    produceTopicQuestions(f.queue, readTopicQuestionState(f.a, f.still())!, {
      until: Number.POSITIVE_INFINITY,
      clock: f.still,
    });
    expect(f.items(TOPIC_WORDING_OPERATION)).toHaveLength(2);
  });
});

void ROLLUP_SUMMARY_OPERATION;
void closedFixture;

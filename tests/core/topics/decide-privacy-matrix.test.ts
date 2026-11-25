/**
 * The partition rule of every record a dream-time use writes (design
 * D20, "Partition of a written record"), as one table: for each record
 * kind and each input that can be private (none, the topic, the subject
 * record or note, the item, one other input of the question, a
 * `<private>` region inside an otherwise shared input: the subject, or
 * a side text such as a topic title or a milestone; another subject,
 * or that subject's own topic, which now rides a request of its own; a
 * private head field), the written record lands in `private` whenever
 * any input it was derived from is private, and no shared record the
 * pass writes carries a word taken from a private input. Each cell runs
 * twice: once with private records of the use allowed to leave the
 * machine (they reach the model), once against a hosted provider that
 * may not see them, where an item with any private input waits for a
 * local executor and decides nothing (change `dream-closed-questions`,
 * design D3.7, D4.3). Fake provider, no HTTP, a clock that does not
 * advance on read.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  DecisionModelUse,
  DecisionRequest,
} from "../../../src/core/decision-model/contract.ts";
import {
  decisionThresholdsPath,
  resetThresholdsStoreCache,
  writeThresholdEntry,
} from "../../../src/core/decision-model/thresholds.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import type { StoreRecord } from "../../../src/core/store/envelope.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import type { StoreHandle } from "../../../src/core/store/store-open.ts";
import { newUlid } from "../../../src/core/store/ulid.ts";
import {
  TOPIC_ASSIGN_KIND,
  TOPIC_CREATE_KIND,
  TOPIC_DECISION_KIND,
  TOPIC_GOAL_KIND,
  TOPIC_MILESTONE_KIND,
  TOPIC_QUESTION_KIND,
  TOPIC_RENAME_KIND,
} from "../../../src/core/topics/constants.ts";
import { runDecisionExecutor } from "../../../src/core/brain/dream-queue/decision-executor.ts";
import { answerWork, dreamQueueOn, takeWork } from "../../../src/core/brain/dream-queue/queue.ts";
import { readTopicQuestionState } from "../../../src/core/topics/decide-operations.ts";
import { produceTopicQuestions } from "../../../src/core/topics/decide-produce.ts";
import { bindTestDreamOwner } from "../../helpers/closed-answers.ts";
import { runTopicPlanning } from "../../../src/core/topics/planning.ts";
import { claimSettled, claimViewWriter, readViewWriter } from "../../../src/core/view/writer.ts";
import { FAKE_DECISION_KEY } from "../../helpers/fake-credentials.ts";
import { FakeDecisionProvider } from "../../helpers/fake-decision-provider.ts";
import { makeMachines, type Machines } from "../view/fixtures/machines.ts";

/** The word every private input carries; no shared record may. */
const MARKER = "Halcyon";
const T0 = Date.UTC(2026, 11, 1, 9, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

type Partition = "shared" | "private";
type Variant =
  | "none"
  | "topic"
  | "subject"
  | "item"
  | "evidence"
  | "region"
  | "side-region"
  | "mate"
  | "mate-topic"
  | "withheld-field";
type Share = "may-leave" | "hosted";

let clock = T0;
/** Advances on every read: the seed records get distinct, ordered stamps. */
const tick = (): number => (clock += 1000);
/** Does not advance on read: the decide pass's budget clock. */
const still = (): number => clock;

let m: Machines;
let a: StoreHandle;
let configPath: string;
let seq = 0;

beforeEach(() => {
  clock = T0;
  m = makeMachines(["dev-a"], "o2b-decide-matrix-");
  a = m.open("dev-a");
  claimViewWriter(a, { agent: "dream", now: tick });
  claimSettled(a, readViewWriter(a, tick));
  bindTestDreamOwner(a, tick);
  const tmp = mkdtempSync(join(m.parent, "cfg-"));
  const vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  process.env["VAULT_DIR"] = vault;
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, "");
  resetThresholdsStoreCache();
});

afterEach(() => {
  delete process.env["VAULT_DIR"];
  resetThresholdsStoreCache();
  m.cleanup();
});

// ----- seeding ----------------------------------------------------------------

function topicRecord(
  kind: string,
  topic: string,
  body: Record<string, unknown>,
  partition: Partition = "shared",
): void {
  appendRecord(
    a,
    {
      partition,
      stream: "topics",
      kind,
      agent: "seed",
      topic,
      body: { authority: "agent", ...body },
    },
    { now: tick },
  );
}

function seedTopic(title: string, partition: Partition = "shared"): string {
  const topic = newUlid(tick());
  topicRecord(TOPIC_CREATE_KIND, topic, { title, scope: "project:o2b" }, partition);
  return topic;
}

function signal(text: string, partition: Partition = "shared", session = "s1"): string {
  seq += 1;
  return appendRecord(
    a,
    {
      partition,
      stream: "events",
      kind: "signal",
      agent: "agent-1",
      body: {
        id: `sig-2026-12-01-x${seq}`,
        path: `Brain/inbox/x${seq}.md`,
        staged: false,
        frontmatter: { principle: text, project: "o2b", session },
        raw: null,
        raw_shape: "bare",
      },
    },
    { now: tick },
  ).record.id;
}

function note(text: string, partition: Partition): void {
  const at = T0 - DAY_MS;
  appendRecord(
    a,
    {
      partition,
      stream: "log",
      kind: "log-event",
      agent: "seed",
      body: { timestamp: new Date(at).toISOString(), event_type: "note", body: { text } },
    },
    { now: () => at },
  );
}

/** `text` with the marker as a private record, or in a region, as the variant asks. */
function marked(text: string, own: boolean, variant: Variant): [string, Partition] {
  if (!own) return [text, "shared"];
  if (variant === "region") return [`${text} <private>${MARKER}</private>`, "shared"];
  return [`${text} ${MARKER}`, "private"];
}

/** A shared topic, or the private one the `topic` variant asks for. */
function holdingTopic(variant: Variant): { id: string; partition: Partition } {
  const partition: Partition = variant === "topic" ? "private" : "shared";
  const base = "Shard compaction keeps monthly shard files small";
  const title =
    variant === "topic"
      ? `${base} ${MARKER}`
      : variant === "side-region"
        ? `${base} <private>${MARKER}</private>`
        : base;
  return { id: seedTopic(title, partition), partition };
}

/** A topic of another subject of the same request, private with the marker. */
function mateTopic(): { id: string; partition: Partition } {
  return {
    id: seedTopic(`Kestrel ledger rollup migration ${MARKER}`, "private"),
    partition: "private",
  };
}

/** A private head field of a shared topic whose text carries a region. */
function privateField(topic: string, field: "title" | "goal"): void {
  const value = `Shard compaction plan <private>${MARKER}</private>`;
  topicRecord(
    field === "title" ? TOPIC_RENAME_KIND : TOPIC_GOAL_KIND,
    topic,
    { [field]: value },
    "private",
  );
}

/** A record held by `topic`, assigned by the seed. */
function heldSignal(
  topic: { id: string; partition: Partition },
  text: string,
  own: boolean,
  variant: Variant,
): void {
  const [body, partition] = marked(text, own, variant);
  const record = signal(body, partition);
  const assign: Partition =
    partition === "private" || topic.partition === "private" ? "private" : "shared";
  topicRecord(TOPIC_ASSIGN_KIND, topic.id, { record }, assign);
}

// ----- the record kinds -----------------------------------------------------------

/** The option key of a choice question whose state text lacks the marker, else the first. */
function cleanOption(texts: Record<string, unknown> | undefined, keys: string[]): string {
  const clean = keys.find((key) => !JSON.stringify(texts?.[key] ?? "").includes(MARKER));
  return clean ?? keys[0]!;
}

function optionKeys(req: DecisionRequest, id: string): string[] {
  const q = req.questions[id] as { criteria?: Record<string, unknown> };
  return Object.keys(q.criteria ?? {}).filter((k) => k !== "none");
}

interface Kind {
  readonly name: string;
  readonly use: DecisionModelUse;
  readonly threshold: Record<string, number>;
  /** The stored record kind the use writes. */
  readonly writes: string;
  readonly variants: ReadonlyArray<Variant>;
  /** Variants whose input is never read, so nothing is written. */
  readonly absent?: ReadonlyArray<Variant>;
  /**
   * The partitions of every decided record, for the cells whose request
   * holds a second subject or whose input the egress rule withholds.
   */
  readonly cells?: Partial<Record<Variant, Record<Share, Partition[]>>>;
  /**
   * The partitions of every decided record under a hosted provider: an
   * item with any private input is private as a whole and waits for a
   * local executor (`[]`; change `dream-closed-questions`, design D3.7).
   */
  readonly hosted?: Partial<Record<Variant, Partition[]>>;
  seed(variant: Variant): void;
  answer(id: string, req: DecisionRequest): number | string | undefined;
}

const KINDS: ReadonlyArray<Kind> = [
  {
    name: "route assign",
    use: "topic_route",
    threshold: { route_min: 0.5 },
    writes: TOPIC_ASSIGN_KIND,
    // An item with any private input (the topic, the subject, an option,
    // a region, a private head field) waits for a local executor.
    hosted: { topic: [], subject: [], region: [], evidence: [], "side-region": [] },
    variants: [
      "none",
      "topic",
      "subject",
      "evidence",
      "region",
      "side-region",
      "mate",
      "mate-topic",
      "withheld-field",
    ],
    // One request per item: another subject never rides this one's.
    cells: {
      mate: { "may-leave": ["shared", "private"], hosted: ["shared"] },
      "mate-topic": { "may-leave": ["shared", "private"], hosted: ["shared"] },
      "withheld-field": { "may-leave": ["private"], hosted: [] },
    },
    seed(variant) {
      const topic = holdingTopic(variant);
      if (variant === "evidence") {
        seedTopic(`Shard compaction ${MARKER} acquisition window`, "private");
      }
      if (variant === "withheld-field") privateField(topic.id, "goal");
      if (variant === "mate")
        signal(`Shard compaction rollup thresholds ${MARKER} tuned`, "private");
      if (variant === "mate-topic") {
        mateTopic();
        signal("Kestrel ledger rollup migration started");
      }
      const [text, partition] = marked(
        "Shard compaction thresholds were tuned today",
        variant === "subject" || variant === "region",
        variant,
      );
      signal(text, partition);
    },
    answer(id, req) {
      if (!id.startsWith("route_")) return undefined;
      const topics = (req.state as { topics?: Record<string, unknown> }).topics;
      return cleanOption(topics, optionKeys(req, id));
    },
  },
  {
    name: "derived item",
    use: "event_kind",
    threshold: { kind_min: 0.5 },
    writes: TOPIC_DECISION_KIND,
    // An item with any private input waits for a local executor.
    hosted: { topic: [], subject: [], region: [], evidence: [], "side-region": [] },
    variants: [
      "none",
      "topic",
      "subject",
      "evidence",
      "region",
      "side-region",
      "mate",
      "mate-topic",
      "withheld-field",
    ],
    // One request per item: another subject never rides this one's.
    cells: {
      mate: { "may-leave": ["shared", "private"], hosted: ["shared"] },
      "mate-topic": { "may-leave": ["shared", "private"], hosted: ["shared"] },
      "withheld-field": { "may-leave": ["private"], hosted: [] },
    },
    seed(variant) {
      const topic = holdingTopic(variant);
      if (variant === "withheld-field") privateField(topic.id, "title");
      if (variant === "mate") {
        heldSignal(topic, "Shard compaction rollup thresholds were decided", true, "subject");
      }
      if (variant === "mate-topic") {
        heldSignal(mateTopic(), "Kestrel ledger rollup migration decided", false, "none");
      }
      if (variant === "evidence") {
        // A private rename of the shared topic: its title rides the question.
        topicRecord(
          TOPIC_RENAME_KIND,
          topic.id,
          { title: `Shard compaction ${MARKER} plan` },
          "private",
        );
      }
      heldSignal(
        topic,
        "Shard compaction window decided: the nightly one ships first",
        variant === "subject" || variant === "region",
        variant,
      );
    },
    answer: (id) => (id.startsWith("kind_") ? "decision" : undefined),
  },
  {
    name: "resolution proposal",
    use: "question_resolved",
    threshold: { resolved_min: 0.5 },
    writes: "question-resolved",
    hosted: { topic: [], subject: [], item: [], evidence: [], region: [] },
    variants: ["none", "topic", "subject", "item", "evidence", "region", "withheld-field"],
    // One request per record: no other subject rides it.
    cells: { "withheld-field": { "may-leave": ["private"], hosted: [] } },
    seed(variant) {
      const topic = holdingTopic(variant);
      if (variant === "withheld-field") privateField(topic.id, "title");
      const [question, qPartition] = marked(
        "Which compaction window ships first",
        variant === "item" || variant === "region",
        variant,
      );
      topicRecord(
        TOPIC_QUESTION_KIND,
        topic.id,
        { item: "q-window", text: question },
        topic.partition === "private" ? "private" : qPartition,
      );
      if (variant === "evidence") {
        topicRecord(
          TOPIC_QUESTION_KIND,
          topic.id,
          { item: "q-other", text: `Does the ${MARKER} deal move the compaction window` },
          "private",
        );
      }
      heldSignal(
        topic,
        "Shard compaction window answered: the nightly one ships first",
        variant === "subject",
        variant,
      );
    },
    answer(id, req) {
      if (!id.startsWith("answers_")) return undefined;
      const questions = (req.state as { questions?: Record<string, unknown> }).questions;
      return cleanOption(questions, optionKeys(req, id));
    },
  },
  {
    name: "completion proposal",
    use: "milestone_done",
    threshold: { done_min: 0.5 },
    writes: "milestone-done",
    hosted: { topic: [], item: [], evidence: [], region: [], "side-region": [] },
    variants: ["none", "topic", "item", "evidence", "region", "side-region"],
    seed(variant) {
      // A region in the milestone text here, not in the topic title.
      const topic = holdingTopic(variant === "side-region" ? "none" : variant);
      const [milestone, mPartition] =
        variant === "side-region"
          ? marked("Ship the first compaction window", true, "region")
          : marked("Ship the first compaction window", variant === "item", variant);
      topicRecord(
        TOPIC_MILESTONE_KIND,
        topic.id,
        { item: "m-window", text: milestone },
        topic.partition === "private" ? "private" : mPartition,
      );
      heldSignal(
        topic,
        "Shard compaction window shipped and the rollup ledger closed",
        variant === "evidence" || variant === "region",
        variant,
      );
    },
    answer: (id) => (id.startsWith("done_") ? 0.95 : undefined),
  },
  {
    name: "history verdict",
    use: "human_readable",
    threshold: { hide_below: 0.3 },
    writes: "history-verdict",
    variants: ["none", "subject", "region"],
    // A private note is never read; a note with a region is never asked.
    absent: ["subject", "region"],
    seed(variant) {
      const [text, partition] = marked(
        "Routine heartbeat of the nightly compaction job",
        variant !== "none",
        variant,
      );
      note(text, partition);
    },
    answer: (id) => (id.startsWith("history_") ? 0.1 : undefined),
  },
  {
    name: "topic create",
    use: "topic_new",
    threshold: { veto_below: 0.3 },
    writes: TOPIC_CREATE_KIND,
    // A group of private records waits for a local executor: its item is
    // private as a whole (change dream-closed-questions D3.7). Private
    // records group apart from shared ones, so every member is private here.
    hosted: { subject: [], region: [] },
    variants: ["none", "subject", "region"],
    seed(variant) {
      const texts = [
        "Deprecation windows for the public API start next quarter",
        "Deprecation windows for the public API were drafted",
        "Deprecation windows for the public API got reviewed",
        "Deprecation windows for the public API were approved",
        "Deprecation windows for the public API announced today",
      ];
      texts.forEach((text, i) => {
        const [body, partition] = marked(text, variant !== "none", variant);
        signal(body, partition, i < 2 ? "s1" : "s2");
      });
    },
    answer: (id) => (id.startsWith("new_") ? 0.9 : undefined),
  },
];

function envFor(kind: Kind, share: Share): Record<string, string | undefined> {
  return {
    OPEN_SECOND_BRAIN_DECISION_MODEL_ENABLED: "true",
    OPEN_SECOND_BRAIN_DECISION_MODEL_PROVIDER: "compatible",
    OPEN_SECOND_BRAIN_DECISION_MODEL_BASE_URL: "https://decide.invalid/v1",
    OPEN_SECOND_BRAIN_DECISION_MODEL_ID: "decide-model",
    OPEN_SECOND_BRAIN_DECISION_MODEL_ENV_KEY: "O2B_TEST_DECIDE_KEY",
    OPEN_SECOND_BRAIN_DECISION_MODEL_USES: `${kind.use}:enforce`,
    O2B_TEST_DECIDE_KEY: FAKE_DECISION_KEY,
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    ...(share === "may-leave" ? { OPEN_SECOND_BRAIN_DECISION_MODEL_PRIVATE_USES: kind.use } : {}),
  };
}

/** The records the pass wrote (agent `dream`) in `partition`. */
function written(partition: Partition): StoreRecord[] {
  return readPartition(join(m.root("dev-a"), partition))
    .flatMap((s) => s.records)
    .filter((r) => r.agent === "dream");
}

/** The partitions holding the record the use decided (it carries a verdict). */
function decidedIn(kind: Kind): Partition[] {
  return (["shared", "private"] as const).flatMap((partition) =>
    written(partition)
      .filter((r) => r.kind === kind.writes && r.body["verdict"] !== undefined)
      .map(() => partition),
  );
}

describe("the partition of every record a dream-time use writes", () => {
  for (const kind of KINDS) {
    for (const variant of kind.variants) {
      for (const share of ["may-leave", "hosted"] as const) {
        test(`${kind.name}, private input: ${variant}, ${share}`, async () => {
          kind.seed(variant);
          writeThresholdEntry(decisionThresholdsPath(configPath), "decide-model", kind.use, {
            values: kind.threshold,
            source: "set",
          });
          resetThresholdsStoreCache();
          const fake = new FakeDecisionProvider({ answer: kind.answer, probability: 0.95 });
          const queue = dreamQueueOn(a, { vault: null, writer: "dream", now: still });
          produceTopicQuestions(queue, readTopicQuestionState(a, still())!, {
            until: Number.POSITIVE_INFINITY,
            clock: still,
          });
          await runDecisionExecutor(queue, {
            until: Number.POSITIVE_INFINITY,
            clock: still,
            provider: fake,
            env: envFor(kind, share),
          });
          runTopicPlanning(a, { agent: "dream", now: tick });
          // An approved group waits for its wording: the launched agent
          // words it (change `dream-launched-agent`) and the next pass creates it.
          for (;;) {
            const taken = takeWork(queue, {
              run: "word",
              filter: (item) => item.body.operation === "topic-wording",
            });
            if (taken.item === null) break;
            answerWork(queue, {
              item: taken.item.id,
              generation: taken.item.generation,
              lease_token: taken.item.lease_token,
              value: { title: "Public API deprecation windows", goal: "Plan the deprecation." },
              agent: "claude",
              model: "agent-model-1",
            });
            runTopicPlanning(a, { agent: "dream", now: tick });
          }

          // No shared record the pass wrote carries a private input's word.
          for (const record of written("shared")) {
            expect(JSON.stringify(record.body)).not.toContain(MARKER);
          }
          // A region's text never leaves, whatever the egress rule allows.
          if (variant === "region" || variant === "side-region") {
            expect(JSON.stringify(fake.requests)).not.toContain(MARKER);
          }
          if (share === "hosted") expect(JSON.stringify(fake.requests)).not.toContain(MARKER);
          const cell = kind.cells?.[variant]?.[share];
          if (cell !== undefined) {
            expect(decidedIn(kind)).toEqual(cell);
            return;
          }
          if (share === "hosted") {
            // Every hosted cell names its partitions: the text checks
            // above cannot see a shared verdict that holds only private
            // record identifiers.
            const expected: Partition[] | undefined =
              variant === "none"
                ? ["shared"]
                : kind.absent?.includes(variant)
                  ? []
                  : kind.hosted?.[variant];
            expect(expected).toBeDefined();
            expect(decidedIn(kind)).toEqual(expected!);
            return;
          }
          const expected: Partition[] = kind.absent?.includes(variant)
            ? []
            : [variant === "none" ? "shared" : "private"];
          expect(decidedIn(kind)).toEqual(expected);
        });
      }
    }
  }
});

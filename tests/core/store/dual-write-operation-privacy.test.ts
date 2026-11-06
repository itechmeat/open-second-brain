/**
 * One privacy verdict per write operation: every brain store record one
 * writer operation produces (the main record, the split preference
 * records, the log event, the evidence record, the idempotency receipt)
 * lands in ONE partition. Checked for every operation kind against every
 * trigger that makes an operation private, plus an all-open control:
 *
 *  - `target`: the page the operation writes or is about is private;
 *  - `link`: a content field links a private page;
 *  - `region`: a content field carries a `<private>` region.
 *
 * A second suite walks every string field of each operation's caller
 * input and puts a region, then a private link, into each one in turn,
 * so a caller field the verdict does not read fails by name.
 *
 * A third suite runs every private cell again on a machine WITHOUT the
 * `private` partition: none of the operation's records may reach `shared`
 * (they are refused instead), whatever stream they belong to.
 *
 * The records an operation wrote are the ones present after it and absent
 * before it, across both partitions and every stream (events, log,
 * ledgers, receipts, anything a writer down the call chain appends), not
 * only the kinds a case names. Every test runs against its own temp
 * HOME, state base, vault and store root under one named parent, removed
 * in teardown.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { appendApplyEvidence } from "../../../src/core/brain/apply-evidence.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { appendBrainNote } from "../../../src/core/brain/note.ts";
import { logShardPath } from "../../../src/core/brain/paths.ts";
import { setPinned } from "../../../src/core/brain/pin.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { applyWriteBatch, WriteBatchError } from "../../../src/core/brain/write-batch.ts";
import { createNote } from "../../../src/core/brain/notes/create-note.ts";
import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import { STORE_DUAL_WRITE_ENV, STORE_ROOT_ENV } from "../../../src/core/store/constants.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { initStore } from "../../../src/core/store/store-init.ts";

const ENV_KEYS = [
  STORE_DUAL_WRITE_ENV,
  STORE_ROOT_ENV,
  "O2B_DEVICE_ID",
  "HOME",
  "XDG_STATE_HOME",
  "LOCALAPPDATA",
  "OPEN_SECOND_BRAIN_CONFIG",
  "VAULT_AGENT_NAME",
] as const;

let parent: string;
let vault: string;
let storeRoot: string;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  parent = mkdtempSync(join(tmpdir(), "osb-operation-privacy-"));
  vault = join(parent, "vault");
  storeRoot = join(parent, "store");
  mkdirSync(vault, { recursive: true });
  bootstrapBrain(vault);
  process.env["HOME"] = join(parent, "home");
  process.env["XDG_STATE_HOME"] = join(parent, "state");
  process.env["LOCALAPPDATA"] = join(parent, "state");
  process.env[STORE_ROOT_ENV] = storeRoot;
  process.env["O2B_DEVICE_ID"] = "dev-a";
  process.env[STORE_DUAL_WRITE_ENV] = "1";
  delete process.env["VAULT_AGENT_NAME"];
  const config = join(parent, "config.yaml");
  writeFileSync(config, `vault: ${JSON.stringify(vault)}\nagent_name: agent-self\n`);
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = config;
  initStore({ root: storeRoot });
  writePage("Notes/secret.md", "visibility: [private]");
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

type Partition = "shared" | "private";

function writePage(rel: string, frontmatter: string): void {
  const abs = join(vault, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `---\n${frontmatter}\n---\n\nbody\n`);
}

/** Every record of the store, as `partition:kind:checksum-ish` keys. */
function snapshot(): Map<string, Partition> {
  const out = new Map<string, Partition>();
  for (const partition of ["shared", "private"] as const) {
    for (const shard of readPartition(join(storeRoot, partition))) {
      shard.records.forEach((record, index) => {
        out.set(`${partition}:${shard.rel}:${index}:${record.kind}`, partition);
      });
    }
  }
  return out;
}

/** The partition and kind of every record `operation` added. */
function recordsOf(operation: () => unknown): Array<{ partition: Partition; kind: string }> {
  const before = snapshot();
  operation();
  const added: Array<{ partition: Partition; kind: string }> = [];
  for (const [key, partition] of snapshot()) {
    if (!before.has(key)) added.push({ partition, kind: key.split(":").at(-1)! });
  }
  return added;
}

function seedPreference(slug: string, extra: Record<string, unknown> = {}): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `principle ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-30T00:00:00Z",
    status: "confirmed",
    confirmed_at: "2026-05-02T00:00:00Z",
    evidenced_by: [],
    confidence: "high",
    ...extra,
  });
}

type Trigger = "open" | "target" | "link" | "region" | "identity";

/** Per trigger: the field values that make the operation private. */
const TEXT: Record<Trigger, string> = {
  open: "a plain line",
  target: "a plain line",
  link: "see [[Notes/secret]] for the details",
  region: "met <private>the landlord</private> today",
  identity: "a plain line",
};

/**
 * The writer identity (`agent`, `owner`) an operation carries: a private
 * link under the `identity` trigger, a realistic agent name otherwise, so
 * every open control proves a plain identity names nothing private.
 */
function identity(trigger: Trigger): string {
  return trigger === "identity" ? "[[Notes/secret]]" : "@claude-devbox-agent";
}

interface Case {
  /** Triggers this operation kind can carry. */
  readonly triggers: ReadonlyArray<Trigger>;
  /** Seeds what the operation needs; its records are not the operation's. */
  readonly seed?: (trigger: Trigger) => void;
  /** Runs the operation. */
  readonly run: (trigger: Trigger) => void;
  /** Kinds of record the operation writes, at least. */
  readonly minRecords: number;
  /**
   * The operation writes a record that goes to `private` whenever this
   * machine holds it (a permissions decision row), so its open control
   * runs on a machine without `private`, where all of it lands in `shared`.
   */
  readonly heldPrivateRecord?: true;
}

/**
 * Turn the owner-write gate to `warn`: a note naming a foreign `owner`
 * is written, and the gate appends one decision row for it.
 */
function watchOwnerWrites(): void {
  appendFileSync(brainConfigPath(vault), "\nintegrity:\n  owner_scope_writes: warn\n");
}

let counter = 0;
function nextKey(): string {
  counter += 1;
  return `k-${counter}`;
}

const CASES: Record<string, Case> = {
  "signal write (raw)": {
    triggers: ["open", "link", "region", "identity"],
    minRecords: 2,
    run: (trigger) => {
      writeSignal(vault, {
        topic: "plain-topic",
        signal: "positive",
        agent: identity(trigger),
        principle: "keep it short",
        created_at: "2026-11-06T10:00:00Z",
        date: "2026-11-06",
        slug: "plain-topic",
        raw: TEXT[trigger],
        idempotency_key: nextKey(),
      });
    },
  },
  "signal write (principle)": {
    triggers: ["open", "link", "region"],
    minRecords: 2,
    run: (trigger) => {
      writeSignal(vault, {
        topic: "plain-topic",
        signal: "positive",
        agent: identity(trigger),
        principle: TEXT[trigger],
        created_at: "2026-11-06T10:00:00Z",
        date: "2026-11-06",
        slug: "plain-topic",
        idempotency_key: nextKey(),
      });
    },
  },
  "signal write (source)": {
    triggers: ["open", "link"],
    minRecords: 2,
    run: (trigger) => {
      writeSignal(vault, {
        topic: "plain-topic",
        signal: "positive",
        agent: identity(trigger),
        principle: "keep it short",
        created_at: "2026-11-06T10:00:00Z",
        date: "2026-11-06",
        slug: "plain-topic",
        source: [trigger === "link" ? "[[Notes/secret]]" : "[[Notes/open]]"],
        idempotency_key: nextKey(),
      });
    },
  },
  "preference write (human split)": {
    triggers: ["open", "target", "link", "region"],
    minRecords: 3,
    run: (trigger) => {
      writePreference(
        vault,
        {
          slug: "rule",
          topic: "rule",
          principle: TEXT[trigger],
          created_at: "2026-05-01T00:00:00Z",
          unconfirmed_until: "2026-05-30T00:00:00Z",
          status: "confirmed",
          confirmed_at: "2026-05-02T00:00:00Z",
          evidenced_by: [],
          confidence: "high",
          idempotency_key: nextKey(),
          ...(trigger === "target" ? { visibility: ["private"] } : {}),
        },
        { authority: "human" },
      );
    },
  },
  "preference write (owner)": {
    triggers: ["open", "identity"],
    minRecords: 2,
    run: (trigger) => {
      writePreference(vault, {
        slug: "rule",
        topic: "rule",
        principle: "keep it short",
        created_at: "2026-05-01T00:00:00Z",
        unconfirmed_until: "2026-05-30T00:00:00Z",
        status: "confirmed",
        confirmed_at: "2026-05-02T00:00:00Z",
        evidenced_by: [],
        confidence: "high",
        owner: identity(trigger),
        idempotency_key: nextKey(),
      });
    },
  },
  "preference write (evidenced_by)": {
    triggers: ["open", "link"],
    minRecords: 2,
    run: (trigger) => {
      writePreference(vault, {
        slug: "rule",
        topic: "rule",
        principle: "keep it short",
        created_at: "2026-05-01T00:00:00Z",
        unconfirmed_until: "2026-05-30T00:00:00Z",
        status: "confirmed",
        confirmed_at: "2026-05-02T00:00:00Z",
        evidenced_by: [trigger === "link" ? "[[Notes/secret]]" : "[[Notes/open]]"],
        confidence: "high",
        idempotency_key: nextKey(),
      });
    },
  },
  "apply_evidence (artifact)": {
    triggers: ["open", "target", "link", "region", "identity"],
    minRecords: 3,
    seed: (trigger) =>
      seedPreference("rule", trigger === "target" ? { visibility: ["private"] } : {}),
    run: (trigger) => {
      appendApplyEvidence(vault, {
        pref_id: "pref-rule",
        artifact: trigger === "region" ? "[[src/main.ts]]" : TEXT[trigger],
        result: "applied",
        agent: identity(trigger),
        ...(trigger === "region" ? { note: TEXT.region } : {}),
        idempotency_key: nextKey(),
      });
    },
  },
  brain_note: {
    triggers: ["open", "link", "region", "identity"],
    minRecords: 1,
    run: (trigger) => {
      appendBrainNote({ vault, text: TEXT[trigger], agent: identity(trigger) });
    },
  },
  write_batch: {
    triggers: ["open", "target", "link", "region", "identity"],
    minRecords: 4,
    seed: (trigger) => {
      seedPreference("open-rule");
      seedPreference("rule", trigger === "target" ? { visibility: ["private"] } : {});
    },
    run: (trigger) => {
      applyWriteBatch(
        vault,
        [
          {
            kind: "append_log_line",
            input: { text: "a plain line first", agent: identity(trigger) },
          },
          {
            kind: "apply_evidence",
            input: {
              pref_id: "pref-open-rule",
              artifact: "[[src/main.ts]]",
              result: "applied",
              agent: identity(trigger),
            },
          },
          {
            kind: "apply_evidence",
            input: {
              pref_id: "pref-rule",
              artifact: "[[src/other.ts]]",
              result: "applied",
              agent: identity(trigger),
            },
          },
          {
            kind: "append_log_line",
            input: { text: TEXT[trigger], agent: identity(trigger) },
          },
        ],
        { requestId: nextKey() },
      );
    },
  },
  "write_batch (private note page)": {
    triggers: ["open", "target"],
    minRecords: 2,
    run: (trigger) => {
      applyWriteBatch(
        vault,
        [
          {
            kind: "append_log_line",
            input: { text: "a plain line first", agent: identity(trigger) },
          },
          {
            kind: "create_note",
            path: "Notes/new.md",
            frontmatter: trigger === "target" ? { visibility: ["private"] } : { title: "new" },
            content: "plain body",
          },
        ],
        { requestId: nextKey() },
      );
    },
  },
  "preference write (watched foreign owner on a private page)": {
    triggers: ["open", "target"],
    minRecords: 3,
    heldPrivateRecord: true,
    seed: () => watchOwnerWrites(),
    run: (trigger) => {
      writePreference(vault, {
        slug: "rule",
        topic: "rule",
        principle: "keep it short",
        created_at: "2026-05-01T00:00:00Z",
        unconfirmed_until: "2026-05-30T00:00:00Z",
        status: "confirmed",
        confirmed_at: "2026-05-02T00:00:00Z",
        evidenced_by: [],
        confidence: "high",
        owner: "agent-cross-owner",
        idempotency_key: nextKey(),
        ...(trigger === "target" ? { visibility: ["private"] } : {}),
      });
    },
  },
  "write_batch (watched foreign owner on a private note)": {
    triggers: ["open", "target"],
    minRecords: 3,
    heldPrivateRecord: true,
    seed: () => watchOwnerWrites(),
    run: (trigger) => {
      applyWriteBatch(
        vault,
        [
          {
            kind: "create_note",
            path: "Notes/owned.md",
            frontmatter: {
              owner: "agent-cross-owner",
              ...(trigger === "target" ? { visibility: ["private"] } : {}),
            },
            content: "plain body",
          },
        ],
        { requestId: nextKey() },
      );
    },
  },
  "create_note (watched foreign owner on a private note)": {
    triggers: ["open", "target"],
    minRecords: 2,
    heldPrivateRecord: true,
    seed: () => watchOwnerWrites(),
    run: (trigger) => {
      createNote(vault, {
        path: "Notes/owned.md",
        frontmatter: {
          owner: "agent-cross-owner",
          ...(trigger === "target" ? { visibility: ["private"] } : {}),
        },
        content: "plain body",
      });
    },
  },
  pin: {
    triggers: ["open", "target", "link", "region"],
    minRecords: 2,
    seed: (trigger) =>
      seedPreference("rule", {
        principle: TEXT[trigger],
        ...(trigger === "target" ? { visibility: ["private"] } : {}),
      }),
    run: () => {
      setPinned(vault, "pref-rule", true, { agent: identity("open") });
    },
  },
};

describe("one privacy verdict per write operation", () => {
  for (const [name, c] of Object.entries(CASES)) {
    for (const trigger of c.triggers) {
      const expected: Partition = trigger === "open" ? "shared" : "private";
      test(`${name}, ${trigger}: every record lands in ${expected}`, () => {
        writePage("Notes/open.md", "title: open");
        c.seed?.(trigger);
        if (trigger === "open" && c.heldPrivateRecord === true) {
          rmSync(join(storeRoot, "private"), { recursive: true, force: true });
        }
        const added = recordsOf(() => c.run(trigger));
        expect(added.length).toBeGreaterThanOrEqual(c.minRecords);
        expect(added.filter((r) => r.partition !== expected)).toEqual([]);
      });
    }
  }
});

describe("a private operation on a machine without the private partition", () => {
  for (const [name, c] of Object.entries(CASES)) {
    for (const trigger of c.triggers) {
      if (trigger === "open") continue;
      test(`${name}, ${trigger}: no record of the operation reaches shared`, () => {
        writePage("Notes/open.md", "title: open");
        c.seed?.(trigger);
        rmSync(join(storeRoot, "private"), { recursive: true, force: true });
        const added = recordsOf(() => c.run(trigger));
        expect(added).toEqual([]);
      });
    }
  }
});

describe("the operation verdict is final for its receipt", () => {
  test("a page turned private between verdict and receipt keeps the operation in one partition", () => {
    // The evidence call judges its preference and its event, both open,
    // and writes its log event under that verdict. The daily log page its
    // receipt names is private by the time the receipt is written (another
    // writer reserved it): the receipt still follows the operation.
    seedPreference("rule");
    const day = new Date().toISOString().slice(0, 10);
    const shard = logShardPath(vault, day, "dev-a");
    writePage(relative(vault, shard), "visibility: [private]");
    const added = recordsOf(() =>
      appendApplyEvidence(vault, {
        pref_id: "pref-rule",
        artifact: "[[src/main.ts]]",
        result: "applied",
        agent: identity("open"),
        idempotency_key: nextKey(),
      }),
    );
    expect(added.length).toBeGreaterThanOrEqual(3);
    expect(new Set(added.map((r) => r.partition)).size).toBe(1);
  });
});

describe("a malformed batch is refused by index before any privacy judge", () => {
  const MALFORMED: Record<string, ReadonlyArray<unknown>> = {
    "a null operation": [null],
    "an append_log_line without input": [{ kind: "append_log_line" }],
  };
  for (const dual of ["off", "on"] as const) {
    for (const [name, operations] of Object.entries(MALFORMED)) {
      test(`${name}, dual write ${dual}: indexed WriteBatchError, nothing written`, () => {
        if (dual === "off") delete process.env[STORE_DUAL_WRITE_ENV];
        const added = recordsOf(() => {
          let thrown: unknown;
          try {
            applyWriteBatch(vault, operations as never, {
              requestId: nextKey(),
            });
          } catch (err) {
            thrown = err;
          }
          expect(thrown).toBeInstanceOf(WriteBatchError);
          expect((thrown as WriteBatchError).index).toBe(0);
        });
        expect(added).toEqual([]);
      });
    }
  }
});

/**
 * The verdict covers every caller-supplied input. For each operation kind,
 * every string field of the caller's input (walked at any depth; for a
 * batch, every field of every operation and the request id) gets, one at a
 * time, a `<private>` region, and in a second cell a `[[Notes/secret]]`
 * link. Whatever the operation then writes lands in ONE partition: a
 * region anywhere, or a link in any field that is not opaque (a key, a
 * hash, a timestamp, an id), makes it `private`. A caller field the
 * verdict does not read would leave some records in `shared` and fail here.
 */
interface FieldCase {
  /** Seeds what the operation needs. */
  readonly seed?: () => void;
  /** A fresh caller input. */
  readonly input: () => Record<string, unknown>;
  /** Runs the operation on `input`. */
  readonly run: (input: Record<string, unknown>) => unknown;
  /** Fields a link in which names nothing: keys, hashes, timestamps, ids. */
  readonly opaque: ReadonlySet<string>;
  /**
   * Fields the writer validates (an enum, a slug, a date, a path, an
   * operation kind): any extra text there refuses the input before a
   * record is written. Every other cell must write records.
   */
  readonly refuses: ReadonlySet<string>;
}

type FieldPath = ReadonlyArray<string | number>;

/** The path of every string `value` carries, at any depth. */
function stringPaths(value: unknown, at: FieldPath = []): FieldPath[] {
  if (typeof value === "string") return [at];
  if (Array.isArray(value)) return value.flatMap((child, i) => stringPaths(child, [...at, i]));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => stringPaths(child, [...at, key]));
  }
  return [];
}

/** `input` with the string at `path` passed through `edit`. */
function editAt<T>(input: T, path: FieldPath, edit: (s: string) => string): T {
  const copy = structuredClone(input) as Record<string | number, unknown>;
  let node = copy;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  const last = path.at(-1)!;
  node[last] = edit(node[last] as string);
  return copy as T;
}

const FIELD_CASES: Record<string, FieldCase> = {
  signal: {
    input: () => ({
      topic: "plain-topic",
      signal: "positive",
      agent: "@claude-devbox-agent",
      principle: "keep it short",
      created_at: "2026-11-06T10:00:00Z",
      date: "2026-11-06",
      slug: "plain-topic",
      scope: "coding",
      source: ["[[Notes/open]]"],
      raw: "a plain line",
      idempotency_key: nextKey(),
    }),
    run: (input) => writeSignal(vault, input as never),
    opaque: new Set(["created_at", "date", "slug", "idempotency_key"]),
    refuses: new Set(["signal", "date", "slug", "scope"]),
  },
  preference: {
    input: () => ({
      slug: "rule",
      topic: "rule",
      principle: "keep it short",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-05-02T00:00:00Z",
      evidenced_by: ["[[Notes/open]]"],
      confidence: "high",
      scope: "coding",
      owner: "@claude-devbox-agent",
      idempotency_key: nextKey(),
    }),
    run: (input) => writePreference(vault, input as never),
    opaque: new Set(["slug", "created_at", "unconfirmed_until", "confirmed_at", "idempotency_key"]),
    refuses: new Set(["slug", "status", "scope"]),
  },
  apply_evidence: {
    seed: () => seedPreference("rule"),
    input: () => ({
      pref_id: "pref-rule",
      artifact: "[[src/main.ts]]",
      result: "applied",
      agent: "@claude-devbox-agent",
      note: "a plain line",
      outcome: "success",
      idempotency_key: nextKey(),
    }),
    run: (input) => appendApplyEvidence(vault, input as never),
    opaque: new Set(["idempotency_key"]),
    refuses: new Set(["pref_id", "result", "outcome"]),
  },
  brain_note: {
    input: () => ({ text: "a plain line", agent: "@claude-devbox-agent" }),
    run: (input) => appendBrainNote({ vault, ...(input as { text: string; agent: string }) }),
    opaque: new Set(),
    refuses: new Set(),
  },
  pin: {
    seed: () => seedPreference("rule"),
    input: () => ({ prefId: "pref-rule", agent: "@claude-devbox-agent" }),
    run: (input) =>
      setPinned(vault, input["prefId"] as string, true, { agent: input["agent"] as string }),
    opaque: new Set(),
    refuses: new Set(["prefId"]),
  },
  write_batch: {
    seed: () => seedPreference("open-rule"),
    input: () => ({
      requestId: nextKey(),
      operations: [
        {
          kind: "append_log_line",
          input: { text: "a plain line first", agent: "@claude-devbox-agent" },
        },
        {
          kind: "apply_evidence",
          input: {
            pref_id: "pref-open-rule",
            artifact: "[[src/main.ts]]",
            result: "applied",
            agent: "@claude-devbox-agent",
            note: "a plain line",
            idempotency_key: nextKey(),
          },
        },
        {
          kind: "create_note",
          path: "Notes/new.md",
          frontmatter: { title: "new" },
          content: "plain body",
        },
        {
          kind: "append_log_line",
          input: { text: "a plain line last", agent: "@claude-devbox-agent" },
        },
      ],
    }),
    run: (input) =>
      applyWriteBatch(vault, input["operations"] as never, {
        requestId: input["requestId"] as string,
      }),
    opaque: new Set(["requestId", "kind", "idempotency_key"]),
    refuses: new Set(["kind", "pref_id", "result", "path"]),
  },
};

const INJECTIONS = {
  region: (s: string) => `${s}<private>x</private>`,
  link: (s: string) => `${s} [[Notes/secret]]`,
} as const;

describe("the operation verdict covers every caller-supplied field", () => {
  for (const [name, c] of Object.entries(FIELD_CASES)) {
    test(`${name}, open control: every record lands in shared`, () => {
      writePage("Notes/open.md", "title: open");
      c.seed?.();
      const added = recordsOf(() => c.run(c.input()));
      expect(added.length).toBeGreaterThan(0);
      expect(added.filter((r) => r.partition !== "shared")).toEqual([]);
    });
    for (const path of stringPaths(c.input())) {
      const field = path.findLast((p) => typeof p === "string") as string;
      for (const [injection, edit] of Object.entries(INJECTIONS)) {
        const named = injection === "region" || !c.opaque.has(field);
        test(`${name}, ${injection} in ${path.join(".")}: one partition${named ? ", private" : ""}`, () => {
          writePage("Notes/open.md", "title: open");
          c.seed?.();
          const input = editAt(c.input(), path, edit);
          const added = recordsOf(() => {
            try {
              c.run(input);
            } catch {
              // A refused input: checked below to have written nothing.
            }
          });
          if (c.refuses.has(field)) {
            expect(added).toEqual([]);
            return;
          }
          expect(added.length).toBeGreaterThan(0);
          expect(new Set(added.map((r) => r.partition)).size).toBe(1);
          if (named) expect(added.filter((r) => r.partition !== "private")).toEqual([]);
        });
      }
    }
  }
});

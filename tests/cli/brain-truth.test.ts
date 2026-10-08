/**
 * `o2b brain truth` and `o2b brain facts` CLI surfaces (Entity Truth &
 * Self-Improving Dream Suite): ledger ingest, slots, conflicts,
 * aggregate, collisions, sweep, and deterministic atomic-fact
 * decomposition with optional ledger ingest.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendClaimEvent, readClaimEvents } from "../../src/core/brain/truth/store.ts";
import { upsertEntity } from "../../src/core/brain/entities/registry.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-truth-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seedConflict(): void {
  appendClaimEvent(vault, {
    ts: "2026-06-01T10:00:00Z",
    agent: "claude-dev-agent",
    entity: "Alice Mason",
    aspect: "employer",
    value: "Google",
    source: "[[Brain/notes/standup.md]]",
  });
  appendClaimEvent(vault, {
    ts: "2026-06-10T10:00:00Z",
    agent: "sales-agent",
    entity: "Alice Mason",
    aspect: "employer",
    value: "Meta",
    source: "[[Brain/notes/intro-call.md]]",
  });
}

test("truth ingest appends one claim and reports the slot", async () => {
  const res = await runCli([
    "brain",
    "truth",
    "ingest",
    "--vault",
    vault,
    "--entity",
    "Alice Mason",
    "--aspect",
    "employer",
    "--value",
    "Google",
    "--source",
    "[[Brain/notes/standup.md]]",
    "--json",
  ]);
  expect(res.returncode).toBe(0);
  const body = JSON.parse(res.stdout) as { ok: boolean; entity: string; aspect: string };
  expect(body.ok).toBe(true);
  expect(body.entity).toBe("alice mason");
  expect(readClaimEvents(vault).events).toHaveLength(1);
});

test("truth slots renders current values with history", async () => {
  seedConflict();
  const res = await runCli(["brain", "truth", "slots", "--vault", vault, "--json"]);
  expect(res.returncode).toBe(0);
  const body = JSON.parse(res.stdout) as {
    slots: Array<{ entity: string; current: { value: string }; history: unknown[] }>;
  };
  expect(body.slots).toHaveLength(1);
  expect(body.slots[0]!.current.value).toBe("Meta");
  expect(body.slots[0]!.history).toHaveLength(1);
});

test("truth conflicts lists contested slots with ask_user resolution", async () => {
  seedConflict();
  const res = await runCli(["brain", "truth", "conflicts", "--vault", vault, "--json"]);
  expect(res.returncode).toBe(0);
  const body = JSON.parse(res.stdout) as {
    conflicts: Array<{ entity: string; resolution: string }>;
  };
  expect(body.conflicts).toHaveLength(1);
  expect(body.conflicts[0]!.resolution).toBe("ask_user");
});

test("truth aggregate sums exact-match quantities only", async () => {
  appendClaimEvent(vault, {
    ts: "2026-06-01T10:00:00Z",
    agent: "claude-dev-agent",
    entity: "operator",
    aspect: "hosting spend",
    value: "120",
    valueKind: "quantity",
    quantity: { value: 120, unit: "usd", action: "spent" },
    source: "[[Brain/notes/a.md]]",
  });
  appendClaimEvent(vault, {
    ts: "2026-06-02T10:00:00Z",
    agent: "claude-dev-agent",
    entity: "operator",
    aspect: "domain spend",
    value: "42",
    valueKind: "quantity",
    quantity: { value: 42, unit: "usd", action: "spent" },
    source: "[[Brain/notes/b.md]]",
  });
  const res = await runCli([
    "brain",
    "truth",
    "aggregate",
    "--vault",
    vault,
    "--action",
    "spent",
    "--unit",
    "usd",
    "--json",
  ]);
  expect(res.returncode).toBe(0);
  const body = JSON.parse(res.stdout) as { total: number; count: number };
  expect(body.total).toBe(162);
  expect(body.count).toBe(2);
});

test("truth collisions reports cross-agent convergence", async () => {
  appendClaimEvent(vault, {
    ts: new Date(Date.now() - 24 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, "Z"),
    agent: "claude-dev-agent",
    entity: "Project Atlas",
    aspect: "pricing page",
    value: "confusing",
    source: "[[Brain/notes/support.md]]",
  });
  appendClaimEvent(vault, {
    ts: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    agent: "sales-agent",
    entity: "Project Atlas",
    aspect: "pricing deal",
    value: "stalled",
    source: "[[Brain/notes/deal.md]]",
  });
  const res = await runCli(["brain", "truth", "collisions", "--vault", vault, "--json"]);
  expect(res.returncode).toBe(0);
  const body = JSON.parse(res.stdout) as { collisions: Array<{ entity: string }> };
  expect(body.collisions).toHaveLength(1);
  expect(body.collisions[0]!.entity).toBe("project atlas");
});

test("truth sweep bounds the ledger", async () => {
  seedConflict();
  const res = await runCli([
    "brain",
    "truth",
    "sweep",
    "--vault",
    vault,
    "--max-events",
    "1",
    "--json",
  ]);
  expect(res.returncode).toBe(0);
  const body = JSON.parse(res.stdout) as { removed: number; kept: number };
  expect(body.removed).toBe(1);
  expect(body.kept).toBe(1);
});

test("truth with an unknown op exits 2", async () => {
  const res = await runCli(["brain", "truth", "bogus", "--vault", vault]);
  expect(res.returncode).toBe(2);
});

// ----- truth events + windowed ingest (truth-correctable-time-aware, Task 9)

interface ClaimEventRow {
  readonly ts: string;
  readonly entity: string;
  readonly aspect: string;
  readonly value: string;
  readonly source: string;
  readonly validFrom?: string;
  readonly validUntil?: string;
}

interface EventsBody {
  readonly ok: boolean;
  readonly operation: string;
  readonly entity: string | null;
  readonly events: ReadonlyArray<ClaimEventRow>;
  readonly total: number;
  readonly truncated: boolean;
}

test("truth events prints the MCP events shape over a windowed slice", async () => {
  appendClaimEvent(vault, {
    ts: "2026-06-01T10:00:00Z",
    agent: "claude-dev-agent",
    entity: "Alice Mason",
    aspect: "employer",
    value: "Google",
    validFrom: "2026-06-01",
    validUntil: "2026-09-01",
    source: "[[Brain/notes/a.md]]",
  });
  appendClaimEvent(vault, {
    ts: "2026-06-10T12:00:00Z",
    agent: "claude-dev-agent",
    entity: "Project Atlas",
    aspect: "status",
    value: "on track",
    source: "[[Brain/notes/b.md]]",
  });
  const res = await runCli([
    "brain",
    "truth",
    "events",
    "--vault",
    vault,
    "--entity",
    "Alice Mason",
    "--since",
    "2026-06-01",
    "--json",
  ]);
  expect(res.returncode).toBe(0);
  const body = JSON.parse(res.stdout) as unknown as EventsBody;
  expect(body.ok).toBe(true);
  expect(body.operation).toBe("events");
  expect(body.entity).toBe("alice mason");
  expect(body.events.map((e) => e.ts)).toEqual(["2026-06-01T10:00:00Z"]);
  expect(body.events[0]!.validFrom).toBe("2026-06-01");
  expect(body.events[0]!.validUntil).toBe("2026-09-01");
  expect(body.total).toBe(1);
  expect("withheld" in body).toBe(false);
  expect(body.truncated).toBe(false);
});

test("truth ingest accepts --valid-from and --valid-until", async () => {
  const res = await runCli([
    "brain",
    "truth",
    "ingest",
    "--vault",
    vault,
    "--entity",
    "Alice Mason",
    "--aspect",
    "employer",
    "--value",
    "Google",
    "--source",
    "[[Brain/notes/standup.md]]",
    "--valid-from",
    "2026-06-01",
    "--valid-until",
    "2026-09-01",
    "--json",
  ]);
  expect(res.returncode).toBe(0);
  const [event] = readClaimEvents(vault).events;
  expect(event!.validFrom).toBe("2026-06-01");
  expect(event!.validUntil).toBe("2026-09-01");
});

test("truth ingest refuses an empty or inverted validity window as a usage error", async () => {
  // A mistyped window is the same failure class as the sibling mistyped
  // inputs (--since garbage, --limit 0): usage, exit 2 - not an
  // operational failure.
  const res = await runCli([
    "brain",
    "truth",
    "ingest",
    "--vault",
    vault,
    "--entity",
    "Alice Mason",
    "--aspect",
    "employer",
    "--value",
    "Google",
    "--source",
    "[[Brain/notes/standup.md]]",
    "--valid-from",
    "2026-09-01",
    "--valid-until",
    "2026-06-01",
    "--json",
  ]);
  expect(res.returncode).toBe(2);
  expect(readClaimEvents(vault).events).toHaveLength(0);
});

test("truth ingest refuses an unparseable validity bound as a usage error", async () => {
  const res = await runCli([
    "brain",
    "truth",
    "ingest",
    "--vault",
    vault,
    "--entity",
    "Alice Mason",
    "--aspect",
    "employer",
    "--value",
    "Google",
    "--source",
    "[[Brain/notes/standup.md]]",
    "--valid-from",
    "garbage",
    "--json",
  ]);
  expect(res.returncode).toBe(2);
  expect(readClaimEvents(vault).events).toHaveLength(0);
});

test("truth events refuses unparseable bounds with a usage error", async () => {
  const res = await runCli([
    "brain",
    "truth",
    "events",
    "--vault",
    vault,
    "--since",
    "not a date",
    "--json",
  ]);
  expect(res.returncode).toBe(2);
  expect(readClaimEvents(vault).events).toHaveLength(0);
});

test("truth events refuses a non-positive or fractional limit", async () => {
  for (const limit of ["0", "-3", "1.5"]) {
    const res = await runCli(["brain", "truth", "events", "--vault", vault, "--limit", limit]);
    expect(res.returncode).toBe(2);
  }
});

test("truth events refuses a non-numeric limit naming the raw flag value", async () => {
  // Number("abc") is NaN, which the shared limit guard's refusal would
  // stringify as "null" - naming nothing the operator typed. The CLI
  // validates the flag is finite before that message is composed and
  // names the raw flag value it was handed.
  for (const limit of ["abc", "many"]) {
    const res = await runCli(["brain", "truth", "events", "--vault", vault, "--limit", limit]);
    expect(res.returncode).toBe(2);
    expect(res.stderr).toContain(`got ${JSON.stringify(limit)}`);
  }
});

// ----- truth state (grounded agent-stated claims, Task 9) -------------------

function seedCliRegistry(): void {
  upsertEntity(vault, {
    category: "people",
    name: "Alice Mason",
    aliases: ["Alice"],
    agent: "claude",
    now: new Date("2026-06-01T00:00:00Z"),
  });
  upsertEntity(vault, {
    category: "projects",
    name: "Project Atlas",
    aliases: ["Atlas"],
    agent: "claude",
    now: new Date("2026-06-01T00:00:00Z"),
  });
}

interface StateBody {
  readonly ok: boolean;
  readonly operation: string;
  readonly committed: ReadonlyArray<Record<string, unknown>>;
  readonly ungrounded: ReadonlyArray<{
    readonly subject: string;
    readonly relation: string;
    readonly object: string;
    readonly reasons: ReadonlyArray<string>;
  }>;
}

function stateArgs(vaultFlag: string, extra: ReadonlyArray<string>): string[] {
  return ["brain", "truth", "state", "--vault", vaultFlag, ...extra, "--json"];
}

test("truth state commits a grounded claim and prints the verdict", async () => {
  seedCliRegistry();
  const res = await runCli(
    stateArgs(vault, [
      "--subject",
      "Alice Mason",
      "--relation",
      "extends",
      "--object",
      "Atlas",
      "--text",
      "Alice Mason said the Atlas extension plan is ready for review today.",
      "--source",
      "[[Brain/notes/session.md]]",
    ]),
  );
  expect(res.returncode).toBe(0);
  const body = JSON.parse(res.stdout) as unknown as StateBody;
  expect(body.ok).toBe(true);
  expect(body.operation).toBe("state");
  expect(body.committed).toHaveLength(1);
  const row = body.committed[0] as Record<string, unknown>;
  expect(row["entity"]).toBe("alice mason");
  expect(row["aspect"]).toBe("extends");
  expect(row["value"]).toBe("Atlas");
  expect(row["extractor"]).toBe("agent_stated");
  expect(body.ungrounded).toHaveLength(0);
  const [stored] = readClaimEvents(vault).events;
  expect(stored!.extractor).toBe("agent_stated");
});

test("truth state reports an ungrounded claim with reasons and writes nothing", async () => {
  seedCliRegistry();
  const res = await runCli(
    stateArgs(vault, [
      "--subject",
      "Alice Mason",
      "--relation",
      "related",
      "--object",
      "Project Osiris",
      "--text",
      "Alice walked through the Project Atlas plan all morning.",
      "--source",
      "[[Brain/notes/session.md]]",
    ]),
  );
  expect(res.returncode).toBe(0);
  const body = JSON.parse(res.stdout) as unknown as StateBody;
  expect(body.committed).toHaveLength(0);
  expect(body.ungrounded).toHaveLength(1);
  expect(body.ungrounded[0]!.reasons).toContain("object_unanchored");
  expect(readClaimEvents(vault).events).toHaveLength(0);
});

test("truth state refuses an unknown relation with a usage error", async () => {
  seedCliRegistry();
  const res = await runCli(
    stateArgs(vault, [
      "--subject",
      "Alice Mason",
      "--relation",
      "invented_by",
      "--object",
      "Atlas",
      "--text",
      "Alice Mason reviewed Atlas today.",
      "--source",
      "[[Brain/notes/session.md]]",
    ]),
  );
  expect(res.returncode).toBe(2);
  expect(readClaimEvents(vault).events).toHaveLength(0);
});

test("truth state refuses an inverted source window as a usage error", async () => {
  // The stated claim carries no explicit window, so the store resolves
  // one from the source record's frontmatter; an inverted window there
  // raises the store's typed refusal, which - like ingest's - is a
  // mistyped input and must answer as the usage failure class (exit 2),
  // not the sibling ingest path's exit-2-vs-exit-1 divergence.
  seedCliRegistry();
  mkdirSync(join(vault, "Brain", "notes"), { recursive: true });
  writeFileSync(
    join(vault, "Brain", "notes", "session.md"),
    "---\nkind: note\nvalid_from: 2026-06-01\nvalid_until: 2026-01-01\n---\n\nsession page\n",
  );
  const res = await runCli(
    stateArgs(vault, [
      "--subject",
      "Alice Mason",
      "--relation",
      "related",
      "--object",
      "Atlas",
      "--text",
      "Alice Mason reviewed Atlas today.",
      "--source",
      "[[Brain/notes/session.md]]",
    ]),
  );
  expect(res.returncode).toBe(2);
  expect(readClaimEvents(vault).events).toHaveLength(0);
});

test("facts decompose splits a file into assertions", async () => {
  const file = join(tmp, "session.md");
  writeFileSync(
    file,
    "# Standup\n\n- Alice approves the deploy window tomorrow\n\nThe rollback plan stays unchanged. Nothing else moved.\n",
  );
  const res = await runCli([
    "brain",
    "facts",
    "decompose",
    "--vault",
    vault,
    "--file",
    file,
    "--json",
  ]);
  expect(res.returncode).toBe(0);
  const body = JSON.parse(res.stdout) as { assertions: Array<{ text: string; kind: string }> };
  expect(body.assertions).toHaveLength(3);
  expect(body.assertions[0]!.kind).toBe("list_item");
});

test("facts decompose --ingest writes entity-aspect-shaped claims to the ledger", async () => {
  const file = join(tmp, "session.md");
  writeFileSync(file, "I spent 120 USD on hosting last month.\n");
  const res = await runCli([
    "brain",
    "facts",
    "decompose",
    "--vault",
    vault,
    "--file",
    file,
    "--ingest",
    "--entity",
    "operator",
    "--json",
  ]);
  expect(res.returncode).toBe(0);
  const body = JSON.parse(res.stdout) as { ingested: number };
  expect(body.ingested).toBe(1);
  const events = readClaimEvents(vault).events;
  expect(events).toHaveLength(1);
  expect(events[0]!.valueKind).toBe("quantity");
  expect(events[0]!.quantity?.value).toBe(120);
});

test("facts decompose without --ingest leaves the ledger untouched", async () => {
  const file = join(tmp, "session.md");
  writeFileSync(file, "I spent 120 USD on hosting last month.\n");
  const res = await runCli([
    "brain",
    "facts",
    "decompose",
    "--vault",
    vault,
    "--file",
    file,
    "--json",
  ]);
  expect(res.returncode).toBe(0);
  expect(readClaimEvents(vault).events).toHaveLength(0);
});

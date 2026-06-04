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

/**
 * Claim ledger store (Entity Truth & Self-Improving Dream Suite,
 * t_d6849b56): device-sharded append-only JSONL under `Brain/truth/`,
 * fail-closed line parsing, derived state cache that is never
 * authority, and an explicit sweep bounded by a newest-N cap.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendClaimEvent,
  CLAIM_EVENT_MAX_COUNT,
  claimShardPath,
  ClaimWindowRefusal,
  readClaimEvents,
  readTruthState,
  sweepClaimEvents,
  truthDir,
  truthStatePath,
  writeTruthState,
} from "../../../../src/core/brain/truth/store.ts";
import { computeTruthState } from "../../../../src/core/brain/truth/fold.ts";
import { computeTruthStateWithConflicts } from "../../../../src/core/brain/truth/conflicts.ts";
import { withDeviceId } from "../../../helpers/device-id.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-truth-store-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function append(
  over: Partial<Parameters<typeof appendClaimEvent>[1]> = {},
): ReturnType<typeof appendClaimEvent> {
  return appendClaimEvent(vault, {
    ts: "2026-06-01T10:00:00Z",
    agent: "claude-dev-agent",
    entity: "Alice Mason",
    aspect: "employer",
    value: "Google",
    source: "[[Brain/notes/standup.md]]",
    ...over,
  });
}

describe("appendClaimEvent", () => {
  test("appends one JSONL line to the device shard and normalizes identity", () => {
    const written = append({ entity: "  Alice   Mason ", aspect: " Employer " });
    expect(written.path).toBe(claimShardPath(vault));
    const lines = readFileSync(written.path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(row["v"]).toBe(1);
    expect(row["entity"]).toBe("alice mason");
    expect(row["aspect"]).toBe("employer");
    expect(row["value"]).toBe("Google");
  });

  test("two appends accumulate; the derived state cache refreshes", () => {
    append();
    append({ ts: "2026-06-02T10:00:00Z", value: "Meta", source: "[[Brain/notes/later.md]]" });
    expect(readClaimEvents(vault).events).toHaveLength(2);
    const state = readTruthState(vault);
    expect(state).not.toBeNull();
    expect(state!.events).toBe(2);
  });

  test("rejects an empty entity or aspect", () => {
    expect(() => append({ entity: "  " })).toThrow();
    expect(() => append({ aspect: "" })).toThrow();
  });

  test("quantity claims persist the quantity payload", () => {
    append({
      value: "3",
      valueKind: "quantity",
      quantity: { value: 3, unit: "usd", action: "spent" },
    });
    const events = readClaimEvents(vault).events;
    expect(events[0]!.valueKind).toBe("quantity");
    expect(events[0]!.quantity).toEqual({ value: 3, unit: "usd", action: "spent" });
  });
});

describe("readClaimEvents", () => {
  test("merges device shards sorted by (ts, shard, line)", () => {
    mkdirSync(truthDir(vault), { recursive: true });
    const rowA = {
      v: 1,
      ts: "2026-06-02T09:00:00Z",
      agent: "a",
      entity: "alice mason",
      aspect: "employer",
      value: "Meta",
      valueKind: "text",
      source: "[[x]]",
    };
    const rowB = { ...rowA, ts: "2026-06-01T09:00:00Z", agent: "b", value: "Google" };
    writeFileSync(join(truthDir(vault), "claims.dev-a.jsonl"), JSON.stringify(rowA) + "\n");
    writeFileSync(join(truthDir(vault), "claims.dev-b.jsonl"), JSON.stringify(rowB) + "\n");
    const { events, warnings } = readClaimEvents(vault);
    expect(warnings).toHaveLength(0);
    expect(events.map((e) => e.value)).toEqual(["Google", "Meta"]);
  });

  test("fail-closed: malformed lines and wrong versions surface as warnings, never throw", () => {
    mkdirSync(truthDir(vault), { recursive: true });
    const good = {
      v: 1,
      ts: "2026-06-01T09:00:00Z",
      agent: "a",
      entity: "alice mason",
      aspect: "employer",
      value: "Google",
      valueKind: "text",
      source: "[[x]]",
    };
    const lines = [
      "not json at all",
      JSON.stringify({ ...good, v: 99 }),
      JSON.stringify({ ...good, ts: "yesterday" }),
      JSON.stringify({ ...good, entity: 42 }),
      JSON.stringify(good),
    ].join("\n");
    writeFileSync(join(truthDir(vault), "claims.jsonl"), lines + "\n");
    const { events, warnings } = readClaimEvents(vault);
    expect(events).toHaveLength(1);
    expect(warnings).toHaveLength(4);
  });

  test("sync-conflict copies are never read as shards", () => {
    mkdirSync(truthDir(vault), { recursive: true });
    writeFileSync(
      join(truthDir(vault), "claims.sync-conflict-20260601-foo.jsonl"),
      JSON.stringify({ v: 1 }) + "\n",
    );
    expect(readClaimEvents(vault).events).toHaveLength(0);
  });

  test("missing directory reads as empty", () => {
    expect(readClaimEvents(vault).events).toHaveLength(0);
  });
});

describe("derived state cache", () => {
  test("readTruthState is fail-closed on corrupt nested rows", () => {
    writeTruthState(vault, computeTruthState([]));
    expect(readTruthState(vault)).not.toBeNull();
    writeFileSync(
      truthStatePath(vault),
      JSON.stringify({
        version: 1,
        events: 1,
        updatedAt: null,
        slots: [{ bogus: true }],
        conflicts: [],
      }),
    );
    expect(readTruthState(vault)).toBeNull();
    writeFileSync(truthStatePath(vault), "{ not json");
    expect(readTruthState(vault)).toBeNull();
  });

  test("state cache is recomputable: deleting it loses nothing", () => {
    append();
    append({ ts: "2026-06-02T10:00:00Z", value: "Meta" });
    const before = readTruthState(vault);
    rmSync(truthStatePath(vault));
    const refolded = computeTruthState(readClaimEvents(vault).events);
    expect(refolded).toEqual(before!);
  });
});

describe("sweepClaimEvents", () => {
  test("keeps the newest N events and refolds", () => {
    for (let i = 0; i < 5; i++) {
      append({
        ts: `2026-06-0${i + 1}T10:00:00Z`,
        value: `v${i}`,
        source: `[[Brain/notes/n${i}.md]]`,
      });
    }
    const outcome = sweepClaimEvents(vault, { maxEvents: 2 });
    expect(outcome.removed).toBe(3);
    expect(outcome.kept).toBe(2);
    const { events } = readClaimEvents(vault);
    expect(events.map((e) => e.value)).toEqual(["v3", "v4"]);
    expect(readTruthState(vault)!.events).toBe(2);
  });

  test("default cap is generous", () => {
    expect(CLAIM_EVENT_MAX_COUNT).toBeGreaterThanOrEqual(10000);
  });

  test("sweep with no directory refolds an orphaned state file", () => {
    writeTruthState(vault, {
      ...computeTruthState([]),
      events: 42,
    });
    const outcome = sweepClaimEvents(vault, {});
    expect(outcome).toEqual({ removed: 0, kept: 0 });
    expect(existsSync(truthStatePath(vault))).toBe(true);
    expect(readTruthState(vault)!.events).toBe(0);
  });
});

test("the claim shard name is claims.jsonl or claims.<deviceId>.jsonl, byte for byte", () => {
  expect(withDeviceId("", () => claimShardPath(vault))).toBe(join(truthDir(vault), "claims.jsonl"));
  expect(withDeviceId("laptop-01", () => claimShardPath(vault))).toBe(
    join(truthDir(vault), "claims.laptop-01.jsonl"),
  );
});

describe("claim validity windows (presence-gated, schema v1)", () => {
  const WINDOWLESS_LINE =
    JSON.stringify({
      v: 1,
      ts: "2026-06-01T10:00:00Z",
      agent: "claude-dev-agent",
      entity: "alice mason",
      aspect: "employer",
      value: "Google",
      valueKind: "text",
      source: "[[Brain/notes/standup.md]]",
    }) + "\n";

  test("a windowless append writes a byte-identical line (no validity keys)", () => {
    const written = append();
    const line = readFileSync(written.path, "utf8");
    expect(line).toBe(WINDOWLESS_LINE);
    const row = JSON.parse(line) as Record<string, unknown>;
    expect("validFrom" in row).toBe(false);
    expect("validUntil" in row).toBe(false);
  });

  test("present validity fields serialize by conditional spread, before source", () => {
    const written = append({ validFrom: "2026-01-01", validUntil: "2026-06-30T23:59:59Z" });
    const row = JSON.parse(readFileSync(written.path, "utf8")) as Record<string, unknown>;
    expect(row["validFrom"]).toBe("2026-01-01");
    expect(row["validUntil"]).toBe("2026-06-30T23:59:59Z");
    const keys = Object.keys(row);
    expect(keys.indexOf("validUntil")).toBe(keys.indexOf("source") - 1);
    expect(written.event.validFrom).toBe("2026-01-01");
  });

  test("an invalid validity value refuses the append with a named error", () => {
    expect(() => append({ validFrom: "yesterday" })).toThrow(/validFrom/);
    expect(() => append({ validUntil: "2026-01-01T10:00:00+02:00" })).toThrow(/validUntil/);
  });

  test("a window refusal is typed, so tool surfaces map it to invalid params", () => {
    // The MCP boundary maps this class to INVALID_PARAMS and the CLI
    // verb to exit 2; the store keeps refusing strictly either way.
    expect(() => append({ validFrom: "yesterday" })).toThrow(ClaimWindowRefusal);
    expect(() => append({ validFrom: "2026-06-01", validUntil: "2026-01-01" })).toThrow(
      ClaimWindowRefusal,
    );
  });

  test("an empty or inverted window refuses the append", () => {
    // Half-open [from, until): a bare-date until is the exclusive day
    // start, so equal bare-date bounds are an empty window and rejected,
    // as are same-instant bounds and any inverted pair.
    expect(() =>
      append({ validFrom: "2026-01-01T00:00:00Z", validUntil: "2026-01-01T00:00:00Z" }),
    ).toThrow();
    expect(() => append({ validFrom: "2026-06-01", validUntil: "2026-06-01" })).toThrow();
    expect(() => append({ validFrom: "2026-06-01", validUntil: "2026-01-01" })).toThrow();
  });

  test("a state file with a valid successions channel reads back; a corrupt one reads null", () => {
    append({ validFrom: "2025-01-01", validUntil: "2025-12-31" });
    append({
      ts: "2026-06-10T10:00:00Z",
      value: "Meta",
      source: "[[Brain/notes/later.md]]",
      validFrom: "2026-01-01",
    });
    const withSuccessions = computeTruthStateWithConflicts(readClaimEvents(vault).events);
    expect(withSuccessions.successions).toHaveLength(1);
    writeTruthState(vault, withSuccessions);
    expect(readTruthState(vault)).toEqual(withSuccessions);

    const corrupt = JSON.parse(readFileSync(truthStatePath(vault), "utf8")) as Record<
      string,
      unknown
    >;
    corrupt["successions"] = [{ entity: "alice mason", aspect: "employer", bogus: true }];
    writeFileSync(truthStatePath(vault), JSON.stringify(corrupt));
    expect(readTruthState(vault)).toBeNull();
  });

  test("the new binary reads old lines (fields absent) unchanged", () => {
    mkdirSync(truthDir(vault), { recursive: true });
    writeFileSync(join(truthDir(vault), "claims.jsonl"), WINDOWLESS_LINE);
    const { events, warnings } = readClaimEvents(vault);
    expect(warnings).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]!.validFrom).toBeUndefined();
    expect(events[0]!.validUntil).toBeUndefined();
  });

  test("the new binary reads new lines and validates the fields when present", () => {
    mkdirSync(truthDir(vault), { recursive: true });
    const good = {
      v: 1,
      ts: "2026-06-01T09:00:00Z",
      agent: "a",
      entity: "alice mason",
      aspect: "employer",
      value: "Google",
      valueKind: "text",
      validFrom: "2026-01-01",
      validUntil: "2026-06-01T00:00:00Z",
      source: "[[x]]",
    };
    const badFrom = { ...good, ts: "2026-06-02T09:00:00Z", validFrom: "not a date" };
    const inverted = {
      ...good,
      ts: "2026-06-03T09:00:00Z",
      validFrom: "2026-06-01T00:00:00Z",
      validUntil: "2026-01-01T00:00:00Z",
    };
    writeFileSync(
      join(truthDir(vault), "claims.jsonl"),
      [good, badFrom, inverted].map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    const { events, warnings } = readClaimEvents(vault);
    expect(events).toHaveLength(1);
    expect(events[0]!.validFrom).toBe("2026-01-01");
    expect(warnings).toHaveLength(2);
    expect(warnings.map((w) => w.message).toSorted()).toEqual([
      "invalid claim validFrom: not a date",
      "invalid claim validity window: validFrom must parse before validUntil",
    ]);
  });

  test("unknown keys on a line stay ignored (old binaries read new lines verbatim)", () => {
    // The old-binary half of the read/write matrix: an older reader
    // rebuilds the row from known keys only, so a NEW line's validity
    // fields (and any future field) degrade to the assertion-time axis.
    // Pinned here against the CURRENT reader: unknown keys are dropped,
    // not warnings.
    mkdirSync(truthDir(vault), { recursive: true });
    const future = {
      v: 1,
      ts: "2026-06-01T09:00:00Z",
      agent: "a",
      entity: "alice mason",
      aspect: "employer",
      value: "Google",
      valueKind: "text",
      source: "[[x]]",
      futureField: { nested: true },
    };
    writeFileSync(join(truthDir(vault), "claims.jsonl"), JSON.stringify(future) + "\n");
    const { events, warnings } = readClaimEvents(vault);
    expect(warnings).toHaveLength(0);
    expect(events).toHaveLength(1);
    const row = events[0] as unknown as Record<string, unknown>;
    expect("futureField" in row).toBe(false);
  });

  test("the extractor serializes by conditional spread, after source", () => {
    const written = append({
      extractor: "agent_stated",
      validFrom: "2026-01-01",
      validUntil: "2026-06-30",
    });
    const row = JSON.parse(readFileSync(written.path, "utf8")) as Record<string, unknown>;
    expect(row["extractor"]).toBe("agent_stated");
    const keys = Object.keys(row);
    expect(keys.indexOf("extractor")).toBe(keys.length - 1);
    // The pinned window/source adjacency is unaffected by the tag.
    expect(keys.indexOf("source")).toBe(keys.indexOf("validUntil") + 1);
  });

  test("an extractorless append stays byte-identical (no extractor key)", () => {
    const written = append();
    const line = readFileSync(written.path, "utf8");
    expect(line).toBe(WINDOWLESS_LINE);
  });

  test("a foreign extractor value refuses the append with a named error", () => {
    // Strict on write: this binary emits exactly one tag.
    expect(() =>
      append({ extractor: "model_mined" } as unknown as Parameters<typeof append>[0]),
    ).toThrow(/extractor/);
  });

  test("the reader tolerates a future extractor value and passes it through verbatim", () => {
    mkdirSync(truthDir(vault), { recursive: true });
    const futureTagged = {
      v: 1,
      ts: "2026-06-01T09:00:00Z",
      agent: "a",
      entity: "alice mason",
      aspect: "employer",
      value: "Google",
      valueKind: "text",
      source: "[[x]]",
      extractor: "model_mined",
    };
    writeFileSync(join(truthDir(vault), "claims.jsonl"), JSON.stringify(futureTagged) + "\n");
    const { events, warnings } = readClaimEvents(vault);
    expect(warnings).toHaveLength(0);
    expect(events).toHaveLength(1);
    // A future tag is passed through verbatim, whatever it spells; the
    // projection sidesteps the closed write-time vocabulary in the type.
    expect(String(events[0]!.extractor)).toBe("model_mined");
  });

  test("an extractor that is not a non-empty string drops the line with a warning", () => {
    mkdirSync(truthDir(vault), { recursive: true });
    const badTag = {
      v: 1,
      ts: "2026-06-01T09:00:00Z",
      agent: "a",
      entity: "alice mason",
      aspect: "employer",
      value: "Google",
      valueKind: "text",
      source: "[[x]]",
      extractor: 42,
    };
    writeFileSync(join(truthDir(vault), "claims.jsonl"), JSON.stringify(badTag) + "\n");
    const { events, warnings } = readClaimEvents(vault);
    expect(events).toHaveLength(0);
    expect(warnings.map((w) => w.message)).toEqual(["invalid claim extractor: 42"]);
  });
});

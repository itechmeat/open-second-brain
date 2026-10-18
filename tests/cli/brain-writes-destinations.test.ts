/**
 * `o2b brain writes destinations` (actionable-now batch, A4 / t_69fec179):
 * the CLI exposure of the destination-keyed write aggregate. The same
 * rows the core reader returns, with the filters it accepts; a query
 * here never writes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendLogEvent } from "../../src/core/brain/log.ts";
import { WRITE_DESTINATION_COVERAGE_NOTE } from "../../src/core/brain/notes/write-destinations.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../src/core/brain/types.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-writes-destinations-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seedNoteWrite(timestamp: string, agent: string, target: string, deviceId = ""): void {
  appendLogEvent(
    vault,
    {
      timestamp,
      eventType: BRAIN_LOG_EVENT_KIND.noteWrite,
      agent,
      body: {
        write_id: `nw_${timestamp.replace(/\D/g, "")}_${target}`,
        op: "update",
        target,
        hash_before: "a".repeat(64),
        hash_after: "b".repeat(64),
        bytes_before: "10",
        bytes_after: "20",
        agent,
      },
    },
    { deviceId },
  );
}

function seedWriteSession(timestamp: string, agent: string, target: string): void {
  appendLogEvent(
    vault,
    {
      timestamp,
      eventType: BRAIN_LOG_EVENT_KIND.writeSession,
      agent,
      body: {
        session_id: `ws_${timestamp.replace(/\D/g, "")}`,
        kind: "artifact",
        status: "done",
        target,
        attempts: "1",
        review: "not-required",
      },
    },
    { deviceId: "" },
  );
}

function seedBoth(): void {
  seedNoteWrite("2026-03-04T01:00:00Z", "alpha", "Notes/One.md");
  seedNoteWrite("2026-03-04T02:00:00Z", "beta", "Notes/One.md", "laptop");
  seedWriteSession("2026-03-04T03:00:00Z", "alpha", "Notes/Two.md");
}

interface DestinationRow {
  readonly target: string;
  readonly kinds: string[];
  readonly note_writes: number;
  readonly write_sessions: number;
  readonly agents: string[];
  readonly last_write: string;
}

interface DestinationsReply {
  readonly destinations: DestinationRow[];
  readonly total_matched: number;
  readonly returned: number;
  readonly window: { readonly since: string; readonly until: string | null };
  readonly coverage_note: string;
  readonly warnings: unknown[];
}

describe("o2b brain writes destinations", () => {
  test("--json lists the rows the core reader returns", async () => {
    seedBoth();
    const r = await runCli([
      "brain",
      "writes",
      "destinations",
      "--vault",
      vault,
      "--since",
      "2026-03-01",
      "--until",
      "2026-03-04",
      "--json",
    ]);
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as DestinationsReply;
    expect(payload.total_matched).toBe(2);
    expect(payload.coverage_note).toBe(WRITE_DESTINATION_COVERAGE_NOTE);
    // The window the walk covered rides the answer: the requested bounds
    // completed to timestamps, so a JSON caller can read the coverage it
    // is looking at instead of inferring it from the flags it sent.
    expect(payload.window).toEqual({
      since: "2026-03-01T00:00:00Z",
      until: "2026-03-04T23:59:59.999Z",
    });
    const one = payload.destinations.find((d) => d.target === "Notes/One.md")!;
    expect(one.note_writes).toBe(2);
    expect(one.agents).toEqual(["alpha", "beta"]);
    const two = payload.destinations.find((d) => d.target === "Notes/Two.md")!;
    expect(two.kinds).toEqual(["write-session"]);
    expect(two.write_sessions).toBe(1);
  });

  test("--agent narrows the rows the way the core filter does", async () => {
    seedBoth();
    const r = await runCli([
      "brain",
      "writes",
      "destinations",
      "--vault",
      vault,
      "--since",
      "2026-03-01",
      "--until",
      "2026-03-04",
      "--agent",
      "beta",
      "--json",
    ]);
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as DestinationsReply;
    expect(payload.destinations.map((d) => d.target)).toEqual(["Notes/One.md"]);
    // Only the filtered events' kinds are named.
    expect(payload.destinations[0]!.kinds).toEqual(["note-write"]);
  });

  test("the plain render prints one line per destination and the coverage note", async () => {
    seedBoth();
    const r = await runCli([
      "brain",
      "writes",
      "destinations",
      "--vault",
      vault,
      "--since",
      "2026-03-01",
      "--until",
      "2026-03-04",
    ]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("Notes/One.md");
    expect(r.stdout).toContain("Notes/Two.md");
    expect(r.stdout).toContain(WRITE_DESTINATION_COVERAGE_NOTE);
    // The covered window is one explicit line, both ends completed to
    // timestamps - a bare-date until reads through the end of its day.
    expect(r.stdout).toContain("window: 2026-03-01T00:00:00Z .. 2026-03-04T23:59:59.999Z");
  });

  test("the plain render names the window's open upper end as now", async () => {
    seedBoth();
    const r = await runCli(["brain", "writes", "destinations", "--vault", vault]);
    expect(r.returncode).toBe(0);
    // No --until: the walk ran to the present, and the line says so rather
    // than printing a null.
    expect(r.stdout).toMatch(/window: \d{4}-\d{2}-\d{2}T00:00:00Z \.\. now/);
  });

  test("an empty window reports zero rows and exits 0", async () => {
    const r = await runCli([
      "brain",
      "writes",
      "destinations",
      "--vault",
      vault,
      "--since",
      "2031-01-01",
      "--until",
      "2031-01-02",
      "--json",
    ]);
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as DestinationsReply;
    expect(payload.total_matched).toBe(0);
    expect(payload.destinations).toEqual([]);
  });

  test("--device '' selects the legacy un-sharded shard, not everything", async () => {
    seedBoth();
    const r = await runCli([
      "brain",
      "writes",
      "destinations",
      "--vault",
      vault,
      "--since",
      "2026-03-01",
      "--until",
      "2026-03-04",
      "--device",
      "",
      "--json",
    ]);
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as DestinationsReply;
    // Both targets have an un-sharded touch, but One.md's laptop write by
    // beta must drop out of the row the empty-string filter produces.
    expect(payload.total_matched).toBe(2);
    const one = payload.destinations.find((d) => d.target === "Notes/One.md")!;
    expect(one.agents).toEqual(["alpha"]);
  });

  test("an un-sharded touch renders as an absent cell, not a blank", async () => {
    seedBoth();
    const r = await runCli([
      "brain",
      "writes",
      "destinations",
      "--vault",
      vault,
      "--since",
      "2026-03-01",
      "--until",
      "2026-03-04",
    ]);
    expect(r.returncode).toBe(0);
    // One.md's devices are the un-sharded pair and laptop: the un-sharded
    // empty string is an answer, and the row says so the way the list
    // verb does - a dash, never a silent blank cell.
    expect(r.stdout).toContain("device: -,laptop");
    expect(r.stdout).not.toContain("device: ,");
    expect(r.stdout).not.toContain("device:  ");
  });

  test("a malformed bound is a usage error naming the flag, not a silent empty", async () => {
    seedBoth();
    for (const [flag, value] of [
      ["--since", "yesterday"],
      ["--until", "03/01/2026"],
    ] as const) {
      const r = await runCli([
        "brain",
        "writes",
        "destinations",
        "--vault",
        vault,
        flag,
        value,
        "--json",
      ]);
      expect(r.returncode).toBe(2);
      expect(r.stderr).toContain(flag);
      expect(r.stderr).toContain(value);
    }
  });
});

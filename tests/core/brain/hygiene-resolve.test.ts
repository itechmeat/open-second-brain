/**
 * External conflict resolution over the command bridge
 * (continuity-hygiene-freshness suite, Task 10; kanban t_db375a60).
 *
 * Detection stays deterministic; resolution consults an optional
 * external resolver command (JSON stdin/stdout, fail-open). Without a
 * resolver - or on any resolver failure or invalid verdict - every
 * conflict stays `review`. A valid `supersede` / `merge` verdict
 * upgrades the finding and records the resolver evidence.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { appendClaimEvent } from "../../../src/core/brain/truth/store.ts";
import { runHygieneScan } from "../../../src/core/brain/hygiene/scan.ts";
import { resolveConflictFindings } from "../../../src/core/brain/hygiene/resolve-conflicts.ts";

let vault: string;

const NOW = new Date("2026-06-10T12:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-hygiene-resolve-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  appendClaimEvent(vault, {
    ts: "2026-06-01T10:00:00Z",
    agent: "agent-a",
    entity: "acme",
    aspect: "hq",
    value: "Berlin",
    source: "[[note-a]]",
  });
  appendClaimEvent(vault, {
    ts: "2026-06-05T10:00:00Z",
    agent: "agent-b",
    entity: "acme",
    aspect: "hq",
    value: "Lisbon",
    source: "[[note-b]]",
  });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function conflictFindings() {
  return runHygieneScan(vault, { detectors: ["conflicts"], now: NOW }).findings;
}

/** Write a resolver script answering every conflict with one action. */
function resolverCmd(action: string): string {
  const script = join(vault, "resolver.ts");
  writeFileSync(
    script,
    [
      "const input = await new Response(Bun.stdin.stream()).json();",
      "const verdicts: Record<string, unknown> = {};",
      "for (const conflict of input.conflicts) {",
      `  verdicts[conflict.id] = { action: ${JSON.stringify(action)}, winner_value: conflict.evidence.values.at(-1).value, rationale: "latest independent assertion" };`,
      "}",
      "console.log(JSON.stringify({ verdicts }));",
    ].join("\n"),
    "utf8",
  );
  return `bun ${script}`;
}

describe("resolveConflictFindings", () => {
  test("without a resolver every conflict stays review", () => {
    const findings = conflictFindings();
    const resolved = resolveConflictFindings(vault, findings, {});
    expect(resolved[0]?.proposed_action).toBe("review");
    expect(resolved[0]?.evidence["resolver"]).toBeUndefined();
  });

  test("a supersede verdict upgrades the finding and records evidence", () => {
    const findings = conflictFindings();
    const resolved = resolveConflictFindings(vault, findings, {
      resolverCmd: resolverCmd("supersede"),
    });
    expect(resolved).toHaveLength(1);
    const finding = resolved[0]!;
    expect(finding.proposed_action).toBe("supersede");
    const resolver = finding.evidence["resolver"] as Record<string, unknown>;
    expect(resolver["action"]).toBe("supersede");
    expect(resolver["winner_value"]).toBe("Lisbon");
    expect(resolver["rationale"]).toBe("latest independent assertion");
  });

  test("an invalid verdict action falls back to review", () => {
    const findings = conflictFindings();
    const resolved = resolveConflictFindings(vault, findings, {
      resolverCmd: resolverCmd("delete-everything"),
    });
    expect(resolved[0]?.proposed_action).toBe("review");
  });

  test("a failing resolver is fail-open: review plus the error recorded", () => {
    const findings = conflictFindings();
    const resolved = resolveConflictFindings(vault, findings, { resolverCmd: "exit 7" });
    expect(resolved[0]?.proposed_action).toBe("review");
    expect(String(resolved[0]?.evidence["resolver_error"])).toContain("exited 7");
  });

  test("non-conflict findings pass through untouched", () => {
    const findings = conflictFindings();
    const foreign = { ...findings[0]!, detector: "dedup" as const };
    const resolved = resolveConflictFindings(vault, [foreign], {
      resolverCmd: resolverCmd("supersede"),
    });
    expect(resolved[0]).toBe(foreign);
  });
});

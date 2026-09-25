import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildForgetPlan } from "../../../src/core/brain/governance/forget-plan.ts";
import { PayloadRegistry } from "../../../src/core/brain/payload-registry.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-governance-preview-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("buildForgetPlan", () => {
  test("returns a dry-run manifest for files mentioning a source", () => {
    writeFileSync(
      join(vault, "Brain", "inbox", "sig-2026-05-31-one.md"),
      "---\nid: sig-one\n---\n\nsource: session-a#turn-1\n",
    );
    writeFileSync(
      join(vault, "Brain", "preferences", "pref-one.md"),
      "---\nid: pref-one\n---\n\nEvidenced by session-a#turn-1\n",
    );
    mkdirSync(join(vault, "Brain", "processed-archive"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", "processed-archive", "note.md"),
      "---\nid: archived-note\n---\n\nsource: session-a#turn-1\n",
    );

    const plan = buildForgetPlan(vault, { source: "session-a" });

    expect(plan.mode).toBe("dry-run");
    expect(plan.source).toBe("session-a");
    expect(plan.entries.map((entry) => entry.id).toSorted()).toEqual([
      "archived-note",
      "pref-one",
      "sig-one",
    ]);
    expect(plan.entries.find((entry) => entry.id === "archived-note")?.kind).toBe("other");
    expect(plan.entries.every((entry) => entry.action === "would-remove-source-support")).toBe(
      true,
    );
    expect(plan.audit.contentIncluded).toBe(false);
  });
});

describe("PayloadRegistry", () => {
  test("externalizes oversized payloads and retrieves bounded pages", () => {
    const registry = new PayloadRegistry({ vault, maxInlineChars: 40 });
    const payload = `data:image/png;base64,${"A".repeat(80)}`;

    const result = registry.externalizeOversized(`before ${payload} after`);

    expect(result.text).not.toContain("A".repeat(80));
    expect(result.payloads).toHaveLength(1);
    expect(result.payloads[0]!.placeholder).toContain("osb-payload://");
    const page = registry.get(result.payloads[0]!.ref, {
      offset: 0,
      limit: 22,
    });
    expect(page.content).toBe("data:image/png;base64,");
    expect(page.nextOffset).toBe(22);
  });

  test("externalizes data URIs without consuming markdown delimiters", () => {
    const registry = new PayloadRegistry({ vault, maxInlineChars: 40 });
    const payload = `data:image/png;base64,${"A".repeat(80)}`;

    const result = registry.externalizeOversized(`![diagram](${payload})`);

    expect(result.payloads).toHaveLength(1);
    expect(result.text).toEndWith(")");
    expect(result.text).toContain(result.payloads[0]!.placeholder);
  });
});

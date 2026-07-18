import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFrontmatter } from "../../../../src/core/vault.ts";
import { packContext } from "../../../../src/core/brain/context-pack.ts";
import { deriveTrust } from "../../../../src/core/search/enrich.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-chain-consumer-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writePref(slug: string, extra: Record<string, string> = {}): void {
  writeFrontmatter(
    join(vault, "Brain", "preferences", `pref-${slug}.md`),
    {
      kind: "brain-preference",
      id: `pref-${slug}`,
      _status: "confirmed",
      topic: slug,
      principle: `principle ${slug}`,
      tags: ["brain"],
      created_at: "2026-01-01T00:00:00Z",
      unconfirmed_until: "2026-02-01T00:00:00Z",
      _confidence: "high",
      ...extra,
    },
    `Body for ${slug}.`,
  );
}

test("a chain of three superseding memories injects only the tip by default", () => {
  writePref("a", { superseded_by: "[[pref-b]]" });
  writePref("b", { superseded_by: "[[pref-c]]" });
  writePref("c");

  const report = packContext(vault, { maxTokens: 5000 });
  const ids = report.items.map((i) => i.id);
  expect(ids).toContain("pref-c");
  expect(ids).not.toContain("pref-a");
  expect(ids).not.toContain("pref-b");
});

test("the explicit historical flag keeps the whole chain", () => {
  writePref("a", { superseded_by: "[[pref-b]]" });
  writePref("b", { superseded_by: "[[pref-c]]" });
  writePref("c");

  const report = packContext(vault, { maxTokens: 5000, includeHistorical: true });
  const ids = report.items.map((i) => i.id).toSorted();
  expect(ids).toEqual(["pref-a", "pref-b", "pref-c"]);
});

test("non-chain memories inject byte-identically with and without tip preference", () => {
  writePref("x");
  writePref("y");

  const def = packContext(vault, { maxTokens: 5000 })
    .items.map((i) => i.id)
    .toSorted();
  const hist = packContext(vault, { maxTokens: 5000, includeHistorical: true })
    .items.map((i) => i.id)
    .toSorted();
  expect(def).toEqual(["pref-x", "pref-y"]);
  expect(hist).toEqual(def);
});

test("recall trust carries a pointer to the replacement for a superseded hit", () => {
  const trust = deriveTrust({
    mtimeMs: 0,
    nowMs: 0,
    relations: [{ relation: "superseded_by", target: "pref-new" }],
  });
  expect(trust.superseded).toBe(true);
  expect(trust.replacement).toBe("pref-new");
});

test("recall trust replacement is null for a non-superseded hit", () => {
  const trust = deriveTrust({ mtimeMs: 0, nowMs: 0 });
  expect(trust.superseded).toBe(false);
  expect(trust.replacement).toBeNull();
});

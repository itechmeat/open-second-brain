/**
 * Owner-scope isolation on the preference-backed delivery surfaces
 * (context-integrity-gates, Unit A / Task 6).
 *
 * The load-bearing assertion is the FIRST one: with
 * `integrity.owner_scope_delivery` absent or `off`, every surface is
 * byte-identical whether or not a scope is requested. Every module on
 * this path documents a "a null scope is byte-identical to today"
 * contract, so a gate that narrowed by default would be a breaking
 * change disguised as a fix.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GATE_MODE } from "../../../src/core/integrity/stamp.ts";
import { renderActive } from "../../../src/core/brain/active.ts";
import { anticipatoryCachePath } from "../../../src/core/brain/anticipatory-cache.ts";
import { packContext } from "../../../src/core/brain/context-pack.ts";
import { renderDigest } from "../../../src/core/brain/digest.ts";
import { buildMorningBrief } from "../../../src/core/brain/morning-brief.ts";
import { brainConfigPath, brainDirs } from "../../../src/core/brain/paths.ts";
import { buildPreCompressPack } from "../../../src/core/brain/pre-compress-pack.ts";
import { moveToRetired, writePreference } from "../../../src/core/brain/preference.ts";
import { preferencePath } from "../../../src/core/brain/paths.ts";
import {
  collectPreferencePages,
  collectPreferences,
  resolveOwnerScopeDelivery,
  type OwnerScopeDelivery,
} from "../../../src/core/brain/preferences-collect.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../../src/core/brain/types.ts";

const OWNER_A = "agent-a";
const OWNER_B = "agent-b";
const NOW = new Date("2026-05-10T00:00:00Z");
/**
 * The identity the WRITER resolves to for this file.
 *
 * Pinned because `writePreference` refuses to stamp a placeholder
 * (a-label-is-not-a-boundary, U3): with no `agent_name` configured,
 * `resolveAgentName` answers `"agent"`, which owner-scope delivery
 * refuses as an unverifiable identity and therefore also refuses as an
 * owner. Unpinned, the `warn` case below wrote pages owned by the
 * literal `agent` - the state no caller can ever be shown to own.
 */
const WRITER = "agent-writer";

let vault: string;
let savedAgentName: string | undefined;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-owner-delivery-"));
  for (const sub of ["preferences", "retired", "inbox", "log"]) {
    mkdirSync(join(vault, "Brain", sub), { recursive: true });
  }
  savedAgentName = process.env["VAULT_AGENT_NAME"];
  process.env["VAULT_AGENT_NAME"] = WRITER;
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  if (savedAgentName === undefined) delete process.env["VAULT_AGENT_NAME"];
  else process.env["VAULT_AGENT_NAME"] = savedAgentName;
});

function setGate(mode: string | null): void {
  const body = mode === null ? "" : `integrity:\n  owner_scope_delivery: ${mode}\n`;
  writeFileSync(brainConfigPath(vault), `schema_version: 1\n${body}`);
}

function makePref(slug: string, owner?: string): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `principle for ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [`[[sig-2026-05-01-${slug}]]`],
    confirmed_at: "2026-05-02T00:00:00Z",
    applied_count: 1,
    violated_count: 0,
    last_evidence_at: "2026-05-02T00:00:00Z",
    confidence: BRAIN_CONFIDENCE.high,
    confidence_value: 0.8,
    ...(owner !== undefined ? { owner } : {}),
  });
}

/** Every preference-backed delivery surface, rendered as comparable text. */
function renderAll(agentScope?: string): Record<string, string> {
  // The DELIVERY surface for active.md is the render, never the write:
  // `regenerateActive` writes one shared file for the whole vault.
  const active = renderActive(vault, { now: NOW, ...scopeArg(agentScope) });
  return {
    pack: JSON.stringify(
      packContext(vault, { maxTokens: 4000, ...scopeArg(agentScope) }).items.map((i) => i.id),
    ),
    preCompress: buildPreCompressPack(vault, { topK: 10, ...scopeArg(agentScope) }).text,
    morningBrief: buildMorningBrief(vault, { now: NOW, topK: 10, ...scopeArg(agentScope) }).text,
    digest: renderDigest(vault, {
      now: NOW,
      until: NOW,
      format: "json",
      ...scopeArg(agentScope),
    }).content,
    active: JSON.stringify(active.counts),
  };
}

/** A gate verdict that actually withholds, i.e. `fail` with a scope. */
function enforcing(scope: string): OwnerScopeDelivery {
  return { mode: GATE_MODE.fail, enforcedScope: scope, requestedScope: scope };
}

function scopeArg(agentScope?: string): { agentScope?: string } {
  return agentScope === undefined ? {} : { agentScope };
}

test("gate absent: a requested scope changes nothing on any surface", () => {
  setGate(null);
  makePref("shared");
  makePref("owned-by-a", OWNER_A);

  const unscoped = renderAll();
  expect(renderAll(OWNER_B)).toEqual(unscoped);
  expect(renderAll(OWNER_A)).toEqual(unscoped);
  // Sanity: the owned preference really is on the surfaces being compared.
  expect(unscoped["pack"]).toContain("pref-owned-by-a");
});

test("gate off: explicit off behaves exactly like an absent block", () => {
  setGate(GATE_MODE.off);
  makePref("shared");
  makePref("owned-by-a", OWNER_A);

  expect(renderAll(OWNER_B)).toEqual(renderAll());
});

test("gate fail: another owner's preference is absent from every surface", () => {
  // The shared preference is written BEFORE the gate goes on, because
  // that is the only way a shared one comes to exist: with the gate on,
  // every new preference is stamped with the identity of the agent that
  // wrote it, and a page created before the gate stays shared rather than
  // being retro-owned by whoever rewrites it first.
  makePref("shared");
  setGate(GATE_MODE.fail);
  makePref("owned-by-a", OWNER_A);

  const asB = renderAll(OWNER_B);
  for (const [surface, text] of Object.entries(asB)) {
    if (surface === "active") continue; // counts only; asserted below
    expect(text).not.toContain("owned-by-a");
    expect(text).toContain("shared");
  }
  expect(JSON.parse(asB["active"]!).confirmed).toBe(1);

  const asA = renderAll(OWNER_A);
  expect(asA["pack"]).toContain("pref-owned-by-a");
  expect(asA["pack"]).toContain("pref-shared");
  expect(JSON.parse(asA["active"]!).confirmed).toBe(2);
});

test("gate fail with no scope requested still delivers everything", () => {
  // The shared preference is written BEFORE the gate goes on, because
  // that is the only way a shared one comes to exist: with the gate on,
  // every new preference is stamped with the identity of the agent that
  // wrote it, and a page created before the gate stays shared rather than
  // being retro-owned by whoever rewrites it first.
  makePref("shared");
  setGate(GATE_MODE.fail);
  makePref("owned-by-a", OWNER_A);

  expect(renderAll()["pack"]).toContain("pref-owned-by-a");
});

test("gate warn reports the isolation without withholding anything", () => {
  setGate(GATE_MODE.warn);
  makePref("shared");
  makePref("owned-by-a", OWNER_A);

  const warned = packContext(vault, { maxTokens: 4000, agentScope: OWNER_B });
  expect(warned.items.map((i) => i.id)).toContain("pref-owned-by-a");
  expect((warned.warnings ?? []).join("\n")).toContain("owner");

  const off = packContext(vault, { maxTokens: 4000 });
  expect(off.warnings).toBeUndefined();
});

test("resolveOwnerScopeDelivery narrows only under fail", () => {
  setGate(GATE_MODE.fail);
  expect(resolveOwnerScopeDelivery(vault, OWNER_A).enforcedScope).toBe(OWNER_A);
  expect(resolveOwnerScopeDelivery(vault, undefined).enforcedScope).toBeNull();

  setGate(GATE_MODE.warn);
  expect(resolveOwnerScopeDelivery(vault, OWNER_A).enforcedScope).toBeNull();
  expect(resolveOwnerScopeDelivery(vault, OWNER_A).requestedScope).toBe(OWNER_A);

  setGate(GATE_MODE.off);
  expect(resolveOwnerScopeDelivery(vault, OWNER_A).enforcedScope).toBeNull();
  expect(resolveOwnerScopeDelivery(vault, OWNER_A).requestedScope).toBeNull();
});

test("the collector drops an unreadable page under an active scope", () => {
  const dir = brainDirs(vault).preferences;
  makePref("shared");
  // A directory named like a note: readable as an entry, unreadable as a file.
  mkdirSync(join(dir, "pref-unreadable.md"));

  const open = collectPreferencePages(dir);
  expect(open.entries.map((e) => e.name)).toContain("pref-unreadable.md");

  const closed = collectPreferencePages(dir, { ownerScope: enforcing(OWNER_B) });
  expect(closed.entries.map((e) => e.name)).not.toContain("pref-unreadable.md");
  expect(closed.entries.map((e) => e.name)).toContain("pref-shared.md");
});

test("the collector counts what an active scope removed", () => {
  const dir = brainDirs(vault).preferences;
  makePref("shared");
  makePref("owned-by-a", OWNER_A);

  expect(collectPreferences(dir, { ownerScope: enforcing(OWNER_B) }).hiddenByOwnerScope).toBe(1);
  expect(collectPreferences(dir, { ownerScope: enforcing(OWNER_A) }).hiddenByOwnerScope).toBe(0);
  expect(collectPreferences(dir).hiddenByOwnerScope).toBe(0);
});

test("an ownerless preference is visible under every scope", () => {
  const dir = brainDirs(vault).preferences;
  makePref("shared");

  for (const scope of [null, OWNER_A, OWNER_B]) {
    const collected = collectPreferences(dir, {
      ownerScope: scope === null ? null : enforcing(scope),
    });
    expect(collected.entries.map((e) => e.pref.id)).toEqual(["pref-shared"]);
  }
});

test("the anticipatory cache path is distinct per owner scope under `fail`", () => {
  setGate(GATE_MODE.fail);
  const none = anticipatoryCachePath(vault, "root-1");
  const a = anticipatoryCachePath(vault, "root-1", OWNER_A);
  const b = anticipatoryCachePath(vault, "root-1", OWNER_B);

  expect(new Set([none, a, b]).size).toBe(3);
  // An absent scope keeps the legacy path so warm caches are not orphaned.
  expect(anticipatoryCachePath(vault, "root-1", null)).toBe(none);
});

/**
 * The key follows the ENFORCED scope, not the requested one. Under `off`
 * and `warn` the pack is not narrowed, so a per-scope filename would only
 * split one identical payload across N files - and, because the MCP tool
 * always passes a scope while the hook writers never do, would turn every
 * MCP read into a permanent miss (context-integrity-gates, A4).
 */
for (const mode of [null, GATE_MODE.off, GATE_MODE.warn]) {
  test(`the anticipatory cache path ignores the requested scope under ${mode ?? "an absent gate"}`, () => {
    setGate(mode);
    const none = anticipatoryCachePath(vault, "root-1");
    expect(anticipatoryCachePath(vault, "root-1", OWNER_A)).toBe(none);
    expect(anticipatoryCachePath(vault, "root-1", OWNER_B)).toBe(none);
  });
}

// ----- A7: retirement KEEPS ownership -------------------------------------

/**
 * Retiring a memory must not PUBLISH it. Before this fix the wave answered
 * the question three ways: the agent-source provider kept the owner, while
 * `active.md`'s recently-retired list, the digest's retired section, and
 * `brain_query` all treated a retired record as shared - because
 * `BrainRetired` carried no `owner` field, so the visibility predicate was
 * trivially true for it.
 */
test("a retired memory keeps its owner on every delivery surface", () => {
  // The shared preference is written BEFORE the gate goes on, because
  // that is the only way a shared one comes to exist: with the gate on,
  // every new preference is stamped with the identity of the agent that
  // wrote it, and a page created before the gate stays shared rather than
  // being retro-owned by whoever rewrites it first.
  makePref("shared");
  setGate(GATE_MODE.fail);
  makePref("owned-by-a", OWNER_A);
  moveToRetired(vault, preferencePath(vault, "owned-by-a"), "stale-no-evidence", {
    now: NOW,
    retired_by: "[[Brain/log/2026-05-10]]",
  });

  const asB = renderActive(vault, { now: NOW, agentScope: OWNER_B });
  expect(asB.document).not.toContain("owned-by-a");
  expect(asB.counts.retired_recent).toBe(0);
  expect(
    renderDigest(vault, { now: NOW, until: NOW, format: "json", agentScope: OWNER_B }).content,
  ).not.toContain("owned-by-a");

  // Its own owner still sees it - the memory is withheld, not destroyed.
  const asA = renderActive(vault, { now: NOW, agentScope: OWNER_A });
  expect(asA.document).toContain("ret-owned-by-a");
  expect(asA.counts.retired_recent).toBe(1);
});

test("with the gate off a retired memory reaches every caller as before", () => {
  setGate(GATE_MODE.off);
  makePref("owned-by-a", OWNER_A);
  moveToRetired(vault, preferencePath(vault, "owned-by-a"), "stale-no-evidence", {
    now: NOW,
    retired_by: "[[Brain/log/2026-05-10]]",
  });

  const asB = renderActive(vault, { now: NOW, agentScope: OWNER_B });
  expect(asB.document).toContain("ret-owned-by-a");
  expect(asB.counts.retired_recent).toBe(1);
});

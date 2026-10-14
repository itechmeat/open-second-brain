/**
 * Opt-in standing-instruction facets on the `standing_query` attention
 * action (recall lane).
 *
 * With the facet option unset, every emitted string is the legacy
 * `pref-<slug> (scope)` output, byte for byte, and sections carry no
 * facet data at all. With it set, a surfaced preference whose
 * provenance join resolves gains an earliest-cited annotation on its item
 * string plus a structured facet entry; a preference whose join does
 * not resolve keeps the plain string and is absent from `facets` — an
 * honestly-unresolved preference, never an implied provenance.
 *
 * The facet option changes annotations, never membership: the set of
 * preferences a section names is identical with the option on and off,
 * so a facet can never make a withheld preference visible. The
 * import-session fixture below is written by the LIVE import writer
 * (`importSession` over the checked-in claude fixture), so the joined
 * `session_ref` shape is the one production emits, not a hand-written
 * stand-in.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import {
  attentionFlowsDir,
  brainDirs,
  brainScopedRulePath,
  brainStandingRulesPath,
} from "../../../src/core/brain/paths.ts";
import { writeFrontmatterAtomic } from "../../../src/core/vault.ts";
import { moveToRetired, writePreference } from "../../../src/core/brain/preference.ts";
import { parseSignal, writeSignal } from "../../../src/core/brain/signal.ts";
import { importSession } from "../../../src/core/brain/sessions/import.ts";
import { BRAIN_RETIRED_REASON } from "../../../src/core/brain/types.ts";
import {
  buildAttentionContextBlock,
  evaluateAttentionFlow,
  renderAttentionFlow,
} from "../../../src/core/brain/attention-flows.ts";
import { changedPaths, digestVaultFiles, digestVaultTree } from "../../helpers/vault-digest.ts";

const CLAUDE = resolve("tests/fixtures/sessions/claude-minimal.jsonl");
const NOW = new Date("2026-06-01T00:00:00Z");

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-facet-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-facet-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function writeConfirmed(slug: string, scope: string, evidenced_by: string[], owner?: string): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `rule ${slug}`,
    created_at: "2026-06-01T00:00:00Z",
    unconfirmed_until: "2026-07-01T00:00:00Z",
    confirmed_at: "2026-06-02T00:00:00Z",
    status: "confirmed",
    evidenced_by,
    scope,
    ...(owner !== undefined ? { owner } : {}),
  });
}

function writeStandingFlow(scopes: string[]): void {
  writeFrontmatterAtomic(
    join(attentionFlowsDir(vault), "loops.md"),
    {
      kind: "brain-attention-flow",
      id: "loops",
      title: "Open loops",
      actions: ["standing_query"],
      standing_queries: scopes,
      status: "active",
    },
    "# Open loops",
    { overwrite: true },
  );
}

/**
 * Run the LIVE session-import writer over the checked-in claude fixture
 * and return the written signal's id and session_ref. The marker turn
 * (`turn-user-1`) emits the feedback signal whose ref is composed as
 * `${sessionKey}#${turnId}` with the portable basename key.
 */
async function importFixtureSignal(): Promise<{ id: string; session_ref: string }> {
  const res = await importSession(vault, CLAUDE, { agent: "test", now: NOW });
  expect(res.signals_created).toBeGreaterThan(0);
  const inbox = brainDirs(vault).inbox;
  const found: { id: string; session_ref: string }[] = [];
  for (const name of readdirSync(inbox).toSorted()) {
    if (!name.endsWith(".md")) continue;
    const signal = parseSignal(join(inbox, name));
    if (signal.session_ref !== undefined && signal.session_ref.endsWith("#turn-user-1")) {
      found.push({ id: signal.id, session_ref: signal.session_ref });
    }
  }
  expect(found.length).toBe(1);
  return found[0]!;
}

/** A capture-lifecycle-shaped signal: `session:<id>#<event>` (lifecycle.ts:858). */
function writeLifecycleSignal(): string {
  return writeSignal(vault, {
    topic: "lifecycle-rule",
    signal: "positive",
    agent: "test",
    principle: "greet before asking",
    created_at: "2026-06-01T00:00:00Z",
    date: "2026-06-01",
    slug: "lifecycle-rule",
    scope: "testing",
    session_ref: "session:00000000-0000-0000-0000-000000000003#UserPromptSubmit",
    source: ["[[session:00000000-0000-0000-0000-000000000003#UserPromptSubmit]]"],
  }).id;
}

/** An auto-extract-shaped signal: a bare session id, no fragment (extract-signals.ts:646). */
function writeBareSignal(): string {
  return writeSignal(vault, {
    topic: "bare-rule",
    signal: "positive",
    agent: "test",
    principle: "prefer small commits",
    created_at: "2026-06-01T00:00:00Z",
    date: "2026-06-01",
    slug: "bare-rule",
    scope: "testing",
    session_ref: "session:conv-02",
    source: ["[[session:conv-02]]"],
  }).id;
}

function standingSection(evaluation: ReturnType<typeof evaluateAttentionFlow>) {
  const section = evaluation.sections.find((s) => s.action === "standing_query");
  expect(section).toBeDefined();
  return section!;
}

/** Strip an earliest-cited annotation, leaving the legacy `id (scope)` string. */
function stripAnnotation(item: string): string {
  return item.split(" [earliest cited ")[0]!;
}

describe("standing-instruction facets: opt-in gate", () => {
  test("with the option unset the items are the legacy strings and carry no facet data", async () => {
    const ref = await importFixtureSignal();
    expect(ref.session_ref).toBe("claude-minimal.jsonl#turn-user-1");
    writeConfirmed("imported", "testing", [`[[${ref.id}]]`]);
    writeStandingFlow(["testing"]);

    const section = standingSection(evaluateAttentionFlow(vault, "loops"));
    expect(section.items).toEqual(["pref-imported (testing)"]);
    expect(Object.hasOwn(section, "facets")).toBe(false);
  });

  test("the option changes annotations, never membership", async () => {
    const ref = await importFixtureSignal();
    writeConfirmed("secret", "testing", [`[[${ref.id}]]`], "alice");
    writeStandingFlow(["testing"]);

    const off = standingSection(evaluateAttentionFlow(vault, "loops"));
    const on = standingSection(
      evaluateAttentionFlow(vault, "loops", { standingInstructionFacets: true }),
    );
    // Same preference ids on both sides: the facet annotates what the
    // lane already delivers and admits nothing new.
    expect(on.items.map(stripAnnotation)).toEqual([...off.items]);
    expect(off.items).toEqual(["pref-secret (testing)"]);
    expect(on.items).toEqual([
      "pref-secret (testing) [earliest cited turn claude-minimal.jsonl#turn-user-1]",
    ]);
  });
});

describe("standing-instruction facets: provenance annotation", () => {
  test("only preferences whose join resolves gain annotations and facet entries", async () => {
    const ref = await importFixtureSignal();
    const lifecycleId = writeLifecycleSignal();
    const bareId = writeBareSignal();
    writeConfirmed("imported", "testing", [`[[${ref.id}]]`]);
    writeConfirmed("lifecycle", "testing", [`[[${lifecycleId}]]`]);
    writeConfirmed("bare", "testing", [`[[${bareId}]]`]);
    writeConfirmed("noevidence", "testing", []);
    writeStandingFlow(["testing"]);

    const section = standingSection(
      evaluateAttentionFlow(vault, "loops", { standingInstructionFacets: true }),
    );
    // Items stay in filename order; the bare auto-extract ref resolves
    // to no origin, so that preference keeps the plain string.
    expect(section.items).toEqual([
      "pref-bare (testing)",
      "pref-imported (testing) [earliest cited turn claude-minimal.jsonl#turn-user-1]",
      "pref-lifecycle (testing) [earliest cited session session:00000000-0000-0000-0000-000000000003#UserPromptSubmit]",
      "pref-noevidence (testing)",
    ]);
    expect(section.facets).toEqual([
      {
        key: "pref:pref-imported",
        preferenceId: "pref-imported",
        scope: "testing",
        origins: [{ sessionKey: "claude-minimal.jsonl", fragment: "turn-user-1", kind: "turn" }],
      },
      {
        key: "pref:pref-lifecycle",
        preferenceId: "pref-lifecycle",
        scope: "testing",
        origins: [
          {
            sessionKey: "session:00000000-0000-0000-0000-000000000003",
            fragment: "UserPromptSubmit",
            kind: "session",
          },
        ],
      },
    ]);
  });

  test("a retired preference is never annotated back into view", async () => {
    const ref = await importFixtureSignal();
    writeConfirmed("doomed", "testing", [`[[${ref.id}]]`]);
    writeStandingFlow(["testing"]);
    moveToRetired(
      vault,
      join(brainDirs(vault).preferences, "pref-doomed.md"),
      BRAIN_RETIRED_REASON.rebutted,
      {
        now: NOW,
        retired_by: "test",
      },
    );

    const section = standingSection(
      evaluateAttentionFlow(vault, "loops", { standingInstructionFacets: true }),
    );
    expect(section.items).toEqual([]);
    expect(section.facets).toEqual([]);
  });

  test("a population where nothing resolves reports zero resolved facets", async () => {
    const bareId = writeBareSignal();
    writeConfirmed("bare", "testing", [`[[${bareId}]]`]);
    writeConfirmed("quiet", "testing", ["[[sig-2026-05-01-missing]]"]);
    writeConfirmed("empty", "testing", []);
    writeStandingFlow(["testing"]);

    const section = standingSection(
      evaluateAttentionFlow(vault, "loops", { standingInstructionFacets: true }),
    );
    expect(section.items).toEqual([
      "pref-bare (testing)",
      "pref-empty (testing)",
      "pref-quiet (testing)",
    ]);
    expect(section.facets).toEqual([]);
  });
});

describe("standing-instruction facets: lane invariants", () => {
  /** Preference ids named by a section's items, annotations and scopes stripped. */
  function itemIds(section: ReturnType<typeof standingSection>): string[] {
    return section.items.map((item) => stripAnnotation(item).split(" (")[0]!);
  }

  test("the whole lane performs zero writes on a fully populated vault", async () => {
    const ref = await importFixtureSignal();
    const lifecycleId = writeLifecycleSignal();
    // The operator-authored layers the lane must never touch, plus the
    // preference populations it reads.
    writeFileSync(brainStandingRulesPath(vault), "# Standing rules\n\nnever force push\n", "utf8");
    mkdirSync(join(brainScopedRulePath(vault, "project", "release"), ".."), { recursive: true });
    writeFileSync(
      brainScopedRulePath(vault, "project", "release"),
      "# Scoped rule\n\ntag before merge\n",
      "utf8",
    );
    writeConfirmed("imported", "testing", [`[[${ref.id}]]`]);
    writeConfirmed("lifecycle", "testing", [`[[${lifecycleId}]]`]);
    writeConfirmed("secret", "testing", ["[[sig-2026-05-01-missing]]"], "alice");
    writeConfirmed("quiet", "testing", []);
    writeStandingFlow(["testing"]);

    // Warm-up: the one-time lazy default-flow bootstrap is pre-existing
    // behavior outside this lane; settle it BEFORE the guarded window.
    evaluateAttentionFlow(vault, "loops");

    const beforeFiles = digestVaultFiles(vault);
    const before = digestVaultTree(vault);
    evaluateAttentionFlow(vault, "loops");
    evaluateAttentionFlow(vault, "loops", { standingInstructionFacets: true });
    renderAttentionFlow(vault, "loops");
    buildAttentionContextBlock(vault, ["loops"]);
    // The per-file digests cover every byte of every file and every
    // path name, so a created, deleted, or edited file anywhere under
    // the vault fails this assertion - including the standing rules,
    // the scoped rule, and any preference file.
    expect(changedPaths(beforeFiles, digestVaultFiles(vault))).toEqual([]);
    expect(digestVaultTree(vault)).toBe(before);
  });

  test("facet output never includes a preference the caller could not already see", async () => {
    const ref = await importFixtureSignal();
    const bareId = writeBareSignal();
    writeConfirmed("imported", "testing", [`[[${ref.id}]]`]);
    writeConfirmed("secret", "testing", [`[[${ref.id}]]`], "alice");
    writeConfirmed("bare", "testing", [`[[${bareId}]]`]);
    writeConfirmed("doomed", "testing", [`[[${ref.id}]]`]);
    moveToRetired(
      vault,
      join(brainDirs(vault).preferences, "pref-doomed.md"),
      BRAIN_RETIRED_REASON.rebutted,
      { now: NOW, retired_by: "test" },
    );
    writeStandingFlow(["testing"]);

    const off = itemIds(standingSection(evaluateAttentionFlow(vault, "loops")));
    const on = standingSection(
      evaluateAttentionFlow(vault, "loops", { standingInstructionFacets: true }),
    );
    // The retired preference is in neither; every facet names a
    // preference the unset lane already delivered.
    const visible = new Set(off);
    expect(off).toEqual(["pref-bare", "pref-imported", "pref-secret"]);
    for (const facet of on.facets!) {
      expect(visible.has(facet.preferenceId)).toBe(true);
    }
    expect(on.facets!.map((f) => f.preferenceId)).toEqual(["pref-imported", "pref-secret"]);
  });

  test("the resolved count is honest in a mixed population", async () => {
    const ref = await importFixtureSignal();
    const bareId = writeBareSignal();
    writeConfirmed("imported", "testing", [`[[${ref.id}]]`]);
    writeConfirmed("bare", "testing", [`[[${bareId}]]`]);
    writeConfirmed("quiet", "testing", []);
    writeStandingFlow(["testing"]);

    const section = standingSection(
      evaluateAttentionFlow(vault, "loops", { standingInstructionFacets: true }),
    );
    // Exactly the preferences whose join resolved, and not one more:
    // three surfaced items, one facet, the rest reported unresolved.
    expect(itemIds(section)).toEqual(["pref-bare", "pref-imported", "pref-quiet"]);
    expect(section.facets!.length).toBe(1);
    expect(section.facets!.map((f) => f.preferenceId)).toEqual(["pref-imported"]);
  });
});

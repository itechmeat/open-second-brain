/**
 * Name-aware merge guard (t_e9692750): refuse merging two notes whose
 * person/org entity anchors are disjoint non-empty sets - "Alice
 * decided X" must never collapse into "Bob decided X". Notes with no
 * guarded anchors or overlapping anchors merge exactly as today.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { upsertEntity } from "../../../../src/core/brain/entities/registry.ts";
import { BrainMergeError, mergePreferences } from "../../../../src/core/brain/merge.ts";
import {
  writePreference,
  type WritePreferenceInput,
} from "../../../../src/core/brain/preference.ts";
import {
  GUARDED_ENTITY_CATEGORIES,
  guardEntityMerge,
  type GuardEntityLike,
} from "../../../../src/core/brain/truth/merge-guard.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../../../src/core/brain/types.ts";

const NOW = new Date("2026-06-01T10:00:00Z");

function person(id: string, name: string, aliases: string[] = []): GuardEntityLike {
  return { id, category: "people", name, aliases, status: "active" };
}

describe("guardEntityMerge (pure)", () => {
  const alice = person("ent-people-alice-mason", "Alice Mason", ["Alice"]);
  const bob = person("ent-people-bob-hale", "Bob Hale", ["Bob"]);

  test("disjoint person anchors block with an explainable reason", () => {
    const verdict = guardEntityMerge({
      keepText: "Alice Mason decided to ship on Friday",
      dropText: "Bob Hale decided to ship on Friday",
      entities: [alice, bob],
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("ent-people-alice-mason");
    expect(verdict.reason).toContain("ent-people-bob-hale");
    expect(verdict.keepAnchors).toEqual(["ent-people-alice-mason"]);
    expect(verdict.dropAnchors).toEqual(["ent-people-bob-hale"]);
  });

  test("overlapping anchors are allowed", () => {
    const verdict = guardEntityMerge({
      keepText: "Alice and Bob agreed on the deploy window",
      dropText: "Bob Hale confirmed the deploy window",
      entities: [alice, bob],
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBeNull();
  });

  test("notes with no guarded anchors are allowed", () => {
    const verdict = guardEntityMerge({
      keepText: "Use spaces over tabs",
      dropText: "Spaces are preferred over tabs",
      entities: [alice, bob],
    });
    expect(verdict.allowed).toBe(true);
  });

  test("alias mentions anchor like canonical names", () => {
    const verdict = guardEntityMerge({
      keepText: "Alice prefers staged rollouts",
      dropText: "Bob prefers staged rollouts",
      entities: [alice, bob],
    });
    expect(verdict.allowed).toBe(false);
  });

  test("non-guarded categories never block by default but can opt in", () => {
    const projectA: GuardEntityLike = {
      id: "ent-project-atlas",
      category: "project",
      name: "Atlas",
      aliases: [],
      status: "active",
    };
    const projectB: GuardEntityLike = {
      id: "ent-project-borealis",
      category: "project",
      name: "Borealis",
      aliases: [],
      status: "active",
    };
    const def = guardEntityMerge({
      keepText: "Atlas ships next week",
      dropText: "Borealis ships next week",
      entities: [projectA, projectB],
    });
    expect(def.allowed).toBe(true);
    const optIn = guardEntityMerge({
      keepText: "Atlas ships next week",
      dropText: "Borealis ships next week",
      entities: [projectA, projectB],
      categories: ["project"],
    });
    expect(optIn.allowed).toBe(false);
  });

  test("archived entities never anchor", () => {
    const gone: GuardEntityLike = { ...bob, status: "archived" };
    const verdict = guardEntityMerge({
      keepText: "Alice decided X",
      dropText: "Bob Hale decided X",
      entities: [alice, gone],
    });
    expect(verdict.allowed).toBe(true);
  });

  // Separator-tolerant twins (note-change truth maintenance, F3): the
  // guard shares the anchoring kernels' match-form rule, so its inclusion
  // test folds separator runs on both sides, matches a slug-prefixed form
  // at the path-segment boundary, and never anchors a mid-word mention.

  test("separator-folded mentions anchor across hyphen and underscore spellings", () => {
    const ada = person("ent-people-ada-lovelace", "Ada-Lovelace", ["ada_lovelace"]);
    const verdict = guardEntityMerge({
      keepText: "Ada Lovelace decided to ship on Friday",
      dropText: "Bob Hale decided to ship on Friday",
      entities: [ada, bob],
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.keepAnchors).toEqual(["ent-people-ada-lovelace"]);
    expect(verdict.dropAnchors).toEqual(["ent-people-bob-hale"]);
  });

  test("a slug-prefixed alias matches through its last path segment", () => {
    // The "***" name matches nothing, so only the slug-prefixed alias -
    // via its "ada lovelace" tail - can anchor the first entity.
    const weird = person("ent-people-ada-lovelace", "***", ["people/ada_lovelace"]);
    const verdict = guardEntityMerge({
      keepText: "Ada Lovelace decided to ship on Friday",
      dropText: "Bob Hale decided to ship on Friday",
      entities: [weird, bob],
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.keepAnchors).toEqual(["ent-people-ada-lovelace"]);
  });

  test("a mid-word mention never anchors (canada never anchors ada)", () => {
    const ada = person("ent-people-ada", "Ada");
    const verdict = guardEntityMerge({
      keepText: "Canada approved the rollout",
      dropText: "Bob Hale approved the rollout",
      entities: [ada, bob],
    });
    expect(verdict.keepAnchors).toEqual([]);
    expect(verdict.allowed).toBe(true);
  });

  test("CJK names fire the protected-name path (no-space scripts anchor)", () => {
    // Kana particles touch the names directly - a script written without
    // word spaces suspends the boundary rule, so both sides anchor and a
    // disjoint CJK pair blocks the merge exactly like a Latin one.
    const tanaka = person("ent-people-tanaka-taro", "田中太郎");
    const suzuki = person("ent-people-suzuki-hanako", "鈴木花子");
    const verdict = guardEntityMerge({
      keepText: "田中太郎は出張を決めた",
      dropText: "鈴木花子は出張を決めた",
      entities: [tanaka, suzuki],
    });
    expect(verdict.keepAnchors).toEqual(["ent-people-tanaka-taro"]);
    expect(verdict.dropAnchors).toEqual(["ent-people-suzuki-hanako"]);
    expect(verdict.allowed).toBe(false);
  });

  test("inflected Russian names fire the protected-name path (leading-only boundary)", () => {
    // H1 (PR 268 review): Russian attaches case endings to names with no
    // space - "Ивана", "Петра" - and the two-sided boundary rule silenced
    // both sides, letting claims about different people collapse. The
    // leading-only rule keeps the veto: each side anchors its own person
    // through the inflected spelling and the sets are disjoint.
    const ivan = person("ent-people-ivan", "Иван");
    const petr = person("ent-people-petr", "Петр");
    const verdict = guardEntityMerge({
      keepText: "Ивана повысили до директора",
      dropText: "Петра повысили до директора",
      entities: [ivan, petr],
    });
    expect(verdict.keepAnchors).toEqual(["ent-people-ivan"]);
    expect(verdict.dropAnchors).toEqual(["ent-people-petr"]);
    expect(verdict.allowed).toBe(false);
  });

  test("a slash-bearing company name no longer anchors through its bare tail", () => {
    // M1 (PR 268 review): the slug tail fired on ANY slash-containing
    // name, so keep "Bob Chappell left the firm" also anchored the
    // Warner/Chappell organization through the tail "chappell", the
    // anchor sets overlapped, and the merge was allowed. The tail is
    // minted only from a registry entity-type folder prefix, so the
    // person and the organization stay disjoint and the veto holds.
    const bob = person("ent-people-bob-chappell", "Bob Chappell");
    const warner: GuardEntityLike = {
      id: "ent-company-warner-chappell",
      category: "company",
      name: "Warner/Chappell",
      aliases: [],
      status: "active",
    };
    const verdict = guardEntityMerge({
      keepText: "Bob Chappell left the firm",
      dropText: "Warner/Chappell left the firm",
      entities: [bob, warner],
    });
    expect(verdict.keepAnchors).toEqual(["ent-people-bob-chappell"]);
    expect(verdict.dropAnchors).toEqual(["ent-company-warner-chappell"]);
    expect(verdict.allowed).toBe(false);
  });

  test("default guarded categories cover people and orgs", () => {
    expect(GUARDED_ENTITY_CATEGORIES).toContain("people");
    expect(GUARDED_ENTITY_CATEGORIES).toContain("org");
  });
});

describe("mergePreferences integration", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-merge-guard-"));
    mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
    mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
    mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  function pref(slug: string, principle: string): WritePreferenceInput {
    return {
      slug,
      topic: "deploys",
      principle,
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
      pinned: false,
    };
  }

  test("cross-person merge throws entity-guard; bypass merges", () => {
    upsertEntity(vault, { category: "people", name: "Alice Mason", agent: "tester", now: NOW });
    upsertEntity(vault, { category: "people", name: "Bob Hale", agent: "tester", now: NOW });
    writePreference(vault, pref("alice-deploy", "Alice Mason approves every deploy"));
    writePreference(vault, pref("bob-deploy", "Bob Hale approves every deploy"));

    let thrown: unknown;
    try {
      mergePreferences(vault, "pref-alice-deploy", "pref-bob-deploy", { now: NOW });
    } catch (exc) {
      thrown = exc;
    }
    expect(thrown).toBeInstanceOf(BrainMergeError);
    expect((thrown as BrainMergeError).code).toBe("entity-guard");

    const plan = mergePreferences(vault, "pref-alice-deploy", "pref-bob-deploy", {
      now: NOW,
      bypassEntityGuard: true,
      dryRun: true,
    });
    expect(plan.keep_id).toBe("pref-alice-deploy");
  });

  test("same-person merge passes the guard", () => {
    upsertEntity(vault, { category: "people", name: "Alice Mason", agent: "tester", now: NOW });
    writePreference(vault, pref("a-one", "Alice Mason approves every deploy"));
    writePreference(vault, pref("a-two", "Alice Mason signs off on deploys"));
    const plan = mergePreferences(vault, "pref-a-one", "pref-a-two", { now: NOW, dryRun: true });
    expect(plan.keep_id).toBe("pref-a-one");
  });
});

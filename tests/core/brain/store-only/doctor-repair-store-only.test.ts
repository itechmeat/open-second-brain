/**
 * `o2b brain doctor --repair` for a preference finding on a switched
 * machine. The doctor reads the preference from the store's fold and
 * reports its dead `evidenced_by` link under the page's `Brain/` path; the
 * fixer then looked for a file at that path, found none (the store holds
 * the page) and skipped the fix as an idempotent no-op, so the finding
 * stayed forever. On a store-only machine the prune is a store write of
 * the preference's evidence field, and nothing is written under `Brain/`.
 *
 * The machine keeps its legacy tree here: on a switched vault whose tree
 * was removed the doctor runs only its store-side checks
 * (`doctor/store-side-pass.ts`) and reports no preference finding to
 * repair.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { applyRepair, REPAIR_CODE } from "../../../../src/core/brain/diagnostics.ts";
import {
  clearOriginChannel,
  ORIGIN_CHANNEL,
  setOriginChannel,
} from "../../../../src/core/origin-channel.ts";
import { storeMemoryPageAt } from "../../../../src/core/brain/memory-pages.ts";
import { preferencePath } from "../../../../src/core/brain/paths.ts";
import {
  loadPreference,
  moveToRetired,
  writePreference,
} from "../../../../src/core/brain/preference.ts";
import { appendRecord } from "../../../../src/core/store/appender.ts";
import { SIGNAL_STATE_KIND } from "../../../../src/core/store/fold-signals.ts";
import { readStoreEntities } from "../../../../src/core/store/read/store-entities.ts";
import { openStore } from "../../../../src/core/store/store-open.ts";
import { runMigration } from "../../../../src/core/store-migration/migrate.ts";
import { rollback } from "../../../../src/core/store-migration/outcome.ts";
import {
  makeMigrationBench,
  type MigrationBench,
} from "../../store-migration/fixtures/migration-env.ts";

let bench: MigrationBench | null = null;
afterEach(() => {
  bench?.cleanup();
  bench = null;
});

test("a dead evidenced_by of a stored preference is pruned in the store", () => {
  bench = makeMigrationBench("osb-doctor-repair-");
  const { vault } = bench;
  expect(runMigration(vault, { settleMs: 0 }).ok).toBe(true);
  writePreference(vault, {
    slug: "gamma",
    topic: "gamma",
    principle: "rule",
    created_at: "2026-05-14T10:00:00Z",
    unconfirmed_until: "2026-05-28T10:00:00Z",
    status: "unconfirmed",
    evidenced_by: ["[[sig-never-existed]]"],
  });
  const legacyPage = join(vault, "Brain", "preferences", "pref-gamma.md");
  expect(existsSync(legacyPage)).toBe(false);
  expect(loadPreference(vault, "gamma")?.evidenced_by).toEqual(["[[sig-never-existed]]"]);

  const preview = applyRepair(vault, { dryRun: true, now: new Date("2026-07-18T12:00:00Z") });
  const planned = preview.applied.filter((f) => f.code === REPAIR_CODE.orphanedReference);
  expect(planned.map((f) => f.target)).toEqual([
    "Brain/preferences/pref-gamma.md::_evidenced_by::sig-never-existed",
  ]);
  expect(planned[0]!.diff).toContain('- _evidenced_by: ["[[sig-never-existed]]"]');
  expect(planned[0]!.diff).toContain("+ _evidenced_by: []");

  const out = applyRepair(vault, { dryRun: false, now: new Date("2026-07-18T12:00:00Z") });
  expect(out.applied.map((f) => f.target)).toContain(planned[0]!.target);
  expect(loadPreference(vault, "gamma")?.evidenced_by).toEqual([]);
  expect(existsSync(legacyPage)).toBe(false);
  const again = applyRepair(vault, { dryRun: false, now: new Date("2026-07-18T12:05:00Z") });
  expect(again.applied.filter((f) => f.code === REPAIR_CODE.orphanedReference)).toEqual([]);
});

test("a held private preference stays private when its evidence is pruned", () => {
  bench = makeMigrationBench("osb-doctor-repair-private-");
  const { vault } = bench;
  expect(runMigration(vault, { settleMs: 0 }).ok).toBe(true);
  // The preference was first written with a private region, so the store
  // holds it in `private/`. A later edit drops the region: its fields now
  // carry no privacy marker, and the preference stays private, one entity
  // in one partition.
  const base = {
    slug: "delta",
    topic: "delta",
    created_at: "2026-05-14T10:00:00Z",
    unconfirmed_until: "2026-05-28T10:00:00Z",
    status: "unconfirmed" as const,
    evidenced_by: ["[[sig-never-existed]]"],
  };
  writePreference(vault, { ...base, principle: "rule <private>home address</private>" });
  writePreference(vault, { ...base, principle: "rule" }, { overwrite: true });
  const ofDelta = () =>
    bench!.records().filter((r) => JSON.stringify(r.body).includes('"pref-delta"'));
  expect(ofDelta().length).toBeGreaterThan(1);
  expect(ofDelta().every((r) => r.partition === "private")).toBe(true);

  const before = ofDelta().length;
  const out = applyRepair(vault, { dryRun: false, now: new Date("2026-07-18T12:00:00Z") });
  expect(out.applied.map((f) => f.target)).toContain(
    "Brain/preferences/pref-delta.md::_evidenced_by::sig-never-existed",
  );
  expect(loadPreference(vault, "delta")?.evidenced_by).toEqual([]);
  const after = ofDelta();
  expect(after.length).toBeGreaterThan(before);
  expect(after.every((r) => r.partition === "private")).toBe(true);
});

test("the prune writes nothing while the fold it reads may miss a record", () => {
  bench = makeMigrationBench("osb-doctor-repair-gap-");
  const { vault } = bench;
  expect(runMigration(vault, { settleMs: 0 }).ok).toBe(true);
  writePreference(vault, {
    slug: "gamma",
    topic: "gamma",
    principle: "rule",
    created_at: "2026-05-14T10:00:00Z",
    unconfirmed_until: "2026-05-28T10:00:00Z",
    status: "unconfirmed",
    evidenced_by: ["[[sig-never-existed]]"],
  });

  // A peer's events shard, read once, then gone: whatever it held is
  // unknown to this read.
  const peerShard = appendRecord(openStore({ root: bench.storeRoot, device: "dev-b" }), {
    partition: "shared",
    stream: "events",
    kind: SIGNAL_STATE_KIND,
    agent: "u",
    body: { authority: "human", signal: "sig-elsewhere", fields: { topic: "elsewhere" } },
  }).path;
  readStoreEntities();
  rmSync(peerShard);

  const out = applyRepair(vault, { dryRun: false, now: new Date("2026-07-18T12:00:00Z") });
  expect(out.applied.filter((f) => f.code === REPAIR_CODE.orphanedReference)).toEqual([]);
  expect(loadPreference(vault, "gamma")?.evidenced_by).toEqual(["[[sig-never-existed]]"]);
});

const PROSE_RULE = {
  slug: "epsilon",
  topic: "epsilon",
  principle: "rule",
  created_at: "2026-05-14T10:00:00Z",
  unconfirmed_until: "2026-05-28T10:00:00Z",
  status: "unconfirmed" as const,
  howToApply: "Ask before acting.",
};
const PROSE_PAGE = "Brain/preferences/pref-epsilon.md";

test("a pruned evidence link leaves the stored prose of the preference too", () => {
  bench = makeMigrationBench("osb-doctor-repair-prose-");
  const { vault } = bench;
  expect(runMigration(vault, { settleMs: 0 }).ok).toBe(true);
  // Guidance makes the page body prose the fold stores as `text`, with the
  // `## Origin` list it was written with.
  writePreference(vault, { ...PROSE_RULE, evidenced_by: ["[[sig-never-existed]]"] });
  expect(storeMemoryPageAt(vault, PROSE_PAGE)?.body).toContain("[[sig-never-existed]]");

  const out = applyRepair(vault, { dryRun: false, now: new Date("2026-07-18T12:00:00Z") });
  expect(out.applied.map((f) => f.target)).toContain(
    `${PROSE_PAGE}::_evidenced_by::sig-never-existed`,
  );
  expect(loadPreference(vault, "epsilon")?.evidenced_by).toEqual([]);
  const body = storeMemoryPageAt(vault, PROSE_PAGE)?.body ?? "";
  expect(body).not.toContain("sig-never-existed");
  expect(body).toContain("Ask before acting.");
});

test("a rewrite that changes the evidence list re-renders the Origin of the stored prose", () => {
  bench = makeMigrationBench("osb-pref-prose-origin-");
  const { vault } = bench;
  expect(runMigration(vault, { settleMs: 0 }).ok).toBe(true);
  writePreference(vault, { ...PROSE_RULE, evidenced_by: ["[[sig-first]]"] });
  // A later rewrite without guidance (a dream refresh, a merge) carries a
  // longer evidence list: the prose keeps its guidance, and its Origin
  // follows the list.
  const { howToApply: _guidance, ...withoutGuidance } = PROSE_RULE;
  writePreference(
    vault,
    { ...withoutGuidance, evidenced_by: ["[[sig-first]]", "[[sig-second]]"] },
    { overwrite: true },
  );
  const body = storeMemoryPageAt(vault, PROSE_PAGE)?.body ?? "";
  expect(body).toContain("- [[sig-first]]");
  expect(body).toContain("- [[sig-second]]");
  expect(body).toContain("Ask before acting.");

  writePreference(vault, { ...withoutGuidance, evidenced_by: [] }, { overwrite: true });
  const emptied = storeMemoryPageAt(vault, PROSE_PAGE)?.body ?? "";
  expect(emptied).not.toContain("## Origin");
  expect(emptied).toContain("Ask before acting.");
});

test("the pruned evidence list stays the agent's, so a later dream refresh supersedes it", () => {
  bench = makeMigrationBench("osb-doctor-repair-authority-");
  const { vault } = bench;
  expect(runMigration(vault, { settleMs: 0 }).ok).toBe(true);
  const rule = {
    slug: "zeta",
    topic: "zeta",
    principle: "rule",
    created_at: "2026-05-14T10:00:00Z",
    unconfirmed_until: "2026-05-28T10:00:00Z",
    status: "unconfirmed" as const,
  };
  writePreference(vault, { ...rule, evidenced_by: ["[[sig-never-existed]]"] });
  // A person runs the repair: the CLI is the human channel.
  setOriginChannel(ORIGIN_CHANNEL.cli);
  try {
    applyRepair(vault, { dryRun: false, now: new Date("2026-07-18T12:00:00Z") });
  } finally {
    clearOriginChannel();
  }
  expect(loadPreference(vault, "zeta")?.evidenced_by).toEqual([]);
  const ofZeta = bench
    .records()
    .filter((r) => r.body["preference"] === "pref-zeta" && r.kind === "preference-set");
  const pruned = ofZeta.at(-1)!;
  expect(pruned.body["authority"]).toBe("agent");
  expect(Object.keys(pruned.body["fields"] as object)).toEqual(["evidenced_by"]);

  // A dream refresh (an agent write) carries new evidence: it wins.
  writePreference(
    vault,
    { ...rule, evidenced_by: ["[[sig-later]]"] },
    { overwrite: true, authority: "agent" },
  );
  expect(loadPreference(vault, "zeta")?.evidenced_by).toEqual(["[[sig-later]]"]);
});

test("a heading inside a fenced example of the guidance is not the Origin section", () => {
  bench = makeMigrationBench("osb-pref-prose-fence-");
  const { vault } = bench;
  expect(runMigration(vault, { settleMs: 0 }).ok).toBe(true);
  const guidance = [
    "Write the page like this:",
    "",
    "```md",
    "## Origin",
    "",
    "- [[sig-example]]",
    "```",
    "",
    "~~~",
    "## Recent applications",
    "~~~",
    "",
    "Then ask before acting.",
  ].join("\n");
  writePreference(vault, { ...PROSE_RULE, howToApply: guidance, evidenced_by: ["[[sig-first]]"] });
  const { howToApply: _guidance, ...withoutGuidance } = PROSE_RULE;
  writePreference(
    vault,
    { ...withoutGuidance, evidenced_by: ["[[sig-first]]", "[[sig-second]]"] },
    { overwrite: true },
  );
  const body = storeMemoryPageAt(vault, PROSE_PAGE)?.body ?? "";
  expect(body).toContain("- [[sig-second]]");
  expect(body).toContain("```md\n## Origin\n\n- [[sig-example]]\n```");
  expect(body).toContain("~~~\n## Recent applications\n~~~");
  expect(body).toContain("Then ask before acting.");
});

const RETIRE_AT = new Date("2026-07-01T00:00:00Z");

function retireRule(vault: string, slug: string): void {
  moveToRetired(vault, preferencePath(vault, slug), "stale-no-evidence", {
    now: RETIRE_AT,
    retired_by: "[[Brain/log/2026-07-01]]",
    authority: "agent",
  });
}

/** The `## Origin` bullets of a page body, in order. */
function originBullets(body: string): string[] {
  const at = body.indexOf("## Origin");
  if (at === -1) return [];
  const section = body.slice(at).split(/\n(?=#{1,2} )/)[0]!;
  return section.split("\n").filter((line) => line.startsWith("- [["));
}

test("a retired rule whose prose an earlier release stored with its list shows the pruned list", () => {
  bench = makeMigrationBench("osb-doctor-repair-retired-");
  const { vault } = bench;
  expect(runMigration(vault, { settleMs: 0 }).ok).toBe(true);
  writePreference(vault, { ...PROSE_RULE, slug: "eta", evidenced_by: ["[[sig-never-existed]]"] });
  retireRule(vault, "eta");
  // The previous release stored the prose with the Origin list in it.
  const oldText = [
    "## Origin",
    "",
    "- [[sig-never-existed]]",
    "",
    "## How to apply",
    "",
    "Ask before acting.",
    "",
    "## Retired",
    "",
    "Reason: `stale-no-evidence`",
  ].join("\n");
  appendRecord(bench.store(), {
    partition: "shared",
    stream: "events",
    kind: "preference-set",
    agent: "u",
    body: { authority: "human", preference: "pref-eta", fields: { text: oldText } },
  });
  const page = "Brain/retired/ret-eta.md";
  expect(storeMemoryPageAt(vault, page)?.body).toContain("- [[sig-never-existed]]");

  setOriginChannel(ORIGIN_CHANNEL.cli);
  try {
    const out = applyRepair(vault, { dryRun: false, now: new Date("2026-07-18T12:00:00Z") });
    expect(out.applied.map((f) => f.target)).toContain(`${page}::_evidenced_by::sig-never-existed`);
  } finally {
    clearOriginChannel();
  }
  const body = storeMemoryPageAt(vault, page)?.body ?? "";
  expect(body).not.toContain("sig-never-existed");
  expect(body).toContain("Ask before acting.");
  expect(body).toContain("## Retired");
  expect(body).toContain("Reason: `stale-no-evidence`");
});

test("a rule retired by this release shows its evidence list beside its prose and Retired section", () => {
  bench = makeMigrationBench("osb-pref-retired-origin-");
  const { vault } = bench;
  expect(runMigration(vault, { settleMs: 0 }).ok).toBe(true);
  writePreference(vault, {
    ...PROSE_RULE,
    slug: "theta",
    evidenced_by: ["[[sig-a]]", "[[sig-b]]"],
  });
  retireRule(vault, "theta");
  const body = storeMemoryPageAt(vault, "Brain/retired/ret-theta.md")?.body ?? "";
  expect(originBullets(body)).toEqual(["- [[sig-a]]", "- [[sig-b]]"]);
  expect(body.match(/^## Origin$/gm)).toHaveLength(1);
  expect(body).toContain("Ask before acting.");
  expect(body.match(/^## Retired$/gm)).toHaveLength(1);
});

test("a retired rule keeps its list, prose and Retired section through a rollback and a new migration", () => {
  bench = makeMigrationBench("osb-pref-retired-roundtrip-");
  const { vault } = bench;
  expect(runMigration(vault, { settleMs: 0 }).ok).toBe(true);
  writePreference(vault, { ...PROSE_RULE, slug: "iota", evidenced_by: ["[[sig-a]]"] });
  retireRule(vault, "iota");
  const before = storeMemoryPageAt(vault, "Brain/retired/ret-iota.md")?.body ?? "";

  rollback(vault);
  const file = readFileSync(join(vault, "Brain", "retired", "ret-iota.md"), "utf8");
  expect(originBullets(file)).toEqual(["- [[sig-a]]"]);
  expect(file).toContain("Ask before acting.");
  expect(file.match(/^## Retired$/gm)).toHaveLength(1);

  expect(runMigration(vault, { settleMs: 0 }).ok).toBe(true);
  const after = storeMemoryPageAt(vault, "Brain/retired/ret-iota.md")?.body ?? "";
  // The same page, up to the final newline the file writer adds.
  expect(after.trimEnd()).toBe(before.trimEnd());
  expect(originBullets(after)).toEqual(["- [[sig-a]]"]);
});

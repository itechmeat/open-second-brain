/**
 * The 2.10 verify as a census of LITERAL mentions (task 2.10, design D14
 * items 2 and 17): every `Brain/` literal and every `"Brain"` path
 * segment in `src/` code (comments excluded, through the shared source
 * lexer) must sit in a module this allowlist names with a reason. It does
 * not see code that reaches the tree through the path constants
 * (`BRAIN_ROOT_REL`, the `brainDirs*()` family); whether such code writes
 * the tree on a switched machine is proved by the store-only writer and
 * reader suites (a tree digest per surface), and that every vault writer
 * carries a guard by `tests/core/brain/vault-guard-census.test.ts`. The
 * modules allowed to spell the path out:
 *
 *  - a record-lane module that addresses its pages by their legacy path
 *    and reads and writes them through the lane page store (D14 item 2);
 *  - a legacy reader or writer that runs on an unswitched machine only,
 *    the store-only branch beside it reading the store;
 *  - the migration, its exporters and the doctor's migration checks;
 *  - a note wall (D14 item 17) or the vault adapter;
 *  - text: a help line, message or description that names the layout,
 *    from which no path is built;
 *  - a label: an audit target, a provenance key or a path prefix used to
 *    classify, never opened.
 *
 * It fails on a module with a hit that is not listed (a new writer or
 * reader of the legacy tree) and on a listed module with no hit left (a
 * stale entry), so the list stays exactly the set of modules that still
 * name the tree.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { lexSource } from "../../helpers/source-lexer.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const SRC = join(REPO, "src");

/** A `Brain/` literal or a lone `"Brain"` segment (any quote). */
const BRAIN_RE = /Brain\/|(["'`])Brain\1/;

const LANE =
  "record-lane module: its pages are addressed by their legacy path (the lane path rule, " +
  "design D14 item 2), and every read and write goes through the lane page store, so a " +
  "store-only machine writes lane-entry records and no file under Brain/";
const LEGACY =
  "legacy reader or writer of an unswitched machine: the module branches on store-only mode " +
  "and a switched machine reads and writes the store instead";
const LEDGER =
  "the legacy directory of a store ledger (task 2.10 WP3): written only by the dual-write " +
  "branch of an unswitched machine; a store-only machine appends the ledger's store rows";
const MIGRATION = "the migration, the rollback or a check of them: its job is the legacy tree";
const NOTE_WALL = "a note wall (design D14 item 17): it refuses the legacy tree as a note target";
const ADAPTER =
  "a hand-edited file of the user's vault read through the vault adapter (absent means no " +
  "such file); not brain state";
const TEXT =
  "text only: a help line, message, description or config-template comment that names the " +
  "legacy layout to a person; no path is built from it";
const LABEL =
  "a label, not a path: an audit or receipt target, a provenance key, a wikilink target or " +
  "a path prefix used to classify or exclude, never opened";
const DEFINITION = "the one definition of the legacy root's name (BRAIN_ROOT_REL)";
const FIXTURE = "builds a throwaway fixture vault (bench, doctor self-test) whose layout it names";

const ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({
  "src/cli/aider.ts": TEXT,
  "src/cli/brain/help-text.ts": TEXT,
  "src/cli/brain/verbs/bridges.ts": LANE,
  "src/cli/brain/verbs/clusters.ts": LANE,
  "src/cli/brain/verbs/continuity.ts": TEXT,
  "src/cli/brain/verbs/dream.ts": TEXT,
  "src/cli/brain/verbs/explorer.ts": TEXT,
  "src/cli/brain/verbs/foresight.ts": LANE,
  "src/cli/brain/verbs/hallways.ts": TEXT,
  "src/cli/brain/verbs/import-claude-memory.ts": TEXT,
  "src/cli/brain/verbs/lessons.ts": TEXT,
  "src/cli/brain/verbs/links.ts": LABEL,
  "src/cli/brain/verbs/procedural-memory.ts": LANE,
  "src/cli/brain/verbs/rollback.ts": TEXT,
  "src/cli/brain/verbs/snapshot.ts": TEXT,
  "src/cli/brain/verbs/upgrade.ts": TEXT,
  "src/cli/command-manifest.ts": TEXT,
  "src/cli/discipline.ts": TEXT,
  "src/cli/install/init-interactive.ts": TEXT,
  "src/cli/onboarding.ts": LEGACY,
  "src/cli/vault/help-text.ts": TEXT,
  "src/core/bench/fixture.ts": FIXTURE,
  "src/core/brain/architect/decisions.ts": LANE,
  "src/core/brain/architect/generate.ts": LANE,
  "src/core/brain/capture/capture-note.ts": TEXT,
  "src/core/brain/config-template.ts": TEXT,
  "src/core/brain/context-pack.ts": LABEL,
  "src/core/brain/continuity/promote-host-memory.ts": TEXT,
  "src/core/brain/dead-ends.ts": LANE,
  "src/core/brain/decisions/receipts.ts": LEDGER,
  "src/core/brain/design-note.ts": LANE,
  "src/core/brain/destructive-sites.ts": TEXT,
  "src/core/brain/diarization.ts": LABEL,
  "src/core/brain/doctor-exits.ts": TEXT,
  "src/core/brain/doctor/embedding-sunset-check.ts": TEXT,
  "src/core/brain/doctor/inbox-archive-check.ts": TEXT,
  "src/core/brain/doctor/link-checks.ts": TEXT,
  "src/core/brain/doctor/migration-check.ts": MIGRATION,
  "src/core/brain/doctor/planted-rows-check.ts": TEXT,
  "src/core/brain/doctor/store-integrity.ts": TEXT,
  "src/core/brain/dream-stage.ts": LANE,
  "src/core/brain/entities/lexicon.ts": LANE,
  "src/core/brain/entities/person-nicknames.ts": LANE,
  "src/core/brain/export.ts": TEXT,
  "src/core/brain/extract-signals.ts": LABEL,
  "src/core/brain/git/decisions.ts": LANE,
  "src/core/brain/git/store.ts": LEDGER,
  "src/core/brain/handoff.ts": LANE,
  "src/core/brain/heal-run.ts": LABEL,
  "src/core/brain/hygiene/apply.ts": LABEL,
  "src/core/brain/idea-discovery.ts": LEGACY,
  "src/core/brain/init.ts": TEXT,
  "src/core/brain/intentions.ts": LANE,
  "src/core/brain/link-graph/bridge-discovery.ts": LANE,
  "src/core/brain/link-graph/co-occurrence.ts": LANE,
  "src/core/brain/link-graph/communities.ts": LANE,
  "src/core/brain/link-graph/hallways.ts": LANE,
  "src/core/brain/log.ts": LABEL,
  "src/core/brain/maintenance/lane.ts": TEXT,
  "src/core/brain/manifest.ts": TEXT,
  "src/core/brain/metrics.ts": LEDGER,
  "src/core/brain/no-vault.ts": TEXT,
  "src/core/brain/notes/lifecycle.ts": TEXT,
  "src/core/brain/path-constants.ts": DEFINITION,
  "src/core/brain/payload-registry.ts": TEXT,
  "src/core/brain/permissions/document.ts": ADAPTER,
  "src/core/brain/policy/load.ts": TEXT,
  "src/core/brain/portability/knowledge-pack.ts": TEXT,
  "src/core/brain/portability/role-tokens.ts": ADAPTER,
  "src/core/brain/preference.ts": TEXT,
  "src/core/brain/procedural-graph.ts": LANE,
  "src/core/brain/procedural-memory.ts": LANE,
  "src/core/brain/profile-doc.ts": LANE,
  "src/core/brain/recompile.ts": LABEL,
  "src/core/brain/report-snapshot.ts": LANE,
  "src/core/brain/rollup-ladder.ts": LABEL,
  "src/core/brain/schema-mutate.ts": LABEL,
  "src/core/brain/schema-report.ts": LABEL,
  "src/core/brain/session-lifecycle.ts": LABEL,
  "src/core/brain/skill-page-drafts.ts": LABEL,
  "src/core/brain/skill-proposals.ts": LANE,
  "src/core/brain/snapshot-diff.ts": LEGACY,
  "src/core/brain/snapshot-gate.ts": TEXT,
  "src/core/brain/snapshot.ts": TEXT,
  "src/core/brain/source-cleanup.ts": LABEL,
  "src/core/brain/temporal/weekly-brief.ts": LABEL,
  "src/core/brain/triggers/store.ts": LANE,
  "src/core/brain/truth/store.ts": LEDGER,
  "src/core/brain/upgrade.ts": MIGRATION,
  "src/core/brain/watchdog.ts": LABEL,
  "src/core/brain/wikilink.ts": LABEL,
  "src/core/brain/write-session/panel.ts": NOTE_WALL,
  "src/core/brain/write-session/personas.ts": LANE,
  "src/core/brain/write-session/store.ts": LANE,
  "src/core/brain/write-session/validate.ts": NOTE_WALL,
  "src/core/decision-model/diagnostics.ts": TEXT,
  "src/core/doctor-selftest.ts": FIXTURE,
  "src/core/install/ownership.ts": TEXT,
  "src/core/search/activation/decay.ts": LABEL,
  "src/core/search/feedback.ts": LEDGER,
  "src/core/search/indexer.ts": LABEL,
  "src/core/search/pipeline/candidate-signals.ts": LABEL,
  "src/core/search/reinforce.ts": LEDGER,
  "src/core/search/visibility-surface-registry.ts": TEXT,
  "src/core/state/surfaces.ts": TEXT,
  "src/core/write-binding/index.ts": TEXT,
  "src/mcp/brain/context-tools.ts": NOTE_WALL,
  "src/mcp/brain/feedback-tools.ts": TEXT,
  "src/mcp/brain/knowledge-tools.ts": LANE,
  "src/mcp/brain/procedure-tools.ts": LANE,
  "src/mcp/skill-tools.ts": TEXT,
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** Every `src/` module with a hit in its code, with the first hit's line. */
function hits(): Map<string, string> {
  const out = new Map<string, string>();
  for (const path of sourceFiles(SRC)) {
    const code = lexSource(readFileSync(path, "utf8")).withoutComments;
    const lines = code.split("\n");
    const at = lines.findIndex((line) => BRAIN_RE.test(line));
    if (at === -1) continue;
    out.set(relative(REPO, path).split("\\").join("/"), `${at + 1}: ${lines[at]!.trim()}`);
  }
  return out;
}

describe("legacy Brain/ tree census (task 2.10 verify)", () => {
  test("every module naming the legacy tree in code is allowlisted with a reason", () => {
    const unlisted = [...hits()]
      .filter(([path]) => ALLOWLIST[path] === undefined)
      .map(([path, line]) => `${path}:${line}`);
    expect(unlisted).toEqual([]);
  });

  test("no allowlist entry outlives the mention it excuses", () => {
    const present = hits();
    expect(Object.keys(ALLOWLIST).filter((path) => !present.has(path))).toEqual([]);
  });

  test("every reason is a written sentence", () => {
    for (const reason of Object.values(ALLOWLIST)) expect(reason.length).toBeGreaterThan(40);
  });

  test("the detector sees the shapes it measures and skips comments", () => {
    expect(BRAIN_RE.test('join(vault, "Brain", "x")')).toBe(true);
    expect(BRAIN_RE.test("`Brain/inbox/${name}`")).toBe(true);
    expect(BRAIN_RE.test("const BrainStore = 1")).toBe(false);
    const lexed = lexSource("// see Brain/log\nconst a = 1;\n").withoutComments;
    expect(BRAIN_RE.test(lexed)).toBe(false);
  });
});

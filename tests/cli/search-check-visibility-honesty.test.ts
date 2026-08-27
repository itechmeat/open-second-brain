/**
 * `o2b search check`'s visibility honesty finding
 * (nothing-writes-silently, unit H, form B).
 *
 * The finding was written when `visibility:` was a caller-supplied view
 * filter honoured by exactly one lane, and it said so. The reserved token
 * is now enforced at three read roots, so the line reports what is still
 * true instead: how many documents reserve themselves, how many
 * enumerated surfaces still do not consult the field, and how many
 * documents the index cannot measure. Every number is derived - the
 * surface counts from `visibility-surface-registry.ts`'s own exported
 * list, the document counts from the index's own column - and none is
 * hand-written.
 *
 * The claims pinned here:
 *
 *   1. A vault that never uses `visibility:` renders neither the JSON key
 *      nor the human line - both shapes stay silent on it.
 *   2. A vault with a tagged page renders `visibility_honesty` in JSON
 *      with all four counts, and the human line under the same label,
 *      beside `pending_vectors:` and `embedder_record:`.
 *   3. The unmeasured population is reported rather than absorbed into
 *      the measured one.
 *   4. The finding never changes the exit code - it is an honesty
 *      statement, not a fault.
 */

import { expect, test } from "bun:test";

import { runCli } from "../helpers/run-cli.ts";
import { createTempVault, makeConfig, writeMd } from "../helpers/search-fixtures.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import {
  callableVisibilitySurfaces,
  excludedCallableVisibilitySurfaces,
} from "../../src/core/search/visibility-surface-registry.ts";

test("a vault that never uses visibility: renders neither the JSON key nor the human line", async () => {
  const { vault, dbPath, cleanup } = createTempVault("check-visibility-honesty-absent");
  try {
    writeMd(vault, "a.md", "# A\n\nAn ordinary note.");
    await indexVault(makeConfig({ vault, dbPath }));

    const json = await runCli(["search", "check", "--json", "--vault", vault, "--db", dbPath]);
    expect(json.returncode).toBe(0);
    const parsed = JSON.parse(json.stdout) as Record<string, unknown>;
    expect("visibility_honesty" in parsed).toBe(false);

    const human = await runCli(["search", "check", "--vault", vault, "--db", dbPath]);
    expect(human.stdout).not.toContain("visibility_honesty");
  } finally {
    cleanup();
  }
});

test("a vault with one visibility-tagged page renders the finding in both shapes", async () => {
  const { vault, dbPath, cleanup } = createTempVault("check-visibility-honesty-present");
  try {
    writeMd(vault, "a.md", "---\nvisibility: private\n---\n\n# A\n\nA private page.");
    await indexVault(makeConfig({ vault, dbPath }));

    const json = await runCli(["search", "check", "--json", "--vault", vault, "--db", dbPath]);
    expect(json.returncode).toBe(0);
    const parsed = JSON.parse(json.stdout) as Record<string, unknown>;
    const finding = parsed["visibility_honesty"] as Record<string, unknown>;
    expect(finding).toBeDefined();
    expect(finding["excluded_surface_count"]).toBe(excludedCallableVisibilitySurfaces().length);
    expect(finding["total_surface_count"]).toBe(callableVisibilitySurfaces().length);
    // One tagged page in the fixture, and it is the reserved token.
    expect(finding["reserved_document_count"]).toBe(1);
    // Every document in this fixture has a frontmatter chunk to measure.
    expect(finding["unmeasured_document_count"]).toBe(0);

    const human = await runCli(["search", "check", "--vault", vault, "--db", dbPath]);
    expect(human.returncode).toBe(0);
    expect(human.stdout).toContain("visibility_honesty:");
    expect(human.stdout).toContain("reserve themselves against remote reads");
    expect(human.stdout).toContain(`${excludedCallableVisibilitySurfaces().length} of the `);
    // The line names its own scope: the census's population, not the
    // product's whole surface area.
    expect(human.stdout).toContain("the visibility census enumerates");
    // And it names the population it could not measure rather than
    // folding it into "declares nothing".
    expect(human.stdout).toContain("hold no frontmatter the index can measure");
  } finally {
    cleanup();
  }
});

test("the finding never moves the exit code", async () => {
  const { vault, dbPath, cleanup } = createTempVault("check-visibility-honesty-exit");
  try {
    writeMd(vault, "a.md", "---\nvisibility: private\n---\n\n# A\n\nA private page.");
    await indexVault(makeConfig({ vault, dbPath }));

    const out = await runCli(["search", "check", "--vault", vault, "--db", dbPath]);
    expect(out.returncode).toBe(0);
  } finally {
    cleanup();
  }
});

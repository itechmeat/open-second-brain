/**
 * `o2b search check`'s visibility honesty finding
 * (nothing-writes-silently, unit H, form B).
 *
 * The defect: `visibility: private` frontmatter reads as a privacy
 * boundary and is a caller-supplied view filter honoured by exactly one
 * lane (`search()`'s pool-filters pipeline). This finding names the gap,
 * with a count derived from `visibility-surface-registry.ts`'s own
 * exported list - never a hand-written number - and only when the
 * vault/index actually carries at least one tagged page.
 *
 * The claims pinned here:
 *
 *   1. A vault that never uses `visibility:` renders neither the JSON key
 *      nor the human line - both shapes stay silent on it.
 *   2. A vault with a tagged page renders `visibility_honesty` in JSON
 *      with `excluded_surface_count` / `total_surface_count`, and the
 *      human line under the same label, beside `pending_vectors:` and
 *      `embedder_record:`.
 *   3. The finding never changes the exit code - it is an honesty
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

    const human = await runCli(["search", "check", "--vault", vault, "--db", dbPath]);
    expect(human.returncode).toBe(0);
    expect(human.stdout).toContain("visibility_honesty:");
    expect(human.stdout).toContain("caller-supplied view filter, not a privacy boundary");
    expect(human.stdout).toContain(`${excludedCallableVisibilitySurfaces().length} of the `);
    // The line names its own scope: the census's population, not the
    // product's whole surface area.
    expect(human.stdout).toContain("the visibility census enumerates");
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

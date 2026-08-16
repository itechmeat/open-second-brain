/**
 * `o2b brain backlinks` reports what it could not read
 * (a-label-is-not-a-boundary review, C7).
 *
 * `buildBacklinkIndex` stopped swallowing parse failures and started
 * carrying them on the returned index; `brain_backlinks` renders them.
 * This verb - the surface an operator debugging a legacy vault reaches
 * FIRST, before any MCP client is involved - kept printing `Backlinks to
 * <id>: 0` and nothing else, which is the same confident zero the core
 * change removed, one layer up.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-backlinks-cli-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const env = (): Record<string, string> => ({ OPEN_SECOND_BRAIN_CONFIG: config });

async function bootstrap(): Promise<void> {
  const init = await runCli(["init", "--vault", vault, "--name", "TestBacklinks"], { env: env() });
  expect(init.returncode).toBe(0);
  const brainInit = await runCli(["brain", "init", "--vault", vault], { env: env() });
  expect(brainInit.returncode).toBe(0);
}

/**
 * A preference whose frontmatter the collector cannot read, holding a
 * reference to the target. The legacy shape: Group C derived keys written
 * WITHOUT the `_` prefix, which `normalizeDerivedKeys` refuses - the exact
 * vault the swallowed `catch { continue }` used to hide.
 */
function seedUnreadableReferrer(slug: string, target: string): void {
  writeFileSync(
    join(brainDirs(vault).preferences, `pref-${slug}.md`),
    [
      "---",
      "kind: brain-preference",
      "id: `pref-" + slug + "`",
      "status: confirmed",
      "_status: confirmed",
      "topic: legacy",
      `evidenced_by: ["[[${target}]]"]`,
      "---",
      "",
      `## Principle`,
      "",
      `see [[${target}]]`,
      "",
    ].join("\n"),
  );
}

describe("brain backlinks does not report an unmeasured zero", () => {
  test("an unparseable referrer is named on the human surface", async () => {
    await bootstrap();
    seedUnreadableReferrer("legacy-rule", "pref-target");

    const r = await runCli(["brain", "backlinks", "--vault", vault, "pref-target"], {
      env: env(),
    });

    expect(r.returncode).toBe(0);
    // The count is still printed - it is what the caller asked for…
    expect(r.stdout).toContain("Backlinks to pref-target: 0");
    // …but it no longer stands alone. The artifact and the reason travel
    // with it, in the same vocabulary `brain_backlinks` uses.
    expect(r.stderr).toContain("pref-legacy-rule");
    expect(r.stderr).toContain("incomplete");
    // No host path in the reason: `buildBacklinkIndex` strips it, and this
    // verb must not put one back.
    expect(r.stderr).not.toContain(vault);
  });

  test("--json carries the same failures under the MCP tool's key", async () => {
    await bootstrap();
    seedUnreadableReferrer("legacy-rule", "pref-target");

    const r = await runCli(["brain", "backlinks", "--vault", vault, "--json", "pref-target"], {
      env: env(),
    });

    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      count: number;
      unparsed?: ReadonlyArray<{ source: string; sourceKind: string; reason: string }>;
    };
    expect(payload.count).toBe(0);
    expect(payload.unparsed?.map((u) => u.source)).toEqual(["pref-legacy-rule"]);
    expect(payload.unparsed?.[0]?.sourceKind).toBe("preference");
  });

  test("a healthy vault's output is unchanged - no key, no note", async () => {
    await bootstrap();

    const r = await runCli(["brain", "backlinks", "--vault", vault, "--json", "pref-target"], {
      env: env(),
    });

    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as Record<string, unknown>;
    // Absent, never an empty array: an empty list would make every caller
    // branch on a state that cannot happen on a healthy vault.
    expect("unparsed" in payload).toBe(false);
    expect(r.stderr).not.toContain("incomplete");
  });
});

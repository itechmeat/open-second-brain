/**
 * End-to-end scenario for the capture extensions + frontmatter migration.
 *
 * Exercises the full chain across CLI invocations:
 *   1. `o2b init` + `o2b brain init` bootstrap a fresh vault.
 *   2. A Daily note with an `@osb` marker is dropped on disk.
 *   3. `o2b brain scan-inline` captures the marker into Brain/inbox/
 *      and annotates the Daily note with `@osb✓ [[sig-...]]`.
 *   4. The session import path picks up the same marker shape from a
 *      transcript fixture (different topic to confirm independence).
 *   5. `o2b brain migrate-frontmatter --apply --yes` rewrites a
 *      hand-crafted legacy-shape pref file into the `_`-prefixed
 *      form and lands a snapshot under Brain/.snapshots/.
 *   6. `o2b brain rollback <run_id>` restores the pre-migration shape.
 *
 * If any step fails, the chain breaks and we see which seam is broken.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-capture-fields-e2e-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("capture + migration end-to-end", () => {
  test("inline scan → session import → migrate → rollback", async () => {
    // Step 1: bootstrap
    let r = await runCli(["init", "--vault", vault, "--name", "Test"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    r = await runCli(["brain", "init", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);

    // Step 2: drop a Daily note with an inline marker
    mkdirSync(join(vault, "Daily"), { recursive: true });
    const dailyPath = join(vault, "Daily", "2026-05-16.md");
    writeFileSync(
      dailyPath,
      [
        "# Daily notes",
        "",
        "@osb feedback negative topic=e2e-inline principle=\"no e2e shortcuts\"",
        "",
      ].join("\n"),
      "utf8",
    );

    // Step 2b (v0.10.9): an Obsidian-plugin note with a stray marker
    // must NOT be captured — the shared vault.ignore_paths excludes
    // the whole `.obsidian` tree.
    mkdirSync(join(vault, ".obsidian", "plugins", "x"), { recursive: true });
    writeFileSync(
      join(vault, ".obsidian", "plugins", "x", "note.md"),
      "@osb feedback negative topic=e2e-obsidian-leak principle=p\n",
      "utf8",
    );

    // Step 3: scan-inline captures + rewrites
    r = await runCli(["brain", "scan-inline", "--vault", vault, "--path", "Daily"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toMatch(/created: 1/);
    expect(readFileSync(dailyPath, "utf8")).toMatch(/@osb✓ \[\[sig-/);

    const inbox = join(vault, "Brain", "inbox");
    const inlineSigs = readdirSync(inbox).filter((n) => n.startsWith("sig-"));
    expect(inlineSigs.length).toBe(1);
    // The .obsidian marker MUST NOT have produced a signal.
    expect(
      inlineSigs.some((n) => n.includes("e2e-obsidian-leak")),
    ).toBe(false);

    // Step 4: import-session adds an independent signal from the
    // claude fixture (topic=mocking, distinct from e2e-inline).
    const fixturePath = resolve("tests/fixtures/sessions/claude-minimal.jsonl");
    r = await runCli(
      ["brain", "import-session", fixturePath, "--vault", vault],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);

    const sigsAfterImport = readdirSync(inbox).filter((n) => n.startsWith("sig-"));
    expect(sigsAfterImport.length).toBeGreaterThan(inlineSigs.length);

    // Step 5: hand-write a legacy-shape preference, then migrate.
    const legacyPrefPath = join(vault, "Brain", "preferences", "pref-legacy-e2e.md");
    writeFileSync(
      legacyPrefPath,
      [
        "---",
        "kind: brain-preference",
        "id: pref-legacy-e2e",
        "created_at: 2026-05-14T10:42:00Z",
        "unconfirmed_until: 2026-05-28T10:42:00Z",
        "tags: [brain, brain/preference, brain/topic/legacy-e2e]",
        "topic: legacy-e2e",
        "principle: Some rule",
        "pinned: false",
        "status: confirmed",
        "confirmed_at: 2026-05-15T10:00:00Z",
        "evidenced_by: []",
        "applied_count: 1",
        "violated_count: 0",
        "last_evidence_at: null",
        "confidence: low",
        "---",
        "",
      ].join("\n"),
      "utf8",
    );
    r = await runCli(
      ["brain", "migrate-frontmatter", "--vault", vault, "--apply", "--yes"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    const afterMigrate = readFileSync(legacyPrefPath, "utf8");
    expect(afterMigrate).toMatch(/^_status: confirmed$/m);
    expect(afterMigrate).not.toMatch(/^status: confirmed$/m);

    const snapDir = join(vault, "Brain", ".snapshots");
    const snaps = readdirSync(snapDir).filter(
      (n) => n.startsWith("migrate-") && n.endsWith(".tar.zst"),
    );
    expect(snaps.length).toBe(1);

    // Step 6: rollback restores the legacy shape. The migration
    // intentionally drifted the live tree from the snapshot moment,
    // so v0.10.6 rollback requires `--force-rollback` to overwrite.
    const runId = snaps[0]!.replace(/\.tar\.zst$/, "");
    r = await runCli(
      [
        "brain",
        "rollback",
        runId,
        "--vault",
        vault,
        "--yes",
        "--force-rollback",
      ],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(existsSync(legacyPrefPath)).toBe(true);
    const afterRollback = readFileSync(legacyPrefPath, "utf8");
    expect(afterRollback).toMatch(/^status: confirmed$/m);
    expect(afterRollback).not.toMatch(/^_status: confirmed$/m);
  }, 60_000);
});

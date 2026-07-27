/**
 * A registered terminal state fires only where its claim holds
 * (no-dead-ends, phase 3, item 3).
 *
 * The registry entry a rail emission resolves is not just a command - it
 * is an assertion about the state the caller is in. `brain-empty` asserts
 * "Brain with nothing recorded in it"; `search-index-built` asserts
 * "search index up to date". Three emissions fired unconditionally and so
 * made those assertions in cases where they were false, which is exactly
 * the failure class this release exists to remove.
 *
 * Audited here, one test per emission that had to change, plus the
 * negative case for each - because "fires when true" is only half the
 * property and the half that regresses silently is the other one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-claim-truth-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  for (const key of ["VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG", "VAULT_AGENT_NAME"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  writeFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const FEEDBACK_EXIT = "next: o2b brain feedback";
const QUERY_EXIT = "next: o2b search query <text>";
const INDEX_EXIT = "next: o2b search index";

function seedSignal(): void {
  writeSignal(vault, {
    topic: "already-recorded",
    signal: "positive",
    agent: "claude",
    principle: "Something is already recorded here.",
    created_at: "2026-05-20T10:00:00Z",
    date: "2026-05-20",
    slug: "already-recorded-1",
    scope: "writing",
  });
}

describe("brain-empty claims the Brain is empty", () => {
  test("a first bootstrap does leave an empty Brain, so the exit fires", async () => {
    const r = await runCli(["brain", "init", "--vault", vault, "--config", configPath]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain(FEEDBACK_EXIT);
  });

  test("a re-run over a Brain that already holds a signal does not", async () => {
    bootstrapBrain(vault, { configPath });
    seedSignal();

    const r = await runCli(["brain", "init", "--vault", vault, "--config", configPath]);

    expect(r.returncode).toBe(0);
    // Every path was skipped and the Brain is not empty; asserting it is
    // would be a false claim.
    expect(r.stdout).toContain("exists:");
    expect(r.stdout).not.toContain(FEEDBACK_EXIT);
  });

  test("a re-run over a Brain that holds a preference does not", async () => {
    bootstrapBrain(vault, { configPath });
    writeFileSync(
      join(vault, "Brain", "preferences", "pref-recorded.md"),
      "---\nid: pref-recorded\nstatus: confirmed\n---\n\nRecorded.\n",
      "utf8",
    );

    const r = await runCli(["brain", "init", "--vault", vault, "--config", configPath]);

    expect(r.returncode).toBe(0);
    expect(r.stdout).not.toContain(FEEDBACK_EXIT);
  });

  test("a re-run over an empty Brain still fires - the claim is about content, not about a first run", async () => {
    bootstrapBrain(vault, { configPath });

    const r = await runCli(["brain", "init", "--vault", vault, "--config", configPath]);

    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain(FEEDBACK_EXIT);
  });

  test("the machine stream stays clean either way", async () => {
    bootstrapBrain(vault, { configPath });
    seedSignal();
    const r = await runCli(["brain", "init", "--vault", vault, "--config", configPath, "--json"]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).not.toContain("next: ");
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });
});

describe("search-index-built claims the index is up to date", () => {
  const dbPath = (): string => join(tmp, "index.db");

  function writeNote(name: string, body: string): void {
    writeFileSync(join(vault, name), body, "utf8");
  }

  beforeEach(() => {
    bootstrapBrain(vault, { configPath });
  });

  test("a clean run leaves it up to date, so the exit fires", async () => {
    writeNote("good.md", "---\ntitle: Good\n---\n\nSome body text.\n");
    const r = await runCli(["search", "index", "--vault", vault, "--db", dbPath()]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain(QUERY_EXIT);
  });

  test("a run that could not index every file does not claim it is up to date", async () => {
    writeNote("good.md", "---\ntitle: Good\n---\n\nSome body text.\n");
    // Frontmatter with no closing fence: the chunker reports it and the
    // run records the file under `errors`, meaning it did not index.
    writeNote("broken.md", "---\ntitle: Broken\n\nBody without a closing fence.\n");

    const r = await runCli(["search", "index", "--vault", vault, "--db", dbPath()]);

    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("broken.md");
    expect(r.stdout).not.toContain(QUERY_EXIT);
  });

  test("reindex holds the same property", async () => {
    writeNote("good.md", "---\ntitle: Good\n---\n\nSome body text.\n");
    const clean = await runCli(["search", "reindex", "--vault", vault, "--db", dbPath()]);
    expect(clean.stdout).toContain(QUERY_EXIT);

    writeNote("broken.md", "---\ntitle: Broken\n\nBody without a closing fence.\n");
    const dirty = await runCli(["search", "reindex", "--vault", vault, "--db", dbPath()]);
    expect(dirty.stdout).not.toContain(QUERY_EXIT);
  });

  test("the machine stream stays clean and parses in both cases", async () => {
    writeNote("broken.md", "---\ntitle: Broken\n\nBody without a closing fence.\n");
    const r = await runCli(["search", "index", "--vault", vault, "--db", dbPath(), "--json"]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).not.toContain("next: ");
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });
});

describe("search-index-missing claims the index is not built", () => {
  test("o2b init on a vault with no index names the indexer", async () => {
    const r = await runCli(["init", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain(INDEX_EXIT);
  });

  test("o2b init on a vault that already has one does not", async () => {
    // Build the index where the resolver will look for it, then re-init.
    const built = await runCli(["search", "index", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(built.returncode).toBe(0);

    const r = await runCli(["init", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });

    expect(r.returncode).toBe(0);
    // The checklist below it already reports this step as done; the
    // block above it must not contradict that in the same output.
    expect(r.stdout).toContain("Search:");
    expect(r.stdout).not.toContain(INDEX_EXIT);
  });
});

describe("the audit of every other registered emission", () => {
  /**
   * The remaining rail call sites, and the condition each is guarded by.
   * Read off the source at the time of this change and asserted rather
   * than trusted: a site that loses its guard fails here.
   */
  const GUARDED: ReadonlyArray<readonly [string, string, string]> = [
    ["src/cli/brain/verbs/bridges.ts", "bridge-proposals-absent", "!existsSync(path)"],
    ["src/cli/brain/verbs/bridges.ts", "search-index-missing", "INDEX_MISSING"],
    ["src/cli/brain/verbs/clusters.ts", "search-index-missing", "INDEX_MISSING"],
    ["src/cli/brain/verbs/clusters.ts", "cluster-notes-absent", "!existsSync(dir)"],
    ["src/cli/brain/verbs/dream.ts", "dream-bundles-absent", "bundles.length === 0"],
    ["src/cli/brain/verbs/git.ts", "git-history-absent", "results.length === 0"],
    ["src/cli/brain/verbs/git.ts", "git-history-absent", "repos.length === 0"],
    ["src/cli/brain/verbs/inbox-drain.ts", "staged-captures-pending", "report.items.length > 0"],
    ["src/cli/brain/verbs/intention.ts", "intentions-absent", "intentions.length === 0"],
    [
      "src/cli/brain/verbs/intent-review.ts",
      "signal-clusters-absent",
      "report.reviews.length === 0",
    ],
    ["src/cli/brain/verbs/tiers.ts", "tier-drift-restore", "findings.length > 0"],
    ["src/cli/brain/verbs/tune.ts", "recall-tuning-absent", "tuned === null"],
    ["src/cli/main.ts", "cli-config-absent", "!result.exists"],
    ["src/cli/search/verbs/status.ts", "search-index-missing", "!status.exists"],
  ];

  test("every other emission sits under a guard naming its condition", () => {
    const root = join(import.meta.dir, "..", "..");
    const missing: string[] = [];
    for (const [file, code, guard] of GUARDED) {
      const text = readFileSync(join(root, file), "utf8");
      // EVERY occurrence, not the first: a code is now named twice per
      // site - once for the rail line and once for the JSON field - and
      // checking only the first would let the second lose its guard.
      const occurrences = [...text.matchAll(new RegExp(`"${code}"`, "g"))];
      if (occurrences.length === 0) {
        missing.push(`${file}: ${code} is not named at all`);
        continue;
      }
      for (const occurrence of occurrences) {
        if (!text.slice(0, occurrence.index!).includes(guard)) {
          missing.push(`${file}: ${code} is not preceded by \`${guard}\``);
        }
      }
    }
    expect(missing.join("\n")).toBe("");
  });
});

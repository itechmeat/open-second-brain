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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeCaptureNote } from "../../src/core/brain/capture/capture-note.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { NEXT_COMMAND_KEY, resolveNextStep } from "../../src/core/brain/next-step.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
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
    // The indexer refuses a vault directory that does not exist.
    mkdirSync(vault, { recursive: true });
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

/**
 * The emissions that no other suite drives in BOTH directions. The rest
 * of the registered sites are held behaviourally elsewhere (the JSON
 * `next_command` field in `json-next-command.test.ts`, the terminal-state
 * suites); these three states had only a source-text check that some
 * guard string appeared somewhere earlier in the file, which a refactor
 * could satisfy while the emission itself lost its condition.
 */
describe("the remaining claims fire only where they hold", () => {
  const env = (): Record<string, string> => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

  /** The rail line a code prints, read from the registry, never retyped. */
  function railLine(code: string): string {
    const step = resolveNextStep(code);
    expect(`${code} is registered: ${step !== null}`).toBe(`${code} is registered: true`);
    return `next: ${step!.nextCommand}`;
  }

  beforeEach(() => {
    bootstrapBrain(vault, { configPath });
  });

  describe("tier-drift-restore claims an identity field drifted", () => {
    function writePref(id: string): void {
      writeFileSync(
        join(vault, "Brain", "preferences", "pref-spaces.md"),
        `---\nkind: brain-preference\nid: ${id}\ncreated_at: 2026-05-01T00:00:00Z\ntopic: style\n---\n\nUse spaces.\n`,
      );
    }

    test("an index with no hand-edits does not offer a restore", async () => {
      writePref("pref-spaces");
      await indexVault(resolveSearchConfig({ vault, configPath }));
      const r = await runCli(["brain", "tiers", "check", "--vault", vault], { env: env() });
      expect(r.returncode).toBe(0);
      expect(r.stdout).toContain("0 open finding(s)");
      expect(r.stdout).not.toContain(railLine("tier-drift-restore"));
      expect(r.stdout).not.toContain(railLine("tier-drift-accept"));
    });

    test("a hand-edited identity field offers both exits", async () => {
      const config = resolveSearchConfig({ vault, configPath });
      writePref("pref-spaces");
      await indexVault(config);
      writePref("pref-tabs");
      await indexVault(config);
      const r = await runCli(["brain", "tiers", "check", "--vault", vault], { env: env() });
      expect(r.returncode).toBe(0);
      expect(r.stdout).toContain("1 open finding(s)");
      expect(r.stdout).toContain(railLine("tier-drift-restore"));
      expect(r.stdout).toContain(railLine("tier-drift-accept"));
    });
  });

  describe("recall-tuning-absent claims nothing is tuned", () => {
    test("with no persisted tuning the exit fires", async () => {
      const r = await runCli(["brain", "tune", "status", "--vault", vault], { env: env() });
      expect(r.returncode).toBe(0);
      expect(r.stdout).toContain(railLine("recall-tuning-absent"));
    });

    test("with valid persisted tuning it does not, on either stream", async () => {
      mkdirSync(join(vault, "Brain", "search"), { recursive: true });
      writeFileSync(
        join(vault, "Brain", "search", "tuning.json"),
        JSON.stringify({
          chosen: { poolMultiplier: 3, traversalDepth: 1, learnedWeights: false, expansion: false },
        }),
      );
      const human = await runCli(["brain", "tune", "status", "--vault", vault], { env: env() });
      expect(human.returncode).toBe(0);
      expect(human.stdout).toContain("pool x3");
      expect(human.stdout).not.toContain(railLine("recall-tuning-absent"));

      const machine = await runCli(["brain", "tune", "status", "--vault", vault, "--json"], {
        env: env(),
      });
      expect(machine.returncode).toBe(0);
      expect(JSON.parse(machine.stdout)).not.toHaveProperty(NEXT_COMMAND_KEY);
    });
  });

  describe("staged-captures-pending claims captures await routing", () => {
    test("the human stream names the exit only while a capture is staged", async () => {
      const nothing = await runCli(["brain", "inbox-drain"], { env: env() });
      expect(nothing.returncode).toBe(0);
      expect(nothing.stdout).not.toContain(railLine("staged-captures-pending"));

      writeCaptureNote(vault, {
        body: "an atomic idea to keep",
        provenance: { source: "telegram", sender: "100", capturedAt: "2026-07-19T12:00:02Z" },
      });
      const staged = await runCli(["brain", "inbox-drain"], { env: env() });
      expect(staged.returncode).toBe(0);
      expect(staged.stdout).toContain(railLine("staged-captures-pending"));

      const applied = await runCli(["brain", "inbox-drain", "--apply"], { env: env() });
      expect(applied.returncode).toBe(0);
      expect(applied.stdout).not.toContain(railLine("staged-captures-pending"));
    });
  });
});

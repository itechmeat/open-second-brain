import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { HYGIENE_AUDIT_DIR } from "../../src/core/brain/audit-dirs.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-entity-cli-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test-agent\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

async function seed(): Promise<void> {
  const out = await runCli(
    [
      "brain",
      "entity",
      "set",
      "people",
      "Ada",
      "--alias",
      "the operator",
      "--body",
      "Vault operator.",
    ],
    { env: env() },
  );
  expect(out.returncode).toBe(0);
}

describe("o2b brain entity", () => {
  test("set creates and reports the entity id", async () => {
    const out = await runCli(["brain", "entity", "set", "people", "Ada", "--json"], {
      env: env(),
    });
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(payload["id"]).toBe("ent-people-ada");
    expect(payload["created"]).toBe(true);
  });

  test("get resolves by alias and prints the record", async () => {
    await seed();
    const out = await runCli(["brain", "entity", "get", "the operator", "--json"], {
      env: env(),
    });
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(payload["id"]).toBe("ent-people-ada");
    expect(payload["name"]).toBe("Ada");
  });

  test("get returns exit 2 for an unknown entity", async () => {
    await seed();
    const out = await runCli(["brain", "entity", "get", "nobody", "--json"], { env: env() });
    expect(out.returncode).toBe(2);
  });

  test("list filters by category", async () => {
    await seed();
    await runCli(["brain", "entity", "set", "projects", "Open Second Brain"], { env: env() });
    const out = await runCli(["brain", "entity", "list", "--category", "people", "--json"], {
      env: env(),
    });
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as { entities: Array<{ id: string }> };
    expect(payload.entities.map((e) => e.id)).toEqual(["ent-people-ada"]);
  });

  test("relate writes a typed relation", async () => {
    await seed();
    await runCli(["brain", "entity", "set", "projects", "Open Second Brain"], { env: env() });
    const out = await runCli(
      ["brain", "entity", "relate", "Ada", "related", "Open Second Brain", "--json"],
      { env: env() },
    );
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as { relations: Array<{ target: string }> };
    expect(payload.relations[0]!.target).toBe("ent-projects-open-second-brain");
  });

  test("archive and restore round-trip", async () => {
    await seed();
    const archived = await runCli(["brain", "entity", "archive", "Ada", "--json"], {
      env: env(),
    });
    expect(archived.returncode).toBe(0);
    expect((JSON.parse(archived.stdout) as Record<string, unknown>)["status"]).toBe("archived");

    const gone = await runCli(["brain", "entity", "get", "Ada"], { env: env() });
    expect(gone.returncode).toBe(2);

    const restored = await runCli(["brain", "entity", "archive", "Ada", "--restore", "--json"], {
      env: env(),
    });
    expect(restored.returncode).toBe(0);
    expect((JSON.parse(restored.stdout) as Record<string, unknown>)["status"]).toBe("active");
  });

  test("duplicate alias claim fails with a clear error", async () => {
    await seed();
    const out = await runCli(
      ["brain", "entity", "set", "people", "Imposter", "--alias", "the operator"],
      { env: env() },
    );
    expect(out.returncode).not.toBe(0);
    expect(out.stderr).toContain("alias");
  });

  test("set strips Markdown decoration from the stored name", async () => {
    const out = await runCli(["brain", "entity", "set", "projects", "**Mercury**", "--json"], {
      env: env(),
    });
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(payload["name"]).toBe("Mercury");
    expect(payload["id"]).toBe("ent-projects-mercury");
  });

  test("set rejects a structurally-junk name with a non-zero exit", async () => {
    const out = await runCli(["brain", "entity", "set", "people", "***"], { env: env() });
    expect(out.returncode).not.toBe(0);
    expect(out.stderr).toContain("invalid entity label");
  });

  test("prune is dry-run by default and reports no candidates on a clean vault", async () => {
    await seed();
    const out = await runCli(["brain", "entity", "prune", "--json"], { env: env() });
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as { confirmed: boolean; candidates: unknown[] };
    expect(payload.confirmed).toBe(false);
    expect(payload.candidates).toEqual([]);
  });
});

/**
 * Recall-quality A4: `o2b brain entity lexicon rebuild` derives the
 * store-learned lexicon artifact. Dry-run report by default; a derived
 * write is not destructive, so writing takes `--apply`, never `--confirm`
 * - and the verb writes ONLY the derived artifact, never entity nodes.
 */
describe("o2b brain entity lexicon rebuild (recall-quality A4)", () => {
  /** A corpus page whose tokens teach the artifact; caseful, `notes` common. */
  function seedCorpus(): void {
    writeFileSync(
      join(vault, "corpus-page.md"),
      "Notes about the setup. The runner kept notes. Notes ran, notes ran again.\n",
    );
  }

  test("dry-run by default: reports, writes nothing", async () => {
    seedCorpus();
    const out = await runCli(["brain", "entity", "lexicon", "rebuild", "--json"], {
      env: env(),
    });
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(payload["applied"]).toBe(false);
    expect(Number(payload["entries"])).toBeGreaterThan(0);
    expect(payload["schema"]).toBe("o2b.entity-lexicon.v1");
    expect(existsSync(join(vault, "Brain", "entities", "lexicon.json"))).toBe(false);
  });

  test("--apply writes only the derived artifact (no --confirm needed)", async () => {
    seedCorpus();
    const out = await runCli(["brain", "entity", "lexicon", "rebuild", "--apply", "--json"], {
      env: env(),
    });
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(payload["applied"]).toBe(true);
    const artifactPath = join(vault, "Brain", "entities", "lexicon.json");
    expect(existsSync(artifactPath)).toBe(true);
    const doc = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
    expect(doc["schema"]).toBe("o2b.entity-lexicon.v1");
    expect(typeof doc["corpus_scope"]).toBe("string");
    expect(typeof doc["dataset_hash"]).toBe("string");
    // Only the derived artifact: no entity nodes were minted by the rebuild.
    expect(readdirSync(join(vault, "Brain", "entities")).filter((f) => f.endsWith(".md"))).toEqual(
      [],
    );
  });

  test("a rebuilt lexicon gates creation end to end: a learned common word is refused", async () => {
    seedCorpus();
    const rebuild = await runCli(["brain", "entity", "lexicon", "rebuild", "--apply"], {
      env: env(),
    });
    expect(rebuild.returncode).toBe(0);
    expect(rebuild.stdout).toContain("lexicon");
    const refused = await runCli(["brain", "entity", "set", "people", "Notes"], { env: env() });
    expect(refused.returncode).not.toBe(0);
    expect(refused.stderr).toContain("function-word-run");
    // A code-shaped label still admits beside the lexicon.
    const code = await runCli(["brain", "entity", "set", "systems", "FTS5"], { env: env() });
    expect(code.returncode).toBe(0);
  });

  test("an unknown lexicon subcommand is a usage error", async () => {
    const out = await runCli(["brain", "entity", "lexicon", "polish"], { env: env() });
    expect(out.returncode).not.toBe(0);
  });
});

/**
 * Recall-quality review M3: `entity prune --confirm` must agree with the
 * A2 creation policy. The advisory verdict classes - a single-token shout
 * (NASA, a brand or acronym) and a function-word run (Meeting, a topic) -
 * stay in place unless the operator opts in with `--include-advisory`;
 * structural junk still prunes by default.
 */
describe("o2b brain entity prune - advisory classes are opt-in (recall-quality M3)", () => {
  function seedCorpus(): void {
    writeFileSync(
      join(vault, "corpus-page.md"),
      "Meeting notes about the setup. The weekly meeting ran. " +
        "Notes ran, the meeting kept notes, notes ran again.\n",
    );
  }

  /** Write an entity node directly, bypassing the creation quality gate. */
  function writeNode(category: string, id: string, name: string): string {
    const dir = join(vault, "Brain", "entities", category);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${id}.md`);
    writeFileSync(
      path,
      [
        "---",
        "kind: brain-entity",
        `entity_id: ${id}`,
        `category: ${category}`,
        `name: ${name}`,
        "status: active",
        "created_at: 2026-07-18T00:00:00Z",
        "updated_at: 2026-07-18T00:00:00Z",
        "tags:",
        "  - brain",
        "  - brain/entity",
        "---",
        "",
        `# ${name}`,
        "",
      ].join("\n"),
    );
    return path;
  }

  /** A caseful lexicon plus one advisory acronym, one advisory topic, one junk node. */
  async function seedAdvisoryStore(): Promise<{ nasa: string; meeting: string; junk: string }> {
    seedCorpus();
    const rebuild = await runCli(["brain", "entity", "lexicon", "rebuild", "--apply"], {
      env: env(),
    });
    expect(rebuild.returncode).toBe(0);
    return {
      nasa: writeNode("projects", "ent-projects-nasa", "NASA"),
      meeting: writeNode("people", "ent-people-meeting", "Meeting"),
      junk: writeNode("people", "ent-people-junk", "***"),
    };
  }

  test("prune --confirm keeps the acronym and the topic, removes structural junk", async () => {
    const { nasa, meeting, junk } = await seedAdvisoryStore();
    const out = await runCli(["brain", "entity", "prune", "--confirm", "--json"], { env: env() });
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as { removed: string[]; advisory_skipped: number };
    expect(payload.removed).toEqual([junk]);
    expect(payload.advisory_skipped).toBe(2);
    expect(existsSync(nasa)).toBe(true);
    expect(existsSync(meeting)).toBe(true);
  });

  test("--include-advisory removes the advisory classes too", async () => {
    const { nasa, meeting, junk } = await seedAdvisoryStore();
    const out = await runCli(
      ["brain", "entity", "prune", "--confirm", "--include-advisory", "--json"],
      { env: env() },
    );
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as { removed: string[]; advisory_skipped: number };
    expect(payload.advisory_skipped).toBe(0);
    // All three findings go: the structural junk alongside the advisory classes.
    expect([...payload.removed].sort()).toEqual([nasa, meeting, junk].sort());
    expect(existsSync(nasa)).toBe(false);
    expect(existsSync(meeting)).toBe(false);
    expect(existsSync(junk)).toBe(false);
  });
});

describe("o2b brain entity merge", () => {
  async function seedMergePair(): Promise<{ keepId: string; dropId: string; dropPath: string }> {
    const keep = await runCli(
      ["brain", "entity", "set", "people", "Ada Lovelace", "--body", "Analytical engines."],
      { env: env() },
    );
    expect(keep.returncode).toBe(0);
    const drop = await runCli(["brain", "entity", "set", "people", "Ada", "--json"], {
      env: env(),
    });
    expect(drop.returncode).toBe(0);
    const dropPayload = JSON.parse(drop.stdout) as { id: string; path: string };
    return {
      keepId: "ent-people-ada-lovelace",
      dropId: dropPayload.id,
      dropPath: dropPayload.path,
    };
  }

  test("dry-run --json prints the plan and its hash without touching the vault", async () => {
    const { keepId, dropId, dropPath } = await seedMergePair();
    const out = await runCli(["brain", "entity", "merge", keepId, dropId, "--dry-run", "--json"], {
      env: env(),
    });
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as {
      dry_run: boolean;
      plan: { keep_id: string; drop_id: string; alias_added: string | null };
      plan_hash: string;
    };
    expect(payload.dry_run).toBe(true);
    expect(payload.plan.keep_id).toBe(keepId);
    expect(payload.plan.drop_id).toBe(dropId);
    expect(payload.plan.alias_added).toBe("Ada");
    expect(payload.plan_hash).toMatch(/^[0-9a-f]{64}$/);
    // The drop page is still on disk: a preview writes nothing.
    expect(existsSync(dropPath)).toBe(true);
  });

  test("apply without --expect-hash refuses by name and writes nothing", async () => {
    const { keepId, dropId, dropPath } = await seedMergePair();
    const out = await runCli(["brain", "entity", "merge", keepId, dropId, "--force"], {
      env: env(),
    });
    expect(out.returncode).toBe(1);
    expect(out.stderr).toContain("hash-required");
    expect(existsSync(dropPath)).toBe(true);
  });

  test("apply with a stale or mismatched hash refuses before any write", async () => {
    const { keepId, dropId, dropPath } = await seedMergePair();
    const out = await runCli(
      ["brain", "entity", "merge", keepId, dropId, "--force", "--expect-hash", "deadbeef"],
      { env: env() },
    );
    expect(out.returncode).toBe(1);
    expect(out.stderr).toContain("hash-mismatch");
    expect(existsSync(dropPath)).toBe(true);
  });

  test("apply with the echoed hash and --force merges without prompting", async () => {
    const { keepId, dropId, dropPath } = await seedMergePair();
    const preview = await runCli(
      ["brain", "entity", "merge", keepId, dropId, "--dry-run", "--json"],
      { env: env() },
    );
    const { plan_hash: hash } = JSON.parse(preview.stdout) as { plan_hash: string };
    const out = await runCli(
      ["brain", "entity", "merge", keepId, dropId, "--force", "--expect-hash", hash, "--json"],
      { env: env() },
    );
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as {
      applied: boolean;
      keep_id: string;
      drop_id: string;
      snapshot_run_id: string;
    };
    expect(payload.applied).toBe(true);
    expect(payload.keep_id).toBe(keepId);
    expect(payload.drop_id).toBe(dropId);
    // Recovery points read entity-merge-*, so a restore names the merge -
    // not the prune verb the reason was borrowed from.
    expect(payload.snapshot_run_id).toMatch(/^entity-merge-/);
    expect(existsSync(dropPath)).toBe(false);
    // The old name now resolves to the survivor.
    const get = await runCli(["brain", "entity", "get", "Ada", "--json"], { env: env() });
    expect(get.returncode).toBe(0);
    expect((JSON.parse(get.stdout) as { id: string }).id).toBe(keepId);
    // A doctor re-run after apply is clean of duplicate-entity findings.
    const doctor = await runCli(["brain", "doctor", "--json"], { env: env() });
    expect(doctor.stdout).not.toContain("duplicate-entity");
  });

  test("merges are attributed to the configured agent, not 'unknown'", async () => {
    const auditText = (): string => {
      const auditDir = join(vault, "Brain", "log", HYGIENE_AUDIT_DIR);
      return readdirSync(auditDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => readFileSync(join(auditDir, f), "utf8"))
        .join("\n");
    };

    // No --agent at all: the config's agent_name attributes the merge.
    const { keepId, dropId } = await seedMergePair();
    const preview = await runCli(
      ["brain", "entity", "merge", keepId, dropId, "--dry-run", "--json"],
      { env: env() },
    );
    const { plan_hash: hash } = JSON.parse(preview.stdout) as { plan_hash: string };
    const out = await runCli(
      ["brain", "entity", "merge", keepId, dropId, "--force", "--expect-hash", hash, "--json"],
      { env: env() },
    );
    expect(out.returncode).toBe(0);
    expect(auditText()).toContain('"actor":"test-agent"');
    expect(auditText()).not.toContain('"actor":"unknown"');

    // A blank --agent normalizes away to the configured agent too - it is
    // not a null actor smuggled into the audit record.
    const second = await runCli(["brain", "entity", "set", "people", "Grace Hopper"], {
      env: env(),
    });
    expect(second.returncode).toBe(0);
    const third = await runCli(["brain", "entity", "set", "people", "Grace"], { env: env() });
    expect(third.returncode).toBe(0);
    const secondPreview = await runCli(
      [
        "brain",
        "entity",
        "merge",
        "ent-people-grace-hopper",
        "ent-people-grace",
        "--dry-run",
        "--json",
      ],
      { env: env() },
    );
    const { plan_hash: secondHash } = JSON.parse(secondPreview.stdout) as { plan_hash: string };
    const blankAgent = await runCli(
      [
        "brain",
        "entity",
        "merge",
        "ent-people-grace-hopper",
        "ent-people-grace",
        "--force",
        "--expect-hash",
        secondHash,
        "--agent",
        "   ",
        "--json",
      ],
      { env: env() },
    );
    expect(blankAgent.returncode).toBe(0);
    expect(auditText()).not.toContain('"actor":"unknown"');
    expect(auditText()).toContain('"actor":"test-agent"');
  });

  test("--json without --force refuses as structured consent-required JSON", async () => {
    const { keepId, dropId, dropPath } = await seedMergePair();
    const preview = await runCli(
      ["brain", "entity", "merge", keepId, dropId, "--dry-run", "--json"],
      { env: env() },
    );
    const { plan_hash: hash } = JSON.parse(preview.stdout) as { plan_hash: string };
    const out = await runCli(
      ["brain", "entity", "merge", keepId, dropId, "--json", "--expect-hash", hash],
      { env: env() },
    );
    expect(out.returncode).toBe(1);
    // A JSON caller gets a structured refusal on stdout, not fail() prose
    // on stderr: the code is the stable consent vocabulary.
    const payload = JSON.parse(out.stdout) as { ok: boolean; code: string; message: string };
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("consent-required");
    expect(payload.message).toContain("--json without --force");
    expect(out.stderr).toBe("");
    expect(existsSync(dropPath)).toBe(true);
  });

  test("non-TTY stdin without --force refuses instead of prompting", async () => {
    const { keepId, dropId } = await seedMergePair();
    const preview = await runCli(
      ["brain", "entity", "merge", keepId, dropId, "--dry-run", "--json"],
      { env: env() },
    );
    const { plan_hash: hash } = JSON.parse(preview.stdout) as { plan_hash: string };
    const out = await runCli(["brain", "entity", "merge", keepId, dropId, "--expect-hash", hash], {
      env: env(),
    });
    expect(out.returncode).toBe(1);
    expect(out.stderr).toContain("--force required when stdin is not a TTY");
  });

  test("plain dry-run prints the plan-hash line and an apply command", async () => {
    const { keepId, dropId } = await seedMergePair();
    const out = await runCli(["brain", "entity", "merge", keepId, dropId, "--dry-run"], {
      env: env(),
    });
    expect(out.returncode).toBe(0);
    expect(out.stdout).toContain("plan-hash: ");
    expect(out.stdout).toContain("--expect-hash ");
    expect(out.stdout).toContain("dry-run; no changes written");
  });

  test("plain dry-run names the cyclic edges the merge will remove", async () => {
    const { keepId, dropId } = await seedMergePair();
    // The survivor points at the dropped page: a self-relation after the
    // merge, so the plan removes it - and says so before the operator
    // consents.
    const relate = await runCli(["brain", "entity", "relate", "Ada Lovelace", "related", "Ada"], {
      env: env(),
    });
    expect(relate.returncode).toBe(0);
    const out = await runCli(["brain", "entity", "merge", keepId, dropId, "--dry-run"], {
      env: env(),
    });
    expect(out.returncode).toBe(0);
    expect(out.stdout).toContain("cyclic edges removed: 1");
  });

  test("an unexpected failure answers a JSON caller with structured internal-error", async () => {
    const { keepId, dropId } = await seedMergePair();
    const preview = await runCli(
      ["brain", "entity", "merge", keepId, dropId, "--dry-run", "--json"],
      { env: env() },
    );
    const { plan_hash: hash } = JSON.parse(preview.stdout) as { plan_hash: string };
    // Swap the vault's identity marker underneath the live process: the
    // write gate refuses below the verb's own refusal vocabulary - the
    // store changed, not a merge decision. Nothing has been written when
    // it fires.
    const marker = join(vault, "Brain", "vault-id.json");
    writeFileSync(
      marker,
      JSON.stringify({
        schema_version: 1,
        vault_id: "tampered-away-from-the-pinned-id",
        created_at: "2026-01-01T00:00:00Z",
      }),
    );
    const out = await runCli(
      ["brain", "entity", "merge", keepId, dropId, "--force", "--expect-hash", hash, "--json"],
      { env: env() },
    );
    expect(out.returncode).toBe(1);
    const payload = JSON.parse(out.stdout) as { ok: boolean; code: string; message: string };
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("internal-error");
    // The error's own message, one line - never a stack.
    expect(payload.message.split("\n").length).toBe(1);
    expect(payload.message.length).toBeGreaterThan(0);
    expect(out.stderr).toBe("");
  });

  test("the echoed apply command shell-quotes subjects a shell would split", async () => {
    // Subjects echo verbatim into a command line, so a name with a space
    // must come back quoted: `merge 'Ada Lovelace'` parses back as ONE
    // argument, the raw form would split into two.
    await seedMergePair();
    const out = await runCli(["brain", "entity", "merge", "Ada Lovelace", "Ada", "--dry-run"], {
      env: env(),
    });
    expect(out.returncode).toBe(0);
    // The spaced name is quoted; the plain word stays bare.
    expect(out.stdout).toContain("merge 'Ada Lovelace' Ada");
    expect(out.stdout).not.toContain("merge Ada Lovelace");
  });

  test("the echoed apply command carries the --vault flag it was given", async () => {
    // A synced copy at a spaced path: pasting the echo back must target
    // THAT vault - quoted, so the path survives the shell as one argument -
    // not silently fall back to whichever vault the paste resolves.
    const spacedVault = join(tmp, "synced copy");
    const spacedConfig = join(tmp, "spaced.yaml");
    writeFileSync(spacedConfig, `vault: ${spacedVault}\nagent_name: test-agent\n`);
    bootstrapBrain(spacedVault, { configPath: spacedConfig });
    const spacedEnv = () => ({ OPEN_SECOND_BRAIN_CONFIG: spacedConfig });
    const keep = await runCli(["brain", "entity", "set", "people", "Ada Lovelace"], {
      env: spacedEnv(),
    });
    expect(keep.returncode).toBe(0);
    const drop = await runCli(["brain", "entity", "set", "people", "Ada"], { env: spacedEnv() });
    expect(drop.returncode).toBe(0);
    const out = await runCli(
      [
        "brain",
        "entity",
        "merge",
        "ent-people-ada-lovelace",
        "ent-people-ada",
        "--dry-run",
        "--vault",
        spacedVault,
      ],
      { env: spacedEnv() },
    );
    expect(out.returncode).toBe(0);
    expect(out.stdout).toContain(`--vault '${spacedVault}'`);
  });

  test("a guard-tripping pair merges end-to-end under --force; the hash gate still binds", async () => {
    // The keep body anchors Mary Somerville, the drop body anchors only Ada:
    // disjoint guarded anchor sets, the shape the core merge guard refuses.
    const keep = await runCli(
      [
        "brain",
        "entity",
        "set",
        "people",
        "Ada Lovelace",
        "--body",
        "Mary Somerville wrote often.",
      ],
      { env: env() },
    );
    expect(keep.returncode).toBe(0);
    const drop = await runCli(
      ["brain", "entity", "set", "people", "Ada", "--body", "Short note about Ada.", "--json"],
      { env: env() },
    );
    expect(drop.returncode).toBe(0);
    const dropPayload = JSON.parse(drop.stdout) as { id: string; path: string };
    const mary = await runCli(["brain", "entity", "set", "people", "Mary Somerville"], {
      env: env(),
    });
    expect(mary.returncode).toBe(0);
    const keepId = "ent-people-ada-lovelace";
    const dropId = dropPayload.id;
    const dropPath = dropPayload.path;

    // Even the preview refuses while the guard stands, by its stable code.
    const blocked = await runCli(
      ["brain", "entity", "merge", keepId, dropId, "--dry-run", "--json"],
      { env: env() },
    );
    expect(blocked.returncode).toBe(1);
    expect(JSON.parse(blocked.stdout)).toMatchObject({ ok: false, code: "entity-guard" });
    expect(existsSync(dropPath)).toBe(true);

    // --force unblocks the guarded preview and still echoes the hash.
    const preview = await runCli(
      ["brain", "entity", "merge", keepId, dropId, "--force", "--dry-run", "--json"],
      { env: env() },
    );
    expect(preview.returncode).toBe(0);
    const { plan_hash: hash } = JSON.parse(preview.stdout) as { plan_hash: string };
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // The hash gate is a fact-check, not consent: --force does NOT bypass it.
    const stale = await runCli(
      ["brain", "entity", "merge", keepId, dropId, "--force", "--expect-hash", "deadbeef"],
      { env: env() },
    );
    expect(stale.returncode).toBe(1);
    expect(stale.stderr).toContain("hash-mismatch");
    expect(existsSync(dropPath)).toBe(true);

    const out = await runCli(
      ["brain", "entity", "merge", keepId, dropId, "--force", "--expect-hash", hash, "--json"],
      { env: env() },
    );
    expect(out.returncode).toBe(0);
    expect((JSON.parse(out.stdout) as { applied: boolean }).applied).toBe(true);
    expect(existsSync(dropPath)).toBe(false);
    // The old name resolves to the survivor: the guarded merge really landed.
    const get = await runCli(["brain", "entity", "get", "Ada", "--json"], { env: env() });
    expect(get.returncode).toBe(0);
    expect((JSON.parse(get.stdout) as { id: string }).id).toBe(keepId);
  });
});

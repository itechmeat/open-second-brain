/**
 * Workspace Insight Suite e2e (epic t_618c7bd8): one flow exercises
 * both kernels end to end over the real CLI - link a project to its
 * vault, attach a read-only source, search across vaults with origin
 * labels, generate triggers, transition one, and watch the morning
 * brief deliver pending triggers once.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTriggers } from "../../src/core/brain/triggers/store.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let external: string;
let project: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-wis-e2e-"));
  vault = join(tmp, "vault");
  external = join(tmp, "external");
  project = join(tmp, "repo");
  mkdirSync(join(vault, "Brain", "notes"), { recursive: true });
  mkdirSync(join(external, "Brain", "notes"), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(vault, "Brain", "notes", "local.md"),
    "# Local\n\nThe kraken charter lives in the local vault.\n",
  );
  writeFileSync(
    join(external, "Brain", "notes", "shared.md"),
    "# Shared\n\nThe kraken charter is mirrored in the team vault.\n",
  );
  config = join(tmp, "config.yaml");
  writeFileSync(config, `vault: "${vault}"\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: config });

test("workspace reach: link, attach, search across vaults from the project dir", async () => {
  // 1. Link the project directory to the vault.
  const link = await runCli(["brain", "project", "link", project], { env: env() });
  expect(link.returncode).toBe(0);

  // 2. Attach the external vault as a read-only recall source.
  const source = await runCli(["brain", "source", "add", external, "--alias", "team"], {
    env: env(),
  });
  expect(source.returncode).toBe(0);

  // 3. Index both vaults explicitly (union search never builds one).
  expect((await runCli(["search", "index"], { env: env() })).returncode).toBe(0);
  expect((await runCli(["search", "index", "--vault", external], { env: env() })).returncode).toBe(
    0,
  );

  // 4. Search from inside the linked project dir with --global: the
  //    pointer resolves the vault, the union labels both origins.
  const out = await runCli(["search", "kraken charter", "--global", "--json"], {
    env: env(),
    cwd: project,
  });
  expect(out.returncode).toBe(0);
  const parsed = JSON.parse(out.stdout) as {
    results: Array<{ origin?: string; path: string }>;
  };
  const origins = new Set(parsed.results.map((r) => r.origin));
  expect(origins).toEqual(new Set(["local", "source/team"]));

  // 5. The external vault was never written to.
  expect(existsSync(join(external, ".o2bfs"))).toBe(false);
});

test("proactive insight: triggers flow from scan to brief to lifecycle", async () => {
  // Seed one trigger directly (scan over a bare vault finds nothing).
  const NOW = new Date();
  createTriggers(
    vault,
    [
      {
        kind: "contradiction",
        urgency: "high",
        reason: "pref-x contradicts pref-y",
        suggestedAction: "Reconcile the pair",
        sourceArtifacts: ["[[pref-x]]"],
        contextSnippets: [],
        cooldownKey: "contradiction:pref-x:pref-y",
      },
    ],
    { now: NOW },
  );

  // 1. The morning brief surfaces the pending trigger and delivers it.
  const brief = await runCli(["brain", "morning-brief"], { env: env() });
  expect(brief.returncode).toBe(0);
  expect(brief.stdout).toContain("Pending triggers");
  expect(brief.stdout).toContain("pref-x contradicts pref-y");

  // 2. A second brief inside the cooldown window stays silent.
  const second = await runCli(["brain", "morning-brief"], { env: env() });
  expect(second.stdout).not.toContain("Pending triggers");

  // 3. The operator acknowledges and acts on it via the CLI.
  const list = await runCli(["brain", "trigger", "list", "--json"], { env: env() });
  const triggers = (JSON.parse(list.stdout) as { triggers: Array<{ id: string }> }).triggers;
  expect(triggers).toHaveLength(1);
  const id = triggers[0]!.id;
  expect((await runCli(["brain", "trigger", "ack", id], { env: env() })).returncode).toBe(0);
  expect((await runCli(["brain", "trigger", "act", id], { env: env() })).returncode).toBe(0);

  // 4. History shows the acted trigger; the open list is empty.
  const history = await runCli(["brain", "trigger", "history", "--json"], { env: env() });
  const acted = (JSON.parse(history.stdout) as { triggers: Array<{ status: string }> }).triggers;
  expect(acted[0]!.status).toBe("acted");
  const openList = await runCli(["brain", "trigger", "list", "--json"], { env: env() });
  expect((JSON.parse(openList.stdout) as { triggers: unknown[] }).triggers).toHaveLength(0);

  // 5. An idea scan with --triggers enqueues fresh directions.
  writeFileSync(join(vault, "Brain", "notes", "orphan.md"), "# Orphan idea\n");
  const ideas = await runCli(["brain", "ideas", "--triggers", "--json"], { env: env() });
  expect(ideas.returncode).toBe(0);
  const ideasParsed = JSON.parse(ideas.stdout) as { triggers_created: number };
  expect(ideasParsed.triggers_created).toBeGreaterThan(0);
});

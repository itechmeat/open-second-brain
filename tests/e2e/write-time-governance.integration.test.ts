/**
 * Write-Time Integrity & Governance Suite - end-to-end integration
 * over one vault: ontology declaration through schema mutations
 * (Task 1), label assignment + filterable recall (t_7a41f42d), a
 * constraint-violating typed edge blocked at materialization
 * (t_15453235), attribute validation teaching the vocabulary
 * (t_f5633190), a hand-edited identity key detected and restored
 * (t_3f92d3f1), secret custody with redacted exec (t_0b134404), and
 * the lease-guarded maintenance lane (t_166d1226).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applySchemaMutations } from "../../src/core/brain/schema-mutate.ts";
import { loadSchemaPack } from "../../src/core/brain/schema-pack.ts";
import { assignNoteLabel } from "../../src/core/brain/labels.ts";
import { assignNoteAttribute, AttributeVocabularyError } from "../../src/core/brain/attributes.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { runWithSecret } from "../../src/core/brain/secrets/exec.ts";
import { setSecret } from "../../src/core/brain/secrets/store.ts";
import { runMaintenance } from "../../src/core/brain/maintenance/lane.ts";
import { listJournal } from "../../src/core/brain/maintenance/journal.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { search } from "../../src/core/search/search.ts";
import { Store } from "../../src/core/search/store.ts";
import { makeConfig } from "../helpers/search-fixtures.ts";

const NOW = new Date("2026-06-05T03:00:00Z");

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-wtig-e2e-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-wtig-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

test("the suite composes end to end on one vault", async () => {
  // -- 1. Declare the ontology through audited schema mutations --------
  await applySchemaMutations(
    vault,
    [
      { op: "add_type", category: "page_types", token: "paper" },
      { op: "add_type", category: "page_types", token: "receipt" },
      { op: "add_link_type", token: "depends_on" },
      { op: "add_label_dimension", dimension: "priority", values: ["low", "high"] },
      { op: "add_link_constraint", link_type: "depends_on", source: "paper", target: "paper" },
      {
        op: "set_attribute_field",
        type: "paper",
        field: "status",
        description: "reading status, e.g. queued or finished",
      },
    ],
    { actor: "e2e", now: NOW },
  );
  const pack = loadSchemaPack(vault);
  expect(pack.labels["priority"]).toEqual(["low", "high"]);

  // -- 2. Notes: one conforming edge, one violating, one hand-edit bait --
  writeFileSync(
    join(vault, "notes-a.md"),
    '---\ntype: paper\ndepends_on: "[[notes-b]]"\nrelated: "[[notes-c]]"\n---\n\n# A\n\nGovernance pilot note.\n',
  );
  writeFileSync(join(vault, "notes-b.md"), "---\ntype: receipt\n---\n\n# B\n\nA receipt.\n");
  writeFileSync(join(vault, "notes-c.md"), "---\ntype: paper\n---\n\n# C\n\nCompanion paper.\n");
  writeFileSync(
    join(vault, "Brain", "preferences", "pref-canary.md"),
    "---\nkind: brain-preference\nid: pref-canary\ncreated_at: 2026-05-01T00:00:00Z\ntopic: deploys\n---\n\nCanary first.\n",
  );

  // -- 3. Labels: validated assignment, filterable recall ----------------
  assignNoteLabel(vault, "notes-a.md", {
    dimension: "priority",
    value: "high",
    pack,
    agent: "e2e",
    now: NOW,
  });

  const dbPath = join(vault, ".open-second-brain", "brain.sqlite");
  const config = makeConfig({ vault, dbPath });
  const first = await indexVault(config);

  // -- 4. Link constraint: paper->receipt blocked, paper->paper typed ----
  expect(first.relationViolations).toHaveLength(1);
  expect(first.relationViolations[0]).toMatchObject({
    relation: "depends_on",
    sourceType: "paper",
    targetType: "receipt",
  });

  const labeled = await search(config, {
    query: "governance pilot",
    properties: new Map([["labels", ["priority/high"]]]),
  });
  expect(labeled.results.some((r) => r.path === "notes-a.md")).toBe(true);

  // -- 5. Attributes: the error teaches the vocabulary -------------------
  expect(() =>
    assignNoteAttribute(vault, "notes-a.md", { field: "rating", value: "5", pack }),
  ).toThrow(AttributeVocabularyError);
  const attr = assignNoteAttribute(vault, "notes-a.md", {
    field: "status",
    value: "queued",
    pack,
  });
  expect(attr.attributes).toEqual(["status=queued"]);

  // -- 6. Tier drift: hand-edit the join key, detect, restore ------------
  writeFileSync(
    join(vault, "Brain", "preferences", "pref-canary.md"),
    "---\nkind: brain-preference\nid: pref-mangled\ncreated_at: 2026-05-01T00:00:00Z\ntopic: deploys\n---\n\nCanary first, edited by hand.\n",
  );
  const second = await indexVault(config);
  expect(second.tierDrift).toEqual([
    {
      path: "Brain/preferences/pref-canary.md",
      field: "id",
      expected: "pref-canary",
      actual: "pref-mangled",
    },
  ]);
  const store = await Store.open(config, { mode: "write" });
  try {
    const docId = store.getDocumentIdByPath("Brain/preferences/pref-canary.md")!;
    const drift = store.listTierDrift().find((r) => r.documentId === docId)!;
    expect(drift.expected).toBe("pref-canary");
    store.clearTierDrift(docId, "id");
  } finally {
    await store.close();
  }

  // -- 7. Secret custody: redacted exec under the allowlist --------------
  setSecret(vault, {
    name: "deploy-token",
    value: "tok-e2e-secret-31337",
    allow: ["bun -e *"],
    agent: "e2e",
    now: NOW,
  });
  const exec = await runWithSecret(
    vault,
    "deploy-token",
    ["bun", "-e", "console.log('t=' + process.env.DEPLOY_TOKEN)"],
    { agent: "e2e", now: NOW },
  );
  expect(exec.exitCode).toBe(0);
  expect(exec.stdout).not.toContain("tok-e2e-secret-31337");
  const storeRaw = readFileSync(
    join(vault, ".open-second-brain", "secrets", "secrets.json"),
    "utf8",
  );
  expect(storeRaw).not.toContain("tok-e2e-secret-31337");

  // -- 8. Maintenance lane: gated, leased, journaled ----------------------
  const lane = await runMaintenance(vault, {
    now: NOW,
    holder: "e2e@1",
    tasks: [
      {
        name: "reindex",
        run: async () => {
          await indexVault(config);
        },
      },
    ],
  });
  expect(lane.verdict).toBe("run");
  expect(lane.tasks[0]!.ok).toBe(true);
  expect(listJournal(vault).some((e) => e.task === "reindex" && e.ok === true)).toBe(true);
});

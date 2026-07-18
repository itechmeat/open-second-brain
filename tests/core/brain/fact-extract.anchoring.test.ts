/**
 * A1 (t_657b365e): fact-extract anchoring applies the label quality gate
 * to stored entity labels. A junk-label node is skipped-with-log and the
 * skip never breaks the enclosing capture (per-fact containment).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { writeFrontmatterAtomic } from "../../../src/core/vault.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { readLogDay } from "../../../src/core/brain/log-jsonl.ts";
import { __clearEntityIndexCache } from "../../../src/core/brain/entities/index-builder.ts";
import { routeExtractedFacts, type ExtractedFact } from "../../../src/core/brain/fact-extract.ts";
import type { DedupIndexEntry } from "../../../src/core/brain/dedup-hash.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-07-18T12:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-anchor-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-anchor-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
  __clearEntityIndexCache();
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  __clearEntityIndexCache();
});

function writeEntityNode(category: string, id: string, name: string): void {
  const dir = join(brainDirs(vault).entities, category);
  mkdirSync(dir, { recursive: true });
  writeFrontmatterAtomic(
    join(dir, `${id}.md`),
    {
      kind: "brain-entity",
      entity_id: id,
      category,
      name,
      status: "active",
      created_at: "2026-07-18T00:00:00Z",
      updated_at: "2026-07-18T00:00:00Z",
      tags: ["brain", "brain/entity"],
    },
    `# ${name}`,
    { overwrite: true },
  );
  __clearEntityIndexCache();
}

function inboxSignalBodies(): string[] {
  const dir = brainDirs(vault).inbox;
  return readdirSync(dir)
    .filter((f) => f.startsWith("sig-") && f.endsWith(".md"))
    .map((f) => readFileSync(join(dir, f), "utf8"));
}

describe("routeExtractedFacts anchoring with a junk-label node", () => {
  test("skips the junk node, logs the skip, and still captures the fact", () => {
    writeEntityNode("orgs", "ent-orgs-acme", "Acme");
    writeEntityNode("orgs", "ent-orgs-junk", "***");

    const facts: ExtractedFact[] = [{ family: "quantity", text: "acme shipped 5 units", line: 1 }];
    const dedup = new Map<string, DedupIndexEntry>();
    const result = routeExtractedFacts(vault, {
      facts,
      agent: "claude-dev-agent",
      now: NOW,
      sessionRef: "session#turn-1",
      dedup,
    });

    // The capture completed - the junk-label skip did not break it.
    expect(result.created).toBe(1);

    // The written signal anchors the valid entity but never the junk one.
    const bodies = inboxSignalBodies();
    const anchored = bodies.find((b) => b.includes("entities:"));
    expect(anchored).toBeDefined();
    expect(anchored!).toContain("ent-orgs-acme");
    expect(anchored!).not.toContain("ent-orgs-junk");

    // The skip is logged under the dedicated event kind.
    const log = readLogDay(vault, "2026-07-18");
    const skip = log.entries.find((e) => e.eventType === "entity-anchor-skip");
    expect(skip).toBeDefined();
    expect(skip!.body["entity"]).toBe("ent-orgs-junk");
    expect(skip!.body["reason"]).toBe("empty");
  });

  test("a decorated stored name still anchors after sanitisation", () => {
    // A historical node whose name carries Markdown emphasis is still a
    // valid label after stripping, so anchoring must resolve it.
    writeEntityNode("orgs", "ent-orgs-globex", "**Globex**");
    const dedup = new Map<string, DedupIndexEntry>();
    routeExtractedFacts(vault, {
      facts: [{ family: "quantity", text: "globex raised 10 units", line: 1 }],
      agent: "claude-dev-agent",
      now: NOW,
      sessionRef: "session#turn-2",
      dedup,
    });
    const anchored = inboxSignalBodies().find((b) => b.includes("entities:"));
    expect(anchored).toBeDefined();
    expect(anchored!).toContain("ent-orgs-globex");
  });
});

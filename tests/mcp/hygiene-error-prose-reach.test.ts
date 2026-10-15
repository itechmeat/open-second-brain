/**
 * `brain_hygiene` states its error rows for the caller's reach.
 *
 * The scan, refresh and apply payloads carry error rows on the SUCCESS
 * channel, which the server's redactor never sees - it wraps thrown
 * errors only. A detector or executor failure forwards failure prose
 * that names absolute host paths (Node's fs text, a corrupted manifest's
 * path), so the surface states that prose for the caller's reach the
 * same way a throw is stated: substituted below local reach, verbatim at
 * local reach.
 *
 * Claims pinned here:
 *
 *   1. Below local reach an apply failure's prose carries the vault as a
 *      placeholder, never the host path.
 *   2. At local reach the same failure's prose is unchanged - the
 *      operator's own surface loses no detail.
 *   3. The failure itself is honest at both reaches: the row names the
 *      finding, and the message says the retired copy is not on disk.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { manifestPath } from "../../src/core/brain/ingest/content-manifest.ts";
import { HYGIENE_TOOLS } from "../../src/mcp/brain/hygiene-tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";

let tmp: string;
let vault: string;
let configPath: string;

const CANONICAL_BODY =
  "Collect the latency metrics before optimizing the render loop and archive the traces weekly";
const DUPLICATE_BODY =
  "Collect the latency metrics before optimizing the render loop and archive the traces daily";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-hygiene-prose-reach-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`, "utf8");
  bootstrapBrain(vault, { configPath });
  mkdirSync(join(vault, "Brain", "sources"), { recursive: true });
  mkdirSync(join(vault, "imports"), { recursive: true });
  writeFileSync(join(vault, "imports", "a.md"), "older source bytes\n", "utf8");
  writeFileSync(join(vault, "imports", "b.md"), "newer source bytes\n", "utf8");
  for (const [slug, body, createdAt] of [
    ["a", CANONICAL_BODY, "2026-01-01T00:00:00Z"],
    ["b", DUPLICATE_BODY, "2026-02-01T00:00:00Z"],
  ] as const) {
    writeFileSync(
      join(vault, "Brain", "sources", `src-${slug}.md`),
      [
        "---",
        "kind: brain-source",
        `source_path: imports/${slug}.md`,
        `source_hash: ${"a".repeat(64)}`,
        "tags: [brain, brain/source]",
        `created_at: ${createdAt}`,
        "---",
        "",
        body,
        "",
      ].join("\n"),
      "utf8",
    );
  }
  // The retirement's manifest step reads this file after the copy is off
  // disk; corrupted, its own error names the file by its host path - the
  // prose a caller's error row would otherwise carry verbatim.
  mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
  writeFileSync(manifestPath(vault), "not json{", "utf8");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function ctx(reach: TransportReach): ServerContext {
  return {
    vault,
    configPath,
    repoRoot: null,
    requestIdentity: { agent: "codex", via: "token" as const },
    reach,
  };
}

async function retireFindingId(): Promise<string> {
  const tool = HYGIENE_TOOLS.find((t) => t.name === "brain_hygiene")!;
  const scan = (await tool.handler(ctx(TRANSPORT_REACH.local), {
    mode: "scan",
    detectors: ["document-dedup"],
  })) as { findings: Array<{ id: string; proposed_action: string }> };
  const finding = scan.findings.find((f) => f.proposed_action === "retire");
  if (finding === undefined) throw new Error("fixture produced no retire finding");
  return finding.id;
}

async function applyRetire(
  reach: TransportReach,
  id: string,
): Promise<Array<{ finding_id: string; message: string }>> {
  const tool = HYGIENE_TOOLS.find((t) => t.name === "brain_hygiene")!;
  const result = (await tool.handler(ctx(reach), {
    mode: "apply",
    detectors: ["document-dedup"],
    ids: [id],
  })) as { errors: Array<{ finding_id: string; message: string }> };
  return result.errors;
}

describe("brain_hygiene error rows at the caller's reach", () => {
  test("below local reach an apply failure's prose carries the vault as a placeholder", async () => {
    const id = await retireFindingId();
    const errors = await applyRetire(TRANSPORT_REACH.remote, id);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.finding_id).toBe(id);
    const message = errors[0]!.message;
    expect(message).toContain("corrupted JSON");
    expect(message).toContain("<vault>");
    expect(message).not.toContain(vault);
    // The failure stays honest about what landed: the copy is gone.
    expect(message).toContain("not on disk");
  });

  test("at local reach the same failure's prose is unchanged", async () => {
    const id = await retireFindingId();
    const errors = await applyRetire(TRANSPORT_REACH.local, id);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain(vault);
    expect(errors[0]!.message).not.toContain("<vault>");
  });
});

/**
 * `brain_hygiene` apply answers the deny consult for the request's
 * credential identity (write-side trust).
 *
 * Retire is the destructive action the hygiene applier routes to
 * `retireDocumentCopies`, whose deny consult refuses on a
 * permissions-document rule naming the consult's subject. The sibling
 * destructive surfaces (`brain_delete_by_source`, `brain_receipts`
 * compaction) thread `ctx.requestIdentity` into that consult; the
 * hygiene apply must too - a rule naming the token's agent is enforced
 * here exactly as on the other destructive routes, instead of falling
 * back to the config agent and applying anyway.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { HYGIENE_TOOLS } from "../../src/mcp/brain/hygiene-tools.ts";

let tmp: string;
let vault: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};

const CANONICAL_BODY =
  "Collect the latency metrics before optimizing the render loop and archive the traces weekly";
const DUPLICATE_BODY =
  "Collect the latency metrics before optimizing the render loop and archive the traces daily";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-hygiene-retire-deny-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  for (const key of ["VAULT_AGENT_NAME", "OPEN_SECOND_BRAIN_CONFIG"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  // The config declares `claude`: only a consult answering for the
  // request identity can ever refuse with `codex`.
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
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

/** A hand-built per-request context whose credential minted `codex`. */
function identityCtx() {
  return {
    vault,
    configPath,
    repoRoot: null,
    requestIdentity: { agent: "codex", via: "token" as const },
  };
}

async function callApply(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = HYGIENE_TOOLS.find((t) => t.name === "brain_hygiene")!;
  // The document-dedup detector is opt-in: every scan that must see the
  // retire finding names it, the apply's own re-scan included.
  return tool.handler(identityCtx() as any, {
    mode: "apply",
    detectors: ["document-dedup"],
    ...args,
  }) as Record<string, unknown>;
}

describe("brain_hygiene apply deny consult", () => {
  test("a document rule naming the request identity refuses the retire route", async () => {
    writeFileSync(
      join(vault, "Brain", "_permissions.yaml"),
      "version: 1\ndefault_action: allow\nentries:\n  - id: freeze\n    agent: codex\n" +
        "    action: ingest\n    verdict: deny\n",
      "utf8",
    );
    const scan = (await toolScan()) as {
      findings: Array<{ id: string; proposed_action: string }>;
    };
    const finding = scan.findings.find((f) => f.proposed_action === "retire");
    if (finding === undefined) throw new Error("fixture produced no retire finding");

    const result = await callApply({ ids: [finding.id] });

    expect(result.applied).toEqual([]);
    const errors = result.errors as Array<{ finding_id: string; message: string }>;
    expect(errors).toHaveLength(1);
    expect(errors[0]!.finding_id).toBe(finding.id);
    expect(errors[0]!.message).toContain("write-refused");
    expect(errors[0]!.message).toContain('"codex"');
    // Nothing was removed: the consult runs before the retirement.
    expect(existsSync(join(vault, "Brain", "sources", "src-a.md"))).toBe(true);
    expect(existsSync(join(vault, "Brain", "sources", "src-b.md"))).toBe(true);
  });

  test("a rule naming another agent leaves the apply retiring for the same identity", async () => {
    writeFileSync(
      join(vault, "Brain", "_permissions.yaml"),
      "version: 1\ndefault_action: allow\nentries:\n  - id: freeze-gemini\n    agent: gemini\n" +
        "    action: ingest\n    verdict: deny\n",
      "utf8",
    );
    const scan = (await toolScan()) as {
      findings: Array<{ id: string; proposed_action: string }>;
    };
    const finding = scan.findings.find((f) => f.proposed_action === "retire");
    if (finding === undefined) throw new Error("fixture produced no retire finding");

    const result = await callApply({ ids: [finding.id] });

    expect(result.errors).toEqual([]);
    expect(result.applied).toHaveLength(1);
    expect(existsSync(join(vault, "Brain", "sources", "src-a.md"))).toBe(false);
  });
});

/** A scan through the same identity, to read the retire finding id off. */
async function toolScan(): Promise<unknown> {
  const tool = HYGIENE_TOOLS.find((t) => t.name === "brain_hygiene")!;
  return tool.handler(identityCtx() as any, {
    mode: "scan",
    detectors: ["document-dedup"],
  });
}

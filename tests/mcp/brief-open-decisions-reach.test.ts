/**
 * The morning brief's open-decisions section answers at the caller's
 * reach (write-side-trust wave, Task 10).
 *
 * A parked question is vault content: the section rides the same
 * operator-queue boundary as the trigger queue, so a reader below local
 * reach is shown neither the questions nor the unreadable records, and
 * a local caller still sees both. A server with no reach minted is a
 * remote caller.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MCPServer } from "../../src/mcp/server.ts";
import { openDecision } from "../../src/core/brain/decisions/open-store.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";

const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
});

interface Vault {
  vault: string;
  configPath: string;
}

function makeVault(): Vault {
  const base = mkdtempSync(join(tmpdir(), "o2b-brief-open-reach-"));
  bases.push(base);
  const vault = join(base, "vault");
  const configPath = join(base, "config.yaml");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeFileSync(configPath, `vault: ${vault}\nagent_name: tester\n`, "utf8");
  return { vault, configPath };
}

function serverAt(v: Vault, reach?: TransportReach): MCPServer {
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = v.configPath;
  const config = { vault: v.vault, configPath: v.configPath };
  return reach === undefined ? new MCPServer(config) : new MCPServer(config, { reach });
}

async function morningBrief(v: Vault, reach?: TransportReach): Promise<Record<string, unknown>> {
  const result = await serverAt(v, reach).callTool("brain_brief", { view: "morning" });
  return result.structuredContent as Record<string, unknown>;
}

describe("brain_brief view=morning open decisions at the caller's reach", () => {
  test("a remote caller is shown neither the questions nor the unreadable records", async () => {
    const v = makeVault();
    openDecision(v.vault, {
      title: "Parked question",
      question: "Do we keep the legacy importer?",
      options: ["a", "b"],
      agent: "tester",
    });
    writeFileSync(
      join(v.vault, "Brain", "decisions", "open-fragile.md"),
      "---\ntitle: Fragile\nstatus: gone\n---\n\n## Question\n\nDoes the fragile record surface?\n",
      "utf8",
    );
    const remote = await morningBrief(v);
    expect(remote["open_decisions"]).toBeUndefined();
    expect(remote["open_decisions_unreadable"]).toBeUndefined();
    expect(String(remote["text"])).not.toContain("## Open decisions");
    expect(String(remote["text"])).not.toContain("legacy importer");
  });

  test("a local caller sees the parked question; an empty vault names nothing", async () => {
    const withDecision = makeVault();
    openDecision(withDecision.vault, {
      title: "Parked question",
      question: "Do we keep the legacy importer?",
      options: ["a", "b"],
      agent: "tester",
    });
    const local = await morningBrief(withDecision, TRANSPORT_REACH.local);
    const rows = local["open_decisions"] as Array<Record<string, unknown>> | undefined;
    expect(rows).toHaveLength(1);
    expect(rows![0]!["question"]).toBe("Do we keep the legacy importer?");
    expect(String(local["text"])).toContain("## Open decisions");

    const empty = makeVault();
    const localEmpty = await morningBrief(empty, TRANSPORT_REACH.local);
    expect(localEmpty["open_decisions"]).toBeUndefined();
    expect(String(localEmpty["text"])).not.toContain("## Open decisions");
  });
});

/**
 * `brain_hygiene` scan, `capture-scope` detector, at the caller's reach.
 *
 * The detector re-derives each cited source's scope from the filesystem.
 * A cited vault page the caller may not read at its reach must count as
 * url-only, so the finding a caller sees for a page citing it is the same
 * finding it would see for a page citing a path that does not exist.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { CAPTURE_SCOPE_DETECTOR_ID } from "../../src/core/brain/hygiene/detectors/capture-scope.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { HEALTH_TOOLS } from "../../src/mcp/brain/health-tools.ts";
import { HYGIENE_TOOLS } from "../../src/mcp/brain/hygiene-tools.ts";
import { RESEARCH_TOOLS } from "../../src/mcp/brain/research-tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";
import { CHMOD_CANNOT_DENY } from "../helpers/platform.ts";

const WITHHELD_SOURCE = "Notes/withheld.md";
const ABSENT_SOURCE = "Notes/absent.md";

let vault: string;
let configHome: string;
let ctx: ServerContext;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-hygiene-reach-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-hygiene-reach-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  ctx = { vault, configPath, repoRoot: null };
  mkdirSync(join(vault, "Notes"), { recursive: true });
  writeFileSync(join(vault, WITHHELD_SOURCE), "---\nvisibility: private\n---\nbody\n");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

const research = RESEARCH_TOOLS[0]!.handler;
const hygiene = HYGIENE_TOOLS.find((tool) => tool.name === "brain_hygiene")!.handler;
const status = HEALTH_TOOLS.find((tool) => tool.name === "brain_status")!.handler;

/** The status snapshot's hygiene problem line at this reach, if any. */
async function hygieneLineAt(reach: TransportReach): Promise<string | undefined> {
  const res = (await status({ ...ctx, reach }, {})) as {
    problems: ReadonlyArray<{ code: string; detail: string }>;
  };
  return res.problems.find((problem) => problem.code === "hygiene-findings")?.detail;
}

/** Write a report citing only `source`, and return its path. */
async function reportCiting(title: string, source: string): Promise<string> {
  const res = (await research(ctx, {
    title,
    sources: [source],
    findings: [{ statement: "A point", sources: [source] }],
  })) as Record<string, unknown>;
  return res["report_path"] as string;
}

/** The report paths the capture-scope detector names at this reach. */
async function flaggedAt(reach: TransportReach): Promise<ReadonlyArray<string>> {
  const res = (await hygiene(
    { ...ctx, reach },
    { mode: "scan", detectors: [CAPTURE_SCOPE_DETECTOR_ID] },
  )) as { findings: ReadonlyArray<{ targets: ReadonlyArray<string> }> };
  return res.findings.flatMap((finding) => finding.targets).toSorted();
}

describe("brain_hygiene capture-scope at the caller's reach", () => {
  test("a cited page withheld at the caller's reach counts as url-only, like an absent one", async () => {
    const withheld = await reportCiting("Withheld", WITHHELD_SOURCE);
    const absent = await reportCiting("Absent", ABSENT_SOURCE);

    expect(await flaggedAt(TRANSPORT_REACH.remote)).toEqual([absent, withheld].toSorted());
    expect(await flaggedAt(TRANSPORT_REACH.local)).toEqual([absent]);
  });

  test("the status snapshot counts a withheld citation as an absent one", async () => {
    await reportCiting("Withheld", WITHHELD_SOURCE);
    const withheldRemote = await hygieneLineAt(TRANSPORT_REACH.remote);
    rmSync(join(vault, WITHHELD_SOURCE));
    expect(await hygieneLineAt(TRANSPORT_REACH.remote)).toBe(withheldRemote);
  });

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a cited page whose stat is refused counts as url-only for a caller who may not read it",
    async () => {
      const withheld = await reportCiting("Withheld", WITHHELD_SOURCE);
      chmodSync(join(vault, "Notes"), 0o000);
      try {
        expect(await flaggedAt(TRANSPORT_REACH.remote)).toEqual([withheld]);
        expect(await flaggedAt(TRANSPORT_REACH.local)).toEqual([]);
      } finally {
        chmodSync(join(vault, "Notes"), 0o755);
      }
    },
  );
});

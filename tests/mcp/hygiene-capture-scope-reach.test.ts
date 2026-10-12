/**
 * `brain_hygiene` scan, `capture-scope` detector, at the caller's reach.
 *
 * The detector re-derives each cited source's scope from the filesystem.
 * A cited vault page the caller may not read at its reach must count as
 * url-only, so the finding a caller sees for a page citing it is the same
 * finding it would see for a page citing a path that does not exist.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { brainConfigPath } from "../../src/core/brain/paths.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { CAPTURE_SCOPE_DETECTOR_ID } from "../../src/core/brain/hygiene/detectors/capture-scope.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { HEALTH_TOOLS } from "../../src/mcp/brain/health-tools.ts";
import { INGEST_TOOLS } from "../../src/mcp/brain/ingest-tools.ts";
import { HYGIENE_TOOLS } from "../../src/mcp/brain/hygiene-tools.ts";
import { RESEARCH_TOOLS } from "../../src/mcp/brain/research-tools.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
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

/**
 * The archive arm (answer trust, Task C5): a summary page stamped with an
 * archive digest claims durable evidence, and a stamp whose entry is absent
 * or re-hashes differently is a named finding - one per page, review
 * proposed action. An intact entry is not a finding, and a page with no
 * stamp means exactly "not captured", never a finding either. The
 * verification is a fact about the store, so the finding reaches every
 * caller who may read the page, at either reach.
 */
describe("brain_hygiene capture-scope archive findings", () => {
  const ingest = INGEST_TOOLS[0]!.handler;
  const SOURCE = "Articles/archived.md";
  let summaryPath: string;
  let archiveFile: string;

  /** The capture-scope findings at this reach, with their evidence. */
  const findingsAt = async (reach: TransportReach) => {
    const res = (await hygiene(
      { ...ctx, reach },
      { mode: "scan", detectors: [CAPTURE_SCOPE_DETECTOR_ID] },
    )) as {
      findings: ReadonlyArray<{
        targets: ReadonlyArray<string>;
        proposed_action: string;
        title: string;
        evidence: Record<string, unknown>;
      }>;
    };
    return res.findings.filter((f) => f.targets.includes(summaryPath));
  };

  beforeEach(async () => {
    mkdirSync(join(vault, "Articles"), { recursive: true });
    writeFileSync(join(vault, SOURCE), "archived bytes\n", "utf8");
    const res = (await ingest(ctx, {
      source_path: SOURCE,
      summary: "Durable.",
      entities: [{ category: "concept", name: "Durable" }],
    })) as { summary_path: string; source_archive_hash: string };
    summaryPath = res.summary_path;
    archiveFile = join(vault, "Brain", ".archives", `${res.source_archive_hash}.txt`);
    expect(existsSync(archiveFile)).toBe(true);
  });

  test("an intact entry is not a finding, at either reach", async () => {
    expect(await findingsAt(TRANSPORT_REACH.local)).toEqual([]);
    expect(await findingsAt(TRANSPORT_REACH.remote)).toEqual([]);
  });

  test("a deleted entry is a missing-archive finding naming the page", async () => {
    rmSync(archiveFile);
    const findings = await findingsAt(TRANSPORT_REACH.local);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.proposed_action).toBe("review");
    expect(findings[0]!.evidence["archive"]).toBe("missing");
    // The same fact reaches a remote caller who may read the page.
    expect(await findingsAt(TRANSPORT_REACH.remote)).toEqual(findings);
  });

  test("a tampered entry is a mismatched-archive finding, not a missing one", async () => {
    writeFileSync(archiveFile, "rewritten after the stamp", "utf8");
    const findings = await findingsAt(TRANSPORT_REACH.local);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence["archive"]).toBe("mismatched");
  });

  test("a page with no stamp is never an archive finding", async () => {
    const url = (await ingest(ctx, {
      source_path: "https://example.test/unarchived",
      summary: "Remote.",
      entities: [{ category: "concept", name: "Unarchived" }],
    })) as { summary_path: string; source_archive_hash: string | null };
    expect(url.source_archive_hash).toBeNull();
    const res = (await hygiene(ctx, {
      mode: "scan",
      detectors: [CAPTURE_SCOPE_DETECTOR_ID],
    })) as { findings: ReadonlyArray<{ targets: ReadonlyArray<string> }> };
    expect(res.findings.some((f) => f.targets.includes(url.summary_path))).toBe(false);
  });
});

/**
 * The `archive_get` read on the existing tool (answer trust, Task C6),
 * with `brain_artifact_get`'s bounded-fetch posture and the wave's
 * visibility rule: LOCAL reach only. A remote caller gets the answer an
 * absent entry gives - the named miss, no bytes - whether or not an entry
 * is there, so the response is never an existence oracle and never carries
 * archived source bytes off the host.
 */
describe("brain_hygiene archive_get", () => {
  const ingest = INGEST_TOOLS[0]!.handler;
  const SOURCE = "Articles/fetchable.md";
  let hash: string;
  let entryPath: string;
  let summaryPath: string;

  const archiveGet = (reachCtx: ServerContext, args: Record<string, unknown>) =>
    hygiene(reachCtx, { mode: "archive_get", ...args }) as Promise<Record<string, unknown>>;

  /** The delivery gate the owner-scope view reads: `fail` enforces the scope. */
  const setOwnerGate = (mode: string): void => {
    atomicWriteFileSync(
      brainConfigPath(vault),
      `schema_version: 1\nintegrity:\n  owner_scope_delivery: ${mode}\n`,
    );
  };

  /** Restamp the citing summary page under another owner. */
  const restampUnder = (owner: string): void => {
    const path = join(vault, summaryPath);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(/^---\n/, `---\nowner: ${owner}\n`),
      "utf8",
    );
  };

  beforeEach(async () => {
    mkdirSync(join(vault, "Articles"), { recursive: true });
    writeFileSync(join(vault, SOURCE), "fetchable bytes\n", "utf8");
    const res = (await ingest(ctx, {
      source_path: SOURCE,
      summary: "Fetchable.",
      entities: [{ category: "concept", name: "Fetchable" }],
    })) as { source_archive_hash: string; summary_path: string };
    hash = res.source_archive_hash;
    entryPath = join(vault, "Brain", ".archives", `${hash}.txt`);
    summaryPath = res.summary_path;
  });

  test("at local reach a known hash resolves the archived bytes", async () => {
    const res = await archiveGet({ ...ctx, reach: TRANSPORT_REACH.local }, { hash });
    expect(res).toEqual({
      hash,
      archive: "verified",
      bytes: Buffer.byteLength("fetchable bytes\n", "utf8"),
      content: "fetchable bytes\n",
    });
  });

  test("an unknown hash is a named miss, not an error", async () => {
    const res = await archiveGet(
      { ...ctx, reach: TRANSPORT_REACH.local },
      { hash: "b".repeat(64) },
    );
    expect(res).toEqual({ hash: "b".repeat(64), archive: "missing" });
  });

  test("a mismatched entry says so and returns the bytes it actually holds", async () => {
    writeFileSync(entryPath, "rewritten after the stamp", "utf8");
    const res = await archiveGet({ ...ctx, reach: TRANSPORT_REACH.local }, { hash });
    expect(res["archive"]).toBe("mismatched");
    expect(res["content"]).toBe("rewritten after the stamp");
  });

  test("a malformed hash is the caller's named refusal", async () => {
    await expect(
      archiveGet({ ...ctx, reach: TRANSPORT_REACH.local }, { hash: "../../etc/passwd" }),
    ).rejects.toThrow(MCPError);
  });

  test("a remote caller gets the absent entry's answer, never the bytes", async () => {
    // The entry EXISTS; the response must be identical to its absence.
    const res = await archiveGet(ctx, { hash });
    expect(res).toEqual({ hash, archive: "missing" });
    expect(res).not.toHaveProperty("content");
    expect(res).not.toHaveProperty("bytes");
  });

  test("an owner-scoped caller cannot confirm an entry whose citing page is another owner's", async () => {
    // The scan withholds another owner's citing page through the gated
    // view; answering this entry's state or bytes would stand beside that
    // as a confirm-a-guess oracle. Under an enforced scope the entry whose
    // every citing page is withheld reads exactly as absent.
    setOwnerGate("fail");
    restampUnder("other-agent");
    const res = await archiveGet(
      { ...ctx, reach: TRANSPORT_REACH.local, agentName: "me-agent" },
      { hash },
    );
    expect(res).toEqual({ hash, archive: "missing" });
  });

  test("the entry's own owner still reads the bytes at local reach", async () => {
    setOwnerGate("fail");
    restampUnder("other-agent");
    const res = await archiveGet(
      { ...ctx, reach: TRANSPORT_REACH.local, agentName: "other-agent" },
      { hash },
    );
    expect(res["archive"]).toBe("verified");
    expect(res["content"]).toBe("fetchable bytes\n");
  });

  test("an enforced scope still answers a shared citing page with the bytes", async () => {
    // The gate narrows only what the page itself withholds: an ownerless
    // summary page is shared, so the same scoped caller keeps the fetch.
    setOwnerGate("fail");
    const res = await archiveGet(
      { ...ctx, reach: TRANSPORT_REACH.local, agentName: "me-agent" },
      { hash },
    );
    expect(res["archive"]).toBe("verified");
    expect(res["content"]).toBe("fetchable bytes\n");
  });
});

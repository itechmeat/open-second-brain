/**
 * The pledge MCP surface (dated-commitments wave, task A3).
 *
 * `brain_pledge` mirrors `brain_obligation`'s operation shape over the
 * one-off pledge family; `brain_intake_pledges` is the agent-executed
 * extraction intake over `intakePledges`. The acceptance cases below are
 * the ones the wave plan pins for A3: registration on the tool table,
 * closed schemas, handler round-trips over a minimal `ServerContext`,
 * the overdue filter and the readable predicate on `list`, and typed
 * errors preserved - every `PledgeError`/`PledgeIntakeError` surfaces as
 * `INVALID_PARAMS` under the tool prefix, exactly once.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addPledge, noPledgeError, showPledge } from "../../src/core/brain/pledges.ts";
import { upsertEntity } from "../../src/core/brain/entities/registry.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import { buildToolTable, findTool } from "../../src/mcp/tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";
import { INVALID_PARAMS, MCPError } from "../../src/mcp/protocol.ts";
import { PLEDGE_TOOLS } from "../../src/mcp/brain/pledge-tools.ts";

const SOURCE_REL = "notes/team-meeting.md";
// Frontmatter included: the reach case reserves this page by inserting a
// visibility line before its closing fence, the reach-fixture pattern.
const SOURCE_TEXT = [
  "---",
  "title: Team meeting",
  "---",
  "",
  "We synced on the rollout plan.",
  "",
  "- Ada asked for a written recap of the migration steps.",
  "- The storage budget review moves to next quarter.",
].join("\n");
const QUOTE = "Ada asked for a written recap of the migration steps";
const QUOTE_TWO = "The storage budget review moves to next quarter";

/** UTC calendar days relative to today, so the overdue boundary is real. */
function day(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

const AGENT = "claude";
const RESERVE_LINE = `visibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]`;

let vault: string;
let ctx: ServerContext;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-pledge-tools-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, SOURCE_REL), SOURCE_TEXT, "utf8");
  // The operator's own shell; the reach cases build their own contexts.
  ctx = { vault, configPath: null, repoRoot: null, reach: TRANSPORT_REACH.local };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function tool(name: string) {
  return findTool(buildToolTable("full"), name);
}

/** The MCPError an awaited handler call throws, with its code attached. */
async function mcpFailure(run: () => unknown): Promise<{ code: number; message: string }> {
  try {
    await run();
  } catch (err) {
    if (err instanceof MCPError) return { code: err.code, message: err.message };
    throw err;
  }
  throw new Error("expected the handler to refuse");
}

/** Insert the reserve line before the closing frontmatter fence of `path`. */
function reserve(path: string): void {
  const text = readFileSync(path, "utf8");
  const close = text.indexOf("\n---\n", "---\n".length);
  writeFileSync(path, `${text.slice(0, close)}\n${RESERVE_LINE}${text.slice(close)}`);
}

test("both pledge tools are registered on the tool table", () => {
  expect(PLEDGE_TOOLS.map((t) => t.name)).toEqual(["brain_pledge", "brain_intake_pledges"]);
  expect(tool("brain_pledge")).toBeDefined();
  expect(tool("brain_intake_pledges")).toBeDefined();
});

test("both schemas are closed to unknown properties", () => {
  for (const def of PLEDGE_TOOLS) {
    expect(def.inputSchema["additionalProperties"]).toBe(false);
    expect(def.previewBudget).toBeDefined();
  }
  const intake = PLEDGE_TOOLS.find((t) => t.name === "brain_intake_pledges")!;
  const pledges = (intake.inputSchema as Record<string, unknown>)["properties"] as Record<
    string,
    { type?: string; items?: Record<string, unknown> }
  >;
  expect(pledges["pledges"]?.["type"]).toBe("array");
  expect(pledges["pledges"]?.["items"]?.["additionalProperties"]).toBe(false);
});

test("brain_pledge add / fulfill / list / show / remove round-trip", async () => {
  const pledge = tool("brain_pledge");
  const slug = "recap-the-migration";
  const added = (await pledge.handler(ctx, {
    operation: "add",
    title: "Recap the migration",
    due: day(6),
    source: SOURCE_REL,
    evidence: [QUOTE],
    agent: AGENT,
    notes: "Ada is waiting on it.",
  })) as { pledge: { slug: string; due: string; fulfilled: null } };
  expect(added.pledge.slug).toBe(slug);
  expect(added.pledge.fulfilled).toBe(null);

  const listed = (await pledge.handler(ctx, { operation: "list" })) as {
    pledges: Array<{ slug: string; overdue: boolean; days_until_due: number }>;
  };
  expect(listed.pledges.map((p) => p.slug)).toEqual([slug]);
  expect(listed.pledges[0]?.overdue).toBe(false);

  const shown = (await pledge.handler(ctx, { operation: "show", slug })) as {
    present: boolean;
    pledge: { title: string; notes: string };
  };
  expect(shown.present).toBe(true);
  expect(shown.pledge.title).toBe("Recap the migration");
  expect(shown.pledge.notes).toBe("Ada is waiting on it.");

  const fulfilled = (await pledge.handler(ctx, {
    operation: "fulfill",
    slug,
    date: day(0),
  })) as { pledge: { fulfilled: string } };
  expect(fulfilled.pledge.fulfilled).toBe(day(0));

  // Open pledges only by default: the fulfilled one leaves the list.
  const after = (await pledge.handler(ctx, { operation: "list" })) as {
    pledges: Array<{ slug: string }>;
  };
  expect(after.pledges).toEqual([]);

  const removed = (await pledge.handler(ctx, { operation: "remove", slug })) as {
    slug: string;
    archive_path: string;
  };
  expect(removed.slug).toBe(slug);
  expect(removed.archive_path).toContain("archive");
  expect(
    (await pledge.handler(ctx, { operation: "show", slug })) as {
      operation: string;
      slug: string;
      present: boolean;
    },
  ).toEqual({
    operation: "show",
    slug,
    present: false,
  });
});

test("brain_pledge refuses an unanchored evidence quote as INVALID_PARAMS", async () => {
  const pledge = tool("brain_pledge");
  const failure = await mcpFailure(() =>
    pledge.handler(ctx, {
      operation: "add",
      title: "Unsupported pledge",
      due: day(6),
      source: SOURCE_REL,
      evidence: ["a sentence the source never carried"],
      agent: AGENT,
    }),
  );
  expect(failure.code).toBe(INVALID_PARAMS);
  expect(failure.message.startsWith("brain_pledge: ")).toBe(true);
  expect(failure.message).toContain("does not occur in the source page");
});

test("brain_pledge list honors the overdue filter", async () => {
  const pledge = tool("brain_pledge");
  await pledge.handler(ctx, {
    operation: "add",
    title: "Overdue promise",
    due: day(-1),
    source: SOURCE_REL,
    evidence: [QUOTE],
    agent: AGENT,
  });
  await pledge.handler(ctx, {
    operation: "add",
    title: "Future promise",
    due: day(1),
    source: SOURCE_REL,
    evidence: [QUOTE],
    agent: AGENT,
  });
  const undated = addPledge(vault, {
    title: "Undated promise",
    due: day(2),
    source: SOURCE_REL,
    evidence: [QUOTE],
    agent: AGENT,
  });
  writeFileSync(
    undated.path,
    readFileSync(undated.path, "utf8").replace(`due: ${undated.due}`, "due: invalid"),
  );
  // Due-sorted: the overdue pledge lists first, one whole day in arrears.
  const all = (await pledge.handler(ctx, { operation: "list" })) as {
    pledges: Array<{ slug: string; days_until_due: number | null }>;
  };
  expect(all.pledges.map((p) => p.slug)).toEqual([
    "overdue-promise",
    "future-promise",
    "undated-promise",
  ]);
  expect(all.pledges.map((p) => p.days_until_due)).toEqual([-1, 1, null]);
  const overdue = (await pledge.handler(ctx, {
    operation: "list",
    overdue: true,
  })) as { pledges: Array<{ slug: string; overdue: boolean }> };
  expect(overdue.pledges.map((p) => p.slug)).toEqual(["overdue-promise"]);
  expect(overdue.pledges[0]?.overdue).toBe(true);
});

test("brain_pledge honors the readable predicate at remote reach", async () => {
  const remote: ServerContext = { vault, configPath: null, repoRoot: null };
  const pledge = tool("brain_pledge");
  await pledge.handler(ctx, {
    operation: "add",
    title: "Zzreserved promise",
    due: day(2),
    source: SOURCE_REL,
    evidence: [QUOTE],
    agent: AGENT,
  });
  reserve(join(vault, "Brain", "pledges", "zzreserved-promise.md"));
  await pledge.handler(ctx, {
    operation: "add",
    title: "Public promise",
    due: day(3),
    source: SOURCE_REL,
    evidence: [QUOTE],
    agent: AGENT,
  });

  const listed = (await pledge.handler(remote, { operation: "list" })) as {
    pledges: Array<{ slug: string }>;
  };
  expect(listed.pledges.map((p) => p.slug)).toEqual(["public-promise"]);

  const shown = (await pledge.handler(remote, {
    operation: "show",
    slug: "zzreserved-promise",
  })) as { operation: string; slug: string; present: boolean };
  expect(shown).toEqual({ operation: "show", slug: "zzreserved-promise", present: false });

  // The withheld slug is refused with the same `no pledge` error an
  // absent slug gets - the exact refusal `noPledgeError` produces for a
  // slug naming no page - so the wording carries no withheld hint. The
  // two-vault identity check (same slug, absent elsewhere) is the reach
  // suite's acceptance; here the wording is pinned to its source.
  const withheldFulfill = await mcpFailure(() =>
    pledge.handler(remote, { operation: "fulfill", slug: "zzreserved-promise" }),
  );
  expect(withheldFulfill.code).toBe(INVALID_PARAMS);
  expect(withheldFulfill.message).toBe(
    `brain_pledge: ${noPledgeError("zzreserved-promise").message}`,
  );
  const withheldRemove = await mcpFailure(() =>
    pledge.handler(remote, { operation: "remove", slug: "zzreserved-promise" }),
  );
  expect(withheldRemove.message).toBe(withheldFulfill.message);

  // Below local reach the remove answer names no archive path at all.
  const removed = (await pledge.handler(remote, {
    operation: "remove",
    slug: "public-promise",
  })) as Record<string, unknown>;
  expect(removed["slug"]).toBe("public-promise");
  expect(removed["archive_path"]).toBeUndefined();
});

test("brain_intake_pledges creates pledges and anchors counterparties server-side", async () => {
  const ada = upsertEntity(vault, {
    category: "people",
    name: "Ada Lovelace",
    aliases: ["Ada"],
    agent: AGENT,
    now: new Date(),
  }).entity.id;
  const intake = tool("brain_intake_pledges");
  const result = (await intake.handler(ctx, {
    source: SOURCE_REL,
    agent: "proxy-agent",
    pledges: [
      {
        title: "Send Ada the migration recap",
        due: day(4),
        evidence: [QUOTE],
        counterparties: ["Ada", "Zed Nowhere"],
      },
    ],
  })) as {
    created: string[];
    duplicates: string[];
    reanchored: string[];
    unanchored_counterparties: string[];
  };
  expect(result.created).toEqual(["send-ada-the-migration-recap"]);
  expect(result.duplicates).toEqual([]);
  expect(result.reanchored).toEqual([]);
  expect(result.unanchored_counterparties).toEqual(["Zed Nowhere"]);
  // The anchored name is the entity id on the page; the unanchored one is
  // stored nowhere.
  const page = showPledge(vault, { slug: "send-ada-the-migration-recap" })!;
  expect([...page.counterparties]).toEqual([ada]);
  expect(page.agent).toBe("proxy-agent");
});

test("brain_intake_pledges reports a duplicate no-op", async () => {
  const intake = tool("brain_intake_pledges");
  const args = {
    source: SOURCE_REL,
    pledges: [{ title: "Send Ada the recap", due: day(4), evidence: [QUOTE] }],
  };
  const first = (await intake.handler(ctx, args)) as { created: string[] };
  expect(first.created).toEqual(["send-ada-the-recap"]);
  const again = (await intake.handler(ctx, args)) as { created: string[]; duplicates: string[] };
  expect(again.created).toEqual([]);
  expect(again.duplicates).toEqual(["send-ada-the-recap"]);
});

test("brain_intake_pledges preserves typed errors as INVALID_PARAMS, wrapped once", async () => {
  const intake = tool("brain_intake_pledges");
  // A PledgeIntakeError: same identity (title, due, source), a different
  // payload - the replacement quote is real, so the refusal is the
  // identity-mismatch arm, not quote containment.
  await intake.handler(ctx, {
    source: SOURCE_REL,
    pledges: [{ title: "Send Ada the recap", due: day(4), evidence: [QUOTE] }],
  });
  const mismatch = await mcpFailure(async () =>
    intake.handler(ctx, {
      source: SOURCE_REL,
      pledges: [{ title: "Send Ada the recap", due: day(4), evidence: [QUOTE_TWO] }],
    }),
  );
  expect(mismatch.code).toBe(INVALID_PARAMS);
  expect(mismatch.message.startsWith("brain_intake_pledges: ")).toBe(true);
  expect(mismatch.message.startsWith("brain_intake_pledges: brain_intake_pledges: ")).toBe(false);

  // A PledgeError from a core refusal keeps its message under one prefix.
  const badDue = await mcpFailure(() =>
    intake.handler(ctx, {
      source: SOURCE_REL,
      pledges: [{ title: "Undated pledge", due: "not-a-date", evidence: [QUOTE] }],
    }),
  );
  expect(badDue.code).toBe(INVALID_PARAMS);
  expect(badDue.message.startsWith("brain_intake_pledges: ")).toBe(true);
  expect(badDue.message).toContain("not a valid calendar date");

  // An already-typed MCPError from the argument parser is not wrapped twice.
  const malformed = await mcpFailure(() =>
    intake.handler(ctx, { source: SOURCE_REL, pledges: "nope" }),
  );
  expect(malformed.code).toBe(INVALID_PARAMS);
  expect(malformed.message.startsWith("brain_intake_pledges: ")).toBe(true);
  expect(malformed.message.startsWith("brain_intake_pledges: brain_intake_pledges: ")).toBe(false);
});

test("brain_intake_pledges refuses a malformed item before any write", async () => {
  const intake = tool("brain_intake_pledges");
  const item = await mcpFailure(() =>
    intake.handler(ctx, {
      source: SOURCE_REL,
      pledges: [{ due: day(4), evidence: [QUOTE] }],
    }),
  );
  expect(item.code).toBe(INVALID_PARAMS);
  expect(item.message).toContain("pledges[0]");
  // The sentinel write succeeds, proving the refusal above wrote nothing:
  // the slug is free for it.
  const sentinel = addPledge(vault, {
    title: "Sentinel pledge",
    due: day(4),
    source: SOURCE_REL,
    evidence: [QUOTE],
    agent: AGENT,
  });
  expect(sentinel.slug).toBe("sentinel-pledge");
});

test("brain_intake_pledges refuses the whole intake when the source page is withheld", async () => {
  const remote: ServerContext = { vault, configPath: null, repoRoot: null };
  const intake = tool("brain_intake_pledges");
  reserve(join(vault, SOURCE_REL));
  const failure = await mcpFailure(async () =>
    intake.handler(remote, {
      source: SOURCE_REL,
      pledges: [{ title: "Secret-source pledge", due: day(4), evidence: [QUOTE] }],
    }),
  );
  expect(failure.code).toBe(INVALID_PARAMS);
  expect(failure.message.startsWith("brain_intake_pledges: ")).toBe(true);
});

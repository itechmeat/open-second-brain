/**
 * Tier-keyed quote fencing on the search family (delivery-trust, lane A).
 *
 * At remote reach the stored record text `brain_search` delivers in each
 * row's `content`, each card's `snippet` and `brain_search_expand`'s
 * note and chunk bodies arrives inside the `<untrusted_source>` fence
 * when the page's provenance is agent-origin or underivable, and stays
 * byte-identical when the page proves operator-authorship
 * (`origin_channel: cli`). At local reach the shaper does not run at
 * all: every byte is the pre-wave shape. A row the reach view withholds
 * is dropped exactly as before - no fence, no count - and no output
 * schema changes, because the fence lives inside the existing fields.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SEARCH_TOOLS } from "../../src/mcp/search-tools.ts";
import { NOTES_TOOLS } from "../../src/mcp/brain/notes-tools.ts";
import {
  ORIGIN_CHANNEL,
  clearOriginChannel,
  setOriginChannel,
} from "../../src/core/origin-channel.ts";
import { addRecallSource } from "../../src/core/brain/portability/recall-sources.ts";
import { indexVault, resolveSearchConfig } from "../../src/core/search/index.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { UNTRUSTED_SOURCE_TAG } from "../../src/core/brain/untrusted-source.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

const AGENT_LABEL = "stored text: agent-authored (origin_channel=mcp-tool)";
const LEGACY_LABEL = "stored text: unverified provenance (no derivable stamps)";

/** Distinct marker words so each fixture matches its own query. */
const AGENT_WORD = "zzagentoriginzz";
const LEGACY_WORD = "zzlegacynostampzz";
const OPERATOR_WORD = "zzoperatorclizz";
const PRIVATE_WORD = "zzprivatereservedzz";

interface SearchOut {
  results: Array<Record<string, unknown> & { path: string; content: string }>;
  cards?: Array<Record<string, unknown> & { path: string; snippet: string; chunk_id: number }>;
  total: number;
}

interface ExpandOut {
  note: { path: string; content: string };
  raw_content: Array<{ content: string }>;
}

interface FileContextOut {
  results: Array<Record<string, unknown>>;
}

let vault: string;
let configHome: string;

const searchTool = () => SEARCH_TOOLS.find((t) => t.name === "brain_search")!;
const expandTool = () => SEARCH_TOOLS.find((t) => t.name === "brain_search_expand")!;
const fileContextTool = () => SEARCH_TOOLS.find((t) => t.name === "brain_file_context")!;
const updateTool = () => NOTES_TOOLS.find((t) => t.name === "brain_update_note")!;

function ctxFor(reach: TransportReach): ServerContext {
  return {
    vault,
    configPath: join(configHome, "config.yaml"),
    repoRoot: null,
    reach,
  };
}

async function search(
  query: string,
  reach: TransportReach,
  extra: Record<string, unknown> = {},
): Promise<SearchOut> {
  return (await searchTool().handler(ctxFor(reach), { query, ...extra })) as SearchOut;
}

function rowFor(out: SearchOut, path: string): SearchOut["results"][number] {
  const row = out.results.find((r) => r.path === path);
  expect(row).toBeDefined();
  return row!;
}

function fenceFor(label: string, body: string): string {
  return `<${UNTRUSTED_SOURCE_TAG} origin="${label}">\n${body}\n</${UNTRUSTED_SOURCE_TAG}>`;
}

beforeEach(async () => {
  vault = mkdtempSync(join(tmpdir(), "o2b-quote-search-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-quote-search-cfg-"));
  atomicWriteFileSync(
    join(configHome, "config.yaml"),
    `vault: ${vault}\nsearch_chunk_size: 4000\n`,
  );
  const write = (rel: string, frontmatter: string, marker: string): void => {
    const abs = join(vault, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    // "agent" and "agent.md" in the body keep the file-recall lane
    // (whose ANDed terms are derived from the file's own basename)
    // non-empty for the fixture.
    writeFileSync(
      abs,
      `---\n${frontmatter}---\n\nclean agent prose about agent.md and ${marker} entirely.\n`,
    );
  };
  write("notes/agent.md", "origin_channel: mcp-tool\ntitle: Agent\n", AGENT_WORD);
  write("notes/legacy.md", "title: Legacy\n", LEGACY_WORD);
  write("notes/operator.md", "origin_channel: cli\ntitle: Operator\n", OPERATOR_WORD);
  write(
    "notes/private.md",
    `title: Private\nvisibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]\n`,
    PRIVATE_WORD,
  );
  await indexVault(resolveSearchConfig({ vault, configPath: join(configHome, "config.yaml") }), {});
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("cross-vault union rows", () => {
  test("a foreign row ships fenced even when the local vault carries a same-named page", async () => {
    // A second vault registered as a recall source holds a page at the
    // SAME relative path as the local operator-authored note, and its
    // own stamps are cli too. The union row's path is a FOREIGN vault's
    // path, so probing it against the local vault would let the local
    // page's operator stamp vouch for text the foreign vault carried -
    // the foreign row probes the guaranteed-absent page instead and
    // ships fenced, while its `origin` field keeps naming its vault.
    const foreign = mkdtempSync(join(tmpdir(), "o2b-quote-search-foreign-"));
    try {
      mkdirSync(join(foreign, "notes"), { recursive: true });
      writeFileSync(
        join(foreign, "notes", "operator.md"),
        `---\norigin_channel: cli\ntitle: Operator\n---\n\nclean agent prose about agent.md and ${OPERATOR_WORD} in the foreign vault.\n`,
      );
      await indexVault(
        resolveSearchConfig({ vault: foreign, configPath: join(configHome, "config.yaml") }),
        {},
      );
      addRecallSource(join(configHome, "config.yaml"), vault, "peer", foreign);

      const remote = await search(OPERATOR_WORD, TRANSPORT_REACH.remote, { global: true });
      const foreignRow = remote.results.find((r) => r["origin"] === "source/peer");
      expect(foreignRow).toBeDefined();
      expect(foreignRow!["content"]).toContain(OPERATOR_WORD);
      expect(foreignRow!["content"]).toContain(LEGACY_LABEL);
      expect(foreignRow!["content"]).not.toContain(AGENT_LABEL);
      // The local page at the same relative path keeps its own
      // treatment: operator-authored, shipped plain.
      const localRow = rowFor(remote, "notes/operator.md");
      expect(localRow.content).toContain(OPERATOR_WORD);
      expect(localRow.content).not.toContain(`<${UNTRUSTED_SOURCE_TAG}`);
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  });
});

describe("brain_search rows at remote reach", () => {
  test("an agent-origin row is delivered inside the fence naming the derived provenance", async () => {
    const local = await search(AGENT_WORD, TRANSPORT_REACH.local);
    const remote = await search(AGENT_WORD, TRANSPORT_REACH.remote);
    const localRow = rowFor(local, "notes/agent.md");
    const remoteRow = rowFor(remote, "notes/agent.md");
    // Clean prose neutralizes to itself, so the delivered fence is the
    // local bytes wrapped: the fence lives in the same field.
    expect(remoteRow.content).toBe(fenceFor(AGENT_LABEL, localRow.content));
    expect(localRow.content).toContain(AGENT_WORD);
    expect(localRow.content).not.toContain(`<${UNTRUSTED_SOURCE_TAG}`);
  });

  test("a legacy row with no stamps is fenced (fail closed)", async () => {
    const local = await search(LEGACY_WORD, TRANSPORT_REACH.local);
    const remote = await search(LEGACY_WORD, TRANSPORT_REACH.remote);
    expect(rowFor(remote, "notes/legacy.md").content).toBe(
      fenceFor(LEGACY_LABEL, rowFor(local, "notes/legacy.md").content),
    );
  });

  test("a channel-cli row is the one plain answer at remote reach too", async () => {
    const local = await search(OPERATOR_WORD, TRANSPORT_REACH.local);
    const remote = await search(OPERATOR_WORD, TRANSPORT_REACH.remote);
    expect(rowFor(remote, "notes/operator.md").content).toBe(
      rowFor(local, "notes/operator.md").content,
    );
  });

  test("a withheld row is dropped exactly as before: no fence, no count", async () => {
    const local = await search(PRIVATE_WORD, TRANSPORT_REACH.local);
    const remote = await search(PRIVATE_WORD, TRANSPORT_REACH.remote);
    for (const out of [local, remote]) {
      expect(out.results.some((r) => r.path === "notes/private.md")).toBe(false);
    }
    expect(remote.total).toBe(local.total);
    expect(remote.total).toBe(0);
  });

  test("no output schema change: the delivered row keeps the pre-wave field set", async () => {
    const remote = await search(AGENT_WORD, TRANSPORT_REACH.remote);
    const row = rowFor(remote, "notes/agent.md");
    expect(Object.keys(row).toSorted()).toEqual(
      [
        "content",
        "endLine",
        "path",
        "reasons",
        "score",
        "searchType",
        "startLine",
        "title",
      ].toSorted(),
    );
  });

  test("cards mode fences the snippet inside the existing field at remote reach", async () => {
    const local = await search(AGENT_WORD, TRANSPORT_REACH.local, { disclosure: "cards" });
    const remote = await search(AGENT_WORD, TRANSPORT_REACH.remote, { disclosure: "cards" });
    const localCard = local.cards?.find((c) => c.path === "notes/agent.md");
    const remoteCard = remote.cards?.find((c) => c.path === "notes/agent.md");
    expect(localCard).toBeDefined();
    expect(remoteCard).toBeDefined();
    expect(remoteCard!.snippet).toBe(fenceFor(AGENT_LABEL, localCard!.snippet));
    expect(remoteCard!.chunk_id).toBe(localCard!.chunk_id);
  });

  test("an mcp update of an operator page does not deliver its new agent body as plain", async () => {
    // `notes/operator.md` is stamped `origin_channel: cli` and ships
    // plain. An MCP-lane mutation rewrites the body; the page's new words
    // are agent-authored, so the stale operator stamp must not survive
    // the commit path to vouch for them at remote reach - the row has to
    // arrive inside the fence naming the channel that wrote it.
    const mutated = "zzrewrittenbyagentzz";
    setOriginChannel(ORIGIN_CHANNEL.mcpTool);
    try {
      await updateTool().handler(ctxFor(TRANSPORT_REACH.local), {
        path: "notes/operator.md",
        content: `agent-authored rewrite carrying ${mutated} entirely.`,
      });
    } finally {
      clearOriginChannel();
    }
    await indexVault(
      resolveSearchConfig({ vault, configPath: join(configHome, "config.yaml") }),
      {},
    );
    const local = await search(mutated, TRANSPORT_REACH.local);
    const remote = await search(mutated, TRANSPORT_REACH.remote);
    const localRow = rowFor(local, "notes/operator.md");
    expect(localRow.content).toContain(mutated);
    expect(localRow.content).not.toContain(`<${UNTRUSTED_SOURCE_TAG}`);
    expect(rowFor(remote, "notes/operator.md").content).toBe(
      fenceFor(AGENT_LABEL, localRow.content),
    );
  });
});

describe("brain_search_expand at remote reach", () => {
  test("note and chunk bodies are fenced at remote, byte-identical at local", async () => {
    const cards = await search(AGENT_WORD, TRANSPORT_REACH.local, { disclosure: "cards" });
    const card = cards.cards?.find((c) => c.path === "notes/agent.md");
    expect(card).toBeDefined();
    const chunkId = card!.chunk_id;
    const local = (await expandTool().handler(ctxFor(TRANSPORT_REACH.local), {
      chunk_id: chunkId,
    })) as ExpandOut;
    const remote = (await expandTool().handler(ctxFor(TRANSPORT_REACH.remote), {
      chunk_id: chunkId,
    })) as ExpandOut;
    expect(remote.note.path).toBe("notes/agent.md");
    expect(remote.note.content).toBe(fenceFor(AGENT_LABEL, local.note.content));
    expect(remote.raw_content).toHaveLength(local.raw_content.length);
    for (const [index, chunk] of remote.raw_content.entries()) {
      expect(chunk.content).toBe(fenceFor(AGENT_LABEL, local.raw_content[index]!.content));
    }
    // Local reach stays the pre-wave bytes, fence tags nowhere.
    expect(local.note.content).not.toContain(`<${UNTRUSTED_SOURCE_TAG}`);
  });
});

describe("brain_file_context", () => {
  test("delivers no stored text at any reach, so there is nothing to fence", async () => {
    const remote = (await fileContextTool().handler(ctxFor(TRANSPORT_REACH.remote), {
      file_path: "notes/agent.md",
      min_bytes: 0,
    })) as FileContextOut;
    expect(remote.results.length).toBeGreaterThan(0);
    for (const row of remote.results) {
      expect(Object.keys(row).toSorted()).toEqual(["path", "score", "title"].toSorted());
    }
  });
});

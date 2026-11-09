/**
 * The memory readers of dream, briefs, digests and MCP on a switched
 * machine (task 2.10): each answers from the store's folds what it
 * answers from the legacy pages on an unswitched twin built by the same
 * writers (`../fixtures/memory-twins.ts`).
 *
 * The guard at the end runs every reader on the switched twin alone and
 * fails on an empty answer: a reader missed in the swap would read the
 * absent `Brain/` pages and report nothing, which a parity check of two
 * empty answers could not tell from a real empty state.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createInjectionMeter,
  assembleActiveContext,
} from "../../../../hooks/lib/active-context.ts";
import { activeDigestPathForRead, renderActive } from "../../../../src/core/brain/active.ts";
import { collectExplorerData } from "../../../../src/core/brain/explorer.ts";
import { scanApplyEvidence } from "../../../../src/core/brain/dream-refresh.ts";
import { renderDigest } from "../../../../src/core/brain/digest.ts";
import { computeAgentSummary } from "../../../../src/core/brain/digest-agent-summary.ts";
import { collectEvidenceForSlug } from "../../../../src/core/brain/evidence.ts";
import { collectPreferenceRows } from "../../../../src/core/brain/export.ts";
import { buildIntentReview } from "../../../../src/core/brain/intent-review.ts";
import { lessonsDigestPathForRead, regenerateLessons } from "../../../../src/core/brain/lessons.ts";
import { findMergeCandidates } from "../../../../src/core/brain/merge-candidates.ts";
import { buildMorningBrief } from "../../../../src/core/brain/morning-brief.ts";
import { computeMostApplied } from "../../../../src/core/brain/most-applied.ts";
import { packContext } from "../../../../src/core/brain/context-pack.ts";
import { buildPreCompressPack } from "../../../../src/core/brain/pre-compress-pack.ts";
import { loadPreference } from "../../../../src/core/brain/preference.ts";
import {
  queryByLogSince,
  queryByPreference,
  queryByTopic,
  readAllLogEntries,
} from "../../../../src/core/brain/query.ts";
import { vaultAgentSourceProvider as vaultProvider } from "../../../../src/core/brain/agent-source/vault-provider.ts";
import { parseFrontmatterText } from "../../../../src/core/vault.ts";
import { readResource } from "../../../../src/mcp/resources.ts";
import { MCPServer } from "../../../../src/mcp/server.ts";
import { treeEntries } from "../../../helpers/vault-digest.ts";
import type { StoreEnv } from "../../store/fixtures/store-env.ts";
import {
  FIXTURE,
  FIXTURE_ACTIVE_PREFERENCES,
  FIXTURE_NOW,
  makeMemoryTwins,
  type MemoryTwins,
  normalized,
  onBoth,
  useEnv,
} from "../fixtures/memory-twins.ts";

let twins: MemoryTwins;
beforeAll(() => {
  twins = makeMemoryTwins("osb-wp2a-readers-");
});
afterAll(() => twins.cleanup());

const body = (doc: string): string => parseFrontmatterText(doc)[1];

/** One reader: its answer on a twin, and whether that answer holds the fixture's data. */
interface Reader {
  readonly name: string;
  read(env: StoreEnv): unknown;
  holdsData(answer: unknown): boolean;
}

const nonEmptyText = (a: unknown): boolean => typeof a === "string" && a.trim().length > 0;
const nonEmptyList = (a: unknown): boolean => Array.isArray(a) && a.length > 0;
const mentions =
  (...needles: string[]) =>
  (a: unknown): boolean => {
    const text = JSON.stringify(a);
    return needles.every((n) => text.includes(n));
  };

const READERS: ReadonlyArray<Reader> = [
  {
    name: "active digest render",
    read: (env) => renderActive(env.vault, { now: FIXTURE_NOW }).body,
    holdsData: mentions(FIXTURE.confirmed, FIXTURE.quarantine),
  },
  {
    name: "lessons digest render",
    read: (env) => body(regenerateLessonsBody(env)),
    holdsData: mentions("tabs"),
  },
  {
    name: "most applied",
    read: (env) => {
      const pref = loadPreference(env.vault, "tabs");
      return computeMostApplied(env.vault, pref === null ? [] : [pref], { now: FIXTURE_NOW });
    },
    holdsData: nonEmptyList,
  },
  {
    name: "dream refresh evidence",
    read: (env) => scanApplyEvidence(env.vault),
    holdsData: nonEmptyList,
  },
  {
    name: "evidence for a slug",
    read: (env) => collectEvidenceForSlug(env.vault, "tabs", { sinceIso: "" }),
    holdsData: (a) => (a as { applied: unknown[] }).applied.length === 2,
  },
  {
    name: "digest",
    // Compared without the render clock, and without the backlink
    // sections: on the unswitched twin the log day pages link the
    // preferences, and a switched machine has no log pages (the backlink
    // index is another package's reader).
    read: (env) => {
      const {
        generated_at: _at,
        top_referenced: _top,
        connection_health: _health,
        ...rest
      } = JSON.parse(
        renderDigest(env.vault, {
          format: "json",
          since: new Date("2026-10-01T00:00:00Z"),
          until: new Date("2026-11-07T00:00:00Z"),
        }).content,
      ) as Record<string, unknown>;
      return rest;
    },
    holdsData: mentions(FIXTURE.confirmed),
  },
  {
    name: "digest agent summary",
    read: (env) =>
      computeAgentSummary(
        env.vault,
        new Date("2026-11-01T00:00:00Z"),
        new Date("2026-11-07T00:00:00Z"),
      ),
    holdsData: nonEmptyList,
  },
  {
    name: "morning brief",
    read: (env) => buildMorningBrief(env.vault, { now: FIXTURE_NOW, topK: 10 }),
    holdsData: mentions(FIXTURE.confirmed),
  },
  {
    name: "pre-compress pack",
    read: (env) => {
      const pack = buildPreCompressPack(env.vault, { topK: 10 });
      return { ...pack, elapsed_ms: undefined, elapsedMs: undefined };
    },
    holdsData: mentions(FIXTURE.confirmed),
  },
  {
    name: "context pack",
    read: (env) => {
      const pack = packContext(env.vault, { maxTokens: 4000 });
      // Token estimates count characters: the switched twin's signal ids
      // carry its mint tag, so they are compared without the estimates.
      return JSON.parse(
        JSON.stringify({ ...pack, elapsed_ms: undefined, elapsedMs: undefined }, (key, value) =>
          key === "tokens" || key === "tokensUsed" ? undefined : value,
        ),
      ) as unknown;
    },
    holdsData: mentions(FIXTURE.confirmed),
  },
  {
    name: "query by preference",
    read: (env) => queryByPreference(env.vault, FIXTURE.confirmed),
    holdsData: mentions(FIXTURE.confirmed),
  },
  {
    name: "query by retired preference",
    read: (env) => queryByPreference(env.vault, FIXTURE.retired),
    holdsData: mentions("ret-oldrule"),
  },
  {
    name: "query by topic",
    read: (env) => queryByTopic(env.vault, "tabs", { now: FIXTURE_NOW }),
    holdsData: mentions(FIXTURE.confirmed, FIXTURE.activeSignals[0]!),
  },
  {
    name: "query log since",
    read: (env) => queryByLogSince(env.vault, new Date("2026-11-01T00:00:00Z")),
    holdsData: nonEmptyList,
  },
  {
    name: "all log entries",
    read: (env) => readAllLogEntries(env.vault).map((e) => e.eventType),
    holdsData: nonEmptyList,
  },
  {
    name: "intent review",
    read: (env) => {
      const { generated_at: _at, ...rest } = buildIntentReview(env.vault, { now: FIXTURE_NOW });
      return rest;
    },
    holdsData: mentions('"topic":"tabs"', '"topic":"lint"'),
  },
  {
    name: "merge candidates",
    read: (env) => findMergeCandidates(env.vault, { threshold: 0 }),
    holdsData: nonEmptyList,
  },
  {
    name: "explorer graph",
    read: (env) => collectExplorerData(env.vault).nodes.map((n) => n.id),
    holdsData: mentions(FIXTURE.confirmed, "ret-oldrule"),
  },
  {
    name: "export rows",
    read: (env) => collectPreferenceRows(env.vault).rows,
    holdsData: (a) => Array.isArray(a) && a.length === FIXTURE_ACTIVE_PREFERENCES,
  },
  {
    name: "agent source",
    read: (env) => vaultProvider.collect(env.vault),
    holdsData: mentions(FIXTURE.confirmed, FIXTURE.activeSignals[0]!),
  },
  {
    name: "active resource",
    read: (env) => body(readResource({ vault: env.vault }, "osb://preferences/active").text),
    holdsData: mentions(FIXTURE.confirmed),
  },
  {
    name: "lessons resource",
    read: (env) => body(readResource({ vault: env.vault }, "osb://lessons").text),
    holdsData: nonEmptyText,
  },
  {
    name: "preference resource",
    // The rebuilt page carries the page's frontmatter and body; its key
    // order is the fold's, so the page is compared parsed.
    read: (env) =>
      readResource({ vault: env.vault }, `osb://preference/${FIXTURE.confirmed}`)
        .text.split("\n")
        .toSorted(),
    holdsData: mentions("Principle of tabs"),
  },
  {
    name: "topic resource",
    read: (env) => readResource({ vault: env.vault }, "osb://topic/tabs").text,
    holdsData: mentions("Principle of tabs"),
  },
  {
    name: "hook injected context",
    read: (env) => assembleActiveContext(env.vault, 20_000, createInjectionMeter(20_000)),
    holdsData: mentions(FIXTURE.confirmed),
  },
];

/** The lessons digest as a reader gets it: regenerated on the legacy twin, rendered on demand once switched. */
function regenerateLessonsBody(env: StoreEnv): string {
  regenerateLessons(env.vault, { now: FIXTURE_NOW });
  return readFileSync(lessonsDigestPathForRead(env.vault, { now: FIXTURE_NOW }), "utf8");
}

describe("memory readers answer the same once switched", () => {
  for (const reader of READERS) {
    test(reader.name, () => {
      const { legacy, switched } = onBoth(twins, (env) => normalized(reader.read(env), env));
      expect(switched).toEqual(legacy);
    });
  }
});

describe("compiled digests on a switched machine", () => {
  // These tests write the digest cache (and the MCP server renders it), so
  // they get twins of their own: the shared twins every parity, guard and
  // write-nothing test reads stay exactly as built, whatever the order.
  let own: MemoryTwins;
  beforeAll(() => {
    own = makeMemoryTwins("osb-wp2a-digests-");
  });
  afterAll(() => own.cleanup());

  test("the active digest is cached in the device-local state, never in the vault", () => {
    useEnv(own.switched);
    const path = activeDigestPathForRead(own.switched.vault, { now: FIXTURE_NOW });
    expect(path.startsWith(own.switched.vault)).toBe(false);
    const first = readFileSync(path, "utf8");
    // An unchanged body keeps the cached generation.
    activeDigestPathForRead(own.switched.vault, { now: new Date("2026-11-08T00:00:00Z") });
    expect(readFileSync(path, "utf8")).toBe(first);
  });

  test("brain_context serves the rendered digest", async () => {
    const answers = [];
    for (const env of [own.legacy, own.switched]) {
      useEnv(env);
      const server = new MCPServer({ vault: env.vault, configPath: env.configPath });
      const result = (await server.callTool("brain_context", {})) as {
        structuredContent?: { content?: string; present?: boolean };
      };
      answers.push({
        present: result.structuredContent?.present,
        body: body(result.structuredContent?.content ?? ""),
      });
    }
    expect(answers[1]).toEqual(answers[0]!);
    expect(answers[1]!.body).toContain(FIXTURE.confirmed);
  });
});

describe("guard: no reader reads an empty directory on a switched machine", () => {
  for (const reader of READERS) {
    test(reader.name, () => {
      useEnv(twins.switched);
      expect(reader.holdsData(reader.read(twins.switched))).toBe(true);
    });
  }
});

describe("readers write nothing under Brain/ on a switched machine", () => {
  test("every reader, the hook and the resources leave the tree as it was", () => {
    useEnv(twins.switched);
    const vault = twins.switched.vault;
    const before = treeEntries(join(vault, "Brain"));
    for (const reader of READERS) reader.read(twins.switched);
    expect(treeEntries(join(vault, "Brain"))).toEqual(before);
    expect(existsSync(join(vault, "Brain", "active.md"))).toBe(false);
    expect(existsSync(join(vault, "Brain", "lessons.md"))).toBe(false);
  });
});

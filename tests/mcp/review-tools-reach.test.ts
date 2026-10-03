/**
 * The lifecycle review readers - `brain_stale_scan`,
 * `brain_review_candidates`, `brain_retention` and `brain_intent_review` -
 * answer at the caller's reach.
 *
 * The vault pair is tests/helpers/reach-log-fixture.ts: vault A holds a
 * reserved preference and a reserved retired record; vault B never had
 * them. Vault A also holds two withheld preferences whose last evidence
 * is months old, so the stale scan lists them and the dream preview
 * would retire them, and both vaults hold one readable preference in the
 * same state, so a remote answer is never empty. The same holds for an
 * old processed signal the retention review recommends pruning: a
 * withheld one in vault A, a readable one in both. The signal clusters the
 * dream preview and the intent review fold are built the same way: vault A
 * holds a withheld inbox signal on a topic of its own and a second one on
 * the readable cluster's topic, which would move that cluster's count. A
 * server with no reach minted is a remote caller: each tool's whole
 * masked answer, and that of a `brain_trigger` scan over the retention
 * rows, must be the same over both vaults. The local control proves the
 * withheld records are there to list.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { processedSignalPath, signalPath } from "../../src/core/brain/paths.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../src/core/brain/types.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import {
  buildReachLogFixture,
  maskVolatile,
  reachServer,
  RETIRED_SLUG,
  type ReachLogFixture as Fixture,
} from "../helpers/reach-log-fixture.ts";

const WITHHELD_PREFIX = "zzwithheld-stale";
const READABLE_SLUG = "public-stale";
const RESERVE_LINE = `visibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]`;
const CLUSTER_TOPIC = "public-cluster";
const WITHHELD_CLUSTER_TOPIC = `${WITHHELD_PREFIX}-cluster`;
const TOOLS = [
  "brain_stale_scan",
  "brain_review_candidates",
  "brain_retention",
  "brain_intent_review",
] as const;

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

/** Insert the reserve line before the closing frontmatter fence of `path`. */
function reserve(path: string): void {
  const text = readFileSync(path, "utf8");
  const close = text.indexOf("\n---\n", "---\n".length);
  writeFileSync(path, `${text.slice(0, close)}\n${RESERVE_LINE}${text.slice(close)}`);
}

/** An old processed signal, which the retention review recommends pruning. */
function processedSignal(vault: string, slug: string, reserved: boolean): void {
  const date = "2026-04-01";
  writeSignal(vault, {
    topic: slug,
    signal: "negative",
    agent: "test",
    principle: `old one-off signal ${slug}`,
    created_at: `${date}T00:00:00Z`,
    date,
    slug,
  });
  const path = processedSignalPath(vault, date, slug);
  renameSync(signalPath(vault, date, slug), path);
  if (reserved) reserve(path);
}

/** An inbox signal written today, so the dream preview and the intent review fold it. */
function inboxSignal(vault: string, topic: string, slug: string, reserved: boolean): void {
  const date = new Date().toISOString().slice(0, 10);
  writeSignal(vault, {
    topic,
    signal: "positive",
    agent: "test",
    principle: `Prefer ${topic}.`,
    created_at: `${date}T00:00:00Z`,
    date,
    slug,
  });
  if (reserved) reserve(signalPath(vault, date, slug));
}

/** A confirmed preference whose last evidence is months old and never logged since. */
function stalePreference(vault: string, slug: string, reserved: boolean): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `Rule ${slug}.`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [],
    confirmed_at: "2026-05-02T00:00:00Z",
    applied_count: 1,
    violated_count: 0,
    last_evidence_at: "2026-05-02T00:00:00Z",
    confidence: BRAIN_CONFIDENCE.high,
    confidence_value: 0.8,
  });
  if (reserved) reserve(join(vault, "Brain", "preferences", `pref-${slug}.md`));
}

function fixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-review-tools-reach-"));
  bases.push(base);
  const f = buildReachLogFixture(base, withPrivate);
  stalePreference(f.vault, READABLE_SLUG, false);
  processedSignal(f.vault, READABLE_SLUG, false);
  inboxSignal(f.vault, CLUSTER_TOPIC, CLUSTER_TOPIC, false);
  if (withPrivate) {
    inboxSignal(f.vault, WITHHELD_CLUSTER_TOPIC, WITHHELD_CLUSTER_TOPIC, true);
    inboxSignal(f.vault, CLUSTER_TOPIC, `${WITHHELD_PREFIX}-second`, true);
    for (const suffix of ["a", "b"]) stalePreference(f.vault, `${WITHHELD_PREFIX}-${suffix}`, true);
    processedSignal(f.vault, `${WITHHELD_PREFIX}-signal`, true);
  }
  return f;
}

async function answer(
  f: Fixture,
  tool: string,
  reach?: TransportReach,
  args: Record<string, unknown> = {},
): Promise<string> {
  const result = await reachServer(f, reach).callTool(tool, args);
  return maskVolatile(f, result["structuredContent"] ?? result);
}

describe("the lifecycle review readers answer at the caller's reach", () => {
  for (const tool of TOOLS) {
    test(`remote reach: ${tool} names no withheld record`, async () => {
      const withheld = await answer(fixture(true), tool);
      const absent = await answer(fixture(false), tool);
      expect(withheld).toBe(absent);
      expect(withheld).not.toContain(WITHHELD_PREFIX);
      expect(withheld).not.toContain(RETIRED_SLUG);
    });
  }

  test("remote reach: the readable stale preference is still listed", async () => {
    const a = fixture(true);
    expect(await answer(a, "brain_stale_scan")).toContain(READABLE_SLUG);
    expect(await answer(a, "brain_review_candidates")).toContain(READABLE_SLUG);
    expect(await answer(a, "brain_retention")).toContain(READABLE_SLUG);
    expect(await answer(a, "brain_review_candidates")).toContain(CLUSTER_TOPIC);
    expect(await answer(a, "brain_intent_review")).toContain(CLUSTER_TOPIC);
  });

  test("local control: the operator's own shell lists the withheld records", async () => {
    const a = fixture(true);
    const local = TRANSPORT_REACH.local;
    expect(await answer(a, "brain_stale_scan", local)).toContain(WITHHELD_PREFIX);
    expect(await answer(a, "brain_review_candidates", local)).toContain(WITHHELD_PREFIX);
    expect(await answer(a, "brain_retention", local)).toContain(WITHHELD_PREFIX);
    expect(await answer(a, "brain_intent_review", local)).toContain(WITHHELD_CLUSTER_TOPIC);
  });

  test("remote reach: a trigger scan queues nothing from a withheld retention row", async () => {
    const scan = { operation: "scan" };
    const withheld = await answer(fixture(true), "brain_trigger", undefined, scan);
    const absent = await answer(fixture(false), "brain_trigger", undefined, scan);
    expect(withheld).toBe(absent);
    expect(withheld).not.toContain(WITHHELD_PREFIX);
  });

  test("remote reach: a trigger scan still queues the readable retention row", async () => {
    const scan = { operation: "scan" };
    expect(await answer(fixture(true), "brain_trigger", undefined, scan)).toContain(READABLE_SLUG);
  });
});

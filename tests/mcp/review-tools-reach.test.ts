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
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { appendApplyEvidence } from "../../src/core/brain/apply-evidence.ts";
import { processedSignalPath, signalPath } from "../../src/core/brain/paths.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../src/core/brain/types.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";
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

const SIBLINGS_FLAG = "OPEN_SECOND_BRAIN_NEAR_DUPLICATE_RETIRE_SIBLINGS_ENABLED";
const SIBLING_RULE = "always run the formatter before every commit in this repository";
const SIBLING_PARAPHRASE = "always run the formatter before each commit in this repository";

function rule(vault: string, slug: string, principle: string, reserved: boolean): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [],
    confirmed_at: "2026-05-02T00:00:00Z",
    applied_count: 1,
    violated_count: 0,
    last_evidence_at: new Date().toISOString().slice(0, 10) + "T00:00:00Z",
    confidence: BRAIN_CONFIDENCE.high,
    confidence_value: 0.8,
  });
  if (reserved) reserve(join(vault, "Brain", "preferences", `pref-${slug}.md`));
}

function evidence(vault: string, slug: string, result: "applied" | "outdated"): void {
  appendApplyEvidence(vault, {
    pref_id: `pref-${slug}`,
    artifact: "[[AA-artifact]]",
    result,
    agent: "test",
  });
}

function siblingsOf(answerText: string): unknown {
  return (JSON.parse(answerText) as { retire_siblings?: unknown }).retire_siblings;
}

/**
 * Two context-driven retires, each with one paraphrase sibling. In the
 * first pair the sibling is withheld, in the second the retiring
 * preference is; a readable pair is in both vaults.
 */
function siblingFixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-review-siblings-reach-"));
  bases.push(base);
  const f = buildReachLogFixture(base, withPrivate);
  rule(f.vault, "public-old", `${SIBLING_RULE} alpha`, false);
  rule(f.vault, "public-twin", `${SIBLING_PARAPHRASE} alpha`, false);
  evidence(f.vault, "public-twin", "applied");
  evidence(f.vault, "public-old", "outdated");
  if (withPrivate) {
    rule(f.vault, "public-retiring", `${SIBLING_RULE} beta`, false);
    rule(f.vault, `${WITHHELD_PREFIX}-twin`, `${SIBLING_PARAPHRASE} beta`, true);
    evidence(f.vault, `${WITHHELD_PREFIX}-twin`, "applied");
    evidence(f.vault, "public-retiring", "outdated");
    rule(f.vault, `${WITHHELD_PREFIX}-old`, `${SIBLING_RULE} gamma`, true);
    rule(f.vault, "public-gamma-twin", `${SIBLING_PARAPHRASE} gamma`, false);
    evidence(f.vault, "public-gamma-twin", "applied");
    evidence(f.vault, `${WITHHELD_PREFIX}-old`, "outdated");
  }
  return f;
}

describe("brain_review_candidates retire_siblings answer at the caller's reach", () => {
  const savedFlag = process.env[SIBLINGS_FLAG];

  afterEach(() => {
    if (savedFlag === undefined) delete process.env[SIBLINGS_FLAG];
    else process.env[SIBLINGS_FLAG] = savedFlag;
  });

  test("remote reach: a pair with a withheld retiring or sibling id is neither listed nor counted", async () => {
    process.env[SIBLINGS_FLAG] = "1";
    const withheld = await answer(siblingFixture(true), "brain_review_candidates");
    const absent = await answer(siblingFixture(false), "brain_review_candidates");
    expect(withheld).not.toContain(WITHHELD_PREFIX);
    expect(siblingsOf(withheld)).toEqual(siblingsOf(absent));
    expect(siblingsOf(withheld)).toEqual([
      {
        retiring_id: "pref-public-old",
        sibling_id: "pref-public-twin",
        score: 0.833,
        method: "lexical",
      },
    ]);
  });

  test("remote reach: a sibling whose ret- spelling is withheld is not listed", async () => {
    // The dry run admits the readable `pref-bygone`, but the vault also holds
    // a withheld `ret-bygone`: the view asks about both spellings.
    process.env[SIBLINGS_FLAG] = "1";
    const f = siblingFixture(true);
    rule(f.vault, RETIRED_SLUG, `${SIBLING_PARAPHRASE} beta`, false);
    evidence(f.vault, RETIRED_SLUG, "applied");
    const remote = await answer(f, "brain_review_candidates");
    expect(remote).not.toContain(RETIRED_SLUG);
    const local = await answer(f, "brain_review_candidates", TRANSPORT_REACH.local);
    expect(local).toContain(`"sibling_id":"pref-${RETIRED_SLUG}"`);
  });

  test("remote reach: a retire hidden by its withheld ret- spelling moves no semantic status", async () => {
    // The only context-driven retire is the readable `pref-bygone`, whose
    // withheld `ret-bygone` hides it; the absent vault has neither.
    process.env[SIBLINGS_FLAG] = "1";
    const withheldBase = mkdtempSync(join(tmpdir(), "o2b-review-semantic-reach-"));
    const absentBase = mkdtempSync(join(tmpdir(), "o2b-review-semantic-reach-"));
    bases.push(withheldBase, absentBase);
    const withheld = buildReachLogFixture(withheldBase, true);
    rule(withheld.vault, RETIRED_SLUG, SIBLING_RULE, false);
    evidence(withheld.vault, RETIRED_SLUG, "outdated");
    const absent = buildReachLogFixture(absentBase, false);
    const local = await answer(withheld, "brain_review_candidates", TRANSPORT_REACH.local);
    expect(local).toContain('"retire_siblings_semantic"');
    const remote = await answer(withheld, "brain_review_candidates");
    expect(remote).not.toContain("retire_siblings_semantic");
    expect(remote).toBe(await answer(absent, "brain_review_candidates"));
  });

  test("the key is read from the server's own config file, not the default one", async () => {
    delete process.env[SIBLINGS_FLAG];
    const base = mkdtempSync(join(tmpdir(), "o2b-review-siblings-config-"));
    bases.push(base);
    const f = buildReachLogFixture(base, false, ['near_duplicate_retire_siblings_enabled: "true"']);
    rule(f.vault, "public-old", `${SIBLING_RULE} alpha`, false);
    rule(f.vault, "public-twin", `${SIBLING_PARAPHRASE} alpha`, false);
    evidence(f.vault, "public-twin", "applied");
    evidence(f.vault, "public-old", "outdated");
    const server = reachServer(f, TRANSPORT_REACH.local);
    // The default config is now a file without the key.
    const otherConfig = join(base, "other-config.yaml");
    writeFileSync(otherConfig, `vault: ${f.vault}\n`);
    process.env["OPEN_SECOND_BRAIN_CONFIG"] = otherConfig;
    const result = await server.callTool("brain_review_candidates", {});
    expect(siblingsOf(maskVolatile(f, result["structuredContent"] ?? result))).toEqual([
      {
        retiring_id: "pref-public-old",
        sibling_id: "pref-public-twin",
        score: 0.833,
        method: "lexical",
      },
    ]);
  });

  test("an index that will not open keeps the lexical pairs and names the failure", async () => {
    process.env[SIBLINGS_FLAG] = "1";
    const f = siblingFixture(false);
    const { dbPath } = resolveSearchConfig({ vault: f.vault, configPath: f.configPath });
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, "not a database");
    const local = await answer(f, "brain_review_candidates", TRANSPORT_REACH.local);
    expect(local).toContain('"retire_siblings_semantic":"index_unavailable"');
    expect(local).toContain('"retire_siblings_semantic_detail":"INDEX_UNREADABLE"');
    expect(siblingsOf(local)).toEqual([
      {
        retiring_id: "pref-public-old",
        sibling_id: "pref-public-twin",
        score: 0.833,
        method: "lexical",
      },
    ]);
  });

  test("local control: the operator's own shell lists every pair", async () => {
    process.env[SIBLINGS_FLAG] = "1";
    const local = await answer(
      siblingFixture(true),
      "brain_review_candidates",
      TRANSPORT_REACH.local,
    );
    const pairs = (siblingsOf(local) as Array<{ retiring_id: string; sibling_id: string }>).map(
      (p) => `${p.retiring_id}>${p.sibling_id}`,
    );
    expect(pairs).toEqual([
      "pref-public-old>pref-public-twin",
      "pref-public-retiring>pref-zzwithheld-stale-twin",
      "pref-zzwithheld-stale-old>pref-public-gamma-twin",
    ]);
  });
});

describe("brain_dream retire_siblings answer at the caller's reach", () => {
  const savedFlag = process.env[SIBLINGS_FLAG];
  const DRY_RUN = { dry_run: true };
  const PUBLIC_PAIR = {
    retiring_id: "pref-public-old",
    sibling_id: "pref-public-twin",
    score: 0.833,
    method: "lexical",
  };

  afterEach(() => {
    if (savedFlag === undefined) delete process.env[SIBLINGS_FLAG];
    else process.env[SIBLINGS_FLAG] = savedFlag;
  });

  test("remote reach: a pair with a withheld retiring or sibling id is neither listed nor counted", async () => {
    process.env[SIBLINGS_FLAG] = "1";
    const withheld = await answer(siblingFixture(true), "brain_dream", undefined, DRY_RUN);
    const absent = await answer(siblingFixture(false), "brain_dream", undefined, DRY_RUN);
    expect(siblingsOf(withheld)).toEqual(siblingsOf(absent));
    expect(siblingsOf(withheld)).toEqual([PUBLIC_PAIR]);
  });

  test("local control: the operator's own shell lists every pair", async () => {
    process.env[SIBLINGS_FLAG] = "1";
    const local = await answer(siblingFixture(true), "brain_dream", TRANSPORT_REACH.local, DRY_RUN);
    const pairs = (siblingsOf(local) as Array<{ retiring_id: string; sibling_id: string }>).map(
      (p) => `${p.retiring_id}>${p.sibling_id}`,
    );
    expect(pairs).toEqual([
      "pref-public-old>pref-public-twin",
      "pref-public-retiring>pref-zzwithheld-stale-twin",
      "pref-zzwithheld-stale-old>pref-public-gamma-twin",
    ]);
  });

  test("with the key off, the field is absent", async () => {
    delete process.env[SIBLINGS_FLAG];
    const local = await answer(
      siblingFixture(false),
      "brain_dream",
      TRANSPORT_REACH.local,
      DRY_RUN,
    );
    expect(local).not.toContain("retire_siblings");
  });

  test("the key is read from the server's own config file, not the default one", async () => {
    delete process.env[SIBLINGS_FLAG];
    const base = mkdtempSync(join(tmpdir(), "o2b-dream-siblings-config-"));
    bases.push(base);
    const f = buildReachLogFixture(base, false, ['near_duplicate_retire_siblings_enabled: "true"']);
    rule(f.vault, "public-old", `${SIBLING_RULE} alpha`, false);
    rule(f.vault, "public-twin", `${SIBLING_PARAPHRASE} alpha`, false);
    evidence(f.vault, "public-twin", "applied");
    evidence(f.vault, "public-old", "outdated");
    const server = reachServer(f, TRANSPORT_REACH.local);
    // The default config is now a file without the key.
    const otherConfig = join(base, "other-config.yaml");
    writeFileSync(otherConfig, `vault: ${f.vault}\n`);
    process.env["OPEN_SECOND_BRAIN_CONFIG"] = otherConfig;
    const result = await server.callTool("brain_dream", DRY_RUN);
    expect(siblingsOf(maskVolatile(f, result["structuredContent"] ?? result))).toEqual([
      PUBLIC_PAIR,
    ]);
  });
});

/**
 * The ownership statement, and the census that keeps it true.
 *
 * "Every memory is a Markdown file in your own vault; copy it elsewhere,
 * delete it and the brain is gone; there is no service to cancel" is a
 * claim with known counterexamples, and a claim with a known counterexample
 * is exactly what this release exists to remove. So the sentence is not
 * written by hand: it is COMPOSED from the resolved vault path, a
 * filesystem-backing verdict, the measured location of the search index,
 * the measured state of every outbound integration, and an enumeration of
 * the durable state that can live outside the vault.
 *
 * Two families of test, and the split is the point:
 *
 *   The first family pins the MEASURED clauses - every one of them has an
 *   arm that says "not established", and none of them may render as the
 *   confident arm when the input did not say so.
 *
 *   The last describe block is the census. It sweeps the tree for every
 *   module that BUILDS a path rooted outside the vault and demands each be
 *   attributed to an entry in the enumeration or excused in writing - so a
 *   new out-of-vault location cannot be added without the sentence learning
 *   about it. It sweeps path construction rather than write calls because
 *   the write-call form was blind to `fs/promises`, to this repository's
 *   own `atomicWriteText` helper, and to any module that computes such a
 *   path and hands it to something else to write.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { registerAllAdapters } from "../../../src/core/install/adapters/all.ts";
import { measureDataOwnership } from "../../../src/core/install/ownership-measure.ts";
import {
  buildDataOwnership,
  OUT_OF_VAULT_STATE,
  OUT_OF_VAULT_SWEEP_EXCLUSIONS,
  OUTBOUND_SERVICE,
  OUTBOUND_SERVICES,
  OUTBOUND_STATE,
  renderDataOwnership,
  SEARCH_INDEX_LOCATION,
  SOURCES_INVISIBLE_TO_THE_SWEEP,
  type DataOwnershipInput,
  type OutboundMeasurement,
  type OutboundServiceId,
  type SearchIndexVerdict,
} from "../../../src/core/install/ownership.ts";
import {
  VAULT_BACKING,
  VAULT_BACKING_UNDETERMINED_REASON,
} from "../../../src/core/vault-backing.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const VAULT = "/tmp/some-vault";
const INDEX_INSIDE = `${VAULT}/.open-second-brain/index.sqlite`;
const INDEX_OUTSIDE = "/var/tmp/elsewhere/index.sqlite";

const INSIDE_VAULT: SearchIndexVerdict = {
  state: SEARCH_INDEX_LOCATION.insideVault,
  path: INDEX_INSIDE,
  reason: null,
};

/** Every outbound integration measured as absent — the quiet machine. */
function nothingConfigured(): Record<OutboundServiceId, OutboundMeasurement> {
  const out = {} as Record<OutboundServiceId, OutboundMeasurement>;
  for (const service of OUTBOUND_SERVICES) out[service.id] = { state: OUTBOUND_STATE.absent };
  return out;
}

function ownership(overrides: Partial<DataOwnershipInput> = {}) {
  return buildDataOwnership({
    vault: VAULT,
    searchIndex: INSIDE_VAULT,
    adapterTargets: ["cursor", "kiro"],
    outbound: nothingConfigured(),
    backing: {
      state: VAULT_BACKING.durable,
      filesystem: "ext4",
      reason: null,
      detail: `${VAULT} is backed by ext4 (0xef53)`,
    },
    ...overrides,
  });
}

/** The line of the rendered statement that speaks about the search index. */
function indexLine(text: string): string {
  return text.split("\n")[2] ?? "";
}

/** How many bulleted rows the statement printed, catalogue and outbound alike. */
function catalogueRowCount(text: string): number {
  return text.split("\n").filter((l) => l.startsWith("    - ")).length;
}

/** The last sentence of the statement — the one that used to over-claim. */
function closingLine(text: string): string {
  const lines = text.trimEnd().split("\n");
  return lines[lines.length - 1] ?? "";
}

describe("the statement is built from what was measured", () => {
  test("it names the resolved vault, not a configured one", () => {
    const text = renderDataOwnership(ownership());
    expect(text).toContain(VAULT);
  });

  test("a durable backing is stated as such", () => {
    const text = renderDataOwnership(ownership());
    expect(text).toContain("ext4");
  });

  test("an undetermined backing is never rendered as durability", () => {
    const text = renderDataOwnership(
      ownership({
        backing: {
          state: VAULT_BACKING.undetermined,
          filesystem: null,
          reason: VAULT_BACKING_UNDETERMINED_REASON.probeUnsupported,
          detail: "the filesystem backing /tmp/some-vault was not probed",
        },
      }),
    );
    // The verdict is present and it is the honest one; nothing in the
    // rendering promises the vault survives anything.
    expect(text).toContain("was not probed");
    expect(text).not.toContain("survives this process and a reboot");
  });

  test("a memory-backed vault is stated as a loss, not as a caveat", () => {
    const text = renderDataOwnership(
      ownership({
        backing: {
          state: VAULT_BACKING.volatile,
          filesystem: "tmpfs",
          reason: null,
          detail: "/tmp/some-vault is backed by tmpfs (0x1021994)",
        },
      }),
    );
    expect(text).toContain("tmpfs");
    expect(text).toContain("reboot");
  });
});

describe("where the search index is, is measured rather than assumed", () => {
  test("an index inside the vault is named by path, not by assumption", () => {
    const text = renderDataOwnership(ownership());
    expect(indexLine(text)).toContain(INDEX_INSIDE);
  });

  test("a relocated index is never described as being in the vault", () => {
    // The reproduction from the review: OPEN_SECOND_BRAIN_SEARCH_DB points
    // somewhere else, and the first line used to say "in the same vault"
    // two lines above the row admitting it might not be.
    const text = renderDataOwnership(
      ownership({
        searchIndex: {
          state: SEARCH_INDEX_LOCATION.outsideVault,
          path: INDEX_OUTSIDE,
          reason: null,
        },
      }),
    );
    expect(indexLine(text)).toContain(INDEX_OUTSIDE);
    expect(indexLine(text)).not.toContain(indexLine(renderDataOwnership(ownership())));
  });

  test("an index whose location could not be established says so, and names nothing", () => {
    const why = "the search config would not resolve: search_chunk_size must be >= 1";
    const text = renderDataOwnership(
      ownership({
        searchIndex: { state: SEARCH_INDEX_LOCATION.unchecked, path: null, reason: why },
      }),
    );
    expect(indexLine(text)).toContain(why);
    expect(indexLine(text)).not.toContain(INDEX_INSIDE);
  });

  test("no two location states render the same sentence", () => {
    const rendered = new Set(
      [
        INSIDE_VAULT,
        { state: SEARCH_INDEX_LOCATION.outsideVault, path: INDEX_OUTSIDE, reason: null },
        { state: SEARCH_INDEX_LOCATION.unchecked, path: null, reason: "no reason given" },
      ].map((searchIndex) => indexLine(renderDataOwnership(ownership({ searchIndex })))),
    );
    // A vocabulary whose members collapse onto one sentence is a vocabulary
    // the reader cannot use.
    expect(rendered.size).toBe(3);
  });
});

describe("the exceptions are named as a catalogue, never as a scan", () => {
  test("every enumerated out-of-vault location reaches the rendered statement", () => {
    const text = renderDataOwnership(ownership());
    const missing = OUT_OF_VAULT_STATE.filter((entry) => !text.includes(entry.label));
    expect(missing.map((e) => e.id).join("\n")).toBe("");
  });

  test("every row says what creates it and what removes it", () => {
    const text = renderDataOwnership(ownership());
    // Without these two the rows read as a report about this machine, which
    // is what they are not: they are printed unconditionally.
    const silent = OUT_OF_VAULT_STATE.filter(
      (e) =>
        e.created_by.trim().length === 0 ||
        e.removed_by.trim().length === 0 ||
        !text.includes(e.created_by) ||
        !text.includes(e.removed_by),
    );
    expect(silent.map((e) => e.id).join("\n")).toBe("");
  });

  test("the one location that can hold memory content is called out by name", () => {
    const carriers = OUT_OF_VAULT_STATE.filter((e) => e.carries_memory);
    // Not an incidental fact: the opencode spool is the counterexample that
    // makes the unqualified sentence false, so an empty set here means the
    // statement has quietly become the unqualified one again.
    expect(carriers.length).toBeGreaterThan(0);
    const text = renderDataOwnership(ownership());
    for (const carrier of carriers) expect(text).toContain(carrier.location);
  });

  test("every installed runtime target is accounted for in the statement", () => {
    const targets = registerAllAdapters().targets();
    const text = renderDataOwnership(ownership({ adapterTargets: targets }));
    const missing = targets.filter((t) => !text.includes(t));
    expect(missing.join("\n")).toBe("");
  });

  test("the registry list is offered as what CAN be installed, not what is", () => {
    // `defaultRegistry.targets()` is every adapter this build registers, not
    // the ones this machine has. The row that carries it therefore has to
    // say which of the two it is, and it must not grow or shrink with the
    // machine.
    const few = renderDataOwnership(ownership({ adapterTargets: ["cursor"] }));
    const many = renderDataOwnership(ownership({ adapterTargets: ["aider", "cursor", "kiro"] }));
    expect(catalogueRowCount(few)).toBe(catalogueRowCount(many));
    expect(many).toContain("installable targets: aider, cursor, kiro");
  });

  test("no id is spelled twice", () => {
    const ids = OUT_OF_VAULT_STATE.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the closing sentence does not take the qualifications back", () => {
  test("it never restates the unqualified claim the module exists to correct", () => {
    const text = renderDataOwnership(ownership());
    // The exact sentence that shipped, pinned: row one of the list printed
    // immediately above it is a memory carrier outside the vault.
    expect(text).not.toContain("Delete the vault and the memory is gone");
  });

  test("it promises no removal verb on behalf of the rows", () => {
    const closing = closingLine(renderDataOwnership(ownership()));
    // `o2b uninstall` removes two of these rows. A closing sentence that
    // names it once for the whole list is false for the rest, so the
    // closing names no verb at all and each row carries its own.
    const removedByUninstall = OUT_OF_VAULT_STATE.filter((e) =>
      e.removed_by.includes("o2b uninstall"),
    );
    expect(removedByUninstall.length).toBeGreaterThan(0);
    expect(removedByUninstall.length).toBeLessThan(OUT_OF_VAULT_STATE.length);
    expect(closing).not.toContain("o2b uninstall");
  });

  test("it carries the count of memory-bearing rows it is qualified by", () => {
    const carriers = OUT_OF_VAULT_STATE.filter((e) => e.carries_memory).length;
    const closing = closingLine(renderDataOwnership(ownership()));
    expect(closing).toContain(String(carriers));
    expect(closing).toContain(String(OUT_OF_VAULT_STATE.length));
  });
});

describe("`nothing to cancel` is checked against every integration it names", () => {
  test("every outbound integration in the catalogue reaches the statement", () => {
    const text = renderDataOwnership(ownership());
    const missing = OUTBOUND_SERVICES.filter(
      (s) => !text.includes(s.label) || !text.includes(s.settings),
    );
    expect(missing.map((s) => s.id).join("\n")).toBe("");
  });

  test("a configured integration is named with the endpoint it sends to", () => {
    const text = renderDataOwnership(
      ownership({
        outbound: {
          ...nothingConfigured(),
          [OUTBOUND_SERVICE.rerank]: {
            state: OUTBOUND_STATE.configured,
            endpoint: "https://rerank.example/v1",
          },
        },
      }),
    );
    expect(text).toContain("https://rerank.example/v1");
    // The reranker POSTs the candidate document text, so the statement has
    // to say what leaves rather than only that something is configured.
    const rerank = OUTBOUND_SERVICES.find((s) => s.id === OUTBOUND_SERVICE.rerank)!;
    expect(text).toContain(rerank.sends);
  });

  test("an integration that could not be checked is not reported as absent", () => {
    const why = "the search config would not resolve: bad key";
    const unchecked = renderDataOwnership(
      ownership({
        outbound: {
          ...nothingConfigured(),
          [OUTBOUND_SERVICE.embedding]: { state: OUTBOUND_STATE.unchecked, reason: why },
        },
      }),
    );
    const absent = renderDataOwnership(ownership());
    expect(unchecked).toContain(why);
    expect(unchecked).not.toBe(absent);
  });

  test("an unchecked state with no reason still says a check did not run", () => {
    const text = renderDataOwnership(
      ownership({
        outbound: {
          ...nothingConfigured(),
          [OUTBOUND_SERVICE.telegram]: { state: OUTBOUND_STATE.unchecked },
        },
      }),
    );
    const absent = renderDataOwnership(ownership());
    // Silence here would be the whole defect: a check that did not run must
    // never render as the check that ran and found nothing.
    expect(text).not.toBe(absent);
  });

  test("the machine-readable record carries one status per catalogue row", () => {
    const record = ownership();
    expect(record.outbound_services.map((s) => s.id).toSorted()).toEqual(
      OUTBOUND_SERVICES.map((s) => s.id).toSorted(),
    );
    for (const status of record.outbound_services) {
      expect(Object.values(OUTBOUND_STATE)).toContain(status.state);
    }
  });
});

// ---------------------------------------------------------------------------
// The measuring half.
// ---------------------------------------------------------------------------

/** Env keys the measurements below read, saved and restored per test. */
const MEASURED_ENV_KEYS: ReadonlyArray<string> = Object.freeze([
  "OPEN_SECOND_BRAIN_SEARCH_DB",
  "OPEN_SECOND_BRAIN_SEARCH_CHUNK_SIZE",
  "OPEN_SECOND_BRAIN_SEARCH_RERANK_ENABLED",
  "OPEN_SECOND_BRAIN_SEARCH_RERANK_BASE_URL",
  "TELEGRAM_BOT_TOKEN",
  "TAVILY_API_KEY",
  "BRAVE_API_KEY",
]);

describe("the measurements the statement is composed from", () => {
  let saved: Record<string, string | undefined> = {};
  let tempVault = "";
  let configPath = "";

  beforeEach(() => {
    saved = {};
    for (const key of MEASURED_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    tempVault = mkdtempSync(join(tmpdir(), "osb-own-"));
    configPath = join(tempVault, "config.yaml");
    writeFileSync(configPath, `vault: "${tempVault}"\n`);
  });

  afterEach(() => {
    for (const key of MEASURED_ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tempVault, { recursive: true, force: true });
  });

  function measured() {
    return measureDataOwnership({ vault: tempVault, configPath, adapterTargets: ["cursor"] });
  }

  test("the default index is measured as inside the vault", () => {
    const record = measured();
    expect(record.search_index.state).toBe(SEARCH_INDEX_LOCATION.insideVault);
    expect(record.search_index.path).toContain(tempVault);
  });

  test("a relocated index is measured as outside it, at the path it resolved to", () => {
    // The review's reproduction, end to end: the override is set, and the
    // statement's first line is what it changes.
    process.env["OPEN_SECOND_BRAIN_SEARCH_DB"] = "/var/tmp/elsewhere/index.sqlite";
    const record = measured();
    expect(record.search_index.state).toBe(SEARCH_INDEX_LOCATION.outsideVault);
    expect(record.search_index.path).toBe("/var/tmp/elsewhere/index.sqlite");
    expect(renderDataOwnership(record)).toContain("/var/tmp/elsewhere/index.sqlite");
  });

  test("a search config that will not resolve is reported, not read as `nothing configured`", () => {
    process.env["OPEN_SECOND_BRAIN_SEARCH_CHUNK_SIZE"] = "0";
    const record = measured();
    expect(record.search_index.state).toBe(SEARCH_INDEX_LOCATION.unchecked);
    const fromSearch = record.outbound_services.filter(
      (s) => s.id === OUTBOUND_SERVICE.embedding || s.id === OUTBOUND_SERVICE.rerank,
    );
    expect(fromSearch.length).toBe(2);
    for (const service of fromSearch) {
      expect(service.state).toBe(OUTBOUND_STATE.unchecked);
      expect(service.reason ?? "").toContain("search_chunk_size");
    }
  });

  test("the reranker is checked, and named with the endpoint it posts documents to", () => {
    process.env["OPEN_SECOND_BRAIN_SEARCH_RERANK_ENABLED"] = "true";
    process.env["OPEN_SECOND_BRAIN_SEARCH_RERANK_BASE_URL"] = "https://rerank.example/v1";
    const rerank = measured().outbound_services.find((s) => s.id === OUTBOUND_SERVICE.rerank)!;
    expect(rerank.state).toBe(OUTBOUND_STATE.configured);
    expect(rerank.endpoint).toBe("https://rerank.example/v1");
  });

  test("the Telegram bot token and a research key are each an account that was checked", () => {
    process.env["TELEGRAM_BOT_TOKEN"] = "123:abc";
    process.env["TAVILY_API_KEY"] = "tvly-x";
    const record = measured();
    const state = (id: string) =>
      record.outbound_services.find((s) => s.id === id)?.state ?? "missing";
    expect(state(OUTBOUND_SERVICE.telegram)).toBe(OUTBOUND_STATE.configured);
    expect(state(OUTBOUND_SERVICE.research)).toBe(OUTBOUND_STATE.configured);
  });

  test("a quiet machine reports every integration absent, and none unchecked", () => {
    // `embedding_provider` defaults to `openai-compat` with semantic search
    // off, so a check that reads the provider name alone announces a cloud
    // account on a machine that has never computed an embedding.
    for (const service of measured().outbound_services) {
      expect(`${service.id}: ${service.state}`).toBe(`${service.id}: ${OUTBOUND_STATE.absent}`);
    }
  });

  test("a networked embedding endpoint is reported once semantic search is on", () => {
    writeFileSync(
      configPath,
      `vault: "${tempVault}"\nsearch_semantic_enabled: true\nembedding_base_url: "https://api.openai.com/v1"\n`,
    );
    const embedding = measured().outbound_services.find(
      (s) => s.id === OUTBOUND_SERVICE.embedding,
    )!;
    expect(embedding.state).toBe(OUTBOUND_STATE.configured);
    expect(embedding.endpoint).toBe("https://api.openai.com/v1");
  });
});

// ---------------------------------------------------------------------------
// The census.
// ---------------------------------------------------------------------------

/**
 * Roots swept for out-of-vault path construction. `tests/` is deliberately
 * absent: a test writing into a temp home is staging a fixture, not
 * shipping a location an operator will find on their machine afterwards.
 * `scripts/` is present because it ships in `package.json` `files`.
 */
const SWEPT_ROOTS: ReadonlyArray<string> = Object.freeze(["src", "hooks", "plugins", "scripts"]);

/**
 * A path rooted somewhere other than the vault.
 *
 * This is the whole population filter now: a module that names one of
 * these roots is enrolled whether or not it writes through a call this
 * file recognises. The write-call half that used to accompany it was a
 * list of six synchronous `fs` functions, and it therefore could not see
 * `fs/promises`, `Bun.write`, a write stream, this repository's own
 * `atomicWriteText`, a spawned child writing on the module's behalf, or a
 * module that builds the path and hands it to any of those. Matching the
 * ROOT instead of the call catches all of them, at the cost of enrolling
 * read-only modules - which is why the exclusion map is the size it is.
 *
 * `env.home` is included because the install adapters receive the home
 * directory injected rather than reading it, and they are the largest
 * family of out-of-vault writers in the tree. `XDG_` is matched by prefix
 * rather than by naming the four variables this build happens to use, and
 * a quoted `~/` is matched because the cron recipes emit shell text whose
 * writes are performed by the operator's crontab: both widen the
 * population by nothing today, which is the moment to widen them.
 *
 * What it still cannot see, by construction: a root that arrives from a
 * config key or an env override with no token in the source, a path
 * resolved against the working directory, and a hardcoded absolute path
 * outside the vault. The first two are the shapes {@link
 * SOURCES_INVISIBLE_TO_THE_SWEEP} enumerates.
 */
const OUT_OF_VAULT_ANCHOR_RE =
  /XDG_[A-Z_]+|homedir\(\)|process\.env\[["']HOME["']\]|process\.env\[["']USERPROFILE["']\]|\.local\/(?:bin|share|state)|tmpdir\(\)|TMPDIR|env\.home|["'`]~\//;

/**
 * Comments stripped before the pattern runs: a docblock that explains why
 * a module does NOT write outside the vault would otherwise enrol it. The
 * `[^:]` guard keeps `https://` out of the line-comment arm.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      // A dangling symlink is not a module, and a census that throws on one
      // reports nothing at all - which is strictly worse than reporting the
      // rest of the tree. `plugins/codex/skills` is a symlink; a checkout
      // that has not materialised it must not take the sweep down with it.
      continue;
    }
    if (isDir) walk(full, out);
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Every module that builds a path rooted outside the vault. */
function sweepOutOfVaultPathBuilders(): ReadonlyArray<string> {
  const hits: string[] = [];
  for (const root of SWEPT_ROOTS) {
    const dir = join(REPO_ROOT, root);
    if (!existsSync(dir)) continue;
    for (const file of walk(dir, [])) {
      const source = code(readFileSync(file, "utf8"));
      if (!OUT_OF_VAULT_ANCHOR_RE.test(source)) continue;
      hits.push(relative(REPO_ROOT, file));
    }
  }
  return hits.toSorted();
}

/** True when `file` sits under one of the entry's declared sources. */
function attributed(file: string): boolean {
  for (const entry of OUT_OF_VAULT_STATE) {
    for (const source of entry.sources) {
      if (file === source) return true;
      if (source.endsWith("/") && file.startsWith(source)) return true;
    }
  }
  return false;
}

const MIN_EXCLUSION_REASON_LENGTH = 80;

describe("no out-of-vault path escapes the enumeration", () => {
  test("the sweep found a real population", () => {
    // A regex that stopped matching, or a root that was renamed, would
    // sweep an empty set clean and pass every assertion below.
    expect(sweepOutOfVaultPathBuilders().length).toBeGreaterThan(8);
  });

  test("every path builder is either attributed to an entry or excused in writing", () => {
    const orphans = sweepOutOfVaultPathBuilders().filter(
      (file) => !attributed(file) && !OUT_OF_VAULT_SWEEP_EXCLUSIONS.has(file),
    );
    // Named, not counted: the failure message is the work to be done.
    expect(orphans.join("\n")).toBe("");
  });

  test("no exclusion outlives the module it excuses", () => {
    const population = new Set(sweepOutOfVaultPathBuilders());
    const stale = [...OUT_OF_VAULT_SWEEP_EXCLUSIONS.keys()].filter((file) => !population.has(file));
    expect(stale.toSorted().join("\n")).toBe("");
  });

  test("every exclusion reason says something specific", () => {
    for (const [file, reason] of OUT_OF_VAULT_SWEEP_EXCLUSIONS) {
      expect(`${file}: ${reason.trim().length >= MIN_EXCLUSION_REASON_LENGTH}`).toBe(
        `${file}: true`,
      );
    }
  });

  test("every declared source still exists", () => {
    const missing: string[] = [];
    for (const entry of OUT_OF_VAULT_STATE) {
      for (const source of entry.sources) {
        if (!existsSync(join(REPO_ROOT, source))) missing.push(`${entry.id} -> ${source}`);
      }
    }
    expect(missing.join("\n")).toBe("");
  });

  test("every source the sweep cannot see is declared as such, with its reason", () => {
    // The census guarantees nothing about a path whose root arrives from a
    // config key, an env override or the working directory. Which sources
    // those are is enumerated rather than left to the reader to discover by
    // adding a location and watching nothing happen.
    const population = new Set(sweepOutOfVaultPathBuilders());
    const undeclared: string[] = [];
    for (const entry of OUT_OF_VAULT_STATE) {
      for (const source of entry.sources) {
        if (source.endsWith("/")) continue;
        if (population.has(source)) continue;
        if (!SOURCES_INVISIBLE_TO_THE_SWEEP.has(source))
          undeclared.push(`${entry.id} -> ${source}`);
      }
    }
    expect(undeclared.join("\n")).toBe("");
  });

  test("no invisibility claim outlives the sweep that could not see it", () => {
    const population = new Set(sweepOutOfVaultPathBuilders());
    const nowVisible = [...SOURCES_INVISIBLE_TO_THE_SWEEP.keys()].filter((f) => population.has(f));
    expect(nowVisible.toSorted().join("\n")).toBe("");
    for (const [file, reason] of SOURCES_INVISIBLE_TO_THE_SWEEP) {
      expect(`${file}: ${reason.trim().length >= MIN_EXCLUSION_REASON_LENGTH}`).toBe(
        `${file}: true`,
      );
    }
  });
});

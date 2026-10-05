/**
 * Path-scoped vector backfill (Honest Embedding Spend, task 10).
 *
 * Paying for vectors was all-or-nothing across the vault: an operator who
 * wanted only the belief notes embedded (the vectors the `semantic`
 * context-pack mode reads) had to price and pay for every chunk. The
 * backfill now takes repeatable path prefixes, validated by the search
 * layer's `assertSafePathPrefix`, and threads them through the one spend
 * plan, so the dry run, the cost gate's refusal, the embedding phase and
 * the spend receipt all read the same scoped census. The CLI takes the
 * scope as a repeatable `--path`, echoes it, and names a scoped `--apply`
 * as the next step, never the vault-wide one.
 *
 * The only embedding endpoint is the loopback fake the search fixtures
 * ship. Deliberately not covered here: the unscoped census and apply
 * mechanics (search-vector-backfill.test.ts) and the price wording
 * (search-vector-backfill-price.test.ts).
 */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";

import { indexVault } from "../../src/core/search/indexer.ts";
import { SearchError } from "../../src/core/search/search-error.ts";
import { Store } from "../../src/core/search/store.ts";
import { planVectorBackfill } from "../../src/core/search/vector-backfill.ts";
import {
  backfillNextStep,
  emitBackfillNextStep,
  RERUN_WITH_SCOPE_LINE,
  scopedNextCommand,
} from "../../src/cli/search/verbs/vector-backfill.ts";
import { FAKE_PROVIDER_KEY } from "../helpers/fake-credentials.ts";
import { startFakeHttp, type FakeHttp } from "../helpers/fake-http.ts";
import { runCli } from "../helpers/run-cli.ts";
import { createTempVault, makeConfig, writeMd } from "../helpers/search-fixtures.ts";
import { sqliteVecLoadable } from "../helpers/sqlite-vec.ts";

const VEC_LOADABLE = sqliteVecLoadable();
const BELIEFS = "Brain/preferences/";
const MODEL = "c10-model";
/** Priced so that one note's chunks fit under the gate and four notes' do not. */
const USD_PER_MTOK = 1_000;

let vault: string;
let dbPath: string;
let cleanup: () => void;
let server: FakeHttp;

beforeEach(async () => {
  const v = createTempVault("c10-vector-backfill-path");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
  server = await startFakeHttp();
});

afterEach(async () => {
  await server.close();
  cleanup();
});

function semanticConfig(costGateUsd = 0): ReturnType<typeof makeConfig> {
  return makeConfig({
    vault,
    dbPath,
    semantic: {
      enabled: true,
      provider: "openai-compat",
      baseUrl: server.url,
      model: MODEL,
      apiKey: FAKE_PROVIDER_KEY,
      dimension: 4,
      timeoutMs: 5_000,
      costGateUsd,
      priceOverride: { model: MODEL, usdPerMtok: USD_PER_MTOK },
    },
  });
}

/** One belief note and three other notes, indexed with no vectors. */
async function seed(): Promise<void> {
  writeMd(vault, `${BELIEFS}pref-brevity.md`, "# Brevity\n\nKeep answers short.");
  writeMd(vault, "Notes/a.md", "# A\n\nFirst note about something that matters.");
  writeMd(vault, "Notes/b.md", "# B\n\nSecond note discussing other things at length.");
  writeMd(vault, "Notes/c.md", "# C\n\nThird note with yet more words in it.");
  await indexVault(semanticConfig());
}

test.skipIf(!VEC_LOADABLE)(
  "the scoped dry run prices only the chunks under the prefix",
  async () => {
    await seed();
    const all = await planVectorBackfill(semanticConfig());
    const scoped = await planVectorBackfill(semanticConfig(), { pathPrefixes: [BELIEFS] });

    expect(scoped.pathPrefixes).toEqual([BELIEFS]);
    expect(all.pathPrefixes).toEqual([]);
    expect(scoped.pending).toBeGreaterThan(0);
    expect(scoped.pending).toBeLessThan(all.pending);
    expect(scoped.estimatedCostUsd!).toBeLessThan(all.estimatedCostUsd!);
    expect(scoped.chunksTotal).toBe(all.chunksTotal);
  },
);

test.skipIf(!VEC_LOADABLE)(
  "--apply embeds only the scoped chunks and its receipt agrees with the dry run",
  async () => {
    await seed();
    const dry = await planVectorBackfill(semanticConfig(), { pathPrefixes: [BELIEFS] });
    // The applied run embeds from the plan it priced: one census read,
    // not a second one the receipt could disagree with.
    const census = spyOn(Store.prototype, "findChunksWithoutEmbeddings");
    let applied: Awaited<ReturnType<typeof planVectorBackfill>>;
    try {
      applied = await planVectorBackfill(semanticConfig(), {
        pathPrefixes: [BELIEFS],
        apply: true,
      });
      expect(census).toHaveBeenCalledTimes(1);
    } finally {
      census.mockRestore();
    }

    expect(applied.embedded).toBe(dry.pending);
    expect(applied.spend).not.toBeNull();
    expect(applied.spend!.estimatedUsd).toBe(dry.estimatedCostUsd);
    expect(applied.spend!.priceSource).toBe(dry.priceSource);

    const rest = await planVectorBackfill(semanticConfig());
    const afterScoped = await planVectorBackfill(semanticConfig(), { pathPrefixes: [BELIEFS] });
    expect(afterScoped.pending).toBe(0);
    expect(rest.pending).toBeGreaterThan(0);
  },
);

test.skipIf(!VEC_LOADABLE)("the cost gate reads the scoped census", async () => {
  await seed();
  const scopedDry = await planVectorBackfill(semanticConfig(), { pathPrefixes: [BELIEFS] });
  const allDry = await planVectorBackfill(semanticConfig());
  // A gate between the two estimates: the scoped spend fits, the vault-wide one does not.
  const gate = (scopedDry.estimatedCostUsd! + allDry.estimatedCostUsd!) / 2;

  const refusal = await planVectorBackfill(semanticConfig(gate), { apply: true }).catch(
    (e: unknown) => e,
  );
  expect(refusal).toBeInstanceOf(SearchError);
  expect((refusal as SearchError).code).toBe("EMBEDDING_COST_GATE");

  const scopedPlan = await planVectorBackfill(semanticConfig(gate), { pathPrefixes: [BELIEFS] });
  expect(scopedPlan.blocked).toBe(false);
  const scopedApply = await planVectorBackfill(semanticConfig(gate), {
    pathPrefixes: [BELIEFS],
    apply: true,
  });
  expect(scopedApply.embedded).toBe(scopedDry.pending);
});

test.skipIf(!VEC_LOADABLE)("an unpriced refusal counts the scoped census", async () => {
  await seed();
  const unpriced = makeConfig({
    vault,
    dbPath,
    semantic: { ...semanticConfig(1).semantic, priceOverride: undefined },
  });
  const scopedDry = await planVectorBackfill(unpriced, { pathPrefixes: [BELIEFS] });
  expect(scopedDry.blocked).toBe(true);

  const refusal = await planVectorBackfill(unpriced, {
    pathPrefixes: [BELIEFS],
    apply: true,
  }).catch((e: unknown) => e);
  expect(refusal).toBeInstanceOf(SearchError);
  expect((refusal as SearchError).code).toBe("EMBEDDING_COST_UNPRICED");
  expect((refusal as SearchError).message).toContain(`${scopedDry.pending} chunk(s)`);
});

test.each(["../outside/", "Brain/../Notes/", "/etc/", "//server/share/", "C:/Users/"])(
  "an unsafe prefix is refused by name (%p)",
  async (prefix) => {
    const refusal = await planVectorBackfill(semanticConfig(), { pathPrefixes: [prefix] }).catch(
      (e: unknown) => e,
    );
    expect(refusal).toBeInstanceOf(SearchError);
    expect((refusal as SearchError).code).toBe("INVALID_INPUT");
    expect((refusal as SearchError).message).toContain(prefix);
  },
);

/** A CLI config file for the fake provider. */
async function cliConfig(): Promise<string> {
  const config = join(vault, "cli-config.yaml");
  await Bun.write(
    config,
    [
      `vault: "${vault}"`,
      "search_semantic_enabled: true",
      "embedding_provider: openai-compat",
      `embedding_base_url: "${server.url}"`,
      `embedding_model: ${MODEL}`,
      "embedding_api_key: test-key",
      "embedding_dimension: 4",
      "",
    ].join("\n"),
  );
  return config;
}

async function backfillCli(config: string, extra: ReadonlyArray<string>) {
  return await runCli(
    ["search", "vector-backfill", "--vault", vault, "--db", dbPath, "--config", config, ...extra],
    { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
  );
}

test.skipIf(!VEC_LOADABLE)(
  "--path is repeatable, echoed, and the next step keeps the scope",
  async () => {
    await seed();
    writeMd(vault, "Brain/retired/pref-old.md", "# Old\n\nAnswer at length.");
    await indexVault(semanticConfig());
    const config = await cliConfig();
    const scoped = await planVectorBackfill(semanticConfig(), {
      pathPrefixes: [BELIEFS, "Brain/retired/"],
    });

    const json = await backfillCli(config, [
      "--path",
      BELIEFS,
      "--path",
      "Brain/retired/",
      "--json",
    ]);
    expect(json.returncode).toBe(0);
    const payload = JSON.parse(json.stdout) as Record<string, unknown>;
    expect(payload["path_prefixes"]).toEqual([BELIEFS, "Brain/retired/"]);
    expect(payload["pending"]).toBe(scoped.pending);
    expect(payload["next_command"]).toBe(
      "o2b search vector-backfill --apply --path Brain/preferences/ --path Brain/retired/",
    );

    const human = await backfillCli(config, ["--path", BELIEFS]);
    expect(human.returncode).toBe(0);
    expect(human.stdout).toContain(`scope: ${BELIEFS}`);
    expect(human.stdout).toContain(
      "next: o2b search vector-backfill --apply --path Brain/preferences/",
    );
  },
);

test.skipIf(!VEC_LOADABLE)("an unscoped run keeps its report and next step", async () => {
  await seed();
  const config = await cliConfig();
  const json = await backfillCli(config, ["--json"]);
  const payload = JSON.parse(json.stdout) as Record<string, unknown>;
  expect("path_prefixes" in payload).toBe(false);
  expect(payload["next_command"]).toBe("o2b search vector-backfill --apply");
});

test.skipIf(!VEC_LOADABLE)("--apply --path embeds only the scoped chunks", async () => {
  await seed();
  const config = await cliConfig();
  const dry = await planVectorBackfill(semanticConfig(), { pathPrefixes: [BELIEFS] });
  const applied = await backfillCli(config, ["--path", BELIEFS, "--apply", "--json"]);
  expect(applied.returncode).toBe(0);
  const payload = JSON.parse(applied.stdout) as Record<string, unknown>;
  expect(payload["embedded"]).toBe(dry.pending);
  const rest = await planVectorBackfill(semanticConfig());
  expect(rest.pending).toBeGreaterThan(0);
});

test.skipIf(!VEC_LOADABLE).each([
  ["", []],
  ["", ["--apply"]],
  ["   ", ["--apply"]],
  ["./", ["--apply"]],
] as const)(
  "an empty --path %p exits INVALID_INPUT and embeds nothing (%p)",
  async (prefix, extra) => {
    await seed();
    const config = await cliConfig();
    const before = await planVectorBackfill(semanticConfig());
    const run = await backfillCli(config, ["--path", prefix, ...extra]);
    expect(run.returncode).toBe(2);
    expect(run.stderr).toContain("[INVALID_INPUT]");
    expect(run.stderr).toContain("path prefix is empty");
    expect(run.stderr).toContain(JSON.stringify(prefix));
    const after = await planVectorBackfill(semanticConfig());
    expect(after.pending).toBe(before.pending);
  },
);

test.skipIf(!VEC_LOADABLE).each(["./Brain/preferences/", "Brain\\preferences\\"])(
  "a %p prefix matches the same notes as its plain form",
  async (prefix) => {
    await seed();
    const plain = await planVectorBackfill(semanticConfig(), { pathPrefixes: [BELIEFS] });
    const spelled = await planVectorBackfill(semanticConfig(), { pathPrefixes: [prefix] });
    expect(spelled.pending).toBe(plain.pending);
    expect(spelled.pathPrefixes).toEqual([BELIEFS]);
  },
);

test.skipIf(!VEC_LOADABLE)(
  "a scope that matches no document is named, not reported as done",
  async () => {
    await seed();
    const config = await cliConfig();
    const run = await backfillCli(config, ["--path", "Brain/prefs/", "--path", BELIEFS, "--json"]);
    expect(run.returncode).toBe(0);
    expect(run.stderr).toContain("scope Brain/prefs/ matches no indexed document");
    expect(run.stderr).not.toContain(`scope ${BELIEFS} matches`);
    const payload = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(payload["unmatched_path_prefixes"]).toEqual(["Brain/prefs/"]);

    const human = await backfillCli(config, ["--path", "Brain/prefs/"]);
    expect(human.stderr).toContain("scope Brain/prefs/ matches no indexed document");
  },
);

test.skipIf(!VEC_LOADABLE)(
  "a fully embedded scope that matches documents warns nothing",
  async () => {
    await seed();
    await planVectorBackfill(semanticConfig(), { pathPrefixes: [BELIEFS], apply: true });
    const config = await cliConfig();
    const run = await backfillCli(config, ["--path", BELIEFS, "--json"]);
    expect(run.returncode).toBe(0);
    expect(run.stderr).not.toContain("matches no indexed document");
    const payload = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(payload["pending"]).toBe(0);
    expect("unmatched_path_prefixes" in payload).toBe(false);
  },
);

/**
 * A prefix that needs quoting is quoted POSIX-style; on Windows, where
 * that quoting would not run as printed, the key is omitted instead.
 */
function expectQuotedNextStep(payload: Record<string, unknown>, posix: string): void {
  // Pending work is what makes an absent key mean "dropped", not "nothing to advise".
  expect(payload["pending"]).toBeGreaterThan(0);
  if (process.platform === "win32") expect("next_command" in payload).toBe(false);
  else expect(payload["next_command"]).toBe(posix);
}

test.skipIf(!VEC_LOADABLE)("a scoped next step quotes a prefix with a quote", async () => {
  await seed();
  writeMd(vault, "Notes/it's/d.md", "# D\n\nA note in a folder whose name has a quote.");
  await indexVault(semanticConfig());
  const config = await cliConfig();
  const json = await backfillCli(config, ["--path", "Notes/it's/", "--json"]);
  expect(json.returncode).toBe(0);
  const payload = JSON.parse(json.stdout) as Record<string, unknown>;
  expectQuotedNextStep(payload, "o2b search vector-backfill --apply --path 'Notes/it'\\''s/'");
});

test.skipIf(!VEC_LOADABLE)("a scoped next step quotes a prefix with a space", async () => {
  await seed();
  writeMd(vault, "Notes/with space/d.md", "# D\n\nA note in a folder whose name has a space.");
  await indexVault(semanticConfig());
  const config = await cliConfig();
  const json = await backfillCli(config, ["--path", "Notes/with space/", "--json"]);
  expect(json.returncode).toBe(0);
  const payload = JSON.parse(json.stdout) as Record<string, unknown>;
  expectQuotedNextStep(payload, "o2b search vector-backfill --apply --path 'Notes/with space/'");

  // The human advice: the quoted scope off Windows, the rerun line that
  // names no runnable command on it.
  const human = await backfillCli(config, ["--path", "Notes/with space/"]);
  const advice = human.stdout + human.stderr;
  if (process.platform === "win32") {
    expect(advice).toContain(RERUN_WITH_SCOPE_LINE);
    expect(advice).not.toContain("'Notes/with space/'");
  } else {
    expect(advice).toContain("--path 'Notes/with space/'");
    expect(advice).not.toContain(RERUN_WITH_SCOPE_LINE);
  }
});

const APPLY_COMMAND = "o2b search vector-backfill --apply";

test("a scope Windows cannot quote drops the scoped next step", () => {
  // POSIX quoting is not a word cmd.exe or PowerShell reads back, so the
  // advice names no command and asks for a rerun with the same flags.
  expect(scopedNextCommand(APPLY_COMMAND, ["Notes/with space/"], "win32")).toBeNull();
  expect(scopedNextCommand(APPLY_COMMAND, [BELIEFS, "Notes/it's/"], "win32")).toBeNull();
});

test("a plain scope stays in the next step on every platform", () => {
  for (const platform of ["win32", "linux", "darwin"] as const) {
    expect(scopedNextCommand(APPLY_COMMAND, [BELIEFS], platform)).toBe(
      `${APPLY_COMMAND} --path ${BELIEFS}`,
    );
  }
  expect(scopedNextCommand(APPLY_COMMAND, ["Notes/with space/"], "linux")).toBe(
    `${APPLY_COMMAND} --path 'Notes/with space/'`,
  );
});

test.skipIf(!VEC_LOADABLE)(
  "a gate-blocked scope Windows cannot quote advises no runnable command",
  async () => {
    await seed();
    writeMd(vault, "a b/d.md", "# D\n\nA note in a folder whose name has a space.");
    await indexVault(semanticConfig());
    // Priced far above a one-cent gate, so the unforced run is blocked.
    const result = await planVectorBackfill(semanticConfig(0.000_001), { pathPrefixes: ["a b/"] });
    expect(result.blocked).toBe(true);
    expect(result.pending).toBeGreaterThan(0);

    const advice = backfillNextStep(result, "win32");
    expect(advice.command).toBeUndefined();
    const written: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      emitBackfillNextStep(advice, {
        command: "search",
        argv: ["vector-backfill"],
        jsonRequested: false,
      });
    } finally {
      spy.mockRestore();
    }
    const lines = written.join("").split("\n");
    expect(lines).toContain(RERUN_WITH_SCOPE_LINE);
    expect(lines.some((line) => /^next: .*--apply( --force-cost)?$/u.test(line))).toBe(false);
    expect(lines.some((line) => line.includes("--force-cost"))).toBe(false);
  },
);

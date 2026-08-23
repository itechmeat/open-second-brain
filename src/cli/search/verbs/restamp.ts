/**
 * `o2b search restamp` — record this build's sqlite-vec version as the
 * one the stored vectors are accepted under (nothing-writes-silently,
 * unit G).
 *
 * `embedding_vec_version` is an ABI marker, not a property of any
 * vector: it says which sqlite-vec build wrote the storage, and two
 * peers on different builds each read the other's index as drifted.
 * That is precisely why `integrity.embedding_abi` defaults to `warn`
 * rather than refusing - a hard gate would loop a synced vault through
 * rebuilds - and until this verb existed the only way to clear the
 * warning was `o2b search reindex --embeddings`, which pays provider
 * prices to re-derive vectors that were never the problem.
 *
 * What this verb claims, exactly: that the operator accepts the stored
 * vectors under the extension this build loads. It does not verify
 * them. Nothing can - a vector's bytes do not carry the version that
 * wrote them - and a verb that implied otherwise would be the kind of
 * unearned reassurance this wave removes.
 *
 * Three properties are deliberate:
 *
 *   - Dry run is the DEFAULT, as on every other repair verb in this
 *     family. `--apply` is the only path that writes a cell.
 *   - It refuses BY NAME when the recorded model or dimension disagrees
 *     with this build. Those two describe the vectors themselves;
 *     writing a new token over them would record an identity nobody
 *     checked. Repairing that needs re-embedding under a verified
 *     identity, which is deferred by design - the recon that scoped
 *     this wave put it behind the same explicit cost gate
 *     `planVectorBackfill` uses, and it is not built.
 *   - It contacts no provider on any path. The only outside thing it
 *     touches is the sqlite-vec extension, loaded into an in-memory
 *     database to ask its version.
 *
 * The write does NOT go through `Store.open(…, { mode: "write" })`.
 * That path runs `ensureEmbeddingModel`, which CLEARS every stored
 * vector when the model or dimension changed - exactly the destructive
 * repair this verb refuses to perform. It takes the writer lock and
 * writes the one cell instead, the same way `search check --integrity`
 * records its verdict.
 */

import { Database } from "bun:sqlite";

import { compareStamps, formatStampMismatch } from "../../../core/integrity/stamp.ts";
import {
  acquireWriterLock,
  contradictedAbiFields,
  EMBEDDING_ABI_FIX_COMMAND,
  EMBEDDING_VEC_VERSION_STATE_KEY,
  peekEmbeddingAbiSync,
  runtimeEmbeddingAbi,
} from "../../../core/search/store.ts";
import { setState } from "../../../core/search/store/state.ts";
import { loadVecExtension } from "../../../core/search/store/vectors.ts";
import { SearchError } from "../../../core/search/types.ts";
import { info, ok } from "../../output.ts";
import { flagBoolean, parseFlags, resolveConfig, VAULT_FLAGS } from "../helpers.ts";

/** What one restamp run concluded, before it is rendered. */
interface RestampResult {
  /** The token the index records, or null when it never recorded one. */
  readonly recorded: string | null;
  /** The version this build's extension reports. */
  readonly runtime: string;
  /** Whether the two differ at all. */
  readonly changed: boolean;
  /** Whether this run wrote the cell. False on every dry run. */
  readonly applied: boolean;
}

/**
 * The sqlite-vec version this build reports, from an in-memory database
 * so the real index is not opened to answer a question about the
 * extension.
 */
function runtimeVecVersion(): string {
  const probe = new Database(":memory:");
  try {
    const version = loadVecExtension(probe);
    if (version === null) {
      throw new SearchError(
        "VEC_EXTENSION_UNAVAILABLE",
        "sqlite-vec did not load in this build, so there is no version to record. " +
          "Run `o2b search check` for the extension's own diagnosis",
      );
    }
    return version;
  } finally {
    probe.close();
  }
}

/**
 * Refuse, naming every field, when the record disagrees with this build
 * about something a restamp cannot fix. Only fields the index actually
 * RECORDED count - an unrecorded token is a store written before that
 * token existed, which `contradictedAbiFields` already declines to
 * treat as wrong.
 */
function refuseUnrepairableDrift(
  recorded: Record<string, string | null>,
  runtime: Record<string, string | null>,
): void {
  const blocking = contradictedAbiFields(compareStamps(recorded, runtime)).filter(
    (m) => m.field !== EMBEDDING_VEC_VERSION_STATE_KEY,
  );
  if (blocking.length === 0) return;
  throw new SearchError(
    "EMBEDDING_DIMENSION_MISMATCH",
    `restamp refuses: ${blocking.map(formatStampMismatch).join("; ")}. Those fields describe ` +
      `the stored vectors, so recording a new token over them would claim an identity nothing ` +
      `verified. The repair is re-embedding under a verified identity, which is deferred by ` +
      `design and not built; today's honest fix is a rebuild. Run: ${EMBEDDING_ABI_FIX_COMMAND}`,
  );
}

/** Write the one cell, under the writer lock, and nothing else. */
async function applyRestamp(dbPath: string, version: string): Promise<void> {
  const release = await acquireWriterLock(dbPath);
  try {
    const db = new Database(dbPath);
    try {
      setState(db, EMBEDDING_VEC_VERSION_STATE_KEY, version);
    } finally {
      db.close();
    }
  } finally {
    await release();
  }
}

function jsonForResult(r: RestampResult): Record<string, unknown> {
  return {
    dry_run: !r.applied,
    field: EMBEDDING_VEC_VERSION_STATE_KEY,
    recorded: r.recorded,
    runtime: r.runtime,
    changed: r.changed,
    applied: r.applied,
  };
}

function renderHuman(r: RestampResult): void {
  if (!r.changed) {
    ok(`restamp: ${EMBEDDING_VEC_VERSION_STATE_KEY} already records ${r.runtime}; nothing to do`);
    return;
  }
  const change = `${EMBEDDING_VEC_VERSION_STATE_KEY} ${r.recorded ?? "unrecorded"} -> ${r.runtime}`;
  if (r.applied) {
    ok(`restamp: ${change} recorded`);
    return;
  }
  ok(`restamp dry-run: ${change}`);
  info("  nothing was written; pass --apply to record it");
}

export async function cmdSearchRestamp(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    ...VAULT_FLAGS,
    apply: { type: "boolean" },
    json: { type: "boolean" },
  });
  const cfg = resolveConfig(flags);
  if (!cfg.semantic.enabled) {
    throw new SearchError(
      "EMBEDDING_DISABLED",
      "semantic search is disabled in this configuration, so there is no embedder identity to restamp",
    );
  }

  const peek = peekEmbeddingAbiSync(cfg.dbPath);
  if (peek.kind !== "read") {
    // An index that is not there and one that will not open are
    // different faults and are named as the different faults they are.
    throw new SearchError(
      peek.kind === "absent" ? "INDEX_MISSING" : "INDEX_UNREADABLE",
      peek.kind === "absent"
        ? `no search index at ${cfg.dbPath}; there is nothing to restamp`
        : `the search index at ${cfg.dbPath} did not open: ${peek.detail}`,
    );
  }

  const runtime = runtimeVecVersion();
  refuseUnrepairableDrift(peek.value, runtimeEmbeddingAbi(cfg, runtime));

  const recorded = peek.value[EMBEDDING_VEC_VERSION_STATE_KEY] ?? null;
  const changed = recorded !== runtime;
  const apply = flagBoolean(flags, "apply");
  if (changed && apply) await applyRestamp(cfg.dbPath, runtime);

  const result: RestampResult = { recorded, runtime, changed, applied: changed && apply };
  if (flagBoolean(flags, "json")) {
    process.stdout.write(JSON.stringify(jsonForResult(result)) + "\n");
  } else {
    renderHuman(result);
  }
  return 0;
}

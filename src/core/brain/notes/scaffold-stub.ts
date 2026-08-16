/**
 * Materialise a note for an unresolved wikilink target (B3).
 *
 * Three places already KNOW a link target does not exist, and every one
 * of them stops at knowing. `link-graph/repair-lane.ts:236-239` decides
 * `skip-missing-target`. `deep-synthesis.ts:706` emits the advice "write
 * the missing note or fix the dangling link". `doctor/link-checks.ts`
 * emits `broken-backlinks` with a structured `target` and its `sources`.
 * Nothing materialises anything, so each of the three is a report an
 * operator has to act on by hand - in a project whose whole argument is
 * that a mechanism which must be invoked by hand will be missed.
 *
 * Nothing here is new machinery either. The bytes come from
 * {@link renderStub}, which the graph importer has used since it shipped.
 * The write is `createNote`, so the nine-step path envelope and the
 * `if_exists` disposition apply unchanged. The proof that a target is
 * really missing is `note-title-resolver.ts`, which is fail-closed and
 * lists candidates rather than guessing.
 *
 * ## The stub contains nothing invented
 *
 * Its title is the target the link spelled. Its body is a list of the
 * documents that referenced it, as wikilinks, which is the one fact the
 * index actually holds about a target that does not exist. There is no
 * prose, in any language, pretending to be the user's - a scaffolded note
 * that opened with a sentence nobody wrote would be worse than the
 * dangling link it replaced.
 *
 * ## Why the scan refuses instead of returning nothing
 *
 * `resolveLinkTargets` runs as a global post-pass but `replaceDocAliases`
 * runs only for the documents a run actually read, so a dangling count
 * taken after an incremental pass differs from one taken after a forced
 * full pass. An empty list from a partially-resolved index reads as "this
 * vault has no broken links", which is a clean bill of health for a vault
 * nobody finished measuring. `link-ratchet.ts:211-233` already models the
 * refusal - `unmeasurable("partial-resolution")`, verified from the
 * index's own state keys rather than documented - and this follows it.
 * An unmeasurable index is a distinct outcome from a clean one, and there
 * is no fallback that reports zero.
 */

import { statSync } from "node:fs";
import { dirname, join, posix } from "node:path";

import { ensureInsideVault } from "../../path-safety.ts";
import { REDACTION_PLACEHOLDER } from "../../redactor.ts";
import { requireNextStep } from "../next-step.ts";
import { SEARCH_INDEX_MISSING_CODE } from "../diagnostics.ts";
import { renderStub } from "../portability/graph.ts";
import type { DanglingLinkTarget } from "../../search/store/links.ts";
import { createNote, type CreateNoteIfExists, type CreateNoteOutcome } from "./create-note.ts";
import {
  NoteTitleResolutionError,
  resolveNoteTarget as resolveNoteTitle,
} from "./note-title-resolver.ts";

// ----- Why a dangling scan could not answer ---------------------------------

/**
 * The state of one dangling-target scan. Three of the four members are
 * refusals, and that is the point: each names a different reason the
 * index could not be believed, and none of them is spelled as an empty
 * result.
 */
export const DANGLING_SCAN = Object.freeze({
  /** The index recorded a forced full pass as its last run; the list is real. */
  measured: "measured",
  /** No index database at the configured path. */
  indexMissing: "index_missing",
  /** An index exists and could not be opened or queried. */
  indexUnreadable: "index_unreadable",
  /** The last index run was not a forced full pass, so a count is not reproducible. */
  partialResolution: "partial_resolution",
} as const);

/** Closed union over {@link DANGLING_SCAN}. */
export type DanglingScan = (typeof DANGLING_SCAN)[keyof typeof DANGLING_SCAN];

/** Membership list, measurable first. */
export const DANGLING_SCANS: ReadonlyArray<DanglingScan> = Object.freeze(
  Object.values(DANGLING_SCAN),
);

/**
 * `unknown` rather than `string`: the value crosses the MCP and CLI JSON
 * boundaries, and the vocabulary census probes every guard with `null`,
 * `42` and `{}`.
 */
export function isDanglingScan(value: unknown): value is DanglingScan {
  return typeof value === "string" && (DANGLING_SCANS as ReadonlyArray<string>).includes(value);
}

/** What one scan found, or why it declined to say. */
export interface DanglingScanResult {
  readonly state: DanglingScan;
  /**
   * The unresolved targets. Empty unless the state is `measured` - and an
   * empty list under any other state means "not measured", never "none".
   */
  readonly targets: ReadonlyArray<DanglingLinkTarget>;
  /** Why the scan could not measure; `null` when it did. */
  readonly detail: string | null;
  /** The registered command that makes a measurement possible. */
  readonly nextCommand: string;
}

/**
 * The command that produces an index a dangling scan can believe.
 * Resolved from the diagnostics registry rather than written here, so a
 * registry rename fails at import instead of inside the refusal it was
 * meant to explain.
 */
const REINDEX_COMMAND = requireNextStep(SEARCH_INDEX_MISSING_CODE).nextCommand;

/** Default cap on targets returned by one scan. */
export const DANGLING_SCAN_DEFAULT_LIMIT = 100;

/**
 * The `limit` handed to `Store.listDangling` so it groups every
 * unresolved row rather than the first page of them.
 *
 * `listDangling` takes a required cap; there is no "all" spelling. The
 * caller's own limit cannot be that cap, because it has to be applied
 * after the ownership filter - see the call site.
 */
const UNBOUNDED_TARGETS = Number.MAX_SAFE_INTEGER;

function refusal(state: DanglingScan, detail: string): DanglingScanResult {
  return Object.freeze({
    state,
    targets: Object.freeze([]),
    detail,
    nextCommand: REINDEX_COMMAND,
  });
}

export interface ListDanglingOptions {
  /** Maximum targets returned. Defaults to {@link DANGLING_SCAN_DEFAULT_LIMIT}. */
  readonly limit?: number;
  /**
   * Owner scope the listing is filtered against
   * (a-label-is-not-a-boundary, U3). Absent / `null` filters nothing,
   * which is what both existing callers get.
   *
   * The predicate cannot be SQL - `documents` has no owner column
   * (`src/core/search/schema.ts:103-113`) - so it lands here, one layer
   * above `listDangling`, where the vault root is in hand and
   * `isPathOwnerVisible` can be asked. A target whose sources are ALL
   * filtered away is dropped WHOLE: the surviving `target` string is the
   * link spelling a hidden note wrote, so publishing it would name a
   * private page's title and confirm the existence of the note that
   * pointed at it.
   */
  readonly ownerScope?: string | null;
}

/**
 * List the vault's unresolved wikilink targets from the search index,
 * refusing rather than reporting zero when the index cannot be believed.
 *
 * The search modules are reached through a deferred import for the same
 * reason `notes/lifecycle.ts` defers them: the search barrel imports back
 * into the Brain tree, and a static edge from a Brain note writer into it
 * is the shape the acyclic-import ratchet exists to keep out.
 */
export async function listDanglingTargets(
  vault: string,
  opts: ListDanglingOptions = {},
): Promise<DanglingScanResult> {
  const limit = Math.max(0, Math.floor(opts.limit ?? DANGLING_SCAN_DEFAULT_LIMIT));
  const { existsSync } = await import("node:fs");
  const { resolveSearchConfig } = await import("../../search/index.ts");
  const { LAST_FULL_INDEX_AT_STATE_KEY, LAST_INDEXED_AT_STATE_KEY, Store } =
    await import("../../search/store.ts");

  let config;
  try {
    config = resolveSearchConfig({ vault });
  } catch (err) {
    return refusal(DANGLING_SCAN.indexUnreadable, hostPathFree(err, vault, null));
  }
  if (!existsSync(config.dbPath)) {
    // The path is deliberately absent: `admin-tools.ts:137` says the same
    // thing the same way, and the caller already knows which vault it
    // asked about. `nextCommand` carries the remedy.
    return refusal(DANGLING_SCAN.indexMissing, "the vault has no search index yet");
  }

  let store;
  try {
    store = await Store.open(config, { mode: "read" });
  } catch (err) {
    return refusal(DANGLING_SCAN.indexUnreadable, hostPathFree(err, vault, config.dbPath));
  }
  try {
    const full = store.getState(LAST_FULL_INDEX_AT_STATE_KEY);
    const last = store.getState(LAST_INDEXED_AT_STATE_KEY);
    if (full === null || last === null || full !== last) {
      return refusal(
        DANGLING_SCAN.partialResolution,
        `last full index ${full ?? "(never)"} is not the last index run ${last ?? "(never)"}; ` +
          "a dangling list is only reproducible after a forced full pass",
      );
    }
    // The limit caps what the CALLER receives, so it is applied AFTER
    // the ownership filter, never before it. Asking the store for
    // `limit` targets and then hiding some of them silently returns
    // fewer rows than the caller asked for and than the vault holds -
    // and the shortfall is proportional to how much the other owner
    // wrote, which is the existence leak read off a row count. Ordering
    // it this way costs nothing: `listDangling` reads every unresolved
    // row out of sqlite regardless and applies `limit` while grouping.
    const scope = opts.ownerScope ?? null;
    const visible = await visibleTargets(vault, store.listDangling(UNBOUNDED_TARGETS), scope);
    return Object.freeze({
      state: DANGLING_SCAN.measured,
      targets: Object.freeze(visible.slice(0, limit)),
      detail: null,
      nextCommand: REINDEX_COMMAND,
    });
  } catch (err) {
    return refusal(DANGLING_SCAN.indexUnreadable, hostPathFree(err, vault, config.dbPath));
  } finally {
    await store.close();
  }
}

/**
 * Drop the sources the scope may not see, and drop the WHOLE target when
 * none of them survives.
 *
 * Filtering `sources` alone would not close this: `target` is the link
 * text a hidden note wrote, so a target reachable only from hidden
 * sources publishes that note's private outbound link - and, when the
 * link was written by title, the private page's title with it. A target
 * that still has a visible source stays, because that source's own text
 * already names it to this caller.
 *
 * The owner-scope view is reached through a DEFERRED import for the same
 * reason the store is: it imports the search-side frontmatter cache, and
 * a static edge from a Brain note writer into the search tree is the
 * shape the acyclic-import ratchet exists to keep out.
 */
async function visibleTargets(
  vault: string,
  targets: ReadonlyArray<DanglingLinkTarget>,
  scope: string | null,
): Promise<ReadonlyArray<DanglingLinkTarget>> {
  if (scope === null) return targets;
  const { ownerScopeView } = await import("../owner-scope-view.ts");
  const view = ownerScopeView(vault, scope);
  const kept: DanglingLinkTarget[] = [];
  for (const target of targets) {
    const sources = target.sources.filter((source) => view.visible(source));
    if (sources.length === 0) continue;
    kept.push(
      sources.length === target.sources.length
        ? target
        : Object.freeze({ target: target.target, sources: Object.freeze(sources) }),
    );
  }
  return Object.freeze(kept);
}

/**
 * `err`'s own message with this install's absolute host paths removed.
 *
 * The `detail` this returns crosses the MCP boundary and lands in model
 * context - the contract `src/mcp/tools.ts:94-118` states, and the reason
 * `vaultStoreReference` renders `vault://<hex>` instead of a vault path
 * unless `expose_host_paths` is set. A sqlite error embeds the database
 * file it failed on, so passing the raw message through told any agent
 * that called this on an unindexed or locked vault where the operator's
 * home directory is.
 *
 * Substitution rather than suppression: WHICH file the store failed on is
 * not information the caller needs (there is one), but WHAT the
 * filesystem said about it is the whole of the diagnosis. Longest first,
 * so the database path is replaced before the directory that contains it
 * can consume its prefix.
 */
function hostPathFree(err: unknown, vault: string, dbPath: string | null): string {
  const raw = err instanceof Error ? err.message : String(err);
  const hostPaths = (dbPath === null ? [vault] : [dbPath, dirname(dbPath), vault])
    .filter((candidate) => candidate.length > 0)
    .toSorted((a, b) => b.length - a.length);
  let out = raw;
  for (const hostPath of hostPaths) out = out.split(hostPath).join(REDACTION_PLACEHOLDER);
  return out;
}

// ----- Materialising one target ---------------------------------------------

/** Machine-readable reason a {@link scaffoldStub} call was refused. */
export type ScaffoldStubErrorCode =
  /** The target was empty after unwrapping its brackets. */
  | "empty_target"
  /** The target already resolves to a note, so nothing is missing. */
  | "target_resolves"
  /** The target names more than one existing note. */
  | "target_ambiguous"
  /** A declared source is not an existing Markdown file inside the vault. */
  | "unknown_source";

export class ScaffoldStubError extends Error {
  readonly code: ScaffoldStubErrorCode;
  /** Vault-relative candidate paths, populated only for `target_ambiguous`. */
  readonly candidates: ReadonlyArray<string>;
  constructor(
    code: ScaffoldStubErrorCode,
    message: string,
    candidates: ReadonlyArray<string> = [],
  ) {
    super(message);
    this.name = "ScaffoldStubError";
    this.code = code;
    this.candidates = Object.freeze([...candidates]);
  }
}

export interface ScaffoldStubInput {
  /** The unresolved wikilink target, e.g. `Projects/Foo` or `Foo`. */
  readonly target: string;
  /**
   * Explicit destination. Absent derives `<target>.md`, which is the
   * path the link itself named - so a pathed target lands where the link
   * pointed and a bare basename lands at the vault root, predictably,
   * rather than at a location this module guessed from the sources.
   */
  readonly path?: string;
  /** Documents that referenced the target; they become the stub's body links. */
  readonly sources?: ReadonlyArray<string>;
  /** Occupied-target policy, forwarded to `createNote`. Absent means refuse. */
  readonly ifExists?: CreateNoteIfExists;
  /** False (the default) resolves and plans, writing nothing. */
  readonly apply?: boolean;
}

export interface ScaffoldStubResult {
  /** The target as the caller spelled it, minus decoration. */
  readonly target: string;
  /** Vault-relative path the stub would occupy, or does. */
  readonly path: string;
  /** False when this was a plan-only run. */
  readonly applied: boolean;
  /** What `createNote` did; `null` on a plan-only run. */
  readonly outcome: CreateNoteOutcome | null;
  /** The source documents whose wikilinks the stub's body carries, sorted. */
  readonly sources: ReadonlyArray<string>;
}

/** The `.md` suffix, matched case-insensitively by the path envelope. */
const MARKDOWN_SUFFIX = ".md";

/** `Projects/Foo.md` -> `Projects/Foo`; anything else unchanged. */
function withoutSuffix(path: string): string {
  return path.toLowerCase().endsWith(MARKDOWN_SUFFIX)
    ? path.slice(0, -MARKDOWN_SUFFIX.length)
    : path;
}

/** `Projects/Foo` -> `Foo`. */
function basenameOf(target: string): string {
  return target.split(posix.sep).at(-1) ?? target;
}

/**
 * Prove the target is really missing.
 *
 * Success from the title resolver is a REFUSAL here, and that inversion
 * is the whole check: it means a note already answers this link, so there
 * is nothing dangling and creating a second one would introduce the
 * ambiguity the resolver refuses. `ambiguous` is refused for the same
 * reason, one step further along - the link is not broken, it is
 * over-answered, and a third note makes it worse. Only `not_found` /
 * `path_not_found` is a target worth materialising.
 */
function assertMissing(vault: string, target: string): void {
  let resolved: string | null = null;
  try {
    resolved = resolveNoteTitle(vault, target);
  } catch (err) {
    if (err instanceof NoteTitleResolutionError) {
      if (err.code === "ambiguous") {
        throw new ScaffoldStubError(
          "target_ambiguous",
          `target "${target}" already names more than one note; ` +
            `resolve the ambiguity rather than adding a third: ${err.candidates.join(", ")}`,
          err.candidates,
        );
      }
      if (err.code === "empty_target") {
        throw new ScaffoldStubError("empty_target", err.message);
      }
      return;
    }
    throw err;
  }
  throw new ScaffoldStubError(
    "target_resolves",
    `target "${target}" already resolves to ${resolved}; there is nothing to materialise`,
  );
}

/**
 * Refuse a declared source that is not an existing Markdown file inside
 * the vault.
 *
 * The stub's whole claim is that nothing in it is invented: its title is
 * the target the link spelled and its body is the documents that
 * referenced it. `target` and `path` have always gone through the path
 * envelope, and `sources` went through nothing at all - so a caller
 * could hand this function three strings it made up and get a note whose
 * body cited three documents that do not exist, in a surface whose
 * documented selling point is that it cites rather than composes.
 *
 * Existence inside the vault is what can be checked here and it is
 * checked. Whether that document really carries the reference is the
 * INDEX's claim, and `action: "list"` is where a caller gets it from;
 * re-deriving it here would make a write depend on an index the write
 * path deliberately does not consult.
 */
function assertSourcesExist(vault: string, sources: ReadonlyArray<string>): void {
  for (const source of sources) {
    let abs: string;
    try {
      abs = ensureInsideVault(join(vault, source), vault);
    } catch {
      throw new ScaffoldStubError(
        "unknown_source",
        `source "${source}" is not a path inside the vault`,
      );
    }
    if (
      !source.toLowerCase().endsWith(MARKDOWN_SUFFIX) ||
      !statSync(abs, { throwIfNoEntry: false })?.isFile()
    ) {
      throw new ScaffoldStubError(
        "unknown_source",
        `source "${source}" is not an existing Markdown note; a stub cites documents, it does not invent them`,
      );
    }
  }
}

/**
 * Materialise a stub note for one unresolved wikilink target.
 *
 * Dry run by default. Scaffolding is never a side effect of anything: the
 * repair lane's `skip-missing-target` stays its default decision, and
 * this function is reached only when a caller asked for it.
 */
export function scaffoldStub(vault: string, input: ScaffoldStubInput): ScaffoldStubResult {
  const target = withoutSuffix(input.target.trim());
  if (target.length === 0) {
    throw new ScaffoldStubError("empty_target", "scaffold target must not be empty");
  }
  assertMissing(vault, target);

  const path = input.path ?? `${target}${MARKDOWN_SUFFIX}`;
  const sources = Object.freeze([...(input.sources ?? [])].toSorted());
  assertSourcesExist(vault, sources);
  // Body links are the SOURCES, spelled the way a wikilink spells a note:
  // the vault-relative path without its extension. Nothing else about a
  // target that does not exist is known, so nothing else is written.
  const [frontmatter, body] = renderStub(
    basenameOf(target),
    sources.map((source) => withoutSuffix(source)),
    {},
  );

  if (input.apply !== true) {
    // The path is still resolved by the caller's next call, not guessed
    // here: a plan that reported a destination the envelope would refuse
    // is the misleading success this release removes. `createNote` is the
    // only thing that decides, so a plan reports the path it WOULD pass
    // and writes nothing.
    return Object.freeze({ target, path, applied: false, outcome: null, sources });
  }

  const created = createNote(vault, {
    path,
    frontmatter,
    content: body,
    ...(input.ifExists !== undefined ? { ifExists: input.ifExists } : {}),
  });
  return Object.freeze({
    target,
    path: created.path,
    applied: true,
    outcome: created.outcome,
    sources,
  });
}

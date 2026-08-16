/**
 * What each agent host costs this build, one row per capability
 * dimension.
 *
 * The product's claim is "it installs into host X and recall works
 * there". Nine adapters make that claim and no surface said what the nine
 * cost differently: which host caps the tool surface, which one can be
 * asked whether it loaded the entry, which one keeps transcripts this
 * build can read. A maintainer wanting to know whether a friction is the
 * HOST's contract problem or OURS had nine adapter files and one fact
 * table to read and no way to line them up.
 *
 * ## Derived, never written
 *
 * Every cell below is computed from {@link RUNTIME_FACTS} or from the
 * live adapter handed in - never from a table maintained here. That is
 * the whole design constraint: a hand-written comparison is a document
 * that starts drifting the day a runtime is added, which is exactly the
 * failure the fact table was introduced to end. The population is the
 * caller's adapter list, so a runtime registered without a fact row (or
 * the reverse) fails `tests/core/architecture/host-facts-census.test.ts`
 * before it can reach this module.
 *
 * ## The dimensions this build can honestly answer, and three it cannot
 *
 * Carried: the install mechanism (the live plan's own step kinds), the
 * tool ceiling, the resolved tool profile with its origin, what a
 * `verify()` on this target is EVIDENCE of, whether session transcripts
 * are declared, and whether anything in this build parses them.
 *
 * Dropped, with the reason, because inventing a column is worse than
 * admitting there is no source for one:
 *
 *   - **whether the host takes MCP at all.** Nothing structural answers
 *     it. `InstallStepKind` does not distinguish grok's managed TOML
 *     block (which registers MCP servers) from aider's managed YAML block
 *     (which does not), and the only other candidate is matching English
 *     in a plan preview. The mechanism cell plus the artifact paths in
 *     its detail carry the same information without a claim nothing can
 *     back.
 *   - **whether lifecycle hooks are wired.** One runtime gets them and
 *     the knowledge lives entirely inside `grok-asset.ts`, private to
 *     that adapter. A column read out of one adapter's private constant
 *     is a hand-written table wearing a derivation's clothes.
 *   - **whether runtime identity is stamped.** It is applied to the
 *     payload's `env` at apply time (`payloadWithRuntimeIdentity`), and
 *     no read-only surface an adapter exposes - `detect`, `plan`,
 *     `verify` - carries the env of the entry it would write. Answering
 *     it would mean applying into a scratch home, which a report must not
 *     do.
 *
 * Each of the three becomes derivable the moment the adapter contract
 * grows a member that states it; until then this module says nothing
 * about them rather than guessing.
 */

import { hostProbeCommand, NO_HANDSHAKE_NOTE } from "./host-probe.ts";
import { writtenToolProfile } from "./payload-host.ts";
import { RUNTIME_FACTS, TOOL_CEILING_KIND, type InstallTargetId } from "../runtime/host-facts.ts";
import { BrainConfigError } from "../brain/policy/errors.ts";
import type { InstallAdapter, InstallEnv, McpPayload } from "./types.ts";

/**
 * The capability dimensions a host is compared on.
 *
 * A frozen vocabulary with a membership list and no guard: these ids are
 * printed and diffed, never parsed from argv or a config file, so there
 * is no raw boundary for a guard to stand on. A `--dimension` filter
 * would add one, and would add the guard with it.
 */
export const FRICTION_DIMENSION = Object.freeze({
  mechanism: "install-mechanism",
  toolCeiling: "tool-ceiling",
  toolProfile: "tool-profile",
  verifyEvidence: "verify-evidence",
  sessionTranscripts: "session-transcripts",
  sessionParser: "session-parser",
} as const);

export type FrictionDimension = (typeof FRICTION_DIMENSION)[keyof typeof FRICTION_DIMENSION];

/** The dimensions, in the order every row and every diff prints them. */
export const FRICTION_DIMENSIONS: ReadonlyArray<FrictionDimension> = Object.freeze([
  FRICTION_DIMENSION.mechanism,
  FRICTION_DIMENSION.toolCeiling,
  FRICTION_DIMENSION.toolProfile,
  FRICTION_DIMENSION.verifyEvidence,
  FRICTION_DIMENSION.sessionTranscripts,
  FRICTION_DIMENSION.sessionParser,
]);

/** One host's answer on one dimension. */
export interface FrictionCell {
  readonly dimension: FrictionDimension;
  /**
   * The comparable answer. Short, and the ONLY thing a diff compares:
   * two hosts whose citations differ but whose answers do not are not
   * different on that dimension.
   */
  readonly value: string;
  /** Where the answer is published, or why there is none. */
  readonly detail: string | null;
}

/** One host, answered on every dimension, in {@link FRICTION_DIMENSIONS} order. */
export interface FrictionRow {
  readonly target: InstallTargetId;
  readonly label: string;
  readonly cells: ReadonlyArray<FrictionCell>;
}

export interface FrictionMatrix {
  readonly dimensions: ReadonlyArray<FrictionDimension>;
  readonly rows: ReadonlyArray<FrictionRow>;
}

/** One dimension two hosts answer differently. */
export interface FrictionDifference {
  readonly dimension: FrictionDimension;
  readonly baseValue: string;
  readonly compareValue: string;
}

export interface FrictionDiff {
  readonly base: InstallTargetId;
  readonly compare: InstallTargetId;
  readonly differing: ReadonlyArray<FrictionDifference>;
  /** Dimensions the two answer identically. Counted, never listed. */
  readonly shared: number;
}

/**
 * Everything a row is computed from.
 *
 * The adapters arrive as a parameter rather than through
 * `defaultRegistry`, for the reason `ownership.ts` takes the same
 * argument: a module that reaches for the global registry cannot be
 * driven against a registry a test controls, and importing the registry
 * here would put this module downstream of every adapter.
 */
export interface FrictionInput {
  readonly env: InstallEnv;
  readonly payload: McpPayload;
  readonly adapters: ReadonlyArray<InstallAdapter>;
}

/**
 * The answer for a cell whose input could not be resolved, naming the
 * obstacle.
 *
 * `--friction` is a REPORT and is documented as one that never exits
 * non-zero, so a vault whose `_brain.yaml` will not parse must not turn it
 * into a stack trace - which it did the moment `plan()` began resolving
 * the tool profile, because `loadInstallBlockSafe` refuses an unreadable
 * config by design and `runFriction` caught only usage and payload
 * errors. Reporting the refusal in the cell keeps both properties: the
 * report stays total, and the refusal is still stated rather than papered
 * over with a default the operator never chose. Nothing is generated from
 * this value, which is why a report may hold what a writer must not.
 */
function unresolvedCell(dimension: FrictionDimension, exc: BrainConfigError): FrictionCell {
  return { dimension, value: "unresolved", detail: exc.message };
}

/** `compute()`, or the named refusal when the vault config will not parse. */
function orUnresolved(dimension: FrictionDimension, compute: () => FrictionCell): FrictionCell {
  try {
    return compute();
  } catch (exc) {
    if (exc instanceof BrainConfigError) return unresolvedCell(dimension, exc);
    throw exc;
  }
}

/** The install mechanism, as the live adapter's own plan describes it. */
function mechanismCell(adapter: InstallAdapter, input: FrictionInput): FrictionCell {
  const steps = adapter.plan(input.payload, input.env).steps;
  const kinds = [...new Set(steps.map((step) => step.kind))].toSorted();
  const paths = [...new Set(steps.map((step) => step.path).filter((p) => p !== null))];
  return {
    dimension: FRICTION_DIMENSION.mechanism,
    value: kinds.join(", "),
    detail: paths.length === 0 ? null : `writes ${paths.join("; ")}`,
  };
}

/** The published per-workspace tool limit, with its citation or its excuse. */
function ceilingCell(target: InstallTargetId): FrictionCell {
  const ceiling = RUNTIME_FACTS[target].toolCeiling;
  switch (ceiling.kind) {
    case TOOL_CEILING_KIND.declared:
      return {
        dimension: FRICTION_DIMENSION.toolCeiling,
        value: `${ceiling.kind}: ${ceiling.maxTools} tools`,
        detail: ceiling.source,
      };
    case TOOL_CEILING_KIND.unbounded:
      return {
        dimension: FRICTION_DIMENSION.toolCeiling,
        value: ceiling.kind,
        detail: ceiling.source,
      };
    case TOOL_CEILING_KIND.unknown:
      return {
        dimension: FRICTION_DIMENSION.toolCeiling,
        value: ceiling.kind,
        detail: ceiling.reason,
      };
  }
}

/**
 * The profile the generated registration will actually carry, asked of the
 * one function the write path asks - not the fact row's bottom tier, which
 * is only one of the three and is the one an operator is least likely to
 * be looking at.
 *
 * Three targets carry no profile because they write no MCP command line at
 * all, and they answer so by name. Resolving the ladder for them anyway
 * printed `generic tool-profile minimal / resolved from ...` beside a
 * `--target generic --apply` that emits no `--tool-profile` argument - a
 * cell contradicting the artifact it claims to describe.
 */
function profileCell(target: InstallTargetId, input: FrictionInput): FrictionCell {
  const resolved = writtenToolProfile(target, input.env);
  if (resolved === null) {
    return {
      dimension: FRICTION_DIMENSION.toolProfile,
      value: "not carried",
      detail: "this target writes no MCP command line, so no profile is selected for it",
    };
  }
  return {
    dimension: FRICTION_DIMENSION.toolProfile,
    value: resolved.value ?? "none",
    detail: `resolved from ${resolved.origin}`,
  };
}

/** What a `verify()` on this target is evidence OF. The point of the table. */
function evidenceCell(target: InstallTargetId): FrictionCell {
  const probe = RUNTIME_FACTS[target].hostProbe;
  if (probe === null) {
    return {
      dimension: FRICTION_DIMENSION.verifyEvidence,
      value: "configuration comparison only",
      detail: NO_HANDSHAKE_NOTE,
    };
  }
  return {
    dimension: FRICTION_DIMENSION.verifyEvidence,
    value: `host probe: ${hostProbeCommand(probe)}`,
    detail: probe.answers,
  };
}

/**
 * The transcript roots THIS ADAPTER answers for, resolved against the
 * injected machine.
 *
 * Asked of `adapter.sessionPaths(env)` rather than read out of
 * `RUNTIME_FACTS` directly, and that is the point: the member shipped
 * required with ten implementations and no caller anywhere in `src/`,
 * which is the exact defect - a declaration nothing reads - that this
 * release exists to remove. These two cells are per target and
 * adapter-keyed and already hold an `InstallEnv`, so they are the caller
 * the member was written for. The adapters all delegate to
 * `sessionPathsFor`, so the answer still comes from the one declaration;
 * what changes is that the seam is now load-bearing and a broken
 * implementation is visible in a surface an operator reads.
 *
 * Declared, not measured: whether the directory exists on this box is a
 * discovery question, and answering it here would turn a capability table
 * into a machine report.
 */
function transcriptCell(adapter: InstallAdapter, input: FrictionInput): FrictionCell {
  const answered = adapter.sessionPaths(input.env);
  if (answered === null || answered.roots.length === 0) {
    return {
      dimension: FRICTION_DIMENSION.sessionTranscripts,
      value: "none declared",
      detail: null,
    };
  }
  return {
    dimension: FRICTION_DIMENSION.sessionTranscripts,
    value: `${answered.roots.length} declared root(s)`,
    detail: answered.roots.map((root) => `${root.path}/${root.glob} (${root.format})`).join("; "),
  };
}

/** Whether anything in this build reads those transcripts. */
function parserCell(adapter: InstallAdapter, input: FrictionInput): FrictionCell {
  const answered = adapter.sessionPaths(input.env);
  const roots = answered === null ? [] : answered.roots;
  // Each root names its own parser, so a runtime whose stores are split
  // between a readable and an unreadable format says both rather than
  // rounding to the row's single answer.
  const adapters = [...new Set(roots.map((root) => root.adapter).filter((a) => a !== null))];
  if (adapters.length > 0) {
    return {
      dimension: FRICTION_DIMENSION.sessionParser,
      value: adapters.toSorted().join(", "),
      detail: null,
    };
  }
  const formats = [...new Set(roots.map((root) => root.format))];
  return {
    dimension: FRICTION_DIMENSION.sessionParser,
    value: "none ships",
    detail:
      formats.length === 0
        ? null
        : `roots are declared but nothing in this build parses ${formats.join(", ")}`,
  };
}

/** One host's row. */
function rowFor(adapter: InstallAdapter, input: FrictionInput): FrictionRow {
  const target = adapter.target;
  return {
    target,
    label: adapter.label,
    cells: [
      orUnresolved(FRICTION_DIMENSION.mechanism, () => mechanismCell(adapter, input)),
      ceilingCell(target),
      orUnresolved(FRICTION_DIMENSION.toolProfile, () => profileCell(target, input)),
      evidenceCell(target),
      transcriptCell(adapter, input),
      parserCell(adapter, input),
    ],
  };
}

/** Every supplied adapter, one row each, in registration order. */
export function buildFrictionMatrix(input: FrictionInput): FrictionMatrix {
  return {
    dimensions: FRICTION_DIMENSIONS,
    rows: input.adapters.map((adapter) => rowFor(adapter, input)),
  };
}

/**
 * One host's row, refused by name when nothing registered that target.
 *
 * The refusal lists the known targets for the same reason the `--target`
 * validation does: an operator who mistyped a runtime name needs the
 * spelling, not the news that theirs is wrong.
 */
export function frictionRowFor(target: InstallTargetId, input: FrictionInput): FrictionRow {
  const adapter = input.adapters.find((candidate) => candidate.target === target);
  if (adapter === undefined) {
    throw new Error(
      `unknown install target: ${target}. ` +
        `Known: ${input.adapters.map((a) => a.target).join(", ")}`,
    );
  }
  return rowFor(adapter, input);
}

/** The one cell of `row` for `dimension`; rows are total over the set. */
function cellOf(row: FrictionRow, dimension: FrictionDimension): FrictionCell {
  const found = row.cells.find((cell) => cell.dimension === dimension);
  if (found === undefined) {
    throw new Error(`${row.target} has no ${dimension} cell; the row is not total`);
  }
  return found;
}

/**
 * What the two hosts answer differently, and how many answers they share.
 *
 * The shared dimensions are COUNTED rather than listed: a diff that
 * reprints everything is a table, and the reader asking for a diff has
 * already got the table. The count is what stops the silence being read
 * as "there was nothing else to compare".
 */
export function diffFrictionRows(base: FrictionRow, compare: FrictionRow): FrictionDiff {
  const differing: FrictionDifference[] = [];
  let shared = 0;
  for (const dimension of FRICTION_DIMENSIONS) {
    const baseValue = cellOf(base, dimension).value;
    const compareValue = cellOf(compare, dimension).value;
    if (baseValue === compareValue) {
      shared += 1;
      continue;
    }
    differing.push({ dimension, baseValue, compareValue });
  }
  return { base: base.target, compare: compare.target, differing, shared };
}

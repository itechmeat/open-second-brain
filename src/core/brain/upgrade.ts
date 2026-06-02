/**
 * Brain managed-file upgrade for the release-owned files in
 * `Brain/` (`_brain.yaml`, `_BRAIN.md`), plus one narrow repair pass
 * over `preferences/`: principle frontmatter corrupted by leaked
 * tool-call fragments or escape-amplified quote chains is rewritten
 * once through `sanitisePrinciple` (token-diet, t_40eb1de7). Beyond
 * that repair, user-owned content (`preferences/`, `retired/`,
 * `inbox/`, `log/`) is never touched.
 *
 * Key design choice: `_brain.yaml` is text-walked rather than
 * re-serialised through the strict parser, because the live file
 * carries hand-written comments the parser drops. Existing values,
 * ordering, and comments stay untouched; only missing schema keys
 * and sections are appended. A malformed source surfaces as
 * `status: "error"` so `--apply` refuses to half-merge.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";
import { formatFrontmatter, parseFrontmatterText } from "../vault.ts";
import { sanitisePrinciple } from "./text/sanitize-principle.ts";
import { defaultConfigPath, resolveAgentName } from "../config.ts";
import { appendLogEvent } from "./log.ts";
import { brainConfigPath, brainManualPath, vaultRelative } from "./paths.ts";
import { BrainConfigError, DEFAULT_BRAIN_CONFIG_YAML, loadBrainConfig } from "./policy.ts";
import { createSnapshot } from "./snapshot.ts";
import { renderBrainManual } from "./templates.ts";
import { isoSecond } from "./time.ts";
import { BRAIN_LOG_EVENT_KIND } from "./types.ts";

// ----- Public types --------------------------------------------------------

export type UpgradeFileStatus = "noop" | "update" | "error";

export interface UpgradeFilePlan {
  /** Vault-relative path, e.g. `Brain/_brain.yaml`. */
  readonly path: string;
  readonly status: UpgradeFileStatus;
  /** Current bytes on disk. Empty when the file does not exist yet. */
  readonly before: string;
  /** Target bytes for the file under the current release. */
  readonly after: string;
  /**
   * Diagnostic message when `status === "error"`. Empty for `noop`
   * and `update`.
   */
  readonly error: string;
}

export interface UpgradePlan {
  readonly files: ReadonlyArray<UpgradeFilePlan>;
  /** Count of `status === "update"` files. */
  readonly pending: number;
  /** Count of `status === "error"` files. */
  readonly errors: number;
}

export interface UpgradeApplyResult {
  readonly run_id: string;
  readonly snapshot_path: string;
  /** Vault-relative paths of files rewritten by this run. */
  readonly files_updated: ReadonlyArray<string>;
}

export class BrainUpgradeError extends Error {
  /**
   * The `upgrade-<ts>` snapshot run id when the failure happened
   * after the pre-apply snapshot was taken. `null` for failures
   * during planning (malformed `_brain.yaml`, read errors) — those
   * never wrote anything, so there is nothing to roll back.
   */
  readonly runId: string | null;

  constructor(message: string, runId: string | null = null) {
    super(message);
    this.name = "BrainUpgradeError";
    this.runId = runId;
  }
}

// ----- planUpgrade ---------------------------------------------------------

/**
 * Compute the upgrade plan for `vault` without touching disk.
 *
 * Order of files in `plan.files` is fixed: `_brain.yaml`,
 * `_BRAIN.md`. This is the order the CLI renders the per-file diff
 * so the operator's eye lands at the same spot on every run.
 */
export function planUpgrade(vault: string): UpgradePlan {
  const files: UpgradeFilePlan[] = [
    planBrainYaml(vault),
    planManagedPath(
      vault,
      brainManualPath(vault),
      vaultRelative(brainManualPath(vault), vault),
      () => renderBrainManual(vault),
    ),
    ...planCorruptedPreferences(vault),
  ];
  const pending = files.filter((f) => f.status === "update").length;
  const errors = files.filter((f) => f.status === "error").length;
  return Object.freeze({
    files: Object.freeze(files),
    pending,
    errors,
  });
}

// ----- applyUpgrade --------------------------------------------------------

/**
 * Apply every pending update from {@link planUpgrade}.
 *
 * Sequence:
 *   1. Compute the plan. If `errors > 0`, throw — never touch disk
 *      when the schema source is malformed.
 *   2. If `pending === 0`, return early without taking a snapshot or
 *      appending a log row. Idempotent re-run is free.
 *   3. `createSnapshot(vault, run_id)` — sidecar manifest comes
 *      along automatically. The run id includes a `upgrade-` prefix
 *      so the operator can spot upgrade snapshots in `--list`.
 *   4. Write each `update` file via `atomicWriteFileSync`.
 *   5. Append a `BRAIN_LOG_EVENT_KIND.upgrade` event.
 *
 * On any write failure mid-step we throw — the snapshot already
 * persisted is the recovery path (`o2b brain rollback upgrade-<ts>`).
 */
export function applyUpgrade(
  vault: string,
  opts: { agent?: string; now?: Date } = {},
): UpgradeApplyResult {
  const plan = planUpgrade(vault);
  if (plan.errors > 0) {
    const messages = plan.files
      .filter((f) => f.status === "error")
      .map((f) => `${f.path}: ${f.error}`)
      .join("; ");
    throw new BrainUpgradeError(
      `upgrade aborted: ${plan.errors} file(s) failed to plan — ${messages}`,
    );
  }
  if (plan.pending === 0) {
    return Object.freeze({
      run_id: "",
      snapshot_path: "",
      files_updated: Object.freeze([] as ReadonlyArray<string>),
    });
  }

  const now = opts.now ?? new Date();
  const runId = `upgrade-${isoSecondCompact(now)}`;
  const snap = createSnapshot(vault, runId);

  const updated: string[] = [];
  for (const file of plan.files) {
    if (file.status !== "update") continue;
    try {
      atomicWriteFileSync(join(vault, file.path), file.after);
    } catch (err) {
      // Mid-apply failure: one or more files have already been
      // rewritten under the new release, the rest still match the
      // old. The pre-apply snapshot is the recovery path — embed
      // its run id so the operator does not need to grep
      // `.snapshots/` to find it.
      throw new BrainUpgradeError(
        `upgrade aborted mid-apply at ${file.path}: ` +
          `${(err as Error).message ?? String(err)}. ` +
          `${updated.length} file(s) already rewritten; ` +
          `roll back via \`o2b brain rollback ${runId} --force-rollback\` ` +
          `before re-running.`,
        runId,
      );
    }
    updated.push(file.path);
  }

  const agent = opts.agent ?? resolveAgentName(defaultConfigPathOrEmpty());
  try {
    appendLogEvent(vault, {
      timestamp: isoSecond(now),
      eventType: BRAIN_LOG_EVENT_KIND.upgrade,
      body: {
        run_id: runId,
        agent,
        snapshot: snap.path,
        files: updated,
      },
    });
  } catch (err) {
    // Audit-only failure — the files are already on disk. Surface so
    // the operator can record manually if needed.
    process.stderr.write(`warning: append upgrade log failed: ${(err as Error).message}\n`);
  }

  return Object.freeze({
    run_id: runId,
    snapshot_path: snap.path,
    files_updated: Object.freeze(updated),
  });
}

// ----- Internal helpers ----------------------------------------------------

function planBrainYaml(vault: string): UpgradeFilePlan {
  const path = brainConfigPath(vault);
  const rel = vaultRelative(path, vault);
  let before: string;
  try {
    before = readFileSync(path, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      // The file vanished from a `o2b brain init`-bootstrapped
      // vault. Same recovery shape as `planManagedPath`: treat
      // missing as an update from empty so `--apply` restores the
      // canonical body. Refusing here would block every other
      // managed-file update behind one missing config.
      return makeUpdate(rel, "", DEFAULT_BRAIN_CONFIG_YAML);
    }
    return makeError(rel, `read failed: ${e.message ?? String(err)}`);
  }
  // Validate the live file with the strict parser. A malformed source
  // is surfaced as `error` so the operator fixes it manually before
  // `--apply` runs — a half-merged YAML is worse than a refusal.
  try {
    loadBrainConfig(vault);
  } catch (err) {
    if (err instanceof BrainConfigError) {
      return makeError(rel, err.message);
    }
    return makeError(rel, (err as Error).message ?? String(err));
  }
  const after = mergeBrainYaml(before, DEFAULT_BRAIN_CONFIG_YAML);
  if (after === before) {
    return makeNoop(rel);
  }
  return makeUpdate(rel, before, after);
}

function planManagedPath(
  _vault: string,
  absolutePath: string,
  relPath: string,
  renderTarget: () => string,
): UpgradeFilePlan {
  const after = renderTarget();
  if (!existsSync(absolutePath)) {
    // File missing entirely: an upgrade should restore it. Treat as
    // update with empty `before` so the diff shows the full body.
    return makeUpdate(relPath, "", after);
  }
  let before: string;
  try {
    before = readFileSync(absolutePath, "utf8");
  } catch (err) {
    return makeError(relPath, `read failed: ${(err as Error).message}`);
  }
  if (before === after) {
    return makeNoop(relPath);
  }
  return makeUpdate(relPath, before, after);
}

function makeNoop(path: string): UpgradeFilePlan {
  // `noop` rows never expose `before` / `after` bodies — the CLI
  // diff renderer and JSON output only consult `.length`/`.status`
  // for noops, so carrying the full file body here would waste memory
  // on every plan invocation (planUpgrade is read-only and may be
  // called from JSON/CI paths repeatedly).
  return Object.freeze({
    path,
    status: "noop" as const,
    before: "",
    after: "",
    error: "",
  });
}

function makeUpdate(path: string, before: string, after: string): UpgradeFilePlan {
  return Object.freeze({
    path,
    status: "update" as const,
    before,
    after,
    error: "",
  });
}

function makeError(path: string, message: string): UpgradeFilePlan {
  return Object.freeze({
    path,
    status: "error" as const,
    before: "",
    after: "",
    error: message,
  });
}

/**
 * Compact ISO without colons or `Z` suffix so the run id is
 * filesystem-safe under every snapshot validator.
 */
function isoSecondCompact(d: Date): string {
  return isoSecond(d).replace(/[:Z]/g, "");
}

/**
 * `applyUpgrade` is callable from tests that may not have set up a
 * real plugin config. Fall back to an empty path string so
 * `resolveAgentName` returns its built-in default rather than
 * throwing on a missing file.
 */
function defaultConfigPathOrEmpty(): string {
  try {
    return defaultConfigPath();
  } catch {
    return "";
  }
}

// ----- `_brain.yaml` text-level merge --------------------------------------

/**
 * Append missing top-level sections / scalars and missing nested keys
 * from `target` (the default YAML the current release ships) into a
 * copy of `live` (the user's current file). Existing values are
 * never rewritten; comments and ordering are preserved.
 *
 * Algorithm:
 *   1. Walk `target` block-by-block. A top-level section is a key
 *      followed by `:` at column 0; a top-level scalar is a key
 *      followed by `: <value>` at column 0.
 *   2. For each top-level scalar in `target`: if the same key
 *      appears at column 0 in `live`, leave it alone. Otherwise
 *      append the line at end-of-file.
 *   3. For each top-level section in `target`: if the section
 *      header is absent from `live`, append the whole block
 *      (header + indented body + leading comment block, if any) at
 *      end-of-file. If present, compute the missing nested keys
 *      (keys present in the target's block but absent in live's
 *      block) and insert each missing line at the end of the live
 *      block.
 *
 * The merge is purely additive — we never delete, reorder, or
 * rewrite. Comment-only lines and blank lines from `target` are
 * carried along with their adjacent section so the inserted block
 * reads the same as the canonical template.
 */
export function mergeBrainYaml(live: string, target: string): string {
  const targetBlocks = parseYamlBlocks(target);
  const liveBlocks = parseYamlBlocks(live);
  const liveByName = new Map(liveBlocks.map((b) => [b.name, b]));
  const liveScalars = new Set(liveBlocks.filter((b) => b.kind === "scalar").map((b) => b.name));
  const liveSections = new Map(
    liveBlocks.filter((b) => b.kind === "section").map((b) => [b.name, b] as const),
  );

  let result = live;
  // Pass 1: append missing top-level scalars / sections.
  for (const tb of targetBlocks) {
    if (tb.kind === "scalar" && !liveScalars.has(tb.name)) {
      result = appendBlockAtEnd(result, tb.text);
    } else if (tb.kind === "section" && !liveSections.has(tb.name)) {
      result = appendBlockAtEnd(result, tb.text);
    }
  }

  // Pass 2: for each section present in both, splice missing nested
  // keys into the existing live block.
  for (const tb of targetBlocks) {
    if (tb.kind !== "section") continue;
    const live = liveByName.get(tb.name);
    if (!live || live.kind !== "section") continue;
    const liveKeys = new Set(live.nestedKeys);
    // Only consider lines that are real key declarations. Blank
    // lines and comment lines return an empty `extractKey`, which
    // would otherwise look "missing from liveKeys" and inflate the
    // diff with whitespace.
    const missing = tb.nestedLines.filter((line) => {
      const key = extractKey(line);
      return key.length > 0 && !liveKeys.has(key);
    });
    if (missing.length === 0) continue;
    result = insertLinesAtSectionEnd(result, tb.name, missing);
  }

  return result;
}

interface YamlBlock {
  readonly kind: "scalar" | "section" | "comment";
  /** Identifier key for scalar/section; `""` for comment-only block. */
  readonly name: string;
  /** Block source text including trailing newline. */
  readonly text: string;
  /** Lines under a section (indented), in source order. Empty for scalar / comment. */
  readonly nestedLines: ReadonlyArray<string>;
  /** Convenience: keys extracted from `nestedLines` (one per indented key line). */
  readonly nestedKeys: ReadonlyArray<string>;
}

function parseYamlBlocks(yaml: string): YamlBlock[] {
  const lines = yaml.split("\n");
  const blocks: YamlBlock[] = [];
  let i = 0;
  // Buffer comment / blank lines so they attach to the next block
  // header — that way an inserted section copies its leading
  // commentary verbatim.
  let preface: string[] = [];
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trimEnd() === "" || /^\s*#/.test(line)) {
      preface.push(line);
      i++;
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line);
    if (m && !line.startsWith(" ") && !line.startsWith("\t")) {
      const key = m[1]!;
      const rest = m[2]!;
      const trimmedRest = rest.trim();
      // Scalar: `key: value`. Section: `key:` (rest is empty after
      // colon) followed by indented continuation.
      if (trimmedRest === "") {
        // Section header. Consume continuation lines (indented or blank).
        const start = i;
        i++;
        const nestedLines: string[] = [];
        while (i < lines.length) {
          const next = lines[i]!;
          if (next.startsWith(" ") || next.startsWith("\t")) {
            nestedLines.push(next);
            i++;
            continue;
          }
          if (next.trim() === "") {
            // Trailing blank line belongs to the section block.
            nestedLines.push(next);
            i++;
            // The next non-blank determines whether we are still
            // inside the section.
            if (i < lines.length && !/^[ \t]/.test(lines[i]!)) break;
            continue;
          }
          break;
        }
        const text = [...preface, lines[start]!, ...nestedLines].join("\n") + "\n";
        preface = [];
        blocks.push({
          kind: "section",
          name: key,
          text,
          nestedLines: nestedLines.filter((l) => l.trim() !== ""),
          nestedKeys: nestedLines.filter((l) => /^\s+[A-Za-z_]/.test(l)).map(extractKey),
        });
        continue;
      }
      // Scalar at column 0.
      const text = [...preface, line].join("\n") + "\n";
      preface = [];
      blocks.push({
        kind: "scalar",
        name: key,
        text,
        nestedLines: [],
        nestedKeys: [],
      });
      i++;
      continue;
    }
    // Unrecognised top-level line (e.g. a stray non-key). Treat as
    // commentary so we never silently drop it.
    preface.push(line);
    i++;
  }
  if (preface.length > 0) {
    blocks.push({
      kind: "comment",
      name: "",
      text: preface.join("\n") + (preface.at(-1) === "" ? "" : "\n"),
      nestedLines: [],
      nestedKeys: [],
    });
  }
  return blocks;
}

function extractKey(indentedLine: string): string {
  const m = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(indentedLine);
  return m ? m[1]! : "";
}

function appendBlockAtEnd(yaml: string, block: string): string {
  // Ensure exactly one blank line between the existing content and
  // the new block, and exactly one trailing newline overall.
  const trimmedTail = yaml.replace(/\s+$/, "");
  const trimmedBlock = block.replace(/\s+$/, "");
  return `${trimmedTail}\n\n${trimmedBlock}\n`;
}

function insertLinesAtSectionEnd(
  yaml: string,
  sectionName: string,
  newLines: ReadonlyArray<string>,
): string {
  const lines = yaml.split("\n");
  const header = `${sectionName}:`;
  const headerIdx = lines.findIndex(
    (l) => l === header || l.startsWith(`${header} `) || l === header.trimEnd(),
  );
  if (headerIdx === -1) {
    // Section not in live (shouldn't happen given the caller guard);
    // append the lines at end-of-file as a fallback.
    return appendBlockAtEnd(yaml, newLines.join("\n"));
  }
  // Find the end of the section: first column-0 non-blank line after
  // the header.
  let end = headerIdx + 1;
  while (end < lines.length) {
    const l = lines[end]!;
    if (l !== "" && !/^[ \t]/.test(l)) break;
    end++;
  }
  // Insert the new keys right before `end`, after stripping any
  // trailing blank lines inside the section so the inserted lines
  // land flush with the existing keys.
  let insertAt = end;
  while (insertAt > headerIdx + 1 && lines[insertAt - 1]!.trim() === "") {
    insertAt--;
  }
  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  return [...before, ...newLines, ...after].join("\n");
}

// ----- Corrupted preference repair (token-diet, t_40eb1de7) ----------------

/**
 * One narrow, idempotent repair over `Brain/preferences/`: rewrite
 * files whose `principle` frontmatter still carries leaked tool-call
 * fragments or escape-amplified quote chains (written before the
 * write-seam sanitizer and the frontmatter unescape fix shipped).
 *
 * The rewrite goes through the raw frontmatter map - not the typed
 * preference parser - so every other field round-trips through the
 * same `formatFrontmatter` the writers use and unknown keys survive
 * verbatim. Files that fail to parse, or whose principle is already
 * clean, are left untouched; on the pass after the repair the plan is
 * empty again.
 */
function planCorruptedPreferences(vault: string): UpgradeFilePlan[] {
  const dir = join(vault, "Brain", "preferences");
  if (!existsSync(dir)) return [];
  const plans: UpgradeFilePlan[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    if (!name.endsWith(".md")) continue;
    const abs = join(dir, name);
    const rel = `Brain/preferences/${name}`;
    let before: string;
    try {
      before = readFileSync(abs, "utf8");
    } catch {
      continue; // unreadable file is doctor's domain, not upgrade's
    }
    const [meta, body] = parseFrontmatterText(before);
    const principle = meta["principle"];
    if (typeof principle !== "string") continue;
    const repaired = sanitisePrinciple(principle);
    if (repaired === principle || repaired.length === 0) continue;
    const after = formatFrontmatter({ ...meta, principle: repaired }, body);
    if (after === before) continue;
    plans.push(
      Object.freeze({
        path: rel,
        status: "update" as const,
        before,
        after,
        error: "",
      }),
    );
  }
  return plans;
}

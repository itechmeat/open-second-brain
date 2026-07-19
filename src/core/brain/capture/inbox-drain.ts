/**
 * Inbox-drain classify-and-route pass (Knowledge intake suite, I2,
 * t_b0bba8cb).
 *
 * Walks the staged captures via the seam-1 capture-note contract and, for
 * each, decides a route from STRUCTURAL signals only - never a
 * natural-language word list:
 *
 *   - source-reference: a URL-shaped body (the trimmed body is a single
 *     `http(s)://` token). Routed through {@link ingestSource}.
 *   - obligation: the body's first line begins with the explicit
 *     {@link CAPTURE_OBLIGATION_MARKER} token, optionally carrying a cadence
 *     from the obligation vocabulary. Routed through {@link addObligation}.
 *   - idea: everything else is an atomic idea. Routed to a create-or-merge
 *     note under `captured/`.
 *
 * Dry-run is the default and writes nothing. `apply` executes the route and
 * archives the capture through the contract, so a rerun after apply finds no
 * staged captures and is a no-op (the processed marker is the idempotency
 * key). Unroutable items are reported with a reason and left in place.
 */

import { existsSync, mkdirSync } from "node:fs";

import type { FrontmatterMap } from "../../types.ts";
import { atomicWriteText } from "../../fs-atomic.ts";
import { ensureInsideVault } from "../../path-safety.ts";
import { formatFrontmatter, parseFrontmatter, slugify } from "../../vault.ts";
import { addObligation, obligationExists, parseCadence, ObligationError } from "../obligations.ts";
import { ingestSource } from "../ingest/ingest.ts";
import { isoSecond } from "../time.ts";
import { archiveCapture, listStagedCaptures, type CaptureNote } from "./capture-note.ts";

/** Explicit leading token that classifies a capture as an obligation. */
export const CAPTURE_OBLIGATION_MARKER = "@obligation";

/** Cadence used when an obligation marker carries no explicit cadence. */
export const DEFAULT_CAPTURE_OBLIGATION_CADENCE = "weekly";

/** Vault-relative directory that holds create-or-merge idea notes. */
export const CAPTURED_NOTES_DIR_REL = "captured";

/** Frontmatter `kind:` marker of a drained idea note. */
export const CAPTURED_IDEA_KIND = "captured-idea";

/** A single line-delimited URL with no interior whitespace. */
const URL_SHAPED_RE = /^https?:\/\/\S+$/u;

export type CaptureClass = "source-reference" | "obligation" | "idea";
export type DrainAction = "ingest-source" | "open-obligation" | "note" | "skip";

export interface DrainItem {
  readonly id: string;
  /** Vault-relative path of the staged capture. */
  readonly capturePath: string;
  readonly classification: CaptureClass | "unroutable";
  readonly action: DrainAction;
  readonly reason: string;
  /** Resolved route target (summary page, obligation slug, note path). */
  readonly target: string | null;
  /** `true` when the capture was routed and archived (apply mode only). */
  readonly routed: boolean;
}

export interface DrainReport {
  readonly mode: "dry-run" | "apply";
  readonly items: readonly DrainItem[];
  readonly routed: number;
  readonly unroutable: number;
}

export interface DrainOptions {
  readonly apply: boolean;
  readonly agent: string;
  readonly now: Date;
}

/** One item's route decided structurally, before any write. */
interface RoutePlan {
  readonly classification: CaptureClass;
  readonly action: DrainAction;
  readonly reason: string;
  /** Executes the route and returns the resolved target. */
  readonly execute: () => string;
}

/** A structural refusal that leaves the capture in place. */
class UnroutableCapture {
  constructor(readonly reason: string) {}
}

function classify(
  vault: string,
  note: CaptureNote,
  opts: DrainOptions,
): RoutePlan | UnroutableCapture {
  const body = note.body.trim();
  const firstLine = body.split("\n", 1)[0]!.trim();

  if (firstLine.startsWith(CAPTURE_OBLIGATION_MARKER)) {
    return planObligation(vault, firstLine, opts);
  }
  if (URL_SHAPED_RE.test(body)) {
    return planSource(vault, body, opts);
  }
  return planIdea(vault, body, opts);
}

function planObligation(
  vault: string,
  firstLine: string,
  opts: DrainOptions,
): RoutePlan | UnroutableCapture {
  const afterMarker = firstLine.slice(CAPTURE_OBLIGATION_MARKER.length);
  let cadenceRaw = DEFAULT_CAPTURE_OBLIGATION_CADENCE;
  let rest = afterMarker;
  if (afterMarker.startsWith(":")) {
    const [token, ...tail] = afterMarker.slice(1).trim().split(/\s+/u);
    cadenceRaw = token ?? "";
    rest = tail.join(" ");
  }
  let cadence: string;
  try {
    cadence = parseCadence(cadenceRaw);
  } catch {
    return new UnroutableCapture(`obligation marker has an unknown cadence: ${cadenceRaw}`);
  }
  const title = rest.trim();
  if (title.length === 0) {
    return new UnroutableCapture("obligation marker without a title");
  }
  const slug = slugify(title);
  if (obligationExists(vault, slug)) {
    return new UnroutableCapture(`obligation already exists: ${slug}`);
  }
  return {
    classification: "obligation",
    action: "open-obligation",
    reason: `obligation marker (cadence ${cadence})`,
    execute: () => addObligation(vault, { title, cadence, agent: opts.agent, now: opts.now }).slug,
  };
}

function planSource(vault: string, url: string, opts: DrainOptions): RoutePlan {
  return {
    classification: "source-reference",
    action: "ingest-source",
    reason: "url-shaped body",
    execute: () =>
      ingestSource(
        vault,
        {
          sourcePath: url,
          summary: `Captured source reference: ${url}`,
          extraction: { entities: [] },
        },
        { agent: opts.agent, now: opts.now },
      ).summaryPath,
  };
}

function planIdea(vault: string, body: string, opts: DrainOptions): RoutePlan {
  const slug = slugify(body);
  const relPath = `${CAPTURED_NOTES_DIR_REL}/${slug}.md`;
  const abs = ensureInsideVault(`${vault}/${relPath}`, vault);
  const merge = existsSync(abs);
  return {
    classification: "idea",
    action: "note",
    reason: merge ? "atomic idea (merge into existing note)" : "atomic idea (create note)",
    execute: () => {
      writeIdeaNote(abs, body, opts, merge);
      return relPath;
    },
  };
}

function writeIdeaNote(abs: string, body: string, opts: DrainOptions, merge: boolean): void {
  const stamp = isoSecond(opts.now);
  mkdirSync(dirOf(abs), { recursive: true });
  if (!merge) {
    const meta: FrontmatterMap = {
      kind: CAPTURED_IDEA_KIND,
      created_at: stamp,
      updated_at: stamp,
      tags: ["brain/captured-idea"],
    };
    atomicWriteText(abs, formatFrontmatter(meta, body));
    return;
  }
  const [meta, existing] = parseFrontmatter(abs);
  const nextMeta: FrontmatterMap = { ...meta, updated_at: stamp };
  const mergedBody = `${existing.trim()}\n\n${body.trim()}`;
  atomicWriteText(abs, formatFrontmatter(nextMeta, mergedBody));
}

function dirOf(abs: string): string {
  const idx = abs.lastIndexOf("/");
  return idx < 0 ? abs : abs.slice(0, idx);
}

/** Classify and (in apply mode) route every staged capture. */
export function drainInbox(vault: string, opts: DrainOptions): DrainReport {
  const items: DrainItem[] = [];
  let routed = 0;
  let unroutable = 0;

  for (const note of listStagedCaptures(vault)) {
    const plan = classify(vault, note, opts);
    if (plan instanceof UnroutableCapture) {
      unroutable += 1;
      items.push({
        id: note.id,
        capturePath: note.path,
        classification: "unroutable",
        action: "skip",
        reason: plan.reason,
        target: null,
        routed: false,
      });
      continue;
    }

    if (!opts.apply) {
      items.push({
        id: note.id,
        capturePath: note.path,
        classification: plan.classification,
        action: plan.action,
        reason: plan.reason,
        target: null,
        routed: false,
      });
      continue;
    }

    try {
      const target = plan.execute();
      archiveCapture(vault, note.id);
      routed += 1;
      items.push({
        id: note.id,
        capturePath: note.path,
        classification: plan.classification,
        action: plan.action,
        reason: plan.reason,
        target,
        routed: true,
      });
    } catch (err) {
      unroutable += 1;
      const reason =
        err instanceof ObligationError
          ? err.message
          : `routing failed: ${err instanceof Error ? err.message : String(err)}`;
      items.push({
        id: note.id,
        capturePath: note.path,
        classification: "unroutable",
        action: "skip",
        reason,
        target: null,
        routed: false,
      });
    }
  }

  return {
    mode: opts.apply ? "apply" : "dry-run",
    items,
    routed,
    unroutable,
  };
}

/**
 * The rollup ladder as the queue's producer (design D7, spec "The rollup
 * ladder's model step is queued").
 *
 * The ladder is not changed: it works on counts. When a live pass fires a
 * rung, the pass hands the queue one `rollup-summary` item for it:
 *
 *  - fact rung: the admitted fact ids that no earlier item of this rung
 *    holds as evidence (the queue is the record of what was handed out),
 *    in batches of at most {@link DREAM_WORK_EVIDENCE_MAX}, all produced
 *    during this pass;
 *  - every higher rung: the ids of the lower rung's items produced since
 *    its own last item, with the unfinished ones in `after`.
 *
 * The operation's answer is text only the launched agent writes (change
 * `dream-launched-agent`, design D6): `apply` writes the note at the
 * payload's target path, with its author
 * in the frontmatter (`written_by`, `written_by_model`, `written_by_item`:
 * flat keys, since a frontmatter value cannot be a map), and a second
 * apply that finds the same content writes nothing. The target lies under
 * `Brain/rollups/`, which the free-form note creation path refuses. A
 * store-served brain writes it through the lane page store; a legacy brain
 * writes its legacy file.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { assertNoteVaultForWrite } from "../../vault-adapter/index.ts";
import { formatFrontmatter, parseFrontmatterText } from "../../vault.ts";
import type { StorePartition } from "../../store/constants.ts";
import { readPreferences } from "../../store/read/preferences.ts";
import {
  lanePagesInStore,
  laneVaultRoot,
  readLanePage,
  writeLanePage,
} from "../../store/lane-pages.ts";
import { parseBrainYaml } from "../yaml-parse.ts";
import type { RollupLadderPlan } from "../rollup-ladder.ts";
import { DREAM_WORK_EVIDENCE_MAX } from "./constants.ts";
import type { DreamWorkItem } from "./fold.ts";
import { registerDreamWorkOperation, type DreamWorkContext } from "./operations.ts";
import { dreamWorkInputHash } from "./records.ts";
import { producedItems, produceWork, readDreamWork, type DreamQueue } from "./queue.ts";

export const ROLLUP_SUMMARY_OPERATION = "rollup-summary";
const PROMPT_VERSION = "1";
const SCHEMA_VERSION = "1";

/** The answer: the whole rollup note, a YAML frontmatter block with a `kind` key first. */
const ANSWER_SCHEMA = Object.freeze({
  type: "text",
  description:
    "the full rollup note: a YAML frontmatter block with at least a `kind` key, then the body",
});

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** The longest rollup note accepted, in characters. */
export const ROLLUP_NOTE_MAX_CHARS = 64_000;

function validate(answer: { readonly value?: unknown; readonly text?: string }): string | null {
  if (typeof answer.text !== "string" || answer.text.trim() === "") {
    return "a rollup summary is a text answer";
  }
  if (answer.text.length > ROLLUP_NOTE_MAX_CHARS) {
    return `the note is longer than ${ROLLUP_NOTE_MAX_CHARS} characters`;
  }
  const match = FRONTMATTER.exec(answer.text);
  if (match === null) return "the note must open with a YAML frontmatter block";
  if (/^\s*[^:\n]+:\s*\[[^\]\n]*$/m.test(match[1]!))
    return "the frontmatter must contain valid YAML";
  try {
    const parsed = parseBrainYaml(match[1]!);
    if (!Object.hasOwn(parsed, "kind")) return "the frontmatter must carry a `kind` key";
  } catch {
    return "the frontmatter must contain valid YAML";
  }
  if (answer.text.slice(match[0].length).trim() === "") return "the note has no body";
  return null;
}

/** Write the accepted note with its author; nothing when the same note is there. */
function apply(
  item: DreamWorkItem,
  answer: { readonly text?: string; readonly agent: string; readonly model: string },
  context: DreamWorkContext,
): string[] {
  const target = item.body.payload["target_path"];
  if (typeof target !== "string" || target === "")
    throw new Error("rollup-summary: no target path");
  const invalid = validate(answer);
  if (invalid !== null) throw new Error(`rollup-summary: ${invalid}`);
  const [frontmatter, body] = parseFrontmatterText(answer.text!);
  const authored = {
    ...frontmatter,
    written_by: answer.agent,
    written_by_model: answer.model,
    written_by_item: item.id,
  };
  const fields = item.partition === "private" ? { ...authored, visibility: "private" } : authored;
  if (target.split("/").includes("..") || !target.startsWith("Brain/rollups/")) {
    throw new Error("rollup-summary: the target path is not under Brain/rollups/");
  }
  const vault = laneVaultRoot(context.vault);
  const abs = join(vault, target);
  const inStore = lanePagesInStore(vault, context.configPath);
  if (inStore) {
    const existing = readLanePage(vault, abs, context.configPath);
    if (existing?.frontmatter["written_by_item"] === item.id) return [target];
  } else if (context.vault === null) {
    throw new Error("rollup-summary: no vault to write the note in");
  }
  if (existsSync(abs)) {
    if (!inStore) {
      const [existing] = parseFrontmatterText(readFileSync(abs, "utf8"));
      if (existing["written_by_item"] === item.id) return [target];
    }
  }
  if (inStore) {
    writeLanePage(vault, abs, fields, body, {
      overwrite: true,
      ...(context.configPath !== undefined ? { configPath: context.configPath } : {}),
    });
  } else {
    assertNoteVaultForWrite(context.vault, "rollup notes");
    mkdirSync(dirname(abs), { recursive: true });
    atomicWriteFileSync(abs, formatFrontmatter(fields, body));
  }
  return [target];
}

/** The fact ids the store holds now, and which of them are private. */
function factIndex(context: DreamWorkContext): Map<string, boolean> {
  return new Map(
    readPreferences({
      vault: context.vault,
      ...(context.configPath !== undefined ? { configPath: context.configPath } : {}),
    }).map((p) => [p.id, p.private]),
  );
}

function currentInput(item: DreamWorkItem, context: DreamWorkContext) {
  const rung = item.body.payload["tier"];
  if (rung === "fact") {
    const facts = factIndex(context);
    const kept = item.body.evidence.filter((id) => facts.has(id));
    if (kept.length === 0) return null;
    return { input_hash: dreamWorkInputHash(kept), evidence: kept };
  }
  const state = readDreamWork(context.store);
  const resolve = (id: string): string => {
    const seen = new Set<string>();
    let current = id;
    for (;;) {
      const successor = state.items.get(current)?.closed;
      if (successor?.reason !== "superseded" || successor.successor === null || seen.has(current)) {
        return current;
      }
      seen.add(current);
      current = successor.successor;
    }
  };
  const evidence = [...new Set(item.body.evidence.map(resolve))];
  if (evidence.length === 0) return null;
  if (
    evidence.length === item.body.evidence.length &&
    evidence.every((id, i) => id === item.body.evidence[i])
  ) {
    return { input_hash: item.body.input_hash };
  }
  return { input_hash: dreamWorkInputHash(evidence), evidence };
}

registerDreamWorkOperation({
  name: ROLLUP_SUMMARY_OPERATION,
  closedPredecessor: "release",
  text: true,
  validate,
  currentInput,
  apply,
});

export interface RollupWorkInput {
  readonly plan: RollupLadderPlan;
  /** The ids of the facts the salience gate admitted. */
  readonly admittedIds: ReadonlyArray<string>;
  /** The pass's day (`YYYY-MM-DD`). */
  readonly day: string;
}

export interface RollupWorkResult {
  /** Items newly recorded. */
  readonly produced: number;
  /** Admitted fact ids carried into follow-up items in this pass. */
  readonly left: number;
}

function rungOf(item: DreamWorkItem): unknown {
  return item.body.payload["tier"];
}

/** Queue one item per rung the plan fired (design D7). */
export function produceRollupWork(
  queue: DreamQueue,
  input: RollupWorkInput,
  onProduced?: () => void,
): RollupWorkResult {
  let produced = 0;
  let left = 0;
  let facts: Map<string, boolean> | null = null;
  for (const entry of input.plan.entries) {
    const earlier = producedItems(queue.store, ROLLUP_SUMMARY_OPERATION);
    const mine = earlier.filter((i) => rungOf(i) === entry.tier);
    let evidence: string[];
    let after: string[] = [];
    let sourceById = new Map<string, StorePartition>();
    let leftHere = 0;
    let factFresh: string[] = [];
    if (entry.tier === "fact") {
      const handed = new Set(
        mine.filter((i) => i.closed?.reason !== "cancelled").flatMap((i) => i.body.evidence),
      );
      const fresh = input.admittedIds.filter((id) => !handed.has(id)).toSorted();
      factFresh = fresh;
      evidence = fresh.slice(0, DREAM_WORK_EVIDENCE_MAX);
      leftHere = fresh.length - evidence.length;
      facts ??= factIndex({
        store: queue.store,
        vault: queue.vault,
        now: (queue.now ?? Date.now)(),
        ...(queue.configPath !== undefined ? { configPath: queue.configPath } : {}),
      });
      const index = facts;
      // A fact the fold does not hold reads as private (design D5: the partition that leaks nothing).
      sourceById = new Map(
        factFresh.map((id) => [id, index.get(id) === false ? "shared" : "private"]),
      );
    } else {
      const lowerTier = input.plan.entries.find((e) => e.produces === entry.tier)?.tier ?? "fact";
      const state = readDreamWork(queue.store);
      const resolve = (id: string): string => {
        const seen = new Set<string>();
        let current = id;
        for (;;) {
          const successor = state.items.get(current)?.closed;
          if (
            successor?.reason !== "superseded" ||
            successor.successor === null ||
            seen.has(current)
          ) {
            return current;
          }
          seen.add(current);
          current = successor.successor;
        }
      };
      const handed = new Set(mine.flatMap((i) => i.body.evidence.map(resolve)));
      const lower = new Map<string, DreamWorkItem>();
      for (const item of earlier) {
        if (rungOf(item) !== lowerTier || item.closed?.reason === "cancelled") continue;
        const resolved = state.items.get(resolve(item.id));
        if (resolved !== undefined && resolved.state !== "closed") lower.set(resolved.id, resolved);
      }
      const since = [...lower.values()].filter((i) => !handed.has(i.id));
      evidence = since.map((i) => i.id);
      after = since.filter((i) => i.state !== "finished").map((i) => i.id);
      sourceById = new Map(since.map((i) => [i.id, i.partition]));
    }
    if (evidence.length === 0) continue;
    const sequence = input.plan.ledger.produced[entry.tier] ?? 0;
    const chunkInput = entry.tier === "fact" ? factFresh : evidence;
    const chunks = Array.from(
      { length: Math.ceil(chunkInput.length / DREAM_WORK_EVIDENCE_MAX) },
      (_, i) => chunkInput.slice(i * DREAM_WORK_EVIDENCE_MAX, (i + 1) * DREAM_WORK_EVIDENCE_MAX),
    );
    for (const [index, chunk] of chunks.entries()) {
      if (chunk.length === 0) continue;
      const sources: StorePartition[] = chunk.some((id) => sourceById.get(id) !== "shared")
        ? ["private"]
        : ["shared"];
      const result = produceWork(queue, {
        operation: ROLLUP_SUMMARY_OPERATION,
        subject: `rung:${entry.tier}->${entry.produces}`,
        occurrence: `${input.day}/${String(sequence).padStart(6, "0")}/${entry.tier}/${String(index).padStart(4, "0")}`,
        input: chunk,
        prompt_version: PROMPT_VERSION,
        schema_version: SCHEMA_VERSION,
        answer_schema: ANSWER_SCHEMA,
        after: chunk.filter((id) => after.includes(id)),
        resources: [`rung:${entry.tier}`],
        evidence: chunk,
        payload: {
          tier: entry.tier,
          produces: entry.produces,
          prompt: entry.envelope.prompt,
          schema_hints: [...entry.envelope.schema_hints],
          target_path: entry.envelope.target_path,
          ...(entry.tier === "fact" ? { left_for_next_firing: 0 } : {}),
        },
        sources,
      });
      if (result.created) {
        produced += 1;
        onProduced?.();
      }
    }
    left += leftHere;
  }
  return { produced, left };
}

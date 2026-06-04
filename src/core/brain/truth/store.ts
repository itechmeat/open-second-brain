/**
 * Claim ledger store (t_d6849b56): device-sharded append-only JSONL
 * under `Brain/truth/`, merging the `log-jsonl.ts` shard discipline
 * (Syncthing-safe concurrent appends) with the `activation/store.ts`
 * derived-fold discipline (the state file is a recomputable cache,
 * never authority).
 *
 *   - `claims.jsonl`              - legacy/un-sharded shard (empty id);
 *   - `claims.<deviceId>.jsonl`   - one append-only file per device;
 *   - `state.json`                - derived fold, safe to delete.
 *
 * Every line carries `v: TRUTH_SCHEMA_VERSION` and parses fail-closed:
 * malformed or unknown-version lines surface as warnings, never throw.
 */

import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { resolveDeviceId } from "../../config.ts";
import { normalizeEntityName } from "../entities/canonical.ts";
import { computeTruthState } from "./fold.ts";
import type {
  ClaimEvent,
  ClaimParseWarning,
  ClaimQuantity,
  ClaimSlot,
  ClaimSweepOutcome,
  ClaimVersion,
  ReadClaimEventsResult,
  TruthConflict,
  TruthState,
} from "./types.ts";
import { TRUTH_SCHEMA_VERSION } from "./types.ts";

/** Default cap on retained claim events (explicit sweep only). */
export const CLAIM_EVENT_MAX_COUNT = 10000;

// Same canonical UTC shape the log writer emits; see ISO_UTC_TS_RE in
// log-jsonl.ts for why this stays strict.
const ISO_UTC_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

// `claims.jsonl` or `claims.<deviceId>.jsonl`; device ids are lowercase
// slugs, and Syncthing conflict copies are never shards.
const CLAIM_SHARD_RE = /^claims(?:\.([a-z0-9-]{1,32}))?\.jsonl$/;

export function truthDir(vault: string): string {
  return join(vault, "Brain", "truth");
}

export function truthStatePath(vault: string): string {
  return join(truthDir(vault), "state.json");
}

/** The shard this device appends to. */
export function claimShardPath(vault: string, configPath?: string): string {
  const deviceId = resolveDeviceId(configPath);
  const name = deviceId === "" ? "claims.jsonl" : `claims.${deviceId}.jsonl`;
  return join(truthDir(vault), name);
}

export interface AppendClaimInput {
  readonly ts: string;
  readonly agent: string;
  readonly entity: string;
  readonly aspect: string;
  readonly value: string;
  readonly valueKind?: ClaimEvent["valueKind"];
  readonly quantity?: ClaimQuantity;
  readonly source: string;
}

export interface AppendClaimResult {
  readonly path: string;
  readonly event: ClaimEvent;
}

/**
 * Validate, normalize identity fields, append one JSONL line to this
 * device's shard, and refresh the derived state cache.
 */
export function appendClaimEvent(
  vault: string,
  input: AppendClaimInput,
  opts: { readonly configPath?: string } = {},
): AppendClaimResult {
  const entity = normalizeEntityName(input.entity);
  const aspect = normalizeEntityName(input.aspect);
  if (entity === "") throw new Error("claim entity must not be empty");
  if (aspect === "") throw new Error("claim aspect must not be empty");
  const value = input.value.trim();
  if (value === "") throw new Error("claim value must not be empty");
  if (input.agent.trim() === "") throw new Error("claim agent must not be empty");
  if (input.source.trim() === "") throw new Error("claim source must not be empty");
  if (!ISO_UTC_TS_RE.test(input.ts)) {
    throw new Error(`claim ts must be canonical ISO-8601 UTC: ${JSON.stringify(input.ts)}`);
  }

  const event: ClaimEvent = Object.freeze({
    v: TRUTH_SCHEMA_VERSION,
    ts: input.ts,
    agent: input.agent.trim(),
    entity,
    aspect,
    value,
    valueKind: input.valueKind ?? "text",
    ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
    source: input.source.trim(),
  });

  mkdirSync(truthDir(vault), { recursive: true });
  const path = claimShardPath(vault, opts.configPath);
  appendFileSync(path, JSON.stringify(event) + "\n");
  writeTruthState(vault, computeTruthState(readClaimEvents(vault).events));
  return Object.freeze({ path, event });
}

/**
 * Read every retained claim event merged across shards, sorted by
 * (ts, shardId, line). Fail-closed per line.
 */
export function readClaimEvents(vault: string): ReadClaimEventsResult {
  const dir = truthDir(vault);
  let names: string[];
  try {
    names = readdirSync(dir).toSorted();
  } catch {
    return { events: [], warnings: [] };
  }

  interface Tagged {
    readonly event: ClaimEvent;
    readonly shardId: string;
    readonly line: number;
  }
  const tagged: Tagged[] = [];
  const warnings: ClaimParseWarning[] = [];

  for (const name of names) {
    const m = CLAIM_SHARD_RE.exec(name);
    if (!m) continue;
    const shardId = m[1] ?? "";
    if (shardId.startsWith("sync-conflict")) continue;
    const path = join(dir, name);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      const message = (err as NodeJS.ErrnoException).message ?? String(err);
      warnings.push({ path, lineNumber: 0, message: `failed to read shard: ${message}` });
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        warnings.push({
          path,
          lineNumber: i + 1,
          message: `malformed JSONL line: ${line.slice(0, 80)}`,
        });
        continue;
      }
      const event = coerceClaim(parsed, path, i + 1, warnings);
      if (event !== null) tagged.push({ event, shardId, line: i });
    }
  }

  tagged.sort((a, b) => {
    if (a.event.ts !== b.event.ts) return a.event.ts < b.event.ts ? -1 : 1;
    if (a.shardId !== b.shardId) return a.shardId < b.shardId ? -1 : 1;
    return a.line - b.line;
  });

  return { events: tagged.map((t) => t.event), warnings };
}

function coerceClaim(
  raw: unknown,
  path: string,
  lineNumber: number,
  warnings: ClaimParseWarning[],
): ClaimEvent | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push({ path, lineNumber, message: "claim row is not an object" });
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (obj["v"] !== TRUTH_SCHEMA_VERSION) {
    warnings.push({
      path,
      lineNumber,
      message: `unknown claim schema version: ${String(obj["v"])}`,
    });
    return null;
  }
  const ts = obj["ts"];
  if (typeof ts !== "string" || !ISO_UTC_TS_RE.test(ts)) {
    warnings.push({ path, lineNumber, message: `invalid claim ts: ${String(ts)}` });
    return null;
  }
  for (const key of ["agent", "entity", "aspect", "value", "source"] as const) {
    if (typeof obj[key] !== "string" || (obj[key] as string).trim() === "") {
      warnings.push({ path, lineNumber, message: `claim row missing ${key}` });
      return null;
    }
  }
  const valueKind = obj["valueKind"];
  if (valueKind !== "text" && valueKind !== "quantity") {
    warnings.push({ path, lineNumber, message: `invalid claim valueKind: ${String(valueKind)}` });
    return null;
  }
  let quantity: ClaimQuantity | undefined;
  if (obj["quantity"] !== undefined) {
    const q = obj["quantity"];
    if (
      q === null ||
      typeof q !== "object" ||
      typeof (q as Record<string, unknown>)["value"] !== "number" ||
      !Number.isFinite((q as Record<string, unknown>)["value"])
    ) {
      warnings.push({ path, lineNumber, message: "invalid claim quantity payload" });
      return null;
    }
    const qo = q as Record<string, unknown>;
    const unit = qo["unit"];
    const action = qo["action"];
    if (unit !== null && typeof unit !== "string") {
      warnings.push({ path, lineNumber, message: "invalid claim quantity unit" });
      return null;
    }
    if (action !== null && typeof action !== "string") {
      warnings.push({ path, lineNumber, message: "invalid claim quantity action" });
      return null;
    }
    quantity = Object.freeze({
      value: qo["value"] as number,
      unit: unit as string | null,
      action: action as string | null,
    });
  }
  return Object.freeze({
    v: TRUTH_SCHEMA_VERSION,
    ts,
    agent: obj["agent"] as string,
    entity: obj["entity"] as string,
    aspect: obj["aspect"] as string,
    value: obj["value"] as string,
    valueKind,
    ...(quantity !== undefined ? { quantity } : {}),
    source: obj["source"] as string,
  });
}

export function writeTruthState(vault: string, state: TruthState): void {
  mkdirSync(truthDir(vault), { recursive: true });
  writeFileSync(truthStatePath(vault), JSON.stringify(state, null, 2) + "\n");
}

function isClaimVersion(v: unknown): v is ClaimVersion {
  if (v === null || typeof v !== "object") return false;
  const row = v as Record<string, unknown>;
  return (
    typeof row["value"] === "string" &&
    (row["valueKind"] === "text" || row["valueKind"] === "quantity") &&
    typeof row["ts"] === "string" &&
    typeof row["agent"] === "string" &&
    typeof row["source"] === "string" &&
    typeof row["assertCount"] === "number" &&
    Number.isInteger(row["assertCount"]) &&
    (row["assertCount"] as number) >= 1
  );
}

function isClaimSlot(v: unknown): v is ClaimSlot {
  if (v === null || typeof v !== "object") return false;
  const row = v as Record<string, unknown>;
  return (
    typeof row["entity"] === "string" &&
    typeof row["aspect"] === "string" &&
    isClaimVersion(row["current"]) &&
    Array.isArray(row["history"]) &&
    (row["history"] as unknown[]).every(isClaimVersion) &&
    typeof row["contested"] === "boolean"
  );
}

function isTruthConflict(v: unknown): v is TruthConflict {
  if (v === null || typeof v !== "object") return false;
  const row = v as Record<string, unknown>;
  return (
    typeof row["entity"] === "string" &&
    typeof row["aspect"] === "string" &&
    row["kind"] === "value_conflict" &&
    Array.isArray(row["values"]) &&
    (row["values"] as unknown[]).every(isClaimVersion) &&
    typeof row["priority"] === "number" &&
    Number.isFinite(row["priority"]) &&
    row["resolution"] === "ask_user" &&
    typeof row["detectedAt"] === "string"
  );
}

/**
 * Read the derived state cache; structurally invalid content (including
 * corrupt nested rows) reads as null and the caller refolds from events.
 */
export function readTruthState(vault: string): TruthState | null {
  try {
    const parsed = JSON.parse(readFileSync(truthStatePath(vault), "utf8")) as TruthState;
    if (parsed.version !== TRUTH_SCHEMA_VERSION) return null;
    if (!Number.isInteger(parsed.events) || parsed.events < 0) return null;
    if (!(parsed.updatedAt === null || typeof parsed.updatedAt === "string")) return null;
    if (!Array.isArray(parsed.slots)) return null;
    if (!Array.isArray(parsed.conflicts)) return null;
    for (const slot of parsed.slots as ReadonlyArray<unknown>) {
      if (!isClaimSlot(slot)) return null;
    }
    for (const conflict of parsed.conflicts as ReadonlyArray<unknown>) {
      if (!isTruthConflict(conflict)) return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export interface ClaimSweepOptions {
  /** At most this many newest events are kept. */
  readonly maxEvents?: number;
}

/**
 * Keep the newest N events across all shards (rewriting each shard
 * with only its surviving lines), then refold the derived state.
 * Sweeping is an explicit operator action - appends never auto-drop
 * history.
 */
export function sweepClaimEvents(vault: string, opts: ClaimSweepOptions): ClaimSweepOutcome {
  const maxEvents = opts.maxEvents ?? CLAIM_EVENT_MAX_COUNT;
  const dir = truthDir(vault);
  let names: string[];
  try {
    names = readdirSync(dir).toSorted();
  } catch {
    // No event directory: refold an orphaned state file so stale slots
    // never outlive their events.
    if (existsSync(truthStatePath(vault))) {
      writeTruthState(vault, computeTruthState([]));
    }
    return Object.freeze({ removed: 0, kept: 0 });
  }

  // Collect (shard, line, ts) for every valid line; drop the oldest
  // beyond the cap. Invalid lines are preserved verbatim in place -
  // sweep bounds growth, doctor surfaces corruption.
  interface ShardLine {
    readonly name: string;
    readonly index: number;
    readonly raw: string;
    readonly ts: string | null;
  }
  const shards = new Map<string, string[]>();
  const valid: ShardLine[] = [];
  for (const name of names) {
    const m = CLAIM_SHARD_RE.exec(name);
    if (!m) continue;
    if ((m[1] ?? "").startsWith("sync-conflict")) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
    shards.set(name, lines);
    lines.forEach((raw, index) => {
      let ts: string | null = null;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (typeof parsed["ts"] === "string" && ISO_UTC_TS_RE.test(parsed["ts"])) {
          ts = parsed["ts"];
        }
      } catch {
        // Invalid lines never count toward the cap.
      }
      if (ts !== null) valid.push({ name, index, raw, ts });
    });
  }

  valid.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts! < b.ts! ? -1 : 1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.index - b.index;
  });
  const overflow = valid.length > maxEvents ? valid.slice(0, valid.length - maxEvents) : [];
  const removedKeys = new Set(overflow.map((x) => `${x.name}\n${x.index}`));

  if (removedKeys.size > 0) {
    for (const [name, lines] of shards) {
      const kept = lines.filter((_, index) => !removedKeys.has(`${name}\n${index}`));
      const path = join(dir, name);
      if (kept.length === 0) {
        rmSync(path, { force: true });
      } else if (kept.length !== lines.length) {
        writeFileSync(path, kept.join("\n") + "\n");
      }
    }
  }

  writeTruthState(vault, computeTruthState(readClaimEvents(vault).events));
  return Object.freeze({ removed: overflow.length, kept: valid.length - overflow.length });
}

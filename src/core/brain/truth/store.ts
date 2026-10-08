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
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { resolveDeviceId } from "../../config.ts";
import { parseFrontmatter } from "../../vault.ts";
import type { FrontmatterMap } from "../../types.ts";
import { vaultRelative } from "../../path-safety.ts";
import {
  JSONL_LEDGER_EXT,
  jsonlLedgerGrammar,
  parseShardedName,
  shardedFileName,
} from "../ledger-shards.ts";
import { normalizeEntityName } from "../entities/canonical.ts";
import { VALID_FROM_KEY, VALID_UNTIL_KEY } from "../lifecycle/temporal-replace.ts";
import { resolveNotePath } from "../note-path.ts";
import { ANCHORED_WIKILINK_RE, stripWikilinkDecoration } from "../wikilink.ts";
import { computeTruthState } from "./fold.ts";
import {
  isValidityPoint,
  resolveIngestWindow,
  validityWindowMs,
  type SourceValidityWindow,
} from "./validity.ts";
import type {
  ClaimEvent,
  ClaimExtractor,
  ClaimParseWarning,
  ClaimQuantity,
  ClaimSlot,
  ClaimSuccession,
  ClaimSweepOutcome,
  ClaimVersion,
  ReadClaimEventsResult,
  TruthConflict,
  TruthState,
} from "./types.ts";
import { TRUTH_SCHEMA_VERSION } from "./types.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";

/** Default cap on retained claim events (explicit sweep only). */
export const CLAIM_EVENT_MAX_COUNT = 10000;

// Same canonical UTC shape the log writer emits; see ISO_UTC_TS_RE in
// log-jsonl.ts for why this stays strict.
export const ISO_UTC_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * A validity window the append boundary refuses: an unparseable bound,
 * or an empty or inverted window. Typed so a tool surface can map it to
 * its invalid-params failure class (MCP INVALID_PARAMS, CLI exit 2)
 * instead of letting it answer as an internal error - the same
 * mistyped-input discipline the since/until and limit guards follow.
 * The refusal itself stays strict: nothing is written.
 */
export class ClaimWindowRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimWindowRefusal";
  }
}

// `claims.jsonl` or `claims.<deviceId>.jsonl`; device ids are lowercase
// slugs, and Syncthing conflict copies are never shards (the shared
// ledger-shard grammar rejects them).
const CLAIMS_STEM = "claims";
const CLAIMS_GRAMMAR = jsonlLedgerGrammar(CLAIMS_STEM);

/** Extension appended when a source target names no file as given. */
const NOTE_EXTENSION = ".md";

/**
 * The source record's frontmatter validity window, or null when the
 * source is unreadable or carries no validity frontmatter (the ingest
 * default rule, truth-correctable-time-aware task 3). The source is a
 * provenance wikilink or vault-relative path: the wikilink decoration
 * is stripped, the target resolves inside the vault only (a traversal
 * or symlink escape reads as unreadable), and the target is tried as
 * given, then with a `.md` suffix (the Obsidian extensionless-link
 * shape). Only `valid_from` / `valid_until` participate; an mtime is
 * never consulted, because an mtime is an assertion-time proxy, not
 * validity.
 *
 * `readable` is the caller's reach gate, when the append answers at a
 * caller reach (the MCP tools; the CLI verb runs at operator reach and
 * passes none). A candidate the gate withholds is treated EXACTLY like
 * an absent one - skipped like a missing file, so a source the caller
 * cannot read resolves no window and leaves no signal distinguishing
 * withheld from absent anywhere in the event or the response.
 */
function sourceFrontmatterWindow(
  vault: string,
  source: string,
  readable?: (rel: string) => boolean,
): SourceValidityWindow | null {
  // The vault path a source names: the anchored wikilink body when the
  // source is a wikilink, else the source verbatim - then alias/anchor
  // decoration off, folder segments and `.md` kept (the same body
  // discipline every vault-path resolver applies).
  const anchored = ANCHORED_WIKILINK_RE.exec(source.trim());
  const target = stripWikilinkDecoration(anchored !== null ? anchored[1]! : source.trim());
  if (target === "") return null;
  const candidates = target.endsWith(NOTE_EXTENSION) ? [target] : [target, target + NOTE_EXTENSION];
  for (const candidate of candidates) {
    let path: string;
    try {
      path = resolveNotePath(vault, candidate, { mustExist: false });
    } catch {
      return null; // lexical traversal or symlink escape: unreadable.
    }
    // Only a REGULAR file names a page: a directory at the bare
    // spelling is not the record and must not shadow its `.md` twin -
    // the same regular-file rule the artifact-ref view's isVaultFile
    // applies on the read side. An unreadable candidate is skipped like
    // a missing one.
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    // A page the caller may not read does not exist for them: skip it
    // like a missing file rather than refusing, so the extensionless
    // spelling's .md twin resolves exactly as it would had the bare
    // candidate never existed.
    if (readable !== undefined && !readable(vaultRelative(path, vault))) continue;
    // parseFrontmatter never raises on an unreadable file; it yields an
    // empty map, which reads as a windowless source.
    const [meta] = parseFrontmatter(path);
    const validFrom = frontmatterWindowBound(meta, VALID_FROM_KEY);
    const validUntil = frontmatterWindowBound(meta, VALID_UNTIL_KEY);
    if (validFrom === undefined && validUntil === undefined) return null;
    return { validFrom, validUntil };
  }
  return null;
}

function frontmatterWindowBound(meta: FrontmatterMap, key: string): string | undefined {
  const value = meta[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function truthDir(vault: string): string {
  return join(vault, "Brain", "truth");
}

export function truthStatePath(vault: string): string {
  return join(truthDir(vault), "state.json");
}

/**
 * The shard this device appends to.
 *
 * @throws {@link ConfigReadError} when the device-local config naming this
 *   device cannot be read. Propagated rather than falling back to the
 *   legacy un-sharded `claims.jsonl`: `resolveDeviceId` would otherwise
 *   mint and persist a fresh id over a config it could not read (see its
 *   docblock), and a silent shard switch would scatter one device's claims
 *   across two files with nothing recording why. The error names the file
 *   and the way out; the CLI verb wrapping this call prints it, and
 *   `O2B_DEVICE_ID` resolves the append without the file.
 */
export function claimShardPath(vault: string, configPath?: string): string {
  const deviceId = resolveDeviceId(configPath);
  const name = shardedFileName(CLAIMS_STEM, deviceId, JSONL_LEDGER_EXT);
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
  /**
   * Validity window start; absent keys mean windowless (contract item
   * 1). An absent bound resolves from the source record's frontmatter
   * `valid_from` when the source is readable at the caller's reach
   * (`AppendClaimOptions.readableSource`), and the resolved value is
   * frozen on the event; an unreadable, withheld or windowless source
   * leaves the event windowless.
   */
  readonly validFrom?: string;
  /** Validity window end, exclusive; resolved per bound like `validFrom`. */
  readonly validUntil?: string;
  /**
   * Presence-gated provenance tag (schema v1). This binary writes only
   * `agent_stated`; reads tolerate any non-empty string for forward
   * compatibility.
   */
  readonly extractor?: ClaimExtractor;
  readonly source: string;
}

export interface AppendClaimOptions {
  readonly configPath?: string;
  /**
   * The caller's reach gate over the source page, asked with the
   * vault-relative path of every candidate the source resolves to.
   * Absent at operator reach (the CLI verb): every source is
   * resolvable, today's behavior. Present on the MCP tools: a source
   * the caller cannot read is treated exactly like an absent one - no
   * window resolves from it, so the frozen event and the response
   * shape carry no signal distinguishing a withheld source from a
   * missing one (the window read must not become a frontmatter oracle
   * over pages the caller may not see).
   */
  readonly readableSource?: (rel: string) => boolean;
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
  opts: AppendClaimOptions = {},
): AppendClaimResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
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
  // Ingest window defaults (truth-correctable-time-aware, task 3):
  // explicit input wins outright; a bound the caller left open resolves
  // from the source record's frontmatter `valid_from` / `valid_until`
  // when the source is readable at the caller's reach, and the resolved
  // value is frozen on the event. An unreadable, withheld (see
  // `AppendClaimOptions.readableSource`) or windowless source stores a
  // windowless event - byte-identical to the pre-window ledger. The
  // source is read only when a bound is actually missing, so the fully
  // explicit path performs no extra I/O; mtime is never consulted.
  const needsSourceWindow = input.validFrom === undefined || input.validUntil === undefined;
  const resolved = resolveIngestWindow(
    input,
    needsSourceWindow ? sourceFrontmatterWindow(vault, input.source, opts.readableSource) : null,
  );
  // Validity windows (contract item 1): presence-gated, strictly
  // validated, and never guessed. An unparsable bound or an empty or
  // inverted window refuses the append by name - typed, so the tool
  // surfaces answer it as invalid params rather than an internal error.
  if (resolved.validFrom !== undefined && !isValidityPoint(resolved.validFrom)) {
    throw new ClaimWindowRefusal(
      `claim validFrom must be a bare ISO date or canonical UTC timestamp: ${JSON.stringify(resolved.validFrom)}`,
    );
  }
  if (resolved.validUntil !== undefined && !isValidityPoint(resolved.validUntil)) {
    throw new ClaimWindowRefusal(
      `claim validUntil must be a bare ISO date or canonical UTC timestamp: ${JSON.stringify(resolved.validUntil)}`,
    );
  }
  const window = validityWindowMs(resolved.validFrom, resolved.validUntil);
  if (
    window !== null &&
    window.fromMs !== null &&
    window.untilMs !== null &&
    window.fromMs >= window.untilMs
  ) {
    throw new ClaimWindowRefusal(
      `claim validity window is empty or inverted: validFrom ${JSON.stringify(resolved.validFrom)} does not parse before validUntil ${JSON.stringify(resolved.validUntil)}`,
    );
  }
  // Extractor (truth-correctable-time-aware, task 4): presence-gated,
  // strict on write (this binary emits exactly one tag), tolerant on
  // read. Annotation only - the tag never touches conflict semantics.
  if (input.extractor !== undefined && input.extractor !== "agent_stated") {
    throw new Error(`claim extractor must be agent_stated: ${JSON.stringify(input.extractor)}`);
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
    ...(resolved.validFrom !== undefined ? { validFrom: resolved.validFrom } : {}),
    ...(resolved.validUntil !== undefined ? { validUntil: resolved.validUntil } : {}),
    source: input.source.trim(),
    ...(input.extractor !== undefined ? { extractor: input.extractor } : {}),
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
    const shard = parseShardedName(name, CLAIMS_GRAMMAR);
    if (shard === null) continue;
    const shardId = shard.shardId;
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
  // Validity fields (contract item 1): tolerated when absent (old
  // lines), validated when present (new lines, schema v1). Unknown
  // keys stay ignored, so an older binary reading these lines degrades
  // to the assertion-time axis by construction.
  const rawValidFrom = obj["validFrom"];
  const rawValidUntil = obj["validUntil"];
  if (
    rawValidFrom !== undefined &&
    (typeof rawValidFrom !== "string" || !isValidityPoint(rawValidFrom))
  ) {
    warnings.push({
      path,
      lineNumber,
      message: `invalid claim validFrom: ${String(rawValidFrom)}`,
    });
    return null;
  }
  if (
    rawValidUntil !== undefined &&
    (typeof rawValidUntil !== "string" || !isValidityPoint(rawValidUntil))
  ) {
    warnings.push({
      path,
      lineNumber,
      message: `invalid claim validUntil: ${String(rawValidUntil)}`,
    });
    return null;
  }
  const validFrom = rawValidFrom as string | undefined;
  const validUntil = rawValidUntil as string | undefined;
  const window = validityWindowMs(validFrom, validUntil);
  if (
    window !== null &&
    window.fromMs !== null &&
    window.untilMs !== null &&
    window.fromMs >= window.untilMs
  ) {
    warnings.push({
      path,
      lineNumber,
      message: "invalid claim validity window: validFrom must parse before validUntil",
    });
    return null;
  }
  // Extractor (task 4): tolerated when absent, validated as a
  // non-empty string when present, passed through verbatim so a future
  // extractor value survives an upgrade cycle. Annotation only.
  const rawExtractor = obj["extractor"];
  if (
    rawExtractor !== undefined &&
    (typeof rawExtractor !== "string" || rawExtractor.trim() === "")
  ) {
    warnings.push({
      path,
      lineNumber,
      message: `invalid claim extractor: ${String(rawExtractor)}`,
    });
    return null;
  }
  const extractor = rawExtractor as ClaimExtractor | undefined;
  return Object.freeze({
    v: TRUTH_SCHEMA_VERSION,
    ts,
    agent: obj["agent"] as string,
    entity: obj["entity"] as string,
    aspect: obj["aspect"] as string,
    value: obj["value"] as string,
    valueKind,
    ...(quantity !== undefined ? { quantity } : {}),
    ...(validFrom !== undefined ? { validFrom } : {}),
    ...(validUntil !== undefined ? { validUntil } : {}),
    ...(extractor !== undefined ? { extractor } : {}),
    source: obj["source"] as string,
  });
}

export function writeTruthState(vault: string, state: TruthState): void {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
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

function isClaimEventLike(v: unknown): v is ClaimEvent {
  if (v === null || typeof v !== "object") return false;
  const row = v as Record<string, unknown>;
  return (
    row["v"] === TRUTH_SCHEMA_VERSION &&
    typeof row["ts"] === "string" &&
    ISO_UTC_TS_RE.test(row["ts"]) &&
    (["agent", "entity", "aspect", "value", "source"] as const).every(
      (key) => typeof row[key] === "string" && (row[key] as string).trim() !== "",
    ) &&
    (row["valueKind"] === "text" || row["valueKind"] === "quantity")
  );
}

function isClaimSuccession(v: unknown): v is ClaimSuccession {
  if (v === null || typeof v !== "object") return false;
  const row = v as Record<string, unknown>;
  return (
    typeof row["entity"] === "string" &&
    typeof row["aspect"] === "string" &&
    isClaimEventLike(row["predecessor"]) &&
    isClaimEventLike(row["successor"]) &&
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
    // Successions are presence-gated (contract item 1): absent is the
    // normal windowless shape, present must validate, and a corrupt
    // channel reads as null so the caller refolds from events.
    if (parsed.successions !== undefined) {
      if (!Array.isArray(parsed.successions)) return null;
      for (const succession of parsed.successions as ReadonlyArray<unknown>) {
        if (!isClaimSuccession(succession)) return null;
      }
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
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
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
    if (parseShardedName(name, CLAIMS_GRAMMAR) === null) continue;
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

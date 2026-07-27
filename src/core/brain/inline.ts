/**
 * `@osb` marker parser — the deterministic, no-LLM grammar shared
 * between §9 (vault scan) and §16 (session-text scan).
 *
 * Two surface forms, one shape on output. Both are recognised by
 * {@link discoverMarkers}, which walks a file's content line-by-line
 * tracking fenced-code-block state so markers inside non-`osb` fences
 * (Python / TypeScript / docs examples) are not mistakenly captured.
 *
 *   - Inline (single line, anchored at start-of-line):
 *
 *       @osb feedback negative topic=mocking principle="don't mock DB"
 *
 *   - Block (fenced code block whose info-string is `osb`):
 *
 *       ```osb
 *       kind: feedback
 *       signal: negative
 *       topic: t
 *       principle: long form text
 *       ```
 *
 * Both produce a {@link ParsedMarker} with the same field set. The
 * `shape` field disambiguates so the rewriter (§9) can re-emit the
 * sentinel correctly (`@osb✓ [[sig-id]] ...` for inline, info-string
 * flip to `osb-checked` for block).
 *
 * Strictness: a syntactically wrong marker (unknown `kind`, missing
 * required field, bad enum value) returns `null` from the
 * single-line / block parsers — the walker treats null as "this is
 * not a marker" and moves on. CLI `--strict` mode surfaces those
 * misses as warnings separately; the parser itself is silent.
 *
 * The one exception to that silence is a rejection attributable to a
 * NAMED field — a required field that is absent, or one given twice
 * where a single value is the only unambiguous reading. Those are also
 * reported as a {@link MarkerParseIssue} through the optional issue
 * sink both parsers accept, which is how a kind that routes into a
 * store (`fact`, `skill`) turns a marker an author clearly meant into
 * an explicit error naming the field instead of a silent drop.
 */

/**
 * The one kind whose validity is structural rather than a flat presence
 * check: a loop is resolved by the close-form decision table (see
 * {@link classifyLoop}), so it has no row in {@link REQUIRED_FIELDS}.
 */
const LOOP_KIND = "loop";

/** How many values a required field may carry before it turns ambiguous. */
type RequiredFieldArity = "single" | "repeatable";

/** Marker kinds validated by a flat required-field presence check. */
type RequiredFieldKind = "feedback" | "set" | "fact" | "skill";

/**
 * Required `key=value` fields per marker kind, and the arity each one
 * accepts. The single generalisation of the old feedback-specific
 * `topic` / `principle` hard-require, and the single source of the kind
 * vocabulary — {@link KNOWN_KINDS} is derived from these keys plus
 * {@link LOOP_KIND}, so a kind cannot be half-registered.
 *
 * The feedback row reproduces the historical requirement byte-for-byte;
 * the `set` row carries the write-back triple; the `fact` row carries
 * what `deriveFact` cannot default (a premise set and the derivation
 * level); the `skill` row carries what a reviewer needs in order to
 * judge a proposal (what the skill is called, and what it does).
 */
const REQUIRED_FIELDS: Record<RequiredFieldKind, Readonly<Record<string, RequiredFieldArity>>> = {
  feedback: { topic: "single", principle: "single" },
  set: { note: "single", field: "single", value: "single" },
  fact: { topic: "single", principle: "single", premise: "repeatable", level: "single" },
  skill: { name: "single", body: "single" },
};

/**
 * Optional `key=value` fields per marker kind, with the arity each one
 * accepts. Checked in the same pass as {@link REQUIRED_FIELDS} because a
 * field given twice where a single value is the only unambiguous reading
 * is ambiguous whether the field is required or not: `scope: coding`
 * followed by `scope: writing` names two destinations for one signal.
 * Refusing that on a required field while dropping it on an optional one
 * would write the signal unscoped and unroutable, which is the one
 * outcome the author cannot have meant.
 *
 * A key in neither row is collected and ignored, exactly as before - the
 * grammar has never rejected an unknown field.
 */
const OPTIONAL_FIELDS: Record<RequiredFieldKind, Readonly<Record<string, RequiredFieldArity>>> = {
  feedback: { scope: "single", agent: "single", note: "single", source: "repeatable" },
  set: {},
  fact: {},
  skill: {},
};

const KNOWN_KINDS: ReadonlySet<string> = new Set<string>([
  ...Object.keys(REQUIRED_FIELDS),
  LOOP_KIND,
]);
const KNOWN_SIGNALS: ReadonlyArray<string> = ["positive", "negative"];

export type MarkerKind = RequiredFieldKind | typeof LOOP_KIND;
export type MarkerSignal = "positive" | "negative";
export type MarkerShape = "inline" | "block";
export type LoopForm = "open" | "close";

/** A `key=value`-only body kind: everything except `feedback` and `loop`. */
type FieldOnlyKind = Exclude<RequiredFieldKind, "feedback">;

/**
 * True for a known kind whose body carries no positional token, so the
 * whole remainder is a `key=value` collection. Derived from the kind
 * vocabulary rather than from a second list, so a new row in
 * {@link REQUIRED_FIELDS} is routed here without another edit.
 */
function isFieldOnlyKind(kind: string): kind is FieldOnlyKind {
  return KNOWN_KINDS.has(kind) && kind !== "feedback" && kind !== LOOP_KIND;
}

/**
 * One shape for every marker kind. Per-kind fields are optional and
 * additive so existing feedback consumers keep compiling unchanged; a
 * given marker only ever carries the fields for its own `kind`. Use
 * {@link isFeedbackMarker} to narrow to the feedback field set before
 * reading `topic` / `signal` / `principle`.
 */
export interface ParsedMarker {
  readonly kind: MarkerKind;
  // ── feedback (kind === "feedback") and fact (kind === "fact") ──
  /** The rule's subject and text; both rule-bearing kinds carry them. */
  readonly topic?: string;
  readonly principle?: string;
  // ── feedback (kind === "feedback") ──
  readonly signal?: MarkerSignal;
  readonly scope?: string;
  readonly agent?: string;
  /** Feedback free-note, or the `set` target note (`note=` in both). */
  readonly note?: string;
  readonly source?: ReadonlyArray<string>;
  // ── loop (kind === "loop") ──
  /** `open` for a live loop, `close` for the structural close token. */
  readonly loop?: LoopForm;
  /** Open-loop free text (absent on a close token). */
  readonly text?: string;
  /** Explicit or close-token loop id (optional on open loops). */
  readonly id?: string;
  // ── set (kind === "set") ──
  readonly field?: string;
  readonly value?: string;
  // ── fact (kind === "fact") ──
  /** Premise preference ids the conclusion derives from, in source order. */
  readonly premise?: ReadonlyArray<string>;
  /** Derivation trust level, verbatim; `deriveFact` owns that vocabulary. */
  readonly level?: string;
  // ── skill (kind === "skill") ──
  /** Human-facing name of the proposed skill; also its identity key. */
  readonly name?: string;
  /** What the skill does, carried verbatim into the proposal body. */
  readonly body?: string;
  // ── common ──
  /** 1-based line number where the marker starts in the source file. */
  readonly originLine: number;
  /** Verbatim text of the source marker — for rewriter / audit. */
  readonly originText: string;
  readonly shape: MarkerShape;
}

/**
 * A {@link ParsedMarker} narrowed to `kind === "feedback"`, where the
 * feedback fields are guaranteed present. Produced by
 * {@link isFeedbackMarker}.
 */
export type FeedbackMarker = ParsedMarker & {
  readonly kind: "feedback";
  readonly signal: MarkerSignal;
  readonly topic: string;
  readonly principle: string;
};

/**
 * Type guard: true only for feedback markers. Signal-emitting consumers
 * (`scanInline`, `captureMarkers`, `importSession`) filter on this so
 * markers of other kinds are never turned into signals — loops are
 * live-derived, set markers belong to the guarded write-back verb, and
 * fact / skill markers have their own destinations.
 */
export function isFeedbackMarker(marker: ParsedMarker): marker is FeedbackMarker {
  return marker.kind === "feedback";
}

/**
 * A {@link ParsedMarker} narrowed to `kind === "fact"`. Routed through
 * the derive-fact path, which commits it as an unconfirmed preference.
 */
export type FactMarker = ParsedMarker & {
  readonly kind: "fact";
  readonly topic: string;
  readonly principle: string;
  readonly premise: ReadonlyArray<string>;
  readonly level: string;
};

/** Type guard: true only for fact markers. */
export function isFactMarker(marker: ParsedMarker): marker is FactMarker {
  return marker.kind === "fact";
}

/**
 * A {@link ParsedMarker} narrowed to `kind === "skill"`. Routed to the
 * pending skill-proposal queue, never to accepted.
 */
export type SkillMarker = ParsedMarker & {
  readonly kind: "skill";
  readonly name: string;
  readonly body: string;
};

/** Type guard: true only for skill markers. */
export function isSkillMarker(marker: ParsedMarker): marker is SkillMarker {
  return marker.kind === "skill";
}

/**
 * A rejection attributable to a named field, reported through the
 * optional issue sink both parsers accept. The rejection itself is
 * unchanged — the parsers still return null — so a kind that does not
 * route anywhere behaves exactly as before.
 */
export interface MarkerParseIssue {
  readonly kind: MarkerKind;
  readonly shape: MarkerShape;
  /** 1-based line the rejected marker starts on. */
  readonly originLine: number;
  /** Required fields that were absent or empty. */
  readonly missingFields: ReadonlyArray<string>;
  /**
   * Single-valued fields given more than once, which is ambiguous.
   * Required and optional alike: an optional field repeated is no more
   * readable than a required one repeated.
   */
  readonly duplicateFields: ReadonlyArray<string>;
  /** Operator-facing message naming every field in the two lists above. */
  readonly message: string;
}

/** Sink the parsers report a {@link MarkerParseIssue} to. */
export type MarkerIssueSink = (issue: MarkerParseIssue) => void;

/**
 * Check a collected field set against the kind's required and optional
 * field rows. Returns true when the marker may be built; otherwise
 * reports one issue naming every offending field and returns false.
 *
 * A `single` field must be exactly one non-empty value: an array means
 * the key was given twice and there is no unambiguous reading of that,
 * which is why a repeated `set` note / field / value has always been
 * rejected. A `repeatable` field must carry at least one non-empty
 * value. Only a required field can be missing; the ambiguity check runs
 * over both rows (see {@link OPTIONAL_FIELDS}).
 */
function fieldsUsable(input: {
  readonly kind: RequiredFieldKind;
  readonly fields: Record<string, string | string[]>;
  readonly originLine: number;
  readonly shape: MarkerShape;
  readonly onIssue?: MarkerIssueSink | undefined;
}): boolean {
  const { kind, fields, originLine, shape, onIssue } = input;
  const missingFields: string[] = [];
  const duplicateFields: string[] = [];
  for (const [key, arity] of Object.entries(REQUIRED_FIELDS[kind])) {
    const value = fields[key];
    if (arity === "repeatable") {
      const values = toValueList(value);
      if (values.length === 0 || values.some((entry) => entry.length === 0))
        missingFields.push(key);
      continue;
    }
    if (Array.isArray(value)) {
      duplicateFields.push(key);
      continue;
    }
    if (typeof value !== "string" || value.length === 0) missingFields.push(key);
  }
  // An optional field is never missing. A repeat of a single-valued one
  // is exactly as unreadable as it is on a required field, so it lands in
  // the same list and produces the same named refusal.
  for (const [key, arity] of Object.entries(OPTIONAL_FIELDS[kind])) {
    if (arity === "repeatable") continue;
    if (Array.isArray(fields[key])) duplicateFields.push(key);
  }
  if (missingFields.length === 0 && duplicateFields.length === 0) return true;
  onIssue?.({
    kind,
    shape,
    originLine,
    missingFields: Object.freeze([...missingFields]),
    duplicateFields: Object.freeze([...duplicateFields]),
    message: fieldIssueMessage(kind, originLine, missingFields, duplicateFields),
  });
  return false;
}

function fieldIssueMessage(
  kind: RequiredFieldKind,
  originLine: number,
  missingFields: ReadonlyArray<string>,
  duplicateFields: ReadonlyArray<string>,
): string {
  const parts: string[] = [];
  if (missingFields.length > 0) {
    parts.push(`${plural("missing required field", missingFields)}: ${missingFields.join(", ")}`);
  }
  if (duplicateFields.length > 0) {
    parts.push(
      `${plural("repeated single-valued field", duplicateFields)}: ${duplicateFields.join(", ")}`,
    );
  }
  return `@osb ${kind} marker at line ${originLine} is not usable - ${parts.join("; ")}`;
}

function plural(label: string, fields: ReadonlyArray<string>): string {
  return fields.length === 1 ? label : `${label}s`;
}

/** Normalise a collected field value to the list of values it carries. */
function toValueList(value: string | string[] | undefined): ReadonlyArray<string> {
  if (Array.isArray(value)) return value;
  return typeof value === "string" ? [value] : [];
}

/**
 * Build the marker for a `key=value`-only kind. Shared by the inline
 * and block parsers so the two shapes cannot disagree about which field
 * lands where; the required-field check has already passed.
 */
function buildFieldMarker(input: {
  readonly kind: FieldOnlyKind;
  readonly fields: Record<string, string | string[]>;
  readonly originLine: number;
  readonly originText: string;
  readonly shape: MarkerShape;
}): ParsedMarker {
  const { kind, fields, originLine, originText, shape } = input;
  const common = { originLine, originText, shape };
  switch (kind) {
    case "set":
      return {
        kind,
        note: fields["note"] as string,
        field: fields["field"] as string,
        value: fields["value"] as string,
        ...common,
      };
    case "fact":
      return {
        kind,
        topic: fields["topic"] as string,
        principle: fields["principle"] as string,
        premise: Object.freeze([...toValueList(fields["premise"])]),
        level: fields["level"] as string,
        ...common,
      };
    case "skill":
      return {
        kind,
        name: fields["name"] as string,
        body: fields["body"] as string,
        ...common,
      };
  }
}

/**
 * Build a feedback marker from a validated signal token and field set.
 * Shared by both shapes for the same reason as {@link buildFieldMarker}.
 */
function buildFeedbackMarker(input: {
  readonly signal: string;
  readonly fields: Record<string, string | string[]>;
  readonly originLine: number;
  readonly originText: string;
  readonly shape: MarkerShape;
}): ParsedMarker {
  const { signal, fields, originLine, originText, shape } = input;
  return {
    kind: "feedback",
    signal: signal as MarkerSignal,
    topic: fields["topic"] as string,
    principle: fields["principle"] as string,
    ...(typeof fields["scope"] === "string" ? { scope: fields["scope"] } : {}),
    ...(typeof fields["agent"] === "string" ? { agent: fields["agent"] } : {}),
    ...(typeof fields["note"] === "string" ? { note: fields["note"] } : {}),
    ...(fields["source"] !== undefined ? { source: [...toValueList(fields["source"])] } : {}),
    originLine,
    originText,
    shape,
  };
}

/**
 * Apply the fixed close-form decision table to a tokenised loop body,
 * shared by the inline and block parsers:
 *
 *   (a) first token `close` + exactly one id + nothing else -> close;
 *   (b) first token `close` + id + extra content            -> reject;
 *   (c) anything else -> open loop, text = remaining tokens joined,
 *       optional single id; empty text -> reject.
 */
function classifyLoop(input: {
  readonly words: ReadonlyArray<string>;
  readonly idValue: string | null;
  readonly idCount: number;
  readonly originLine: number;
  readonly originText: string;
  readonly shape: MarkerShape;
}): ParsedMarker | null {
  const { words, idValue, idCount, originLine, originText, shape } = input;
  // A present-but-empty `id` is unusable for both forms: a close token
  // cannot reference "", and an open loop must not be named after an empty
  // id. Reject at parse level rather than emit a broken marker.
  if (idCount === 1 && (idValue === null || idValue.length === 0)) return null;
  if (words.length >= 1 && words[0] === "close" && idCount >= 1) {
    if (words.length === 1 && idCount === 1 && idValue !== null) {
      return { kind: LOOP_KIND, loop: "close", id: idValue, originLine, originText, shape };
    }
    // `close` with extra free text or more than one id - ambiguous.
    return null;
  }
  // Open loop. A second id pair is ambiguous; reject rather than guess.
  if (idCount > 1) return null;
  const text = words.join(" ").trim();
  if (text.length === 0) return null;
  return {
    kind: LOOP_KIND,
    loop: "open",
    text,
    ...(idValue !== null && idCount === 1 ? { id: idValue } : {}),
    originLine,
    originText,
    shape,
  };
}

export interface MarkerDiscoveryResult {
  readonly markers: ReadonlyArray<ParsedMarker>;
  /**
   * Count of syntactically-recognisable marker attempts that failed
   * validation. Plain prose such as "@osb is great" is not counted;
   * "@osb feedback ..." with missing / invalid required fields is.
   */
  readonly malformed: number;
  /**
   * The subset of those failures attributable to a named field, in
   * document order. A kind that routes into a store turns its own
   * issues into explicit operator-facing errors; `malformed` still
   * counts every failure, named or not.
   */
  readonly issues: ReadonlyArray<MarkerParseIssue>;
}

// ── Inline parser ───────────────────────────────────────────────────────────

/**
 * Token-by-token state machine. Accepts:
 *   - whitespace at start of line
 *   - `@osb` literal
 *   - a positional `kind` token (must be in KNOWN_KINDS)
 *   - the remaining grammar per kind:
 *       feedback -> positional `signal` (KNOWN_SIGNALS) then any number
 *                   of `key=value` pairs (topic + principle required);
 *       loop     -> free text plus an optional `id=` pair, resolved by
 *                   the close-form decision table (see classifyLoop);
 *       any other kind -> `key=value` pairs only, validated against its
 *                   {@link REQUIRED_FIELDS} row.
 *   - a `value` is either unquoted (no whitespace) or `"..."` with `\"`
 *     and `\\` escapes.
 *
 * Returns null on any structural deviation - the walker treats null as
 * "not a marker" and moves on. When the deviation is a named field,
 * `onIssue` additionally receives a {@link MarkerParseIssue}.
 */
export function parseInlineMarker(
  line: string,
  lineNo: number,
  onIssue?: MarkerIssueSink,
): ParsedMarker | null {
  const originText = line;
  let i = 0;
  const n = line.length;

  const skipWs = (): void => {
    while (i < n && (line[i] === " " || line[i] === "\t")) i++;
  };

  skipWs();
  // Must start with `@osb` and a whitespace boundary so `@osb✓` and
  // `@osbar` don't qualify.
  if (!line.startsWith("@osb", i)) return null;
  i += 4;
  if (i < n && line[i] !== " " && line[i] !== "\t") return null;
  skipWs();

  // Positional `kind`.
  const kindToken = readBareToken();
  if (kindToken === null || !KNOWN_KINDS.has(kindToken)) return null;
  skipWs();

  if (kindToken === LOOP_KIND) return parseLoopBody();
  if (isFieldOnlyKind(kindToken)) return parseFieldBody(kindToken);

  // ----- feedback (positional signal + key=value pairs) -------------------
  const signalToken = readBareToken();
  if (signalToken === null || !KNOWN_SIGNALS.includes(signalToken)) return null;
  skipWs();

  const fields = collectFields();
  if (fields === null) return null;
  if (
    !fieldsUsable({
      kind: "feedback",
      fields,
      originLine: lineNo,
      shape: "inline",
      onIssue,
    })
  ) {
    return null;
  }

  return buildFeedbackMarker({
    signal: signalToken,
    fields,
    originLine: lineNo,
    originText,
    shape: "inline",
  });

  // ----- per-kind bodies ---------------------------------------------------
  function parseFieldBody(kind: FieldOnlyKind): ParsedMarker | null {
    const bodyFields = collectFields();
    if (bodyFields === null) return null;
    if (
      !fieldsUsable({
        kind,
        fields: bodyFields,
        originLine: lineNo,
        shape: "inline",
        onIssue,
      })
    ) {
      return null;
    }
    return buildFieldMarker({
      kind,
      fields: bodyFields,
      originLine: lineNo,
      originText,
      shape: "inline",
    });
  }

  function parseLoopBody(): ParsedMarker | null {
    // Tokenise the remainder into bare free-text words plus at most one
    // structural `id=` pair. Only a leading `id=` is treated specially;
    // any other `word=...` stays free text.
    const words: string[] = [];
    let idValue: string | null = null;
    let idCount = 0;
    while (i < n) {
      skipWs();
      if (i >= n) break;
      if (line.startsWith("id=", i)) {
        i += 3; // consume `id=`
        const v = readValue();
        if (v === null) return null;
        idValue = v;
        idCount++;
        continue;
      }
      const word = readWord();
      if (word === null) return null;
      words.push(word);
    }
    return classifyLoop({
      words,
      idValue,
      idCount,
      originLine: lineNo,
      originText,
      shape: "inline",
    });
  }

  // ----- nested readers ----------------------------------------------------
  function collectFields(): Record<string, string | string[]> | null {
    const collected: Record<string, string | string[]> = {};
    while (i < n) {
      const key = readKey();
      if (key === null) return null;
      if (i >= n || line[i] !== "=") return null;
      i++; // consume '='
      const value = readValue();
      if (value === null) return null;
      collectField(collected, key, value);
      skipWs();
    }
    return collected;
  }
  function readBareToken(): string | null {
    const start = i;
    while (i < n && line[i] !== " " && line[i] !== "\t" && line[i] !== "=") i++;
    if (i === start) return null;
    return line.slice(start, i);
  }
  function readWord(): string | null {
    // Whole whitespace-delimited word verbatim (brackets, punctuation,
    // and any `=` past position 0 are part of the loop's free text).
    const start = i;
    while (i < n && line[i] !== " " && line[i] !== "\t") i++;
    if (i === start) return null;
    return line.slice(start, i);
  }
  function readKey(): string | null {
    // Identifier head must be alpha or underscore; subsequent chars
    // also allow digits and `-`. Testing the per-char class explicitly
    // (rather than the full-key regex per-char) avoids terminating
    // parsing at the first hyphen or digit after position 0.
    const start = i;
    if (i >= n || !/[A-Za-z_]/.test(line[i]!)) return null;
    i++;
    while (i < n && /[A-Za-z0-9_-]/.test(line[i]!)) i++;
    return line.slice(start, i);
  }
  function readValue(): string | null {
    if (i >= n) return null;
    if (line[i] === '"') {
      // Quoted with backslash escapes.
      i++; // consume opening "
      let out = "";
      while (i < n) {
        const ch = line[i]!;
        if (ch === "\\") {
          if (i + 1 >= n) return null;
          const next = line[i + 1]!;
          if (next === '"' || next === "\\") {
            out += next;
            i += 2;
            continue;
          }
          // Unknown escape: pass through literally.
          out += ch;
          i++;
          continue;
        }
        if (ch === '"') {
          i++; // consume closing "
          return out;
        }
        out += ch;
        i++;
      }
      return null; // unterminated string
    }
    // Unquoted: read until whitespace or EOL. Brackets are part of the
    // token (so `source=[[Daily/2026-05-14]]` round-trips intact).
    const start = i;
    while (i < n && line[i] !== " " && line[i] !== "\t") i++;
    return line.slice(start, i);
  }
}

/**
 * Record one occurrence of `key`, promoting a repeat to an array. Both
 * shapes funnel through this, so `premise=a premise=b` and two
 * `premise:` lines collect identically, and a repeated single-valued
 * field is visible to {@link fieldsUsable} as ambiguity rather
 * than silently last-winning.
 */
function collectField(
  collected: Record<string, string | string[]>,
  key: string,
  value: string,
): void {
  const prev = collected[key];
  if (prev === undefined) {
    collected[key] = value;
    return;
  }
  collected[key] = Array.isArray(prev) ? [...prev, value] : [prev, value];
}

// ── Block parser ────────────────────────────────────────────────────────────

/**
 * Parse the body of a fenced `osb` block (everything between the open
 * and close fences, exclusive). The body follows a very small subset
 * of YAML: `key: value` per line, optional `# comments`, optional
 * blank lines. A `key: |` block scalar carries a multi-line value —
 * used by the feedback `note` and by the `skill` body.
 *
 * Returns null on the same conditions as inline parsing (unknown kind,
 * missing required field, bad enum), reporting named-field rejections
 * through `onIssue`.
 */
export function parseBlockMarker(
  body: string,
  fenceStartLine: number,
  onIssue?: MarkerIssueSink,
): ParsedMarker | null {
  const lines = body.split("\n");
  const fields: Record<string, string | string[]> = {};
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]!;
    const stripped = raw.trim();
    if (stripped === "" || stripped.startsWith("#")) {
      i++;
      continue;
    }
    const eq = stripped.indexOf(":");
    if (eq < 0) {
      i++;
      continue; // tolerate stray lines silently
    }
    const key = stripped.slice(0, eq).trim();
    const value: string = stripped.slice(eq + 1).trim();
    if (value === "|") {
      // Multi-line block scalar. Consume indented subsequent lines.
      const parts: string[] = [];
      i++;
      while (i < lines.length) {
        const nxt = lines[i]!;
        if (nxt.startsWith("  ")) {
          parts.push(nxt.slice(2));
          i++;
          continue;
        }
        if (nxt.trim() === "") {
          parts.push("");
          i++;
          continue;
        }
        break;
      }
      // Strip trailing empty lines that bled from blank rows.
      while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
      collectField(fields, key, parts.join("\n"));
      continue;
    }
    collectField(fields, key, stripQuotes(value));
    i++;
  }

  const kind = typeof fields["kind"] === "string" ? fields["kind"] : null;
  if (kind === null || !KNOWN_KINDS.has(kind)) return null;

  if (kind === LOOP_KIND) {
    // Loop block: a required `text:` free-text field plus an optional
    // `id:` field, run through the same close-form decision table as
    // the inline form (the id is a field here, not inline in the text).
    const textField = typeof fields["text"] === "string" ? fields["text"] : null;
    if (textField === null) return null;
    const idField = typeof fields["id"] === "string" ? fields["id"] : null;
    const words = textField
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0);
    // Presence-based (not non-empty-based): an empty `id:` still counts as
    // one occurrence so classifyLoop rejects it, and a duplicate `id:`
    // drives idCount > 1 so the ambiguous marker is rejected too.
    const idCount = toValueList(fields["id"]).length;
    return classifyLoop({
      words,
      idValue: idCount === 1 ? idField : null,
      idCount,
      originLine: fenceStartLine,
      originText: body,
      shape: "block",
    });
  }

  if (isFieldOnlyKind(kind)) {
    // Fail-closed on a repeated single-valued required field: a repeated
    // `set` note / field / value would mutate the wrong note, and a
    // repeated `fact` topic would file the conclusion under the wrong rule.
    if (!fieldsUsable({ kind, fields, originLine: fenceStartLine, shape: "block", onIssue })) {
      return null;
    }
    return buildFieldMarker({
      kind,
      fields,
      originLine: fenceStartLine,
      originText: body,
      shape: "block",
    });
  }

  // Feedback.
  const signal = typeof fields["signal"] === "string" ? fields["signal"] : null;
  if (signal === null || !KNOWN_SIGNALS.includes(signal)) return null;
  if (
    !fieldsUsable({
      kind: "feedback",
      fields,
      originLine: fenceStartLine,
      shape: "block",
      onIssue,
    })
  ) {
    return null;
  }

  return buildFeedbackMarker({
    signal,
    fields,
    originLine: fenceStartLine,
    originText: body,
    shape: "block",
  });
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

// ── File-level discovery ────────────────────────────────────────────────────

const FENCE_RE = /^```([A-Za-z0-9_-]*)\s*$/;

/**
 * Walk the file content line-by-line, returning every marker found in
 * document order. Tracks fenced-code-block state so:
 *
 *   - markers inside fences whose info-string is not `osb` are skipped
 *     (technical documentation that contains literal `@osb feedback`
 *     example markers stays inert);
 *   - blocks whose info-string is `osb-checked` are skipped (already
 *     processed by a prior `scan-inline` run);
 *   - inline lines starting with `@osb✓` (the inline sentinel) are
 *     skipped.
 */
export function discoverMarkersDetailed(content: string): MarkerDiscoveryResult {
  const lines = content.split("\n");
  const out: ParsedMarker[] = [];
  const issues: MarkerParseIssue[] = [];
  const onIssue: MarkerIssueSink = (issue) => {
    issues.push(issue);
  };
  let malformed = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fenceMatch = FENCE_RE.exec(line.trim());
    if (fenceMatch) {
      const infoString = fenceMatch[1] ?? "";
      const fenceStartLineNumber = i + 1; // 1-based
      // Collect body up to the next ``` line.
      const bodyLines: string[] = [];
      let closed = false;
      i++;
      while (i < lines.length) {
        const inner = lines[i]!;
        if (inner.trim().startsWith("```")) {
          i++; // consume closing fence
          closed = true;
          break;
        }
        bodyLines.push(inner);
        i++;
      }
      if (infoString === "osb") {
        if (!closed) {
          // Unterminated `osb` fence — treat as malformed so trailing
          // document content isn't accidentally parsed as a marker.
          malformed++;
          continue;
        }
        const parsed = parseBlockMarker(bodyLines.join("\n"), fenceStartLineNumber, onIssue);
        if (parsed) out.push(parsed);
        else malformed++;
      }
      // `osb-checked` and every other info-string: skip silently.
      continue;
    }
    // Inline path. Skip the sentinel form `@osb✓ ...` so a re-run
    // doesn't re-process a previously captured marker.
    const trimmed = line.trimStart();
    if (trimmed.startsWith("@osb✓")) {
      i++;
      continue;
    }
    if (trimmed.startsWith("@osb")) {
      const parsed = parseInlineMarker(line, i + 1, onIssue);
      if (parsed) out.push(parsed);
      else if (looksLikeInlineMarkerAttempt(trimmed)) malformed++;
    }
    i++;
  }
  return Object.freeze({
    markers: Object.freeze(out),
    malformed,
    issues: Object.freeze(issues),
  });
}

export function discoverMarkers(content: string): ReadonlyArray<ParsedMarker> {
  return discoverMarkersDetailed(content).markers;
}

function looksLikeInlineMarkerAttempt(trimmedLine: string): boolean {
  if (!trimmedLine.startsWith("@osb")) return false;
  const rest = trimmedLine.slice(4);
  if (rest.length > 0 && rest[0] !== " " && rest[0] !== "\t") return false;
  const kind = rest.trimStart().split(/[ \t=]/, 1)[0] ?? "";
  return KNOWN_KINDS.has(kind);
}

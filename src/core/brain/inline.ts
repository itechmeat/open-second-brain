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
 */

const KNOWN_KINDS: ReadonlySet<string> = new Set(["feedback", "loop", "set"]);
const KNOWN_SIGNALS: ReadonlyArray<string> = ["positive", "negative"];

/**
 * Required `key=value` fields per marker kind. The single generalisation
 * of the old feedback-specific `topic` / `principle` hard-require. The
 * feedback row reproduces the historical requirement byte-for-byte; the
 * `set` row adds the write-back triple. `loop` is absent here because it
 * is validated structurally by the close-form decision table, not by a
 * flat presence check.
 */
const REQUIRED_FIELDS: Record<"feedback" | "set", ReadonlyArray<string>> = {
  feedback: ["topic", "principle"],
  set: ["note", "field", "value"],
};

export type MarkerKind = "feedback" | "loop" | "set";
export type MarkerSignal = "positive" | "negative";
export type MarkerShape = "inline" | "block";
export type LoopForm = "open" | "close";

/**
 * One shape for every marker kind. Per-kind fields are optional and
 * additive so existing feedback consumers keep compiling unchanged; a
 * given marker only ever carries the fields for its own `kind`. Use
 * {@link isFeedbackMarker} to narrow to the feedback field set before
 * reading `topic` / `signal` / `principle`.
 */
export interface ParsedMarker {
  readonly kind: MarkerKind;
  // ── feedback (kind === "feedback") ──
  readonly signal?: MarkerSignal;
  readonly topic?: string;
  readonly principle?: string;
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
 * loop / set markers are never consumed, rewritten, or turned into
 * signals — loops are live-derived and set markers belong to the
 * guarded write-back verb.
 */
export function isFeedbackMarker(marker: ParsedMarker): marker is FeedbackMarker {
  return marker.kind === "feedback";
}

function requiredFieldsPresent(
  kind: "feedback" | "set",
  fields: Record<string, string | string[]>,
): boolean {
  for (const key of REQUIRED_FIELDS[kind]) {
    const value = fields[key];
    // Non-empty string only. An array (repeated key) or empty value
    // fails - matching the historical `!topic || !principle` reject.
    if (typeof value !== "string" || value.length === 0) return false;
  }
  return true;
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
  if (words.length >= 1 && words[0] === "close" && idCount >= 1) {
    if (words.length === 1 && idCount === 1 && idValue !== null) {
      return { kind: "loop", loop: "close", id: idValue, originLine, originText, shape };
    }
    // `close` with extra free text or more than one id - ambiguous.
    return null;
  }
  // Open loop. A second id pair is ambiguous; reject rather than guess.
  if (idCount > 1) return null;
  const text = words.join(" ").trim();
  if (text.length === 0) return null;
  return {
    kind: "loop",
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
 *       set      -> `key=value` pairs (note + field + value required);
 *       loop     -> free text plus an optional `id=` pair, resolved by
 *                   the close-form decision table (see classifyLoop).
 *   - a `value` is either unquoted (no whitespace) or `"..."` with `\"`
 *     and `\\` escapes.
 *
 * Returns null on any structural deviation - the walker treats null as
 * "not a marker" and moves on.
 */
export function parseInlineMarker(line: string, lineNo: number): ParsedMarker | null {
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

  if (kindToken === "loop") return parseLoopBody();
  if (kindToken === "set") return parseSetBody();

  // ----- feedback (positional signal + key=value pairs) -------------------
  const signalToken = readBareToken();
  if (signalToken === null || !KNOWN_SIGNALS.includes(signalToken)) return null;
  skipWs();

  const fields = collectFields();
  if (fields === null) return null;
  if (!requiredFieldsPresent("feedback", fields)) return null;

  const out: ParsedMarker = {
    kind: "feedback",
    signal: signalToken as MarkerSignal,
    topic: fields["topic"] as string,
    principle: fields["principle"] as string,
    ...(typeof fields["scope"] === "string" ? { scope: fields["scope"] } : {}),
    ...(typeof fields["agent"] === "string" ? { agent: fields["agent"] } : {}),
    ...(typeof fields["note"] === "string" ? { note: fields["note"] } : {}),
    ...(fields["source"] !== undefined
      ? {
          source: Array.isArray(fields["source"])
            ? [...(fields["source"] as string[])]
            : [fields["source"] as string],
        }
      : {}),
    originLine: lineNo,
    originText,
    shape: "inline",
  };
  return out;

  // ----- per-kind bodies ---------------------------------------------------
  function parseSetBody(): ParsedMarker | null {
    const setFields = collectFields();
    if (setFields === null) return null;
    if (!requiredFieldsPresent("set", setFields)) return null;
    return {
      kind: "set",
      note: setFields["note"] as string,
      field: setFields["field"] as string,
      value: setFields["value"] as string,
      originLine: lineNo,
      originText,
      shape: "inline",
    };
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
      if (collected[key] === undefined) {
        collected[key] = value;
      } else {
        // Second occurrence: promote to array. (Rare in inline form;
        // mainly there so `source=a source=b` works.)
        const prev = collected[key];
        collected[key] = Array.isArray(prev) ? [...prev, value] : [prev, value];
      }
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

// ── Block parser ────────────────────────────────────────────────────────────

/**
 * Parse the body of a fenced `osb` block (everything between the open
 * and close fences, exclusive). The body follows a very small subset
 * of YAML: `key: value` per line, optional `# comments`, optional
 * blank lines. Multi-line `note: |` is supported for the `note` field
 * specifically — the only field where multiple lines are common.
 *
 * Returns null on the same conditions as inline parsing (unknown kind,
 * missing required field, bad enum).
 */
export function parseBlockMarker(body: string, fenceStartLine: number): ParsedMarker | null {
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
    let value: string = stripped.slice(eq + 1).trim();
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
      fields[key] = parts.join("\n");
      continue;
    }
    fields[key] = stripQuotes(value);
    i++;
  }

  const kind = typeof fields["kind"] === "string" ? fields["kind"] : null;
  if (kind === null || !KNOWN_KINDS.has(kind)) return null;

  if (kind === "loop") {
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
    const idCount = idField !== null && idField.length > 0 ? 1 : 0;
    return classifyLoop({
      words,
      idValue: idCount === 1 ? idField : null,
      idCount,
      originLine: fenceStartLine,
      originText: body,
      shape: "block",
    });
  }

  if (kind === "set") {
    if (!requiredFieldsPresent("set", fields)) return null;
    return {
      kind: "set",
      note: fields["note"] as string,
      field: fields["field"] as string,
      value: fields["value"] as string,
      originLine: fenceStartLine,
      originText: body,
      shape: "block",
    };
  }

  // Feedback.
  const signal = typeof fields["signal"] === "string" ? fields["signal"] : null;
  if (signal === null || !KNOWN_SIGNALS.includes(signal)) return null;
  if (!requiredFieldsPresent("feedback", fields)) return null;

  return {
    kind: "feedback",
    signal: signal as MarkerSignal,
    topic: fields["topic"] as string,
    principle: fields["principle"] as string,
    ...(typeof fields["scope"] === "string" ? { scope: fields["scope"] } : {}),
    ...(typeof fields["agent"] === "string" ? { agent: fields["agent"] } : {}),
    ...(typeof fields["note"] === "string" ? { note: fields["note"] } : {}),
    ...(fields["source"] !== undefined
      ? {
          source: Array.isArray(fields["source"])
            ? [...(fields["source"] as string[])]
            : [fields["source"] as string],
        }
      : {}),
    originLine: fenceStartLine,
    originText: body,
    shape: "block",
  };
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
        const parsed = parseBlockMarker(bodyLines.join("\n"), fenceStartLineNumber);
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
      const parsed = parseInlineMarker(line, i + 1);
      if (parsed) out.push(parsed);
      else if (looksLikeInlineMarkerAttempt(trimmed)) malformed++;
    }
    i++;
  }
  return Object.freeze({
    markers: Object.freeze(out),
    malformed,
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

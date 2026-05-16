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

const KNOWN_KINDS: ReadonlyArray<string> = ["feedback"];
const KNOWN_SIGNALS: ReadonlyArray<string> = ["positive", "negative"];

export type MarkerKind = "feedback";
export type MarkerSignal = "positive" | "negative";
export type MarkerShape = "inline" | "block";

export interface ParsedMarker {
  readonly kind: MarkerKind;
  readonly signal: MarkerSignal;
  readonly topic: string;
  readonly principle: string;
  readonly scope?: string;
  readonly agent?: string;
  readonly note?: string;
  readonly source?: ReadonlyArray<string>;
  /** 1-based line number where the marker starts in the source file. */
  readonly originLine: number;
  /** Verbatim text of the source marker — for rewriter / audit. */
  readonly originText: string;
  readonly shape: MarkerShape;
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
 *   - two positional tokens: `kind` (must be in KNOWN_KINDS) and
 *     `signal` (must be in KNOWN_SIGNALS)
 *   - any number of `key=value` pairs. `value` is either unquoted
 *     (no whitespace) or `"..."` with `\"` and `\\` escapes.
 *
 * Returns null on any structural deviation. Required fields
 * (`topic`, `principle`) must be present.
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
  if (kindToken === null || !KNOWN_KINDS.includes(kindToken)) return null;
  skipWs();

  // Positional `signal`.
  const signalToken = readBareToken();
  if (signalToken === null || !KNOWN_SIGNALS.includes(signalToken)) return null;
  skipWs();

  const fields: Record<string, string | string[]> = {};
  while (i < n) {
    const key = readKey();
    if (key === null) return null;
    if (i >= n || line[i] !== "=") return null;
    i++; // consume '='
    const value = readValue();
    if (value === null) return null;
    if (fields[key] === undefined) {
      fields[key] = value;
    } else {
      // Second occurrence: promote to array. (Rare in inline form;
      // mainly there so `source=a source=b` works.)
      const prev = fields[key];
      fields[key] = Array.isArray(prev) ? [...prev, value] : [prev, value];
    }
    skipWs();
  }

  const topic = typeof fields["topic"] === "string" ? fields["topic"] : null;
  const principle =
    typeof fields["principle"] === "string" ? fields["principle"] : null;
  if (!topic || !principle) return null;

  const out: ParsedMarker = {
    kind: kindToken as MarkerKind,
    signal: signalToken as MarkerSignal,
    topic,
    principle,
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

  // ----- nested readers ----------------------------------------------------
  function readBareToken(): string | null {
    const start = i;
    while (i < n && line[i] !== " " && line[i] !== "\t" && line[i] !== "=") i++;
    if (i === start) return null;
    return line.slice(start, i);
  }
  function readKey(): string | null {
    const start = i;
    while (i < n && /[A-Za-z_][A-Za-z0-9_-]*/.test(line[i]!)) {
      // Step through identifier chars only.
      i++;
    }
    if (i === start) return null;
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
  if (kind === null || !KNOWN_KINDS.includes(kind)) return null;
  const signal = typeof fields["signal"] === "string" ? fields["signal"] : null;
  if (signal === null || !KNOWN_SIGNALS.includes(signal)) return null;
  const topic = typeof fields["topic"] === "string" ? fields["topic"] : null;
  const principle =
    typeof fields["principle"] === "string" ? fields["principle"] : null;
  if (!topic || !principle) return null;

  return {
    kind: kind as MarkerKind,
    signal: signal as MarkerSignal,
    topic,
    principle,
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
      i++;
      while (i < lines.length) {
        const inner = lines[i]!;
        if (inner.trim().startsWith("```")) {
          i++; // consume closing fence
          break;
        }
        bodyLines.push(inner);
        i++;
      }
      if (infoString === "osb") {
        const parsed = parseBlockMarker(
          bodyLines.join("\n"),
          fenceStartLineNumber,
        );
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
  return KNOWN_KINDS.includes(kind);
}

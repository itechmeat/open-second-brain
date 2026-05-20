/**
 * Marker-fenced managed block editor for text-format configs.
 *
 * Used by Aider (managed block inside YAML) and any text-fallback
 * adapter. Mirrors the convention already in `o2b brain protect`:
 * a block fenced by `# >>> open-second-brain managed >>>` /
 * `# <<< open-second-brain managed <<<` is the unit of overwrite;
 * everything outside is preserved byte-for-byte.
 *
 * Markers are parametrised so different adapters can use different
 * comment styles if needed (e.g. `// >>>` for JS-style configs).
 */

export class ManagedBlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedBlockError";
  }
}

export const DEFAULT_BEGIN_MARKER = "# >>> open-second-brain managed >>>";
export const DEFAULT_END_MARKER = "# <<< open-second-brain managed <<<";

export interface BlockOpts {
  readonly beginMarker?: string;
  readonly endMarker?: string;
}

interface ResolvedOpts {
  readonly begin: string;
  readonly end: string;
}

function resolve(opts: BlockOpts): ResolvedOpts {
  return {
    begin: opts.beginMarker ?? DEFAULT_BEGIN_MARKER,
    end: opts.endMarker ?? DEFAULT_END_MARKER,
  };
}

interface LineMatches {
  readonly beginIdxs: number[];
  readonly endIdxs: number[];
}

function findMarkers(lines: ReadonlyArray<string>, opts: ResolvedOpts): LineMatches {
  const beginIdxs: number[] = [];
  const endIdxs: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === opts.begin) beginIdxs.push(i);
    if (lines[i] === opts.end) endIdxs.push(i);
  }
  return { beginIdxs, endIdxs };
}

function validateMarkers(matches: LineMatches): void {
  const { beginIdxs, endIdxs } = matches;
  if (beginIdxs.length > 1) {
    throw new ManagedBlockError("multiple begin markers found; refusing to overwrite");
  }
  if (endIdxs.length > 1) {
    throw new ManagedBlockError("multiple end markers found; refusing to overwrite");
  }
  if (beginIdxs.length === 1 && endIdxs.length === 0) {
    throw new ManagedBlockError("begin marker without matching end; refusing to overwrite");
  }
  if (beginIdxs.length === 0 && endIdxs.length === 1) {
    throw new ManagedBlockError("end marker without matching begin; refusing to overwrite");
  }
  if (beginIdxs.length === 1 && endIdxs.length === 1 && endIdxs[0]! < beginIdxs[0]!) {
    throw new ManagedBlockError("end marker appears before begin marker; refusing to overwrite");
  }
}

interface LineEnding {
  readonly newline: string;
  readonly trailing: boolean;
}

function detectLineEnding(text: string): LineEnding {
  const trailing = text.length > 0 && (text.endsWith("\n") || text.endsWith("\r\n"));
  if (text.includes("\r\n")) return { newline: "\r\n", trailing };
  return { newline: "\n", trailing };
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  // Normalise CRLF to LF for processing; we'll restore on join.
  const normalised = text.replace(/\r\n/g, "\n");
  const lines = normalised.split("\n");
  // If the source had a trailing newline, the final split entry is an empty
  // string. Drop it; we restore the trailing newline on output.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function join(lines: ReadonlyArray<string>, ending: LineEnding): string {
  return lines.join(ending.newline) + (ending.trailing ? ending.newline : "");
}

/**
 * Insert or replace the managed block. Idempotent: re-applying with
 * the same body yields byte-equal output.
 */
export function insertManagedBlock(
  current: string,
  body: string,
  opts: BlockOpts = {},
): string {
  const resolved = resolve(opts);
  const ending = detectLineEnding(current);
  const lines = splitLines(current);
  const matches = findMarkers(lines, resolved);
  validateMarkers(matches);

  // Normalise the body lines so the output is deterministic.
  const bodyLines = splitLines(body);

  let nextLines: string[];
  if (matches.beginIdxs.length === 1 && matches.endIdxs.length === 1) {
    nextLines = [
      ...lines.slice(0, matches.beginIdxs[0]!),
      resolved.begin,
      ...bodyLines,
      resolved.end,
      ...lines.slice(matches.endIdxs[0]! + 1),
    ];
  } else {
    // Append; ensure one blank line separating user content from our block
    // when the prior content didn't already end empty.
    const sep = lines.length > 0 && lines[lines.length - 1] !== "" ? [""] : [];
    nextLines = [
      ...lines,
      ...sep,
      resolved.begin,
      ...bodyLines,
      resolved.end,
    ];
  }

  return join(nextLines, { newline: ending.newline, trailing: true });
}

/**
 * Remove the managed block (and its markers). Collapses surrounding
 * blank lines so the file doesn't grow vertical whitespace on repeat
 * install/uninstall cycles.
 */
export function removeManagedBlock(current: string, opts: BlockOpts = {}): string {
  const resolved = resolve(opts);
  const ending = detectLineEnding(current);
  const lines = splitLines(current);
  const matches = findMarkers(lines, resolved);
  if (matches.beginIdxs.length === 0 && matches.endIdxs.length === 0) {
    return current;
  }
  validateMarkers(matches);

  const begin = matches.beginIdxs[0]!;
  const end = matches.endIdxs[0]!;
  const before = lines.slice(0, begin);
  const after = lines.slice(end + 1);

  // Collapse blank-line padding: trailing blanks on `before` + leading
  // blanks on `after` collapse to one separator (or nothing if either
  // side is empty).
  while (before.length > 0 && before[before.length - 1] === "") before.pop();
  while (after.length > 0 && after[0] === "") after.shift();

  let nextLines: string[];
  if (before.length === 0 && after.length === 0) {
    nextLines = [];
  } else if (before.length === 0) {
    nextLines = after;
  } else if (after.length === 0) {
    nextLines = before;
  } else {
    nextLines = [...before, "", ...after];
  }

  return join(nextLines, { newline: ending.newline, trailing: ending.trailing });
}

export function hasManagedBlock(current: string, opts: BlockOpts = {}): boolean {
  const resolved = resolve(opts);
  const lines = splitLines(current);
  const { beginIdxs, endIdxs } = findMarkers(lines, resolved);
  return beginIdxs.length === 1 && endIdxs.length === 1 && endIdxs[0]! > beginIdxs[0]!;
}

export function extractManagedBlock(current: string, opts: BlockOpts = {}): string | null {
  const resolved = resolve(opts);
  const lines = splitLines(current);
  const { beginIdxs, endIdxs } = findMarkers(lines, resolved);
  if (beginIdxs.length !== 1 || endIdxs.length !== 1) return null;
  const begin = beginIdxs[0]!;
  const end = endIdxs[0]!;
  if (end <= begin) return null;
  return lines.slice(begin + 1, end).join("\n");
}

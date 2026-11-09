/**
 * Line diffs for the human view's render protocol (design D7): the hunks
 * that turn the last rendered text (the merge base) into the text a user
 * left on disk, and a three-way merge of base, user and new render in
 * which the user wins every conflict.
 *
 * The alignment is a longest common subsequence over whole lines, after
 * the common prefix and suffix are trimmed (a page edit usually touches a
 * few lines, so the table stays small). A merge keeps every change only
 * one side made, takes either side when both made the same change, and
 * takes the user's lines when both changed the same region differently.
 */

/** One changed region: base lines `[baseStart, baseEnd)` became other lines `[otherStart, otherEnd)`. */
export interface Hunk {
  readonly baseStart: number;
  readonly baseEnd: number;
  readonly otherStart: number;
  readonly otherEnd: number;
}

/** A table larger than this many cells falls back to treating the middle as one hunk. */
const MAX_TABLE_CELLS = 4_000_000;

/** The common prefix and suffix of `a` and `b`: what the alignment table leaves out. */
function trimmedSizes(a: ReadonlyArray<string>, b: ReadonlyArray<string>): [number, number] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  return [endA - start, endB - start];
}

/**
 * Whether the lines of `a` and `b` can be aligned line by line: false when
 * the changed middle is too large for the table, where {@link diffLines}
 * reports it as one hunk and its lines pair only by position.
 */
export function alignable(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  const [n, m] = trimmedSizes(a, b);
  return n === 0 || m === 0 || (n + 1) * (m + 1) <= MAX_TABLE_CELLS;
}

/**
 * For each line of `a`, the index of the line of `b` it is matched with in
 * a longest common subsequence, or -1.
 */
export function matchLines(a: ReadonlyArray<string>, b: ReadonlyArray<string>): Int32Array {
  const match = new Int32Array(a.length).fill(-1);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    match[start] = start;
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
    match[endA] = endB;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_TABLE_CELLS) return match;
  // lcs[i][j]: LCS length of a[start+i..endA) and b[start+j..endB).
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[start + i] === b[start + j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      match[start + i] = start + j;
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return match;
}

/** The changed regions between `base` and `other`, in order. */
export function diffLines(base: ReadonlyArray<string>, other: ReadonlyArray<string>): Hunk[] {
  const match = matchLines(base, other);
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  while (i <= base.length) {
    let k = i;
    while (k < base.length && match[k] === -1) k += 1;
    const otherEnd = k < base.length ? match[k]! : other.length;
    if (k > i || otherEnd > j) hunks.push({ baseStart: i, baseEnd: k, otherStart: j, otherEnd });
    if (k >= base.length) break;
    i = k + 1;
    j = otherEnd + 1;
  }
  return hunks;
}

function sameLines(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

/** One line of a three-way merge: a change on one side wins, the user wins a conflict. */
function mergeLine(base: string, ours: string, theirs: string): string {
  return ours === base ? theirs : ours;
}

/**
 * Merge one region between stable anchors. When all three sides have the
 * same number of lines, each line is merged on its own, so edits of
 * neighbouring lines on the two sides do not conflict.
 */
function mergeChunk(
  base: ReadonlyArray<string>,
  ours: ReadonlyArray<string>,
  theirs: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (sameLines(ours, base)) return theirs;
  if (ours.length === base.length && theirs.length === base.length) {
    return base.map((line, i) => mergeLine(line, ours[i]!, theirs[i]!));
  }
  return ours; // theirs unchanged, both the same, or a conflict the user wins
}

/**
 * Three-way merge of `base`, the user's `ours` and the new render
 * `theirs`, line by line. The user wins a region both sides changed.
 */
export function mergeLines(
  base: ReadonlyArray<string>,
  ours: ReadonlyArray<string>,
  theirs: ReadonlyArray<string>,
): string[] {
  const toOurs = matchLines(base, ours);
  const toTheirs = matchLines(base, theirs);
  const out: string[] = [];
  let b = 0;
  let o = 0;
  let t = 0;
  for (;;) {
    // The next base line both sides kept, in order, is a stable anchor.
    let k = b;
    while (k < base.length && (toOurs[k]! < o || toTheirs[k]! < t)) k += 1;
    const end = k < base.length;
    const baseChunk = base.slice(b, k);
    const oursChunk = ours.slice(o, end ? toOurs[k] : ours.length);
    const theirsChunk = theirs.slice(t, end ? toTheirs[k] : theirs.length);
    out.push(...mergeChunk(baseChunk, oursChunk, theirsChunk));
    if (!end) break;
    out.push(base[k]!);
    b = k + 1;
    o = toOurs[k]! + 1;
    t = toTheirs[k]! + 1;
  }
  return out;
}

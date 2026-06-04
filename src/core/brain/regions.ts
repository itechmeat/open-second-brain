/**
 * Sentinel-region merge engine (Project History Suite, t_929da8a2).
 *
 * Generated note content lives between paired HTML-comment sentinels:
 *
 *   <!-- o2b:begin <region-id> -->
 *   ...generated body...
 *   <!-- o2b:end <region-id> -->
 *
 * Everything OUTSIDE regions is operator-owned and survives every
 * regeneration byte-for-byte; explicit paired ids make fail-closed
 * validation unambiguous, so no second marker kind ("@user") is needed
 * (variants.md, orchestrator refinement 2).
 *
 * Fail-closed contract: an unbalanced, duplicated, nested, or
 * mismatched sentinel raises {@link RegionError} naming the offending
 * region BEFORE any write - a corrupted file is never partially
 * rewritten. Consumers (arch-docs generator) catch this and tell the
 * operator which file to repair.
 *
 * Merge semantics:
 *   - region in document AND update  -> body replaced;
 *   - region only in update          -> appended at document end;
 *   - region only in document        -> left untouched (stable ids let
 *     generators keep emitting the same set; an id they stop emitting
 *     stays as the operator last saw it rather than silently vanishing).
 */

// Trailing \r tolerated so CRLF files keep their regions visible -
// otherwise mergeRegions would append duplicates instead of updating
// in place.
const BEGIN_RE = /^<!-- o2b:begin ([A-Za-z0-9_-]+) -->\r?$/;
const END_RE = /^<!-- o2b:end ([A-Za-z0-9_-]+) -->\r?$/;

export class RegionError extends Error {
  readonly code: "UNBALANCED" | "DUPLICATE" | "NESTED" | "MISMATCHED";

  constructor(code: RegionError["code"], message: string) {
    super(message);
    this.name = "RegionError";
    this.code = code;
  }
}

export interface Region {
  readonly id: string;
  /** Body WITHOUT the sentinel lines and without trailing newline. */
  readonly body: string;
}

/**
 * Extract `id -> body` for every region. Throws {@link RegionError} on
 * any sentinel corruption (fail-closed).
 */
export function parseRegions(text: string): ReadonlyMap<string, string> {
  const regions = new Map<string, string>();
  let open: string | null = null;
  let bodyLines: string[] = [];
  for (const line of text.split("\n")) {
    const begin = BEGIN_RE.exec(line);
    if (begin !== null) {
      const id = begin[1]!;
      if (open !== null) {
        throw new RegionError(
          "NESTED",
          `nested sentinel: region '${id}' opens inside still-open region '${open}'`,
        );
      }
      if (regions.has(id)) {
        throw new RegionError("DUPLICATE", `duplicate region id '${id}'`);
      }
      open = id;
      bodyLines = [];
      continue;
    }
    const end = END_RE.exec(line);
    if (end !== null) {
      const id = end[1]!;
      if (open === null) {
        throw new RegionError("UNBALANCED", `region '${id}' ends without a matching begin`);
      }
      if (open !== id) {
        throw new RegionError(
          "MISMATCHED",
          `region '${open}' is closed by mismatched end sentinel '${id}'`,
        );
      }
      regions.set(id, bodyLines.join("\n"));
      open = null;
      continue;
    }
    if (open !== null) bodyLines.push(line);
  }
  if (open !== null) {
    throw new RegionError("UNBALANCED", `region '${open}' is never closed`);
  }
  return regions;
}

function renderRegion(region: Region): string {
  return `<!-- o2b:begin ${region.id} -->\n${region.body}\n<!-- o2b:end ${region.id} -->`;
}

/** Render a fresh all-generated document from regions. */
export function buildRegionDocument(regions: ReadonlyArray<Region>): string {
  return `${regions.map(renderRegion).join("\n\n")}\n`;
}

/**
 * Replace generated region bodies inside `existing`, preserving every
 * byte outside the regions. Unknown-to-the-update regions stay; regions
 * new to the update are appended. Validates `existing` first and throws
 * {@link RegionError} instead of touching a corrupted document.
 */
export function mergeRegions(existing: string, update: ReadonlyArray<Region>): string {
  parseRegions(existing); // fail-closed validation before any rewrite
  const byId = new Map(update.map((region) => [region.id, region]));
  const out: string[] = [];
  let open: string | null = null;
  let replaced: Region | undefined;
  for (const line of existing.split("\n")) {
    const begin = BEGIN_RE.exec(line);
    if (begin !== null) {
      open = begin[1]!;
      replaced = byId.get(open);
      byId.delete(open);
      out.push(line);
      if (replaced !== undefined) out.push(replaced.body);
      continue;
    }
    const end = END_RE.exec(line);
    if (end !== null) {
      open = null;
      replaced = undefined;
      out.push(line);
      continue;
    }
    // Inside a replaced region the old body is dropped; outside (or in
    // an untouched region) every byte passes through.
    if (open !== null && replaced !== undefined) continue;
    out.push(line);
  }
  let merged = out.join("\n");
  if (byId.size > 0) {
    const appended = [...byId.values()].map(renderRegion).join("\n\n");
    merged = `${merged.replace(/\n+$/, "\n")}\n${appended}\n`;
  }
  return merged;
}

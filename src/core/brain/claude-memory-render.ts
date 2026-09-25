export interface RenderMemoryInput {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly memoryPath: string;
  readonly importedAt: string; // ISO Z
  /**
   * The trial deadline the imported rule lands under (ISO Z). The
   * orchestrator derives it from the vault's
   * `dream.unconfirmed_window_days`, so the renderer stays a pure
   * function of its input.
   */
  readonly unconfirmedUntil: string;
  readonly bodySha256: string;
  /** Owner token for the rendered page; omitted renders no `owner:`. */
  readonly owner?: string | undefined;
}

/**
 * Slugify a Claude Memory `name` field for use as a Brain preference id.
 * Single source of truth: both the orchestrator and the renderer must
 * produce byte-identical slugs from the same input. Steps:
 *   - underscores → dashes
 *   - non-alphanumeric → dash
 *   - lowercase
 *   - collapse runs of dashes → single dash
 *   - trim leading/trailing dashes
 *
 * The collapse step keeps human-typable ids like `pref-no-em-dashes`
 * instead of `pref-no---em-dashes` when the source name contains
 * punctuation or whitespace.
 */
export function slugifyMemoryName(name: string): string {
  return name
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]/gi, "-")
    .toLowerCase()
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

const SCOPE_RE = /^scope:\s*([a-z][a-z0-9-]*)\s*$/m;

function extractScope(body: string): string {
  const m = body.match(SCOPE_RE);
  return m?.[1] ?? "writing";
}

function isoDay(iso: string): string {
  return iso.slice(0, 10);
}

export function renderPreferenceFromMemory(input: RenderMemoryInput): string {
  const slug = slugifyMemoryName(input.name);
  if (!slug) {
    // Punctuation-only / whitespace-only names produce an empty slug,
    // which would yield the bare `pref-` id and a blank `topic:` field.
    // Fail fast so the caller (orchestrator → CLI) surfaces a clear error
    // rather than writing an ambiguous preference file.
    throw new Error(
      `claude-memory: cannot derive a slug from name ${JSON.stringify(input.name)}; rename the memory entry to include at least one alphanumeric character`,
    );
  }
  const prefId = `pref-${slug}`;
  const topic = slug;
  const scope = extractScope(input.body);
  // The import lands UNDER TRIAL, not confirmed. MEMORY.md is
  // session-derived - agent-writable from conversation content - so a
  // poisoned entry must not become a live rule on landing; it gets the
  // same trial window every first-party write observes, and the dream
  // pass reviews it like any other candidate. Provenance is carried by
  // the `_imported_*` fields below; the old `_force_confirmed_via`
  // marker is gone because its claim would now be false.
  const fm = [
    "---",
    "kind: brain-preference",
    `id: ${prefId}`,
    `created_at: "${input.importedAt}"`,
    `unconfirmed_until: "${input.unconfirmedUntil}"`,
    `tags: [brain, brain/preference, brain/topic/${topic}, brain/scope/${scope}]`,
    `topic: ${topic}`,
    "_status: unconfirmed",
    `principle: ${JSON.stringify(input.description)}`,
    "_evidenced_by: []",
    "_applied_count: 0",
    "_violated_count: 0",
    "_last_evidence_at: null",
    "_confidence: low",
    "pinned: false",
    `scope: ${scope}`,
    // Ownership, on the same terms every other preference writer uses.
    // Absent when the gate is off, so a vault that never opted in keeps
    // byte-identical imports.
    ...(input.owner === undefined ? [] : [`owner: ${input.owner}`]),
    `_imported_from: ${JSON.stringify(input.memoryPath)}`,
    `_imported_sha256: ${input.bodySha256}`,
    `_imported_at: "${input.importedAt}"`,
    "---",
    "",
    input.body.trim(),
    "",
    "## Origin",
    "",
    "Imported from Claude Code MEMORY:",
    `\`${input.memoryPath}\``,
    `on ${isoDay(input.importedAt)}.`,
    "",
  ].join("\n");
  return fm;
}

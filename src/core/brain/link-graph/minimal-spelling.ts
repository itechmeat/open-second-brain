/**
 * The minimal-spelling chooser for inbound wikilink retargets.
 *
 * A note relocation has to rewrite the links that named it, and a
 * rewrite that preserves each link's original FORM writes longer links
 * than the vault still needs: `[[Projects/Old]]` becomes
 * `[[Projects/New]]` when `[[New]]` would have resolved to the same
 * note. The chooser answers one question, purely and without I/O:
 * what is the shortest spelling that STILL resolves, under the store's
 * own resolution rules, to exactly this note?
 *
 * The rules are not invented here. They mirror the read-time resolution
 * ladder of `src/core/search/store/links.ts` (RESOLVED_LINK_TARGET_SQL,
 * lines 62-70), rung for rung, so a spelling this chooser calls minimal
 * is a spelling the index itself resolves to the same document:
 *
 *   - exact path: `spelling` (or `spelling + ".md"`) is a document path;
 *   - bare basename, top-level first: a top-level `New.md` OWNS the bare
 *     `New` spelling through the exact-path rung, whatever nested notes
 *     also carry the basename - so for a nested destination a shared
 *     top-level name makes the bare spelling a WRONG answer, and the
 *     chooser falls through;
 *   - bare basename, nested, exactly one: the ladder's basename rung
 *     resolves only when the count of nested carriers is exactly one.
 *
 * Shortest-first over basename, suffix-less relPath, full relPath. An
 * ambiguous spelling is never a stop: it falls through to the
 * next-longer form, because a spelling two documents share resolves, by
 * the ladder's own rule, to neither. If nothing resolves to the
 * destination - the destination is not in the population at all - the
 * full relPath is returned rather than any shorter guess, so a caller
 * that writes the answer writes an over-qualified link and never a
 * broken one.
 *
 * Aliases are deliberately not modeled: the chooser judges a walked
 * file population, and alias resolution lives in the index's
 * `doc_aliases` table, which no walk carries. A spelling only an alias
 * could resolve gets a longer form, which is the honest answer for a
 * population-based judgement.
 */

/**
 * `Projects/Old.md` -> `Old`, matching the store's `documentBasename`.
 * The suffix test is CASE-SENSITIVE on purpose: the ladder's basename
 * rung joins against the stored `documents.basename`, which strips a
 * trailing `.md` and nothing else, so `Old.MD` keeps that basename and
 * the bare spelling `Old` dangles - a candidate this chooser must never
 * produce, however much shorter it reads.
 */
function basenameOf(relPath: string): string {
  const last = relPath.split("/").at(-1) ?? relPath;
  return last.endsWith(".md") ? last.slice(0, -".md".length) : last;
}

/** `Projects/Old.md` -> `Projects/Old`. */
function withoutMarkdownSuffix(relPath: string): string {
  return relPath.toLowerCase().endsWith(".md") ? relPath.slice(0, -".md".length) : relPath;
}

/**
 * What the ladder resolves `spelling` to over `files`, or `null` when it
 * resolves to nothing. Exact-path first (with the suffix appended when
 * absent - the ladder's second rung), then the unambiguous
 * nested-basename rung, whose carriers exclude top-level documents
 * because a top-level carrier would have owned the spelling outright
 * one rung earlier.
 */
function resolveOverFiles(
  spelling: string,
  files: ReadonlyArray<string>,
): string | "ambiguous" | null {
  const target = spelling.toLowerCase().endsWith(".md") ? spelling : `${spelling}.md`;
  const exact = files.filter((rel) => rel === target);
  if (exact.length > 0) return exact.length === 1 ? exact[0]! : "ambiguous";
  if (spelling.includes("/")) return null;
  const nested = files.filter((rel) => rel.includes("/") && basenameOf(rel) === spelling);
  if (nested.length === 1) return nested[0]!;
  if (nested.length > 1) return "ambiguous";
  return null;
}

/**
 * The shortest of basename / suffix-less relPath / full relPath whose
 * exact-one resolution over `knownFiles` equals `destinationRel`.
 *
 * `knownFiles` is the population a vault walk produced - vault-relative
 * paths with the `.md` suffix, the same list a retarget pass reports as
 * the files it read. For a relocation the caller derives the POST-move
 * population (the walked list minus the old path plus the new one);
 * the chooser never sees a half state.
 */
export function minimalSpellingFor(
  destinationRel: string,
  knownFiles: ReadonlyArray<string>,
): string {
  const candidates = [
    basenameOf(destinationRel),
    withoutMarkdownSuffix(destinationRel),
    destinationRel,
  ];
  for (const spelling of candidates) {
    if (resolveOverFiles(spelling, knownFiles) === destinationRel) return spelling;
  }
  return destinationRel;
}

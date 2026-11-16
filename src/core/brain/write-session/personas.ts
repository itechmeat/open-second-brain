/**
 * Panel personas (Agent Write Contract Suite, t_0cc6fdff).
 *
 * A persona is one analytical lens the calling agent must answer
 * through: a slug, a lens and the generation instruction. When no custom
 * persona exists, the built-in default set applies - the panel works out
 * of the box and stays operator-curatable.
 *
 * Where a persona lives (task 3.12, design D19 item 2): on an unswitched
 * machine it is a vault note under `Brain/personas/<slug>.md` (frontmatter
 * `kind: persona`, `lens`; the body is the instruction). On a store-only
 * machine, with or without a vault, it is a record: a `lane-entry` of the
 * lane `personas` in the brain store, folded by entry id like every lane
 * entry, so a persona curated on one machine is the lens on every machine
 * of the store. {@link setPersona} and {@link removePersona} write either
 * form through the lane page layer (`o2b brain panel persona-set` and
 * `persona-remove`; the CLI writes with human authority).
 */

import { join } from "node:path";

import type { WriteSessionPersona } from "./types.ts";
import { legacyPagePrivate, storedEntryPrivate } from "../../store/lane-entry-store.ts";
import { callerInput, opaqueFields, operationPrivacy } from "../../store/operation-privacy.ts";
import {
  assertLaneWrite,
  lanePageExists,
  laneVaultRoot,
  listLaneFiles,
  parseLanePage,
  removeLanePage,
  writeLanePage,
} from "../../store/lane-pages.ts";

/** Default lens set, in deliberation order. */
export const DEFAULT_PERSONAS: ReadonlyArray<WriteSessionPersona> = Object.freeze([
  Object.freeze({
    slug: "technical",
    lens: "technical feasibility",
    prompt:
      "Assess the topic strictly through technical feasibility: implementation effort, architectural fit, operational burden, and reversibility. Name concrete constraints.",
  }),
  Object.freeze({
    slug: "strategic",
    lens: "strategic alignment",
    prompt:
      "Assess the topic through strategic alignment: does it serve the project's direction, what does it displace, and what does deferring cost. Argue from priorities, not implementation detail.",
  }),
  Object.freeze({
    slug: "risk",
    lens: "risk and failure modes",
    prompt:
      "Assess the topic through risk: enumerate failure modes, blast radius, irreversibility, and mitigations. Be explicitly adversarial - assume things go wrong.",
  }),
  Object.freeze({
    slug: "user-experience",
    lens: "user experience",
    prompt:
      "Assess the topic through the user's experience: who is affected, what changes in their workflow, what friction appears or disappears. Argue from the user's seat.",
  }),
]);

/** Vault directory operators curate personas in. */
export function personasDir(vault: string): string {
  return join(vault, "Brain", "personas");
}

/**
 * Load operator personas, falling back to {@link DEFAULT_PERSONAS}.
 * Notes are read in filename order (deterministic step sequence);
 * non-persona notes and malformed files are skipped silently - the
 * panel must keep working when a stray note lands in the directory.
 */
export function loadPersonas(vault: string | null): ReadonlyArray<WriteSessionPersona> {
  return customPersonas(vault) ?? DEFAULT_PERSONAS;
}

/** The custom personas, or `null` when there are none and the defaults apply. */
function customPersonas(vaultOrNull: string | null): ReadonlyArray<WriteSessionPersona> | null {
  const vault = laneVaultRoot(vaultOrNull);
  const dir = personasDir(vault);
  if (!lanePageExists(vault, dir)) return null;
  const personas: WriteSessionPersona[] = [];
  for (const name of listLaneFiles(vault, dir, "").toSorted()) {
    if (!name.endsWith(".md")) continue;
    let meta: Readonly<Record<string, unknown>>;
    let body: string;
    try {
      [meta, body] = parseLanePage(vault, join(dir, name));
    } catch {
      continue;
    }
    if (meta["kind"] !== "persona") continue;
    const slug = name.slice(0, -".md".length);
    const lens =
      typeof meta["lens"] === "string" && meta["lens"].trim() ? meta["lens"].trim() : slug;
    const prompt = body.trim();
    if (prompt === "") continue;
    personas.push(Object.freeze({ slug, lens, prompt }));
  }
  return personas.length > 0 ? Object.freeze(personas) : null;
}

/** The personas in force and whether they are the operator's or the defaults. */
export function listPersonas(vault: string | null): {
  readonly source: "custom" | "default";
  readonly personas: ReadonlyArray<WriteSessionPersona>;
} {
  const custom = customPersonas(vault);
  return custom === null
    ? { source: "default", personas: DEFAULT_PERSONAS }
    : { source: "custom", personas: custom };
}

/** A persona request the verbs refuse (a bad slug, lens or prompt). */
export class PersonaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonaError";
  }
}

/** A persona slug: a plain lowercase name, also its note's file name. */
const PERSONA_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function checkedSlug(slug: string): string {
  if (!PERSONA_SLUG_RE.test(slug)) {
    throw new PersonaError(
      `persona slug "${slug}" must be 1 to 64 lowercase letters, digits and hyphens, ` +
        "starting with a letter or digit",
    );
  }
  return slug;
}

function personaPath(vault: string, slug: string): string {
  return join(personasDir(vault), `${checkedSlug(slug)}.md`);
}

/** The largest prompt a persona may hold, in UTF-8 bytes: it rides in every panel step. */
export const PERSONA_PROMPT_MAX_BYTES = 16 * 1024;

/** The longest lens, in characters: one short label. */
export const PERSONA_LENS_MAX_CHARS = 200;

/** Line breaks a single-line lens may not hold, Unicode separators included. */
const LINE_BREAK_RE = /[\r\n\u0085\u2028\u2029]/;

/**
 * The persona note at `path`, refused when a page of another kind lives
 * there: the verbs curate personas, never another note at that path.
 */
function refuseOtherPage(vault: string, path: string, slug: string): void {
  if (!lanePageExists(vault, path)) return;
  let kind: unknown;
  try {
    kind = parseLanePage(vault, path)[0]["kind"];
  } catch {
    kind = undefined;
  }
  if (kind === "persona") return;
  throw new PersonaError(
    `Brain/personas/${slug}.md is no persona (kind: ${String(kind)}); the persona verbs ` +
      "leave it alone. Pick another slug, or move that note first",
  );
}

/**
 * The persona at `path`, refused when it lives in `private` (or its note
 * is marked private): the lane writer keeps a replaced entry where it
 * lives and never lowers its privacy, so a shared replacement would stay
 * private and machines without `private` would never see it.
 */
function refusePrivateTarget(vault: string, path: string, slug: string): void {
  if (!legacyPagePrivate(vault, path) && !storedEntryPrivate(vault, path)) return;
  throw new PersonaError(
    `persona ${slug} lives in private, and a replacement would stay there, out of reach of ` +
      `machines without private; remove it first (\`o2b brain panel persona-remove ${slug}\`), ` +
      "then set it again as a shared persona",
  );
}

/**
 * Add or replace the custom persona `slug`: a note on an unswitched
 * machine, a `lane-entry` record on a store-only one (`vault` may then be
 * `null`). Writing what the persona already holds changes nothing.
 *
 * Refused (task 3.12 review): in a frozen vault or while a migration runs
 * on it (the lane write guard; on a store-only machine the freeze), over a page
 * of another kind at that path, over a persona that lives in `private`,
 * a prompt over {@link PERSONA_PROMPT_MAX_BYTES} or a lens over
 * {@link PERSONA_LENS_MAX_CHARS} or with a line break, and a private
 * persona: text with a `<private>` region or naming a private page would
 * be stored in `private`, which machines that do not hold it never read,
 * while a persona is the lens on every machine of the store.
 */
export function setPersona(
  vaultOrNull: string | null,
  input: { readonly slug: string; readonly lens?: string; readonly prompt: string },
): { readonly slug: string; readonly changed: boolean } {
  const vault = laneVaultRoot(vaultOrNull);
  const path = personaPath(vault, input.slug);
  const prompt = input.prompt.trim();
  if (prompt === "") throw new PersonaError("a persona needs a non-empty prompt");
  if (Buffer.byteLength(prompt, "utf8") > PERSONA_PROMPT_MAX_BYTES) {
    throw new PersonaError(
      `a persona prompt holds at most ${PERSONA_PROMPT_MAX_BYTES} bytes; every panel step carries it`,
    );
  }
  const lens = input.lens?.trim() || input.slug;
  if (LINE_BREAK_RE.test(lens)) throw new PersonaError("a persona lens must be a single line");
  if (lens.length > PERSONA_LENS_MAX_CHARS) {
    throw new PersonaError(`a persona lens holds at most ${PERSONA_LENS_MAX_CHARS} characters`);
  }
  const isPrivate = operationPrivacy(vaultOrNull, {
    content: [callerInput({ lens, prompt }, opaqueFields())],
  });
  if (isPrivate()) {
    throw new PersonaError(
      `persona ${input.slug} is private: its lens or prompt carries a <private> region or names ` +
        "a private page, and a persona is read by every machine of the store",
    );
  }
  assertLaneWrite(vault);
  refuseOtherPage(vault, path, input.slug);
  refusePrivateTarget(vault, path, input.slug);
  const changed = writeLanePage(vault, path, { kind: "persona", lens }, `${prompt}\n`, {
    overwrite: true,
  });
  return { slug: input.slug, changed };
}

/** Remove the custom persona `slug`; `false` when there was none. */
export function removePersona(vaultOrNull: string | null, slug: string): boolean {
  const vault = laneVaultRoot(vaultOrNull);
  const path = personaPath(vault, slug);
  assertLaneWrite(vault);
  refuseOtherPage(vault, path, slug);
  return removeLanePage(vault, path);
}

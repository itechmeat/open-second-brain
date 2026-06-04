/**
 * Panel personas (Agent Write Contract Suite, t_0cc6fdff).
 *
 * A persona is one analytical lens the calling agent must answer
 * through. Operators own custom personas as ordinary vault notes under
 * `Brain/personas/<slug>.md` (frontmatter `kind: persona`, `lens`; the
 * body is the generation instruction). When the directory is absent or
 * holds no persona notes, the built-in default set applies - the panel
 * works out of the box and stays operator-curatable.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "../../vault.ts";
import type { WriteSessionPersona } from "./types.ts";

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
export function loadPersonas(vault: string): ReadonlyArray<WriteSessionPersona> {
  const dir = personasDir(vault);
  if (!existsSync(dir)) return DEFAULT_PERSONAS;
  const personas: WriteSessionPersona[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    if (!name.endsWith(".md")) continue;
    let meta: Readonly<Record<string, unknown>>;
    let body: string;
    try {
      [meta, body] = parseFrontmatter(join(dir, name));
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
  return personas.length > 0 ? Object.freeze(personas) : DEFAULT_PERSONAS;
}

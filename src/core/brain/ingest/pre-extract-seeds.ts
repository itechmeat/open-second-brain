/**
 * The seed shapes every pre-extractor family emits, and the one specifier
 * step every `imports` seed passes through. A leaf module: the family parsers
 * (`pre-extract.ts` for TS/JS and Python, `pre-extract-hcl.ts` for
 * Terraform) both import it, and it imports neither, so the families share
 * one definition without a module cycle. `pre-extract.ts` re-exports the
 * seed types, so callers keep importing them from there.
 */

import { redactUrlCredentials } from "../../redactor.ts";

/**
 * A declaration surfaced as an entity seed: a class or function (TS/JS,
 * Python), or a Terraform block in address syntax (`resource`, `data`,
 * `module`, `variable`, `output`, `provider`, `locals`).
 */
export interface CodeEntitySeed {
  readonly kind:
    | "class"
    | "function"
    | "resource"
    | "data"
    | "module"
    | "variable"
    | "output"
    | "provider"
    | "locals";
  readonly name: string;
}

/**
 * A structural relationship surfaced as an edge seed. `imports` runs from the
 * source path to a module specifier (a Terraform module `source` included);
 * `inherits` runs from a subclass to a base class (TS `extends`/`implements`,
 * Python base classes); `uses` runs from a `.tsx`/`.jsx` source path to a JSX
 * component it renders; `depends_on` and `references` run from a Terraform
 * address to an address it lists in `depends_on` or cites.
 *
 * `resolvedTo` is present only when the caller supplied the ingested-file set
 * and a relative import specifier probed to exactly one ingested file; it
 * carries that file's canonical vault-relative path. An ambiguous or unmet
 * probe leaves the seed with its raw specifier and no field.
 */
export interface CodeEdgeSeed {
  readonly kind: "imports" | "inherits" | "uses" | "depends_on" | "references";
  readonly from: string;
  readonly to: string;
  readonly resolvedTo?: string;
}

/**
 * The one specifier step every family's `imports` seed passes through: URL
 * credentials (`scheme://user:password@host`) become the redaction
 * placeholder, so a specifier never carries them out of the extractor. Any
 * other specifier text is kept byte-identical.
 */
export function specifierSeed(path: string, specifier: string): CodeEdgeSeed {
  return { kind: "imports", from: path, to: redactUrlCredentials(specifier) };
}

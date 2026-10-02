/**
 * The seed shapes every pre-extractor family emits, and the one specifier
 * step every `imports` seed passes through. A leaf module: the family parsers
 * (`pre-extract.ts` for TS/JS and Python, `pre-extract-hcl.ts` for
 * Terraform) both import it, and it imports neither, so the families share
 * one definition without a module cycle. `pre-extract.ts` re-exports the
 * seed types, so callers keep importing them from there.
 */

import { REDACTION_PLACEHOLDER, redactSpecifierCredentials } from "../../redactor.ts";

/**
 * The longest specifier an `imports` seed carries. A module specifier or
 * source is a short path or URL; anything longer is not one a reader can
 * use, and is carried as the redaction placeholder instead of being parsed.
 */
export const SPECIFIER_MAX_CHARS = 2048;

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
 * The one specifier step every family's `imports` seed passes through
 * ({@link redactSpecifierCredentials}): the userinfo of an http(s) or
 * `git::` specifier (a `user:password` pair or a bare token), a userinfo
 * that does not read as a login on any other scheme, and the value of a
 * named credential query parameter (`sshkey`, `token`, the S3 and GCS
 * signing keys and the rest of `CREDENTIAL_QUERY_KEYS`) become the
 * redaction placeholder. Not covered: a credential in a path segment, a
 * fragment or an unnamed query parameter. A specifier with nothing to
 * redact is kept byte-identical. A specifier longer than
 * {@link SPECIFIER_MAX_CHARS} becomes the placeholder whole.
 */
export function specifierSeed(path: string, specifier: string): CodeEdgeSeed {
  const to =
    specifier.length > SPECIFIER_MAX_CHARS
      ? REDACTION_PLACEHOLDER
      : redactSpecifierCredentials(specifier);
  return { kind: "imports", from: path, to };
}

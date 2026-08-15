/**
 * Registry R2 - every path that hands vault bytes to a destination the
 * operator names, and what each one does about secrets.
 *
 * The vault has no git transport and deliberately never will, so there is
 * no commit or push boundary to gate. The boundary that exists is the
 * export surface: six verbs that write to a path outside the vault. Five
 * of them never called the shared redactor, and the sixth used a private
 * key-name-only copy. Wiring five call sites fixes five call sites; this
 * registry plus `tests/core/architecture/egress-census.test.ts` is what
 * stops a seventh appearing unredacted.
 *
 * The census derives the POPULATION from source - a module that declares
 * an operator-named destination flag is an egress path - and asks this
 * table to account for it. It also checks the declaration against the
 * source rather than trusting it: an entry claiming
 * {@link EGRESS_REDACTION.sharedRedactor} whose module no longer calls
 * `redactForEgress` fails, and so does one that declares LESS than its
 * module does - the answer to which is to flip the declaration, never to
 * remove the call.
 *
 * A `reason` is required on every entry, not only on the unredacted ones.
 * "It redacts" says nothing about WHAT leaves and what a reader should
 * still check, and that is the sentence a person reviewing an export path
 * actually needs.
 */

/**
 * What a given egress path does about secrets on the way out.
 *
 * There used to be a third status, `upstream_read_model` - "something
 * upstream already redacted this". It is gone, and its removal is a
 * finding rather than a tidy-up: the one entry that claimed it was
 * leaking a vendor key, a bare high-entropy token and a `user:pass@host`
 * URL, because its upstream redacted at write time with the redactor's
 * DEFAULT options rather than the export boundary's. A status whose truth
 * cannot be read out of the module it describes is a place for a leak to
 * live, and the census that checks declarations against source could not
 * check that one. Every remaining status is decidable from the module's
 * own text.
 */
export const EGRESS_REDACTION = Object.freeze({
  /** Every outbound byte goes through `redactForEgress`. */
  sharedRedactor: "shared_redactor",
  /** The destination carries no vault content, so there is nothing to scan. */
  noVaultContent: "no_vault_content",
} as const);

export type EgressRedactionStatus = (typeof EGRESS_REDACTION)[keyof typeof EGRESS_REDACTION];

export const EGRESS_REDACTION_STATUSES: ReadonlyArray<EgressRedactionStatus> = Object.freeze([
  EGRESS_REDACTION.sharedRedactor,
  EGRESS_REDACTION.noVaultContent,
]);

/** Takes `unknown`: a status can arrive from a hand-edited declaration. */
export function isEgressRedactionStatus(value: unknown): value is EgressRedactionStatus {
  return (
    typeof value === "string" &&
    (EGRESS_REDACTION_STATUSES as ReadonlyArray<string>).includes(value)
  );
}

export interface EgressSite {
  /** Stable id. Names the path in a refusal message. */
  readonly id: string;
  /** The operator-visible command, spelled as it is typed. */
  readonly verb: string;
  /** Repo-relative module that declares the destination. The census key. */
  readonly module: string;
  readonly redaction: EgressRedactionStatus;
  /** What the status alone does not say. Never empty. */
  readonly reason: string;
}

const R = EGRESS_REDACTION;

/**
 * Every declared egress path, keyed by its own id.
 *
 * Five entries were converted by this unit rather than merely described:
 * before it, `bank-export`, `graph-export`, `okf-export`, `brain export`
 * and `export-config` all wrote vault-derived bytes with no shared scan.
 */
export const EGRESS_SITES = Object.freeze({
  "brain-bank-export": {
    id: "brain-bank-export",
    verb: "o2b brain bank-export",
    module: "src/cli/brain/verbs/bank-export.ts",
    redaction: R.sharedRedactor,
    reason:
      "the widest export in the tree: preferences, the page graph, page contracts and " +
      "the sources dashboard composed into one file. Redaction runs over the bundle " +
      "TREE and the JSON is serialised afterwards, so a note whose text happens to " +
      "contain a credential assignment cannot mangle the document's own quoting.",
  },
  "brain-graph-export": {
    id: "brain-graph-export",
    verb: "o2b brain graph-export",
    module: "src/cli/brain/verbs/graph-export.ts",
    redaction: R.sharedRedactor,
    reason:
      "carries no page body, but does carry every page title, path and typed-relation " +
      "target - a credential pasted into a title left through here verbatim.",
  },
  "brain-okf-export": {
    id: "brain-okf-export",
    verb: "o2b brain okf-export",
    module: "src/cli/brain/verbs/okf-export.ts",
    redaction: R.sharedRedactor,
    reason:
      "the only export that carries page bodies VERBATIM, which is its interchange " +
      "contract and also why it is the widest leak by volume. The manifest is redacted " +
      "as a tree and `okf.json` re-serialised from it; the markdown files are redacted " +
      "as text. A bundle whose secrets were removed is no longer a lossless round-trip " +
      "of the vault, and the verb says so rather than implying otherwise.",
  },
  "brain-preference-export": {
    id: "brain-preference-export",
    verb: "o2b brain export",
    module: "src/cli/brain/verbs/export.ts",
    redaction: R.sharedRedactor,
    reason:
      "preference principles are free text an agent wrote, and the llms-txt form is " +
      "meant to be pasted into a foreign prompt - the destination least likely to be " +
      "read before it is shared.",
  },
  "config-export": {
    id: "config-export",
    verb: "o2b export-config",
    module: "src/cli/main.ts",
    redaction: R.sharedRedactor,
    reason:
      "the machine-config snapshot an operator hands to someone else when reporting a " +
      "problem. It used a private copy that matched five substrings against KEY NAMES " +
      "and never inspected a value, so a credential stored under a name that copy did " +
      "not recognise was written out in full.",
  },
  "brain-continuity-export": {
    id: "brain-continuity-export",
    verb: "o2b brain continuity export",
    module: "src/cli/brain/verbs/continuity.ts",
    redaction: R.sharedRedactor,
    reason:
      "was declared as covered by its read model, which was wrong in both directions. " +
      "The upstream call redacts at WRITE time with the redactor's DEFAULT options, so " +
      "`redactTokens` and `redactUrlCredentials` were both off and a vendor key, a bare " +
      "high-entropy token and a `user:pass@host` URL all left through here verbatim - " +
      "the two flags the export boundary exists to turn on. Write-time coverage also " +
      "says nothing about a record already on disk or appended by another writer, since " +
      "the read model never re-scans. The verb now scans what it READ, which answers " +
      "both, and gains the truncation refusal the other five already had.",
  },
  "install-adapter-out": {
    id: "install-adapter-out",
    verb: "o2b install --out",
    module: "src/cli/install/install.ts",
    redaction: R.noVaultContent,
    reason:
      "writes an adapter configuration rendered from install templates plus the " +
      "resolved config path. It reads no vault note and composes no vault content, so " +
      "there is no vault payload to scan. In population only because it names a " +
      "destination, which is the syntactic rule the census uses on purpose - deciding " +
      "'is this vault content' is what this entry is for, not what the sweep should " +
      "guess.",
  },
} as const satisfies Readonly<Record<string, EgressSite>>);

export type EgressSiteId = keyof typeof EGRESS_SITES;

/** Takes `unknown`: an id can arrive from a caller outside TypeScript. */
export function isEgressSiteId(value: unknown): value is EgressSiteId {
  return typeof value === "string" && Object.hasOwn(EGRESS_SITES, value);
}

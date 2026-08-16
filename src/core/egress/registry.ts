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
 * An eighth appeared anyway, and how it appeared is the more useful half.
 * `o2b brain explorer --export` wrote the whole preference graph to an
 * operator-named file with no scan for a whole release, and the census
 * reported a clean sweep throughout - because its destination rule was a
 * hardcoded list of destination WORDS, and this flag was spelled
 * `export`. A registry whose membership rule is a name list is the same
 * defect as a boundary that is only a label, one level up. The rule was
 * widened, and a second rule added for the destinations that are not
 * files at all: the endpoints this product POSTs vault-derived bytes to.
 *
 * The census derives the POPULATION from source - a module that declares
 * an operator-named destination flag, or sends a body over the network,
 * is an egress path - and asks this table to account for it. It also
 * checks the declaration against the source rather than trusting it: an
 * entry claiming
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
  /**
   * Vault-derived bytes go to a network destination without passing the
   * shared guard. Unlike the status this registry deleted, it is decidable
   * from the module's own text - the census asserts such an entry does NOT
   * call `redactForEgress`, so the day one starts scanning, the
   * declaration has to be flipped rather than left describing a gap that
   * closed. It exists because a continuous unscanned egress that no table
   * mentions is worse than one that is written down: the entry's `reason`
   * is where the decision and its cost are stated.
   */
  unscannedNetworkPayload: "unscanned_network_payload",
} as const);

export type EgressRedactionStatus = (typeof EGRESS_REDACTION)[keyof typeof EGRESS_REDACTION];

export const EGRESS_REDACTION_STATUSES: ReadonlyArray<EgressRedactionStatus> = Object.freeze([
  EGRESS_REDACTION.sharedRedactor,
  EGRESS_REDACTION.noVaultContent,
  EGRESS_REDACTION.unscannedNetworkPayload,
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
      "of the vault, and the verb says so rather than implying otherwise. What it does NOT " +
      "do is filter by label: a page carrying `private: true` in its frontmatter exports in " +
      "full, because the `<private>` region marker is this product's only content-derived " +
      "privacy primitive and these composers are content composers, not visibility filters.",
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
  "brain-explorer-export": {
    id: "brain-explorer-export",
    verb: "o2b brain explorer --export",
    module: "src/cli/brain/verbs/explorer.ts",
    redaction: R.sharedRedactor,
    reason:
      "a self-contained HTML file with the whole rule graph embedded as JSON: every " +
      "preference and retired principle verbatim, plus each one's topic, scope and " +
      "provenance counts. It is the export most likely to be handed to a person rather " +
      "than a program - it opens in a browser - and it was the one export that never " +
      "scanned anything. Redaction runs over the graph TREE before the template " +
      "substitution, so a principle whose text contains a quote cannot disturb the " +
      "document. The label rule holds here too: a preference is not withheld for carrying " +
      "a `private` tag, because the `<private>` region marker is the only content-derived " +
      "privacy primitive in this product.",
  },
  "search-embedding-openai-compat": {
    id: "search-embedding-openai-compat",
    verb: "o2b search index (embedding provider)",
    module: "src/core/search/embeddings/openai-compat.ts",
    redaction: R.unscannedNetworkPayload,
    reason:
      "the largest and most continuous egress in this product: every indexed chunk BODY " +
      "is POSTed verbatim to whichever endpoint the operator configured, for every " +
      "reindex, and nothing scans it. It is declared unscanned rather than wired to the " +
      "guard because redaction here would corrupt the thing being built - a vector " +
      "computed over a placeholder is a vector for the placeholder, so the chunk would " +
      "come back unfindable while the index reported success, which is a silent failure " +
      "where this one is at least a stated exposure. The controls that do exist are " +
      "the operator's: semantic search is off until an endpoint and a key are configured, " +
      "and the endpoint is whichever host they name, including a local one.",
  },
  "search-embedding-zeroentropy": {
    id: "search-embedding-zeroentropy",
    verb: "o2b search index (zeroentropy provider)",
    module: "src/core/search/embeddings/zeroentropy.ts",
    redaction: R.unscannedNetworkPayload,
    reason:
      "the same chunk bodies as the OpenAI-compatible provider, to a second vendor's " +
      "embed endpoint under the same operator-configured base URL. Listed separately " +
      "rather than folded into one 'embedding' entry because the census keys on the " +
      "module, and a provider that stops being reachable from the resolver would " +
      "otherwise leave a declaration covering a path nobody can find.",
  },
  "search-rerank-cross-encoder": {
    id: "search-rerank-cross-encoder",
    verb: "o2b search query --rerank",
    module: "src/core/search/rerank/cross-encoder.ts",
    redaction: R.unscannedNetworkPayload,
    reason:
      "sends the QUERY plus the candidate documents to a rerank endpoint, so it carries " +
      "vault text the embedding path may never have seen - the top-of-pool bodies of the " +
      "current result set, chosen by relevance to what the operator just asked. Unscanned " +
      "for the same reason as the embedding path: a reranker scoring placeholders returns " +
      "an order computed over text nobody wrote.",
  },
  "brain-telegram-capture": {
    id: "brain-telegram-capture",
    verb: "o2b brain telegram-run",
    module: "src/core/brain/capture/telegram-capture.ts",
    redaction: R.unscannedNetworkPayload,
    reason:
      "POSTs reply text to the Telegram Bot API, and the `/catchup` reply is composed " +
      "from vault content. The transport is built only by the CLI runner verb, so an " +
      "install that never starts the runner never reaches this path at all - which is " +
      "why it is a declared narrow exposure rather than a guard call: the bytes are a " +
      "chat message the operator asked to be sent, and refusing to send one because it " +
      "quotes a credential-shaped string would break the surface without protecting a " +
      "destination the operator did not already choose.",
  },
  "research-external-fetch": {
    id: "research-external-fetch",
    verb: "o2b brain research",
    module: "src/core/brain/research/external-fetch.ts",
    redaction: R.unscannedNetworkPayload,
    reason:
      "the one transport every research provider's POST goes through, which is why it is " +
      "declared here rather than at the provider modules that name the endpoints and " +
      "never call the network themselves. What leaves is an agent-composed search query, " +
      "not a page body, and the path is key-gated: with no key configured every call is " +
      "a typed `disabled` error, so an install that never sets one has no egress here.",
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

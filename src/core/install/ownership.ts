/**
 * What an operator actually owns, stated without the counterexamples.
 *
 * The sentence this module exists to print is "every memory is a Markdown
 * file in your own vault; copy it elsewhere, delete it and the brain is
 * gone; there is no service to cancel". As written it is FALSE in four
 * places, and a claim with a known counterexample is precisely the
 * misleading output this release removes:
 *
 *   1. The bundled opencode plugin appends raw conversation turns to
 *      `~/.local/share/open-second-brain/opencode/`, and nothing prunes
 *      them. On a machine using that integration, memory content lives
 *      outside the vault.
 *   2. `installation_secret` in the machine config keys the
 *      `vault://<hex>` identity every MCP tool returns, so a vault copied
 *      without it silently stops resolving those references.
 *   3. The search index can be relocated out of the vault by
 *      `OPEN_SECOND_BRAIN_SEARCH_DB` / `search_db_path`.
 *   4. "No service to cancel" is a blanket claim, and it is false for an
 *      operator who configured any outbound integration - vault text has
 *      been sent to a third party this tool does not manage.
 *
 * So the statement is COMPOSED rather than written, and every clause it
 * prints is either measured at the moment it is printed or worded so that
 * it is true without measuring. Which of the two applies is not left to
 * the reader:
 *
 *   MEASURED, per run - the resolved vault path; the filesystem-backing
 *   verdict, which is allowed to say `undetermined`; where the search
 *   index actually resolved and whether that is inside the vault
 *   ({@link SearchIndexVerdict}); and the state of each
 *   {@link OUTBOUND_SERVICES} row, which is allowed to say `unchecked`
 *   with the reason the check could not run.
 *
 *   NOT MEASURED, and therefore worded as a catalogue - {@link
 *   OUT_OF_VAULT_STATE}. These rows are printed unconditionally, so the
 *   statement says what this tool CAN leave outside the vault and what
 *   creates each one, never that any of them is present on this machine.
 *   An earlier version printed the same static list under "these N things
 *   live outside it", which is a measurement claim the composer never
 *   made; the rows now carry {@link OutOfVaultState.created_by} and
 *   {@link OutOfVaultState.removed_by} so the reader can settle presence
 *   and cleanup per row instead.
 *
 * {@link OUT_OF_VAULT_STATE} is a real list rather than prose because
 * `tests/core/install/ownership.test.ts` sweeps the tree for modules that
 * BUILD a path rooted outside the vault - home, XDG, temp - and demands
 * each be attributed to an entry here or excused in {@link
 * OUT_OF_VAULT_SWEEP_EXCLUSIONS}. It sweeps path construction rather than
 * write calls because a module that computes such a path and hands it to
 * something else to write is invisible to a call-site matcher, and because
 * the write-call form was blind to this repository's own atomic-write
 * helper and to the whole `fs/promises` family. What that sweep still
 * cannot see is enumerated in {@link SOURCES_INVISIBLE_TO_THE_SWEEP}: a
 * location whose root arrives from config, from an env override or from
 * the working directory carries no anchor token to match on.
 *
 * Pure: nothing here reads the environment or the filesystem, except the
 * backing probe when a verdict is not injected. The vault path, the search
 * index verdict, the installable adapter targets and the outbound-service
 * states are all parameters - so the statement a test asserts on is the
 * statement an operator gets. The measuring half lives in
 * `ownership-measure.ts`, once, for both callers.
 */

import { probeVaultBacking, VAULT_BACKING, type VaultBackingVerdict } from "../vault-backing.ts";

// ----- The enumeration ------------------------------------------------------

/** One durable thing that can live outside the vault. */
export interface OutOfVaultState {
  /** Stable slug; the machine-readable handle for this row. */
  readonly id: string;
  /** What it is, as a noun phrase the statement can print. */
  readonly label: string;
  /** Where it lives, written the way an operator would find it. */
  readonly location: string;
  /**
   * True when this location can hold MEMORY CONTENT rather than plumbing.
   * The whole point of the field: the unqualified ownership sentence is
   * false exactly on the rows where this is true.
   */
  readonly carries_memory: boolean;
  /**
   * What has to have happened for this to exist at all.
   *
   * The rows are a catalogue, not a scan, so this field is what keeps the
   * catalogue from reading as a report about this machine: an operator who
   * never ran the command named here knows the row does not apply to them.
   */
  readonly created_by: string;
  /**
   * How the operator removes it.
   *
   * Named per row because `o2b uninstall` removes two of them and nothing
   * else, and a closing sentence that offered one verb for the whole list
   * was the over-claim this field replaces.
   */
  readonly removed_by: string;
  /** Why it is out there, and what its absence costs on a copy. */
  readonly note: string;
  /**
   * Repo-relative modules that own this path. A trailing `/` matches a
   * directory prefix. The census attributes swept path-builders through
   * this field, so an anchor that rots fails a test rather than silently
   * orphaning a location.
   */
  readonly sources: ReadonlyArray<string>;
}

/**
 * The row whose `location` is completed from the live adapter registry.
 * Named so {@link buildDataOwnership} cannot drift from the entry it
 * rewrites.
 */
const RUNTIME_CONFIG_BLOCKS_ID = "runtime_config_blocks";

/**
 * Everything durable this tool can leave outside the vault.
 *
 * Ordered memory-bearing first: the enumeration is read as a correction to
 * the ownership claim, and the correction that matters most is the one
 * that holds conversation text.
 */
export const OUT_OF_VAULT_STATE: ReadonlyArray<OutOfVaultState> = Object.freeze([
  {
    id: "opencode_session_spool",
    label: "opencode session spool",
    location:
      "${OSB_OPENCODE_SPOOL_DIR:-${XDG_DATA_HOME:-~/.local/share}}/open-second-brain/opencode/",
    carries_memory: true,
    created_by: "the bundled opencode plugin, on every opencode session it observes",
    removed_by: "deleting that directory yourself - no verb in this tool prunes or removes it",
    note:
      "Raw conversation turns and tool calls, appended by the bundled opencode plugin before " +
      "anything is distilled into the vault. Nothing in this tool prunes them, so on a machine " +
      "using that integration this is memory content living outside your vault.",
    sources: ["plugins/opencode/open-second-brain.ts", "src/core/brain/sessions/opencode.ts"],
  },
  {
    id: "relocated_search_index",
    label: "relocated search index",
    location: "OPEN_SECOND_BRAIN_SEARCH_DB, or the search_db_path config key, when either is set",
    carries_memory: true,
    created_by: "setting either of those, then running `o2b search index`",
    removed_by: "deleting that file; `o2b search index` rebuilds it from the vault",
    note:
      "Derived and rebuildable, so no memory is LOST by deleting it - but with the override " +
      "pointed outside the vault, a copy of every indexed chunk lives at that path. The first " +
      "line above says where this run resolved it.",
    sources: ["src/core/search/paths.ts"],
  },
  {
    id: "machine_config",
    label: "machine-local plugin config",
    location:
      "$OPEN_SECOND_BRAIN_CONFIG, else ${XDG_CONFIG_HOME:-~/.config}/open-second-brain/config.yaml",
    carries_memory: false,
    created_by: "`o2b init`, and any verb that writes a config key",
    removed_by: "`o2b uninstall --apply-local`",
    note:
      "Holds the pointer to this vault, any embedding_api_key, the device_id your log shards are " +
      "attributed to, and the installation_secret that keys every vault://<hex> reference MCP " +
      "tools have already handed out. A vault copied without it keeps every memory and loses " +
      "those references.",
    sources: ["src/core/config.ts"],
  },
  {
    id: "vault_profiles",
    label: "vault profiles registry",
    location: "profiles.json, beside the config file above",
    carries_memory: false,
    created_by: "`o2b vault profile create <name> <vault>`, and `o2b vault profile switch`",
    removed_by: "`o2b uninstall --apply-local`, which removes the directory it sits in",
    note:
      "The name and absolute path of every registered vault, plus which one is active. Deleting " +
      "a vault leaves its entry here.",
    sources: ["src/core/brain/portability/profiles.ts"],
  },
  {
    id: RUNTIME_CONFIG_BLOCKS_ID,
    label: "managed blocks in each agent's own config",
    location: "each installed runtime's own config file",
    carries_memory: false,
    created_by: "`o2b install --target <t> --apply`, once per runtime you install",
    removed_by: "`o2b uninstall --target <t> --apply`",
    note:
      "They point at this vault; they hold none of it. Which runtimes are installed on this " +
      "machine is not read here - `o2b install --check` answers that.",
    sources: ["src/core/install/adapters/", "src/core/install/grok-asset.ts", "src/cli/aider.ts"],
  },
  {
    id: "cli_symlinks",
    label: "CLI symlinks",
    location: "~/.local/bin/o2b, ~/.local/bin/vault-log, ~/.local/bin/o2b-hook",
    carries_memory: false,
    created_by: "`o2b install-cli`",
    removed_by: "`o2b uninstall --remove-cli`",
    note:
      "Re-pointed automatically at SessionStart when a plugin update rotates the checkout they " +
      "name, so they follow the installation rather than rotting with it.",
    sources: ["src/cli/install-cli.ts", "hooks/active-inject.ts"],
  },
  {
    id: "codex_instruction_fence",
    label: "managed instruction fence in Codex's config",
    location: "~/.codex/config.toml",
    carries_memory: false,
    created_by: "`o2b brain protect --target codex`",
    removed_by: "`o2b brain unprotect --target codex`",
    note:
      "The same verb's claudecode target writes inside the vault instead, so this row is about " +
      "the codex target only.",
    sources: ["src/core/brain/protect.ts"],
  },
  {
    id: "hook_reminder_markers",
    label: "hook reminder markers",
    location: "${O2B_REMINDER_STATE_DIR:-$TMPDIR/o2b-reminder-markers}",
    carries_memory: false,
    created_by: "the post-write reminder hook, once per session id",
    removed_by: "the hook itself, which prunes markers older than 48 hours",
    note:
      "One empty file per session id. It records that a reminder was shown; it records nothing " +
      "that was said.",
    sources: ["hooks/post-write-reminder.ts", "plugins/codex/hooks/post-write-reminder.ts"],
  },
  {
    id: "cron_recipe_artifacts",
    label: "cron recipe scripts and their stamps",
    location:
      "~/.local/bin/<job>.sh, plus ${XDG_STATE_HOME:-~/.local/state}/open-second-brain/ for the " +
      "codegraph resync stamp",
    carries_memory: false,
    created_by:
      "you, following a recipe printed by a `--cron-template` verb - this tool installs none of it",
    removed_by: "deleting the script and the stamp, and removing the crontab line yourself",
    note:
      "The recipes are text on stdout: every write in them is a shell command your own crontab " +
      "runs on your own host. Nothing in this tool creates, updates or removes them.",
    sources: [
      "src/cli/cron-recipe.ts",
      "src/cli/partner-codegraph-cron.ts",
      "src/cli/search-cron-template.ts",
    ],
  },
  {
    id: "bench_run_artifacts",
    label: "benchmark run artifacts",
    location: ".open-second-brain/bench-runs, resolved against the working directory",
    carries_memory: false,
    created_by: "`o2b brain bench`, in whichever directory you ran it from",
    removed_by: "deleting that directory yourself",
    note:
      "Written against the CWD rather than the vault - so they are outside it whenever that " +
      "command was run from anywhere else.",
    sources: ["src/cli/brain/verbs/bench.ts"],
  },
]);

/**
 * Modules the out-of-vault sweep finds that leave no location behind, each
 * with the reason it is not a place an operator will ever find state.
 *
 * The sweep enrols every module that BUILDS a path rooted outside the
 * vault, so this map is larger than the write-call version it replaces and
 * covers three shapes: a module that only reads such a path, a module that
 * computes one and hands it to an attributed writer, and a module whose
 * only such path is created and removed inside the call that made it.
 * Anything an operator could still discover on their machine afterwards
 * belongs in {@link OUT_OF_VAULT_STATE} instead, no matter how small.
 */
export const OUT_OF_VAULT_SWEEP_EXCLUSIONS: ReadonlyMap<string, string> = new Map([
  [
    "src/core/brain/snapshot.ts",
    "its only home- or temp-rooted write is an `mkdtempSync` staging directory that the same " +
      "call removes; the archives it stages are written under Brain/.snapshots inside the vault, " +
      "so nothing it creates outlives the run outside the vault",
  ],
  [
    "src/core/search/link-ratchet.ts",
    "its only temp-rooted write is an `mkdtempSync` scratch directory removed by the same call. " +
      "The ratchet state it actually persists lives inside the vault, so this module leaves " +
      "nothing behind on the machine",
  ],
  [
    "src/core/install/ownership.ts",
    "this module IS the enumeration: the home- and XDG-rooted strings in it are the `location` " +
      "fields the statement prints, and it writes nothing at all - it takes the vault, the " +
      "backing verdict and the measurements as parameters and returns text",
  ],
  [
    "src/cli/install/install.ts",
    "the only out-of-vault path it builds is `InstallEnv.home`, which it hands to the adapters; " +
      "every file written from it belongs to the runtime_config_blocks row, and this verb writes " +
      "nothing outside the vault on its own account",
  ],
  [
    "src/cli/install/init-interactive.ts",
    "same shape as the install verb: it resolves the home directory only to build the InstallEnv " +
      "the adapters receive, and the files that appear from it are the runtime_config_blocks row " +
      "written by those adapters",
  ],
  [
    "src/cli/install/uninstall-target.ts",
    "it builds `InstallEnv.home` to REMOVE what an adapter wrote, per that target's install " +
      "manifest. A verb that only deletes cannot add a location an operator will find, and the " +
      "locations it deletes are the runtime_config_blocks row",
  ],
  [
    "src/cli/update.ts",
    "it rebuilds the same `InstallEnv.home` to re-apply existing install targets after a plugin " +
      "update; the files it can change are the runtime_config_blocks row, and it introduces no " +
      "path of its own outside the vault",
  ],
  [
    "src/cli/uninstall.ts",
    "it only removes: the machine-local config directory (the machine_config row, behind a " +
      "name-and-shape guard) and, with --remove-cli, the cli_symlinks row. The home-rooted " +
      "strings in it are the instructions it prints about those two rows",
  ],
  [
    "src/core/doctor-readiness.ts",
    "it reads `process.env['HOME']` only to build the `InstallEnv` each adapter's own `verify` " +
      "is called with, and every probe in it is read-only by contract - the doctor establishes " +
      "state, it never creates any",
  ],
  [
    "src/core/brain/claude-memory-paths.ts",
    "it resolves and safety-checks the `~/.claude/projects/<slug>/memory` directory this tool " +
      "IMPORTS FROM, refusing any path outside it. The import writes into the vault; nothing " +
      "here creates or touches anything under that home-rooted path",
  ],
  [
    "src/core/discipline/transcripts/claude-code.ts",
    "a read-only transcript scanner: it locates the runtime's own session logs under the home " +
      "directory and reads them. The runtime wrote those files and owns them; this module " +
      "creates nothing and deletes nothing there",
  ],
  [
    "src/core/discipline/transcripts/codex.ts",
    "a read-only transcript scanner: it locates the runtime's own session logs under the home " +
      "directory and reads them. The runtime wrote those files and owns them; this module " +
      "creates nothing and deletes nothing there",
  ],
  [
    "src/core/discipline/transcripts/cursor.ts",
    "a read-only transcript scanner: it locates the runtime's own session logs and workspace " +
      "state under the home directory and reads them. The runtime wrote those files and owns " +
      "them; this module creates nothing and deletes nothing there",
  ],
  [
    "src/core/brain/gates/durability.ts",
    "the temp-directory tokens in it are a REFUSAL list: the gate matches a candidate vault path " +
      "against them so a vault on volatile storage is rejected before anything is written. It " +
      "builds no path and writes nothing anywhere",
  ],
  [
    "src/core/brain/secrets/exec.ts",
    "TMPDIR appears in the environment allow-list handed to a spawned command, so the child gets " +
      "a usable temp directory. This module builds no path from it, and what a spawned command " +
      "writes into its own temp directory is that command's business, not a location this tool leaves",
  ],
]);

/**
 * Declared sources of {@link OUT_OF_VAULT_STATE} rows that the sweep
 * cannot enrol, each with the reason its path carries no anchor to match.
 *
 * This map exists because the docblock above claims the census makes a new
 * out-of-vault location impossible to ship unnoticed, and that claim is
 * true only for paths built from a home-, XDG- or temp-rooted token. A
 * root that arrives from a config key, an env override or the working
 * directory looks like any other relative path in the source, so these
 * rows are held true by their own tests and by review, not by the sweep -
 * and saying which is which is the difference between a census and a
 * claim about a census.
 */
export const SOURCES_INVISIBLE_TO_THE_SWEEP: ReadonlyMap<string, string> = new Map([
  [
    "src/core/search/paths.ts",
    "the relocated index path comes from OPEN_SECOND_BRAIN_SEARCH_DB or search_db_path, an " +
      "operator-supplied absolute path; there is no home or XDG token in the source to match on. " +
      "Where it actually resolved IS measured per run and printed on the first line",
  ],
  [
    "src/cli/brain/verbs/bench.ts",
    "the bench directory is a relative path resolved against the working directory, so it carries " +
      "no root token at all. A CWD-rooted write is invisible to this sweep by construction and " +
      "this row is the only one of its kind",
  ],
  [
    "src/core/brain/sessions/opencode.ts",
    "the spool root is read from OSB_OPENCODE_SPOOL_DIR when set; the plugin that writes the " +
      "turns (plugins/opencode/open-second-brain.ts) does carry the XDG token and IS swept, so " +
      "the location is covered even though this reader is not",
  ],
  [
    "src/core/install/grok-asset.ts",
    "it writes through the install env's injected home rather than naming a root itself; the " +
      "adapter directory it belongs to is swept and attributed to the same row, so the location " +
      "is covered by its sibling",
  ],
  [
    "src/core/brain/portability/profiles.ts",
    "the registry is written beside whatever config file it was handed - `dirname(configPath)` - " +
      "so the root arrives as an argument and no home or XDG token appears in the source. The " +
      "config path itself is built by src/core/config.ts, which IS swept",
  ],
  [
    "hooks/active-inject.ts",
    "it re-points the CLI symlinks by calling `healCliSymlinks` in src/cli/install-cli.ts, which " +
      "is swept and attributed to this same row; the hook names no path of its own, so the " +
      "location is covered by the module that builds it",
  ],
  [
    "src/cli/search-cron-template.ts",
    "the script path it recommends is built by src/cli/cron-recipe.ts, which is swept; this " +
      "module only supplies the job name and body, so it names no root of its own",
  ],
]);

// ----- The measured half ----------------------------------------------------

/**
 * Where the search index turned out to be, relative to the vault.
 *
 * A closed vocabulary rather than a boolean because "could not be
 * established" is a real answer and must not be spelled as `false`: the
 * first line of the statement used to assert the index was "in the same
 * vault" with nothing measured at all, two lines above a row saying it may
 * not be.
 */
export const SEARCH_INDEX_LOCATION = Object.freeze({
  insideVault: "inside_vault",
  outsideVault: "outside_vault",
  unchecked: "unchecked",
} as const);

export type SearchIndexLocationState =
  (typeof SEARCH_INDEX_LOCATION)[keyof typeof SEARCH_INDEX_LOCATION];

export interface SearchIndexVerdict {
  readonly state: SearchIndexLocationState;
  /** The resolved path; null exactly when the state is `unchecked`. */
  readonly path: string | null;
  /** Why it could not be established; null exactly when it was. */
  readonly reason: string | null;
}

/**
 * The state of one outbound integration, as this run found it.
 *
 * `unchecked` carries the reason the check could not run, so a config that
 * will not resolve is reported rather than silently reading as "not
 * configured" - the direction that would print an unqualified "nothing to
 * cancel" on the strength of a check that never happened.
 */
export const OUTBOUND_STATE = Object.freeze({
  configured: "configured",
  absent: "absent",
  unchecked: "unchecked",
} as const);

export type OutboundState = (typeof OUTBOUND_STATE)[keyof typeof OUTBOUND_STATE];

/**
 * The id of every outbound integration this build has.
 *
 * Spelled as a frozen literal map rather than read back off
 * {@link OUTBOUND_SERVICES} so the ids stay a UNION rather than widening
 * to `string`: it is that union which makes {@link
 * DataOwnershipInput.outbound} a total record, and a total record is what
 * stops a fifth integration shipping unmeasured.
 */
export const OUTBOUND_SERVICE = Object.freeze({
  embedding: "embedding_provider",
  rerank: "cross_encoder_rerank",
  telegram: "telegram_capture",
  research: "web_research",
} as const);

/** The id of every row in {@link OUTBOUND_SERVICES}, as a union. */
export type OutboundServiceId = (typeof OUTBOUND_SERVICE)[keyof typeof OUTBOUND_SERVICE];

/** One integration that sends data off this machine once it is configured. */
export interface OutboundService {
  readonly id: OutboundServiceId;
  /** What it is, as the statement prints it. */
  readonly label: string;
  /** What leaves this machine when it is on. */
  readonly sends: string;
  /** The settings that turn it on, named so the operator can find them. */
  readonly settings: string;
}

/**
 * Every outbound integration in this build, as the statement checks them.
 *
 * The blanket "no account, no server, no sync endpoint: nothing to cancel"
 * was qualified by exactly one of these before, so an operator running the
 * cross-encoder reranker - which POSTs the query AND the candidate
 * document text under an API key - read a printed inventory that did not
 * include it. Each row here is measured per run, and the statement says
 * that these are the ones it checked rather than that they are everything
 * that could ever be wired up.
 */
export const OUTBOUND_SERVICES: ReadonlyArray<OutboundService> = Object.freeze([
  {
    id: OUTBOUND_SERVICE.embedding,
    label: "networked embedding endpoint",
    sends: "the text of every indexed chunk, and every semantic query",
    settings: "embedding_provider / embedding_base_url",
  },
  {
    id: OUTBOUND_SERVICE.rerank,
    label: "cross-encoder reranker",
    sends: "each query and the full text of the candidate documents it ranks",
    settings: "search_rerank_enabled / search_rerank_base_url / search_rerank_env_key",
  },
  {
    id: OUTBOUND_SERVICE.telegram,
    label: "Telegram capture bot",
    sends:
      "long-polling requests carrying your bot token, and it captures messages that have " +
      "already passed through Telegram's servers",
    settings: "TELEGRAM_BOT_TOKEN / telegram_bot_token",
  },
  {
    id: OUTBOUND_SERVICE.research,
    label: "web research providers",
    sends: "the search queries the research verbs issue, to whichever provider key is set",
    settings: "TAVILY_API_KEY / BRAVE_API_KEY",
  },
]);

/** One outbound row plus the state this run measured for it. */
export interface OutboundServiceStatus extends OutboundService {
  readonly state: OutboundState;
  /** Why the check could not run; null unless the state is `unchecked`. */
  readonly reason: string | null;
  /** The resolved endpoint, when there was one to resolve; null otherwise. */
  readonly endpoint: string | null;
}

// ----- The composed statement ----------------------------------------------

export interface DataOwnershipInput {
  /** The vault as the canonical resolver answered it, never a raw config key. */
  readonly vault: string;
  /** Where the search index resolved, measured by the caller. */
  readonly searchIndex: SearchIndexVerdict;
  /** Targets the install registry knows, so a new adapter is covered by construction. */
  readonly adapterTargets: ReadonlyArray<string>;
  /**
   * One entry per {@link OUTBOUND_SERVICES} row. A total record rather
   * than a partial one: a fifth integration added to that catalogue stops
   * every caller compiling until it is measured too, which is the property
   * that kept the old single-boolean version from ever being noticed.
   */
  readonly outbound: Readonly<Record<OutboundServiceId, OutboundMeasurement>>;
  /** Injected for tests; probed from {@link vault} when omitted. */
  readonly backing?: VaultBackingVerdict;
}

/** What a caller measured about one outbound integration. */
export interface OutboundMeasurement {
  readonly state: OutboundState;
  /** Required when the state is `unchecked`; ignored otherwise. */
  readonly reason?: string;
  /**
   * The endpoint the configured integration talks to, when the caller
   * resolved one.
   *
   * Printed instead of classifying the host, because classifying it is
   * where the previous version went wrong in the other direction: the
   * provider KIND was read as proof of a third party, so an
   * OpenAI-compatible server on the operator's own loopback address was
   * announced as an account they neither own nor cancel. Naming the
   * endpoint and saying this tool does not run it is true either way, and
   * the operator can see which case they are in.
   */
  readonly endpoint?: string;
}

/**
 * The machine-readable half. It is the same value the human sentence is
 * rendered from - see {@link renderDataOwnership} - so the two surfaces
 * cannot be added separately, which is how the install verb's JSON and
 * human outputs drifted before anything tested either.
 */
export interface DataOwnership {
  readonly vault: string;
  readonly backing: VaultBackingVerdict;
  readonly search_index: SearchIndexVerdict;
  readonly outside_vault: ReadonlyArray<OutOfVaultState>;
  readonly outbound_services: ReadonlyArray<OutboundServiceStatus>;
}

/** Fill the adapter-derived row from the live registry. */
function withAdapterTargets(
  entry: OutOfVaultState,
  targets: ReadonlyArray<string>,
): OutOfVaultState {
  if (entry.id !== RUNTIME_CONFIG_BLOCKS_ID || targets.length === 0) return entry;
  // "installable" rather than "installed": this is the registry's target
  // list, which says what this build CAN write a block into. Reading it as
  // the set of runtimes that hold one is exactly the over-claim the row's
  // `created_by` now prevents.
  return {
    ...entry,
    location: `${entry.location} (installable targets: ${[...targets].toSorted().join(", ")})`,
  };
}

/** Attach the measured state to each outbound row, in catalogue order. */
function outboundStatuses(
  measured: Readonly<Record<OutboundServiceId, OutboundMeasurement>>,
): ReadonlyArray<OutboundServiceStatus> {
  return OUTBOUND_SERVICES.map((service) => {
    const m = measured[service.id];
    return {
      ...service,
      state: m.state,
      reason: m.state === OUTBOUND_STATE.unchecked ? (m.reason ?? UNCHECKED_WITHOUT_REASON) : null,
      endpoint: m.endpoint ?? null,
    };
  });
}

/**
 * What an `unchecked` state says when its caller supplied no reason.
 *
 * Not an empty string and not a silent drop to "not configured": a check
 * that did not run is the one state this statement must never round down,
 * so a caller that forgets the reason still prints a sentence the operator
 * can act on.
 */
const UNCHECKED_WITHOUT_REASON = "the check did not run and reported no reason";

export function buildDataOwnership(input: DataOwnershipInput): DataOwnership {
  return {
    vault: input.vault,
    backing: input.backing ?? probeVaultBacking(input.vault),
    search_index: input.searchIndex,
    outside_vault: OUT_OF_VAULT_STATE.map((entry) =>
      withAdapterTargets(entry, input.adapterTargets),
    ),
    outbound_services: outboundStatuses(input.outbound),
  };
}

/**
 * What the backing verdict lets the statement say about survival.
 *
 * Exhaustive over {@link VaultBackingState} with no default arm: a fifth
 * state added to that vocabulary fails this file to build rather than
 * inheriting whichever sentence happened to be the fallback.
 */
function survivalLine(backing: VaultBackingVerdict): string {
  switch (backing.state) {
    case VAULT_BACKING.durable:
      return `That path is on ${backing.filesystem}, which survives this process and a reboot.`;
    case VAULT_BACKING.volatile:
      return (
        `That path is on ${backing.filesystem}, which is memory-backed: everything in it is ` +
        "gone at reboot. Move the vault to disk before you rely on it."
      );
    case VAULT_BACKING.layered:
      return (
        `That path is on ${backing.filesystem}, a container union mount. Whether it survives ` +
        "this container exiting is not something the host reports, so treat it as unproven."
      );
    case VAULT_BACKING.undetermined:
      return (
        `Whether that path survives this process could not be established: ${backing.detail}. ` +
        "This is stated rather than assumed either way."
      );
  }
}

/**
 * What the measured index location lets the statement say about the index.
 *
 * Exhaustive over {@link SearchIndexLocationState} with no default arm,
 * for the reason {@link survivalLine} has none: the clause this replaces
 * asserted the inside-the-vault arm unconditionally.
 */
function searchIndexLine(index: SearchIndexVerdict): string {
  switch (index.state) {
    case SEARCH_INDEX_LOCATION.insideVault:
      return (
        `The search index is at ${index.path}, inside that vault: a rebuildable SQLite file ` +
        "that travels with a copy of it."
      );
    case SEARCH_INDEX_LOCATION.outsideVault:
      return (
        `The search index is NOT in that vault - it resolved to ${index.path}. It is derived ` +
        "and rebuildable, so no memory is lost by leaving it behind, but a copy of the vault " +
        "does not include it and a copy of every indexed chunk stays at that path."
      );
    case SEARCH_INDEX_LOCATION.unchecked:
      return (
        `Where the search index lives could not be established: ${index.reason}. It is normally ` +
        "inside the vault and can be relocated by OPEN_SECOND_BRAIN_SEARCH_DB or search_db_path, " +
        "so this run cannot tell you which is the case."
      );
  }
}

/** What one outbound row says once its state is known. */
function outboundLine(service: OutboundServiceStatus): string {
  switch (service.state) {
    case OUTBOUND_STATE.configured:
      return (
        `${service.label}: CONFIGURED (${service.settings}) - it sends ${service.sends}` +
        `${service.endpoint === null ? "" : `, to ${service.endpoint}`}. This tool does not run ` +
        "that endpoint and cannot cancel it for you."
      );
    case OUTBOUND_STATE.absent:
      return `${service.label}: not configured (${service.settings})`;
    case OUTBOUND_STATE.unchecked:
      return `${service.label}: NOT CHECKED - ${service.reason} (${service.settings})`;
  }
}

/**
 * Render the statement an operator reads.
 *
 * This is the ONE place the structured value becomes prose, following
 * `renderRuntimeNotices`: the machine-readable field and the sentence a
 * person reads are two views of one record rather than two hand-written
 * copies.
 */
export function renderDataOwnership(ownership: DataOwnership): string {
  const carriers = ownership.outside_vault.filter((e) => e.carries_memory);
  const lines: string[] = [
    "Your data, and where it is:",
    `  Your brain is ${ownership.vault}. Every memory this tool writes is a Markdown file under it.`,
    `  ${searchIndexLine(ownership.search_index)}`,
    `  ${survivalLine(ownership.backing)}`,
    "",
    "  Nothing here is a subscription: this tool has no account of its own, no server it phones home to, no sync endpoint and no update check. What can send your text off this machine is an integration you configure, and these are the ones this run checked:",
  ];
  for (const service of ownership.outbound_services) {
    lines.push(`    - ${outboundLine(service)}`);
  }
  lines.push(
    "  That is what was checked, not a proof that nothing else can reach the network: anything you wire up yourself - your own MCP server, your own hook - is outside what this statement can see.",
  );
  lines.push(
    "",
    `  Copy the vault and the memory in it goes with the copy. This tool can also leave ${ownership.outside_vault.length} kinds of state OUTSIDE the vault, which never travel in a copy. What follows is the catalogue of what it can leave - not a scan of this machine - so each row says what creates it and what removes it:`,
  );
  for (const entry of ownership.outside_vault) {
    lines.push(`    - ${entry.label} — ${entry.location}`);
    lines.push(`      created by: ${entry.created_by}`);
    lines.push(`      removed by: ${entry.removed_by}`);
    lines.push(`      ${entry.note}`);
  }
  if (carriers.length > 0) {
    lines.push(
      "",
      `  ${carriers.length} of those can hold memory content rather than plumbing, which is why the first line says what this tool WRITES rather than everything you have ever said to it.`,
    );
  }
  lines.push(
    "",
    `  Deleting the vault deletes every memory inside it, and nothing else. It does not touch the ${ownership.outside_vault.length} kinds of state above - ${carriers.length} of which can hold memory content - and no single verb removes them all: each row names the one that removes it.`,
    "",
  );
  return lines.join("\n");
}

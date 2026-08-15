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
 *      operator who configured a cloud embedding endpoint - vault text has
 *      been sent to a third party this tool does not manage.
 *
 * So the statement is COMPOSED rather than written: from the resolved
 * vault path, from a filesystem-backing verdict that is allowed to say
 * `undetermined`, from the enumeration in {@link OUT_OF_VAULT_STATE}, and
 * from whether a networked embedding provider is configured. Every one of
 * those is a measurement; none is an assumption.
 *
 * {@link OUT_OF_VAULT_STATE} is a real list rather than prose because
 * `tests/core/install/ownership.test.ts` sweeps the tree for modules that
 * write to home-, XDG- or temp-rooted paths and demands each be attributed
 * to an entry here or excused in {@link OUT_OF_VAULT_SWEEP_EXCLUSIONS}. A
 * new out-of-vault location therefore cannot ship without the sentence
 * learning about it - which the install adapters in particular badly
 * needed, since `write-site-census.test.ts` excludes them by name.
 *
 * Pure: nothing here reads the environment. The vault path, the backing
 * verdict, the installed adapter targets and the embedding state are all
 * parameters, so the statement a test asserts on is the statement an
 * operator gets.
 */

import { probeVaultBacking, VAULT_BACKING, type VaultBackingVerdict } from "../vault-backing.ts";

// ----- The enumeration ------------------------------------------------------

/** One durable thing that lives outside the vault. */
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
  /** Why it is out there, and what its absence costs on a copy. */
  readonly note: string;
  /**
   * Repo-relative modules that own this path. A trailing `/` matches a
   * directory prefix. The census attributes swept writers through this
   * field, so an anchor that rots fails a test rather than silently
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
 * Everything durable this tool leaves outside the vault.
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
    note:
      "Derived and rebuildable, so no memory is LOST by deleting it - but with the override " +
      "pointed outside the vault, a copy of every indexed chunk lives at that path.",
    sources: ["src/core/search/paths.ts"],
  },
  {
    id: "machine_config",
    label: "machine-local plugin config",
    location:
      "$OPEN_SECOND_BRAIN_CONFIG, else ${XDG_CONFIG_HOME:-~/.config}/open-second-brain/config.yaml",
    carries_memory: false,
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
    note:
      "Written by `o2b install --target <t> --apply` and removed by `o2b uninstall`. They point " +
      "at this vault; they hold none of it.",
    sources: ["src/core/install/adapters/", "src/core/install/grok-asset.ts", "src/cli/aider.ts"],
  },
  {
    id: "cli_symlinks",
    label: "CLI symlinks",
    location: "~/.local/bin/o2b, ~/.local/bin/vault-log, ~/.local/bin/o2b-hook",
    carries_memory: false,
    note:
      "Created by `o2b install-cli`, and re-pointed automatically at SessionStart when a plugin " +
      "update rotates the checkout they name.",
    sources: ["src/cli/install-cli.ts", "hooks/active-inject.ts"],
  },
  {
    id: "codex_instruction_fence",
    label: "managed instruction fence in Codex's config",
    location: "~/.codex/config.toml",
    carries_memory: false,
    note:
      "Written by `o2b brain protect --target codex`. The same verb's claudecode target writes " +
      "inside the vault instead.",
    sources: ["src/core/brain/protect.ts"],
  },
  {
    id: "hook_reminder_markers",
    label: "hook reminder markers",
    location: "${O2B_REMINDER_STATE_DIR:-$TMPDIR/o2b-reminder-markers}",
    carries_memory: false,
    note:
      "One empty file per session id, pruned after 48 hours. It records that a reminder was " +
      "shown; it records nothing that was said.",
    sources: ["hooks/post-write-reminder.ts", "plugins/codex/hooks/post-write-reminder.ts"],
  },
  {
    id: "bench_run_artifacts",
    label: "benchmark run artifacts",
    location: ".open-second-brain/bench-runs, resolved against the working directory",
    carries_memory: false,
    note:
      "Written only by `o2b brain bench`, and against the CWD rather than the vault - so they " +
      "are outside it whenever that command was run from anywhere else.",
    sources: ["src/cli/brain/verbs/bench.ts"],
  },
]);

/**
 * Modules the out-of-vault sweep finds that leave nothing behind, each
 * with the reason it is not a location an operator will ever find.
 *
 * Only one shape earns an entry: a path created and removed inside the
 * call that made it. Anything an operator could still discover on their
 * machine afterwards belongs in {@link OUT_OF_VAULT_STATE} instead, no
 * matter how small.
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
]);

// ----- The composed statement ----------------------------------------------

export interface DataOwnershipInput {
  /** The vault as the canonical resolver answered it, never a raw config key. */
  readonly vault: string;
  /** Targets the install registry knows, so a new adapter is covered by construction. */
  readonly adapterTargets: ReadonlyArray<string>;
  /** True when embeddings are computed by an endpoint this tool does not run. */
  readonly networkedEmbeddingProvider: boolean;
  /** Injected for tests; probed from {@link vault} when omitted. */
  readonly backing?: VaultBackingVerdict;
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
  readonly outside_vault: ReadonlyArray<OutOfVaultState>;
  readonly third_party_embedding_configured: boolean;
}

/** Fill the adapter-derived row from the live registry. */
function withAdapterTargets(
  entry: OutOfVaultState,
  targets: ReadonlyArray<string>,
): OutOfVaultState {
  if (entry.id !== RUNTIME_CONFIG_BLOCKS_ID || targets.length === 0) return entry;
  return { ...entry, location: `${entry.location} (${[...targets].toSorted().join(", ")})` };
}

export function buildDataOwnership(input: DataOwnershipInput): DataOwnership {
  return {
    vault: input.vault,
    backing: input.backing ?? probeVaultBacking(input.vault),
    outside_vault: OUT_OF_VAULT_STATE.map((entry) =>
      withAdapterTargets(entry, input.adapterTargets),
    ),
    third_party_embedding_configured: input.networkedEmbeddingProvider,
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

/** The one line the caveat about a configured cloud endpoint adds. */
const THIRD_PARTY_EMBEDDING_LINE =
  "One exception you configured: embedding requests send vault text to the endpoint in " +
  "embedding_base_url, which is a third-party account this tool neither owns nor cancels.";

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
    `  Your brain is ${ownership.vault}. Every memory this tool writes is a Markdown file under it, and the search index beside them is a rebuildable SQLite file in the same vault.`,
    `  ${survivalLine(ownership.backing)}`,
    "",
    "  No account, no server, no sync endpoint and no update check: nothing to cancel.",
  ];
  if (ownership.third_party_embedding_configured) {
    lines.push(`  ${THIRD_PARTY_EMBEDDING_LINE}`);
  }
  lines.push(
    "",
    `  Copy the vault and the memory goes with it. These ${ownership.outside_vault.length} things live outside it and do not travel in the copy:`,
  );
  for (const entry of ownership.outside_vault) {
    lines.push(`    - ${entry.label} — ${entry.location}`);
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
    "  Delete the vault and the memory is gone. What stays behind is the machine-local list above; `o2b uninstall` removes the parts this tool put there.",
    "",
  );
  return lines.join("\n");
}

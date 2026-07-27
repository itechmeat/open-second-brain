/**
 * `o2b search provider` and `o2b search rerank-provider` (Embedding
 * Provider Suite / retrieval-precision-quality-loop, card A).
 *
 * Two structurally identical profile registries with one `add|list|show|
 * remove` CRUD shape between them, so the dispatch lives once and each
 * verb supplies its registry's operations and its nouns.
 */

import {
  addProviderProfile,
  addRerankProviderProfile,
  getProviderProfile,
  getRerankProviderProfile,
  loadProviderRegistry,
  loadRerankRegistry,
  removeProviderProfile,
  removeRerankProviderProfile,
} from "../../../core/search/index.ts";
import {
  EMBEDDING_MODEL_PRESETS,
  RECOMMENDED_EMBEDDING_MODEL,
  type EmbeddingModelPreset,
} from "../../../core/search/embeddings/presets.ts";
import {
  CliError,
  flagBoolean,
  flagString,
  parseFlags,
  resolveConfig,
  VAULT_FLAGS,
} from "../helpers.ts";

/** Structural shape shared by `ProviderProfile` and `RerankProviderProfile`. */
interface CliRegistryProfile {
  readonly name: string;
  readonly baseUrl: string;
  readonly defaultModel: string;
  readonly envKey: string | ReadonlyArray<string>;
}

/** Render an env-key that may be a single name or an ordered probe list. */
function formatEnvKey(envKey: string | ReadonlyArray<string>): string {
  return typeof envKey === "string" ? envKey : envKey.join(",");
}

/**
 * Parse a `--env-key` flag into a single name or an ordered probe list.
 * Accepts a comma-separated list so multi-key failover is CLI-registrable;
 * a single name stays a plain string (byte-identical single-key profile).
 */
function parseEnvKeyFlag(raw: string): string | string[] {
  const parts = raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k !== "");
  return parts.length <= 1 ? (parts[0] ?? "") : parts;
}

/**
 * CRUD operations a provider-style registry exposes to the CLI, plus the
 * naming used in usage/output strings. `verb` is the CLI subcommand name
 * (`provider` / `rerank-provider`); `kind` is the human noun used in prose
 * (`provider` / `rerank provider`).
 */
interface ProviderRegistryOps<T extends CliRegistryProfile> {
  readonly verb: string;
  readonly kind: string;
  readonly load: (vault: string) => ReadonlyArray<T>;
  readonly get: (vault: string, name: string) => T | null;
  readonly add: (vault: string, profile: CliRegistryProfile) => ReadonlyArray<T>;
  readonly remove: (vault: string, name: string) => { removed: boolean };
  /**
   * When true, `--env-key` accepts a comma-separated probe list for
   * multi-key failover (embedding provider only). Rerank stays single-key.
   */
  readonly multiKey?: boolean;
  /**
   * Curated model catalog surfaced via the `presets` action and used as the
   * `--model` default when omitted (embedding provider only). Advisory.
   */
  readonly presets?: ReadonlyArray<EmbeddingModelPreset>;
  /** Recommended default model string when `--model` is omitted. */
  readonly recommendedModel?: string;
}

/**
 * Shared `add|list|show|remove` dispatch for the provider and rerank-provider
 * registries (retrieval-precision-quality-loop, card A) - identical CRUD
 * shape over two structurally identical profile registries.
 */
async function runProviderRegistryCommand<T extends CliRegistryProfile>(
  argv: ReadonlyArray<string>,
  ops: ProviderRegistryOps<T>,
): Promise<number> {
  const { verb, kind } = ops;
  const action = argv[0];
  const allowed = ops.presets
    ? ["add", "list", "show", "remove", "presets"]
    : ["add", "list", "show", "remove"];
  if (!action || !allowed.includes(action)) {
    throw new CliError(
      `usage: o2b search ${verb} <add NAME --base-url U [--model M] --env-key K | list | show NAME | remove NAME${ops.presets ? " | presets" : ""}> [--json]`,
    );
  }
  const { flags, positional } = parseFlags(argv.slice(1), {
    ...VAULT_FLAGS,
    "base-url": { type: "string" },
    model: { type: "string" },
    "env-key": { type: "string" },
    json: { type: "boolean" },
  });
  const json = flagBoolean(flags, "json");

  // `presets` is a static catalog listing; it needs no vault/config.
  if (action === "presets" && ops.presets) {
    if (json) {
      process.stdout.write(JSON.stringify(ops.presets) + "\n");
      return 0;
    }
    process.stdout.write(`curated embedding models (recommended: ${ops.recommendedModel}):\n`);
    for (const p of ops.presets) {
      const tag = p.multilingual ? "multilingual" : "monolingual";
      process.stdout.write(`  ${p.model}\n    dim=${p.dimension} ${tag} - ${p.note}\n`);
    }
    return 0;
  }

  const cfg = resolveConfig(flags);
  const name = typeof positional[0] === "string" ? positional[0] : undefined;

  if (action === "list") {
    const registry = ops.load(cfg.vault);
    if (json) {
      process.stdout.write(JSON.stringify(registry) + "\n");
      return 0;
    }
    if (registry.length === 0) {
      process.stdout.write(`no registered ${kind}s\n`);
      return 0;
    }
    for (const p of registry) {
      process.stdout.write(
        `${p.name}  ${p.baseUrl}  model=${p.defaultModel}  env=${formatEnvKey(p.envKey)}\n`,
      );
    }
    return 0;
  }

  if (action === "show") {
    if (!name) throw new CliError(`usage: o2b search ${verb} show NAME`);
    const profile = ops.get(cfg.vault, name);
    if (!profile) {
      process.stderr.write(`error: no registered ${kind} named '${name}'\n`);
      return 1;
    }
    process.stdout.write(
      json
        ? JSON.stringify(profile) + "\n"
        : `${profile.name}\n  base-url:  ${profile.baseUrl}\n  model:     ${profile.defaultModel}\n  env-key:   ${formatEnvKey(profile.envKey)}\n`,
    );
    return 0;
  }

  if (action === "remove") {
    if (!name) throw new CliError(`usage: o2b search ${verb} remove NAME`);
    const { removed } = ops.remove(cfg.vault, name);
    if (json) {
      process.stdout.write(JSON.stringify({ removed, name }) + "\n");
    } else {
      process.stdout.write(removed ? `removed ${kind} '${name}'\n` : `no such ${kind} '${name}'\n`);
    }
    return removed ? 0 : 1;
  }

  // add
  if (!name)
    throw new CliError(`usage: o2b search ${verb} add NAME --base-url U --model M --env-key K`);
  const baseUrl = flagString(flags, "base-url");
  const flagModel = flagString(flags, "model");
  const envKey = flagString(flags, "env-key");
  // `--model` may be omitted when the registry has a recommended default
  // (embedding provider); custom models remain first-class and verbatim.
  const model = flagModel ?? ops.recommendedModel;
  const modelHint = ops.recommendedModel ? "[--model M]" : "--model M";
  if (!baseUrl || !model || !envKey) {
    throw new CliError(
      `${verb} add requires --base-url, ${modelHint}, and --env-key (the env var NAME holding the API key)`,
    );
  }
  const envKeyValue = ops.multiKey ? parseEnvKeyFlag(envKey) : envKey;
  const registry = ops.add(cfg.vault, { name, baseUrl, defaultModel: model, envKey: envKeyValue });
  const added = registry.find((p) => p.name === name)!;
  if (json) {
    process.stdout.write(JSON.stringify(added) + "\n");
  } else {
    const envHint = Array.isArray(envKeyValue) ? envKeyValue.join(" or ") : envKeyValue;
    const modelNote = flagModel ? "" : ` (defaulted --model to recommended '${model}')`;
    process.stdout.write(
      `added ${kind} '${name}'${modelNote} (set ${envHint} in the environment to supply its key)\n`,
    );
  }
  return 0;
}

export async function cmdSearchProvider(argv: ReadonlyArray<string>): Promise<number> {
  return runProviderRegistryCommand(argv, {
    verb: "provider",
    kind: "provider",
    load: loadProviderRegistry,
    get: getProviderProfile,
    add: addProviderProfile,
    remove: removeProviderProfile,
    multiKey: true,
    presets: EMBEDDING_MODEL_PRESETS,
    recommendedModel: RECOMMENDED_EMBEDDING_MODEL,
  });
}

export async function cmdSearchRerankProvider(argv: ReadonlyArray<string>): Promise<number> {
  return runProviderRegistryCommand(argv, {
    verb: "rerank-provider",
    kind: "rerank provider",
    load: loadRerankRegistry,
    get: getRerankProviderProfile,
    // Rerank stays single-key; coerce any probe-list shape back to a string.
    add: (vault, profile) =>
      addRerankProviderProfile(vault, { ...profile, envKey: formatEnvKey(profile.envKey) }),
    remove: removeRerankProviderProfile,
  });
}

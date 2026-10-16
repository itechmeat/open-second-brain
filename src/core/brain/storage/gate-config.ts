/**
 * The storage policy the ingest admission walls decide under, read from
 * ONLY the `storage:` block of `_brain.yaml`. Shared by the MCP ingest
 * tool and the capture inbox drain so the two walls cannot fail in
 * opposite directions on the same broken block.
 */

import { existsSync, readFileSync } from "node:fs";

import { brainConfigPath } from "../paths.ts";
import { BRAIN_CONFIG_SUPPORTED_VERSIONS } from "../policy/defaults.ts";
import { BrainConfigError } from "../policy/errors.ts";
import { KeyIndexCollector, type BlockParseContext } from "../policy/key-index.ts";
import {
  BRAIN_STORAGE_DEFAULTS,
  parseStorageBlock,
  resolveStorage,
} from "../policy/blocks/storage.ts";
import type { BrainConfig, ResolvedBrainStorageConfig } from "../types.ts";
import { parseBrainYaml, type ParsedBlock } from "../yaml-parse.ts";

/**
 * A broken `_brain.yaml` the admission gate cannot decide under. Its prose
 * is built from a relative config label, never the config's host path, so
 * the refusal can cross to a remote caller (see {@link loadGateStorageConfig}).
 */
export class StorageGateConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageGateConfigError";
  }
}

/**
 * The storage policy the admission gate decides under, read from ONLY the
 * `storage:` block of `_brain.yaml` (review M1).
 *
 * The gate's decision needs no other block, but the whole-file loader
 * validated all of them, so a typo in an unrelated block turned every
 * ingest into an internal error naming the config's host path - including
 * on vaults whose operator never configured a cap, where the documented
 * default is that nothing refuses. This reader answers the gate's actual
 * question: an absent config or block is the defaults (no cap, no gate),
 * and the rest of the file is never validated here.
 *
 * A file that cannot be read or parsed, an unsupported `schema_version`,
 * or a `storage:` block that does not validate is a policy this gate
 * cannot see through, and silently reading it as "no cap" would run
 * writes past an operator's bound. Those refuse BY NAME: the error
 * carries field-level prose built from a relative config label, and the
 * MCP handler maps it onto the registered `config_invalid` envelope -
 * never a path below local reach. Both admission walls read through here
 * (`brain_ingest_source` and the capture inbox drain's
 * {@link evaluateIngestAdmission}), so they apply one rule: refuse on a
 * storage block they cannot see through, ignore every other block.
 */
export function loadGateStorageConfig(vault: string): ResolvedBrainStorageConfig {
  const path = brainConfigPath(vault);
  if (!existsSync(path)) return BRAIN_STORAGE_DEFAULTS;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    // Only the errno code is kept: a read-failure message embeds the
    // absolute path the call failed on.
    const code = (err as NodeJS.ErrnoException).code ?? "unreadable";
    throw new StorageGateConfigError(`_brain.yaml could not be read (${code})`);
  }
  let parsed: ParsedBlock;
  try {
    parsed = parseBrainYaml(text);
  } catch (err) {
    // The parser's messages name line numbers, never paths.
    throw new StorageGateConfigError(`_brain.yaml could not be parsed: ${(err as Error).message}`);
  }
  const version = parsed["schema_version"];
  if (typeof version !== "number" || !BRAIN_CONFIG_SUPPORTED_VERSIONS.includes(version)) {
    throw new StorageGateConfigError(
      `_brain.yaml: unsupported schema_version: ${JSON.stringify(version ?? null)}`,
    );
  }
  const ctx: BlockParseContext = {
    obj: parsed,
    // A relative label, never the host path: the field errors this context
    // raises become the refusal's prose.
    source: "_brain.yaml",
    warnings: [],
    keys: new KeyIndexCollector(),
  };
  try {
    // Only the storage block is parsed and resolved; `resolveStorage`
    // reads nothing else off the config.
    return resolveStorage({ storage: parseStorageBlock(ctx) } as BrainConfig);
  } catch (err) {
    if (err instanceof BrainConfigError) throw new StorageGateConfigError(err.message);
    throw err;
  }
}

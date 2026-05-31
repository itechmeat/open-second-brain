/**
 * Minimal argv parser used by the `o2b` CLI.
 *
 * Intentionally not a full argparse port — the CLI grammar is small and
 * stable, so a hand-written parser keeps the binary dependency-free
 * (KISS, parity with the legacy Python no-deps stance).
 *
 * Conventions:
 *   - Long flags only (`--name`, `--name=value`, `--name value`).
 *   - Boolean flags are recognised by name (no value follows).
 *   - Repeatable flags collect into arrays.
 *   - Positional args are returned as `_`.
 *
 * Throws `CliError` on bad input (unknown flag, missing required arg).
 */

export class CliError extends Error {}

export interface FlagSpec {
  readonly type: "string" | "boolean" | "string-array";
  readonly required?: boolean;
  /** Default value for `string` flags. */
  readonly default?: string;
  /** Number of positional arguments to accept (0 = none). */
}

export type FlagsSchema = Record<string, FlagSpec>;

export interface ParsedArgs {
  readonly flags: Record<string, string | boolean | string[] | undefined>;
  readonly positional: string[];
}

/**
 * Parse argv-tail for one subcommand. `argv` should be everything AFTER the
 * subcommand name. Unknown flags raise `CliError`.
 */
export function parseFlags(argv: ReadonlyArray<string>, schema: FlagsSchema): ParsedArgs {
  const effectiveSchema: FlagsSchema =
    schema["json"] !== undefined ? schema : { ...schema, json: { type: "boolean" } };
  const flags: Record<string, string | boolean | string[] | undefined> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "--") {
      for (let j = i + 1; j < argv.length; j++) positional.push(argv[j]!);
      break;
    }
    if (tok.startsWith("--")) {
      const eqIdx = tok.indexOf("=");
      const name = eqIdx === -1 ? tok.slice(2) : tok.slice(2, eqIdx);
      const inlineVal = eqIdx === -1 ? null : tok.slice(eqIdx + 1);
      const spec = effectiveSchema[name];
      if (!spec) {
        throw new CliError(`unknown flag: --${name}`);
      }
      if (spec.type === "boolean") {
        if (inlineVal !== null) {
          throw new CliError(`flag --${name} does not accept a value`);
        }
        flags[name] = true;
        continue;
      }
      let value: string;
      if (inlineVal !== null) {
        value = inlineVal;
      } else {
        const next = argv[++i];
        if (next === undefined) throw new CliError(`flag --${name} requires a value`);
        value = next;
      }
      if (spec.type === "string") {
        flags[name] = value;
      } else {
        const arr = (flags[name] as string[] | undefined) ?? [];
        arr.push(value);
        flags[name] = arr;
      }
      continue;
    }
    positional.push(tok);
  }

  // Apply defaults and check required flags.
  for (const [name, spec] of Object.entries(effectiveSchema)) {
    if (flags[name] === undefined) {
      if (spec.type === "string" && spec.default !== undefined) {
        flags[name] = spec.default;
      } else if (spec.required) {
        throw new CliError(`missing required flag: --${name}`);
      }
    }
  }
  return { flags, positional };
}

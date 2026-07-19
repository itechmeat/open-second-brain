import {
  clearExactState,
  ExactStateError,
  listExactState,
  readExactState,
  writeExactState,
} from "../../../core/brain/exact-state.ts";
import {
  brainVerbContext,
  fail,
  normalizeFlagString,
  ok,
  okJson,
  parse,
  usageError,
} from "../helpers.ts";

/**
 * `o2b brain state` - the overwrite-only exact-state lane (t_b0c9d0a3).
 *
 * Subcommands:
 *   set   --aspect <slug> --value <text>   overwrite an aspect's value
 *   get   --aspect <slug>                  print an aspect's value
 *   list                                   list every aspect
 *   clear --aspect <slug>                  remove an aspect
 *
 * The lane is excluded from the search index, so writing operational state
 * here never resurfaces a superseded value through recall.
 */
export async function cmdBrainState(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { flags } = parse(rest, {
    vault: { type: "string" },
    aspect: { type: "string" },
    value: { type: "string" },
    json: { type: "boolean" },
  });
  const json = flags["json"] === true;

  if (sub === undefined || sub === "list") {
    const { vault } = brainVerbContext(flags);
    const entries = listExactState(vault);
    if (json) {
      okJson({ aspects: entries.map((e) => ({ aspect: e.aspect, updated_at: e.updatedAt })) });
    } else if (entries.length === 0) {
      ok("no exact-state aspects");
    } else {
      for (const e of entries) ok(`${e.aspect}: ${e.value}`);
    }
    return 0;
  }

  const aspect = normalizeFlagString(flags["aspect"]);

  if (sub === "set") {
    if (aspect === null) return usageError("brain state set missing required flag: --aspect");
    const value = normalizeFlagString(flags["value"]);
    if (value === null) return usageError("brain state set missing required flag: --value");
    const { vault } = brainVerbContext(flags);
    try {
      const entry = writeExactState(vault, aspect, value);
      if (json) okJson({ aspect: entry.aspect, value: entry.value, updated_at: entry.updatedAt });
      else ok(`set ${entry.aspect}`);
      return 0;
    } catch (exc) {
      if (exc instanceof ExactStateError) return fail(`state set failed: ${exc.message}`);
      throw exc;
    }
  }

  if (sub === "get") {
    if (aspect === null) return usageError("brain state get missing required flag: --aspect");
    const { vault } = brainVerbContext(flags);
    const entry = readExactState(vault, aspect);
    if (entry === null) {
      if (json) okJson({ aspect, present: false });
      else ok(`no value for ${aspect}`);
      return 0;
    }
    if (json) okJson({ aspect: entry.aspect, value: entry.value, updated_at: entry.updatedAt });
    else ok(entry.value);
    return 0;
  }

  if (sub === "clear") {
    if (aspect === null) return usageError("brain state clear missing required flag: --aspect");
    const { vault } = brainVerbContext(flags);
    const existed = clearExactState(vault, aspect);
    if (json) okJson({ aspect, cleared: existed });
    else ok(existed ? `cleared ${aspect}` : `no value for ${aspect}`);
    return 0;
  }

  return usageError(`brain state: unknown subcommand '${sub}' (expected set|get|list|clear)`);
}

import { readFileSync } from "node:fs";

import { isHarnessId } from "../../../core/brain/scoped-rules.ts";
import {
  clearOperatorRules,
  OperatorRuleTargetError,
  readOperatorRules,
  writeOperatorRules,
  type OperatorRuleTarget,
} from "../../../core/brain/standing-rules-write.ts";
import { laneVaultRoot } from "../../../core/store/lane-pages.ts";
import { readStdinText } from "../../stdin.ts";
import {
  brainVerbContext,
  fail,
  normalizeFlagString,
  ok,
  okJson,
  parse,
  usageError,
} from "../helpers.ts";

const USAGE =
  "usage: o2b brain standing-rules <show|set|clear> [--project <name> | --harness <id> | --host <device id>]\n" +
  "                                [--file <path> | --stdin] [--vault <path>] [--json]";

/**
 * `o2b brain standing-rules` - the operator's own edit of the standing
 * rules: the vault-wide constitution, or with `--project`, `--harness` or
 * `--host` one scoped rule file.
 *
 *   show                          print the rules as stored
 *   set (--file <path> | --stdin) replace them with the file's text, byte for byte
 *   clear                         remove them
 *
 * On a switched machine the rules are entries of the store's
 * `standing-rule` lane and the vault may have no `Brain/` folder, so this
 * is the way to change them there; on an unswitched one it writes
 * `Brain/standing-rules.md` (or the scoped file) as an editor would.
 */
export async function cmdBrainStandingRules(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (sub === undefined || sub === "-h" || sub === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return sub === undefined ? 2 : 0;
  }
  const { flags } = parse(argv.slice(1), {
    vault: { type: "string" },
    project: { type: "string" },
    harness: { type: "string" },
    host: { type: "string" },
    file: { type: "string" },
    stdin: { type: "boolean" },
    json: { type: "boolean" },
  });
  const json = flags["json"] === true;

  // A scope flag given with a blank value (an empty shell variable) is
  // refused, never dropped: dropped, it would select the vault-wide rules
  // and `clear --project ""` would remove those.
  const given = (["project", "harness", "host"] as const).filter(
    (axis) => flags[axis] !== undefined,
  );
  const blank = given.find((axis) => normalizeFlagString(flags[axis]) === null);
  if (blank !== undefined) {
    return usageError(`brain standing-rules: --${blank} needs a value`);
  }
  const scopes = given;
  if (scopes.length > 1) {
    return usageError("brain standing-rules: name at most one of --project, --harness, --host");
  }
  const axis = scopes[0];
  const value = axis === undefined ? null : normalizeFlagString(flags[axis])!;
  if (axis === "harness" && !isHarnessId(value)) {
    return usageError(`brain standing-rules: unknown harness id '${value}'`);
  }
  const target: OperatorRuleTarget =
    axis === undefined ? { kind: "constitution" } : { kind: "scoped", axis, value: value! };

  // With no vault configured the rules are store entries all the same.
  const { vault: configured } = brainVerbContext(flags, { vault: "optional" });
  const vault = laneVaultRoot(configured);
  try {
    if (sub === "show") {
      const text = readOperatorRules(vault, target);
      if (json) okJson({ present: text !== null, text: text ?? "" });
      else if (text === null) ok("no standing rules");
      else process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
      return 0;
    }
    if (sub === "set") {
      const file = normalizeFlagString(flags["file"]);
      const fromStdin = flags["stdin"] === true;
      if ((file === null) === !fromStdin) {
        return usageError("brain standing-rules set needs exactly one of --file <path>, --stdin");
      }
      const text = file !== null ? readFileSync(file, "utf8") : await readStdinText();
      writeOperatorRules(vault, target, text);
      if (json) okJson({ written: true });
      else ok(`standing rules set (${describe(target)})`);
      return 0;
    }
    if (sub === "clear") {
      const removed = clearOperatorRules(vault, target);
      if (json) okJson({ cleared: removed });
      else ok(removed ? `standing rules cleared (${describe(target)})` : "no standing rules");
      return 0;
    }
  } catch (exc) {
    if (exc instanceof OperatorRuleTargetError)
      return usageError(`brain standing-rules: ${exc.message}`);
    return fail(`standing-rules ${sub} failed: ${(exc as Error).message ?? exc}`);
  }
  return usageError(`brain standing-rules: unknown subcommand '${sub}' (expected show|set|clear)`);
}

function describe(target: OperatorRuleTarget): string {
  return target.kind === "constitution" ? "vault-wide" : `${target.axis} ${target.value}`;
}

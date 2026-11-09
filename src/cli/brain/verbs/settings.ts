/**
 * `o2b brain settings get|set|unset|list`: the operator's front door to
 * the shared brain settings (`../../../core/brain/policy/settings-write.ts`).
 * A write from here carries human authority. On a store-only machine,
 * with or without a vault, it is a `setting-set` / `setting-unset` record
 * in the store; on an unswitched machine it edits `_brain.yaml`.
 */

import {
  BrainSettingError,
  getBrainSetting,
  listBrainSettings,
  parseSettingValue,
  setBrainSetting,
  unsetBrainSetting,
  type BrainSettingView,
  type BrainSettingWrite,
} from "../../../core/brain/policy/settings-write.ts";
import {
  brainVerbContext,
  fail,
  ok,
  okJson,
  parse,
  resolveBrainAgent,
  usageError,
} from "../helpers.ts";

const SUBCOMMANDS = new Set(["get", "set", "unset", "list"]);

function show(value: unknown): string {
  return JSON.stringify(value);
}

function viewLine(view: BrainSettingView): string {
  if (!view.set) {
    const fallback = view.default !== undefined ? `; default ${show(view.default)}` : "";
    return `${view.name} is not set${fallback}`;
  }
  const authority = view.authority !== undefined ? `, ${view.authority}` : "";
  const record = view.record !== undefined ? ` record ${view.record}` : "";
  const where = view.source === "store" ? `store${authority}${record}` : "settings file";
  return `${view.name} = ${show(view.value)} (${where})`;
}

function writeLine(verb: "set" | "unset", result: BrainSettingWrite): string {
  if (!result.changed) {
    return verb === "set"
      ? `${result.name} already ${show(result.value)}`
      : `${result.name} is not set`;
  }
  const record = result.record !== undefined ? ` (record ${result.record})` : "";
  return verb === "set"
    ? `${result.name}: ${show(result.previous)} -> ${show(result.value)}${record}`
    : `${result.name}: unset, the default applies${record}`;
}

export async function cmdBrainSettings(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (sub === undefined || !SUBCOMMANDS.has(sub)) {
    return usageError(
      "brain settings requires one of get, set, unset, list; see `o2b brain help settings`",
    );
  }
  const { flags, positional } = parse(argv.slice(1), {
    vault: { type: "string" },
    agent: { type: "string" },
    json: { type: "boolean" },
  });
  const context = brainVerbContext(flags, { vault: "optional" });
  const read = { vault: context.vault, configPath: context.config };
  const json = Boolean(flags["json"]);

  const arity = { get: 1, set: 2, unset: 1, list: 0 }[sub as "get" | "set" | "unset" | "list"];
  if (positional.length !== arity) {
    const shape = { get: "<name>", set: "<name> <value>", unset: "<name>", list: "" }[
      sub as "get" | "set" | "unset" | "list"
    ];
    return usageError(`usage: o2b brain settings ${sub} ${shape}`.trimEnd());
  }

  try {
    if (sub === "list") {
      const listed = listBrainSettings(read);
      if (json) {
        okJson(listed);
        return 0;
      }
      if (listed.settings.length === 0) ok("no shared brain setting is set; the defaults apply");
      for (const view of listed.settings) ok(viewLine(view));
      return 0;
    }
    if (sub === "get") {
      const view = getBrainSetting(read, positional[0]!);
      if (json) {
        okJson({ ...view });
        return 0;
      }
      ok(viewLine(view));
      return 0;
    }
    const write = {
      ...read,
      authority: "human" as const,
      agent: resolveBrainAgent(flags, context.config),
    };
    const result =
      sub === "set"
        ? setBrainSetting(write, positional[0]!, parseSettingValue(positional[1]!))
        : unsetBrainSetting(write, positional[0]!);
    if (json) {
      okJson({ ...result });
      return 0;
    }
    ok(writeLine(sub as "set" | "unset", result));
    return 0;
  } catch (err) {
    if (err instanceof BrainSettingError) {
      return err.code === "invalid_setting_value" ||
        err.code === "private_setting_value" ||
        err.code === "no_settings_file"
        ? fail(`settings ${sub} failed: ${err.message}`)
        : usageError(err.message);
    }
    // A store write failure's message carries its reason and remedy.
    return fail(`settings ${sub} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * `brain_settings`: the agent's front door to the shared brain settings
 * (`../../core/brain/policy/settings-write.ts`), the MCP twin of
 * `o2b brain settings`. One tool, four actions: `get`, `list`, `set`,
 * `unset`.
 *
 * A write from here carries agent authority. On a store-only machine (and
 * on a server with no vault) it is a `setting-set` / `setting-unset`
 * record in the store, and a value the operator set (human authority) is
 * refused rather than written and outvoted by the fold. On an unswitched
 * machine it edits the vault's settings file. A setting that holds a
 * safety or privacy boundary (`OPERATOR_ONLY_SETTINGS`) is refused in
 * both modes with `operator_only_setting`.
 */

import {
  BrainSettingError,
  getBrainSetting,
  listBrainSettings,
  setBrainSetting,
  unsetBrainSetting,
} from "../../core/brain/policy/settings-write.ts";
import { resolveAgentName } from "../../core/config.ts";
import { coerceStr, unknownOperationError } from "../coerce.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import { contextVault, type ServerContext, type ToolDefinition } from "../tool-contract.ts";

const ACTIONS = ["get", "list", "set", "unset"] as const;
type SettingsAction = (typeof ACTIONS)[number];

function refusal(err: BrainSettingError): MCPError {
  return new MCPError(INVALID_PARAMS, `brain_settings: ${err.message}`, {
    code: err.code,
    ...(err.configKey !== undefined ? { config_key: err.configKey } : {}),
  });
}

async function toolBrainSettings(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const action = coerceStr(args, "action", true) as SettingsAction;
  if (!(ACTIONS as ReadonlyArray<string>).includes(action)) {
    throw unknownOperationError(`brain_settings: 'action' must be one of ${ACTIONS.join(", ")}`);
  }
  const name = coerceStr(args, "name", false) ?? undefined;
  if (action !== "list" && name === undefined) {
    throw new MCPError(INVALID_PARAMS, `brain_settings: action=${action} needs name`);
  }
  if (action === "set" && !("value" in args)) {
    throw new MCPError(INVALID_PARAMS, "brain_settings: action=set needs value");
  }
  const read = {
    vault: contextVault(ctx),
    ...(ctx.configPath ? { configPath: ctx.configPath } : {}),
  };
  try {
    switch (action) {
      case "list":
        return { ...listBrainSettings(read) };
      case "get":
        return { ...getBrainSetting(read, name!) };
      case "set":
      case "unset": {
        const write = {
          ...read,
          authority: "agent" as const,
          // The agent the transport minted for this request (a per-agent
          // token), so the audit trail tells callers apart; the config's
          // agent on stdio.
          agent: ctx.requestIdentity?.agent ?? resolveAgentName(ctx.configPath ?? undefined),
        };
        const result =
          action === "set"
            ? setBrainSetting(write, name!, args["value"])
            : unsetBrainSetting(write, name!);
        return { ...result };
      }
    }
  } catch (err) {
    // A store write failure is classified by the server (`store_write_failed`
    // with its reason and remedy); a refusal of the setting itself is here.
    if (err instanceof BrainSettingError) throw refusal(err);
    throw err;
  }
}

export const SETTINGS_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_settings",
    kind: "write",
    description:
      "Shared brain settings every machine agrees on, named <block>.<field> (dream.candidate_threshold, view.language, primary_agent): get, list, set or unset one. Once switched, an operator value wins; a boundary key (integrity, read or capture scope) is operator-only; a device key names its config key.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...ACTIONS],
          description:
            "get or unset one setting, set one to value, or list every setting that is set.",
        },
        name: {
          type: "string",
          maxLength: 128,
          description:
            "Setting name, <block>.<field>, a scalar key such as primary_agent, or view.language.",
        },
        value: {
          type: ["string", "number", "boolean", "array", "null"],
          items: { type: ["string", "number", "boolean", "null"] },
          description: "action=set: the new value, a scalar or a list of scalars; validated first.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    handler: toolBrainSettings,
  },
]);

import { brainSettingsFromStore } from "../../../core/brain/policy/load.ts";
import { setBrainSetting, unsetBrainSetting } from "../../../core/brain/policy/settings-write.ts";
import { setPrimaryAgent, type SetPrimaryAgentResult } from "../../../core/brain/set-primary.ts";
import { DreamNotOwnerError, openDreamOwnerStore } from "../../../core/brain/dream-owner/gate.ts";
import {
  readDreamOwner,
  takeDreamOwner,
  withDreamPassLock,
} from "../../../core/brain/dream-owner/owner.ts";
import { brainVerbContext, fail, ok, okJson, parse, resolveBrainAgent } from "../helpers.ts";

/**
 * On a brain with a dream owner (change `agent-neutral-dream`, design D4)
 * naming the primary agent names the owner's agent: on the owner's device
 * the owner's agent becomes `name` at once (`o2b dream owner --here
 * --agent <name>`), and anywhere else the verb refuses with
 * `dream_not_owner`. A brain with no owner keeps the declared name only.
 * Store-backed changes share the pass lock with live dream work.
 */
function setPrimaryWithOwner<T>(
  vault: string | null,
  config: string,
  writer: string,
  name: string | null,
  write: () => T,
): T | DreamNotOwnerError {
  const opened = openDreamOwnerStore(vault, config);
  if (opened.store === null) return write();
  const store = opened.store;
  return withDreamPassLock(store, () => {
    const current = readDreamOwner(store);
    const owner = current.owner;
    if (owner !== null && owner.device !== store.device) {
      return new DreamNotOwnerError("elsewhere", owner, store.device, false);
    }
    if (owner !== null && name !== null) {
      takeDreamOwner(store, name, { writer, authority: "human", force: false });
    }
    return write();
  });
}

/**
 * On a store-only machine (or with no vault) `primary_agent` is a shared
 * settings record with human authority, written by the shared settings
 * writer; nothing under `Brain/` changes.
 */
function setPrimaryInStore(
  vault: string | null,
  config: string,
  agent: string,
  name: string | null,
): SetPrimaryAgentResult {
  const ctx = { vault, configPath: config, authority: "human" as const, agent };
  const result =
    name === null
      ? unsetBrainSetting(ctx, "primary_agent")
      : setBrainSetting(ctx, "primary_agent", name);
  const asName = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return { previous: asName(result.previous), next: asName(result.value), changed: result.changed };
}

export async function cmdBrainSetPrimary(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    clear: { type: "boolean" },
    json: { type: "boolean" },
    agent: { type: "string" },
  });
  const { vault, config } = brainVerbContext(flags, { vault: "optional" });

  let name: string | null;
  if (flags["clear"]) {
    if (positional.length > 0)
      return fail("brain set-primary --clear takes no positional argument");
    name = null;
  } else {
    if (positional.length < 1)
      return fail("brain set-primary requires <name> or --clear; see `o2b brain help set-primary`");
    if (positional.length > 1) return fail("brain set-primary accepts a single <name> argument");
    const supplied = positional[0]!.trim();
    if (supplied.length === 0) return fail("brain set-primary <name> must be non-empty");
    name = supplied;
  }

  let result;
  try {
    const agent = resolveBrainAgent(flags, config);
    const bound = setPrimaryWithOwner(vault, config, agent, name, () =>
      vault === null || brainSettingsFromStore(vault)
        ? setPrimaryInStore(vault, config, agent, name)
        : setPrimaryAgent(vault, name),
    );
    if (bound instanceof DreamNotOwnerError) {
      if (flags["json"]) {
        okJson({ ok: false, code: bound.code, owner: bound.owner, message: bound.message });
        return 1;
      }
      return fail(bound.message);
    }
    result = bound;
  } catch (exc) {
    return fail(`set-primary failed: ${(exc as Error).message ?? exc}`);
  }

  if (flags["json"]) {
    okJson({ previous: result.previous, next: result.next, changed: result.changed });
    return 0;
  }

  const fmt = (v: string | null): string => v ?? "null";
  if (!result.changed) {
    ok(`primary_agent already set to ${fmt(result.next)}`);
  } else {
    ok(`primary_agent: ${fmt(result.previous)} → ${fmt(result.next)}`);
  }
  return 0;
}

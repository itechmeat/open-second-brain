import { defaultConfigPath } from "../../../core/config.ts";
import { bootstrapBrain, type BootstrapBrainResult } from "../../../core/brain/init.ts";
import { computeBrainStatus } from "../../../core/brain/status.ts";
import { nextCommandField } from "../../../core/brain/next-step.ts";
import { emitNextStep, type AdvisoryStream } from "../../advisory-rail.ts";
import { parse, fail, ok, info, okJson } from "../helpers.ts";
import { resolveOptionalVault } from "../../helpers.ts";

export async function cmdBrainInit(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    force: { type: "boolean" },
    "primary-agent": { type: "string" },
    starter: { type: "boolean" },
    "starter-path": { type: "string" },
    json: { type: "boolean" },
  });
  const config = (flags["config"] as string | undefined) ?? defaultConfigPath();
  // With no vault the brain is the store (design D14 item 1): init then
  // creates the store and nothing else.
  const vault = resolveOptionalVault(flags["vault"] as string | undefined, config);

  const primaryAgentFlag = flags["primary-agent"];
  let primaryAgent: string | undefined;
  if (typeof primaryAgentFlag === "string") {
    const trimmed = primaryAgentFlag.trim();
    if (trimmed.length === 0) {
      return fail("brain init: --primary-agent must be a non-empty string when provided");
    }
    primaryAgent = trimmed;
  }

  const starterPathFlag = flags["starter-path"];
  let starterPath: string | undefined;
  if (typeof starterPathFlag === "string") {
    starterPath = starterPathFlag.trim();
    if (starterPath.length === 0) {
      return fail("brain init: --starter-path must be a non-empty path when provided");
    }
  }

  let result;
  try {
    result = bootstrapBrain(vault, {
      force: Boolean(flags["force"]),
      configPath: config,
      starter: Boolean(flags["starter"]),
      ...(primaryAgent !== undefined ? { primaryAgent } : {}),
      ...(starterPath !== undefined ? { starterPath } : {}),
    });
  } catch (exc) {
    return fail(`failed to initialize Brain: ${(exc as Error).message ?? exc}`);
  }

  const stream: AdvisoryStream = {
    command: "brain",
    argv,
    jsonRequested: Boolean(flags["json"]),
  };

  if (vault === null) return reportStoreOnlyInit(result, Boolean(flags["json"]));
  // Resolved once, ahead of both renderers: the human stream prints it
  // as a rail line and the machine stream carries it as a field, and a
  // second evaluation could disagree with the first.
  const empty = brainHasNothingRecorded(vault);

  if (flags["json"]) {
    okJson({
      vault,
      created: result.created,
      overwritten: result.overwritten,
      skipped: result.skipped,
      // The bootstrap result's guard field is always set, and the
      // docblock's contract is that machine readers use it instead of
      // parsing stderr: without it a conflict or a failed seed rendered
      // in JSON as a plain skipped, indistinguishable from a clean one.
      guard: result.guard,
      ...(empty ? nextCommandField("brain-empty") : {}),
    });
  } else {
    ok(`brain initialized: ${vault}`);
    for (const p of result.created) info(`  created: ${p}`);
    for (const p of result.overwritten) info(`  overwritten: ${p}`);
    for (const p of result.skipped) info(`  exists: ${p}`);
    // Named like the lists above. Clean statuses say so in one word; a
    // conflict or a failed seed carries its detail so the human output
    // reads alongside the stderr warning instead of instead of it.
    info(
      `  guard: ${result.guard.status}` +
        (result.guard.detail !== undefined ? `: ${result.guard.detail}` : ""),
    );
  }

  // no-dead-ends, task 5. This verb creates the tree and then says
  // nothing about what goes in it, which is the archetypal dead end:
  // the whole point of a Brain is the first recorded signal. The rail
  // keeps the line off the `--json` payload.
  //
  // phase 3: fired UNCONDITIONALLY until now, so a re-run over a Brain
  // full of preferences - every path in `result.skipped` - still
  // asserted `brain-empty`, whose registered class reads "Brain with
  // nothing recorded in it". The claim is about content, not about
  // whether this run created anything, so the condition is the content.
  if (empty) emitNextStep("brain-empty", stream);
  return 0;
}

/** The report of an init with no vault: the store step only. */
function reportStoreOnlyInit(result: BootstrapBrainResult, json: boolean): number {
  const store = result.store;
  // With no vault the bootstrap always reports the store it ensured.
  if (store === undefined || store === null) {
    throw new Error("brain init with no vault reported no brain store");
  }
  const switchWarning = freshSwitchWarning(result.freshSwitch);
  if (json) {
    okJson({
      vault: null,
      created: result.created,
      overwritten: result.overwritten,
      skipped: result.skipped,
      guard: result.guard,
      store,
      ...(result.freshSwitch !== undefined ? { switch: result.freshSwitch } : {}),
    });
    return 0;
  }
  if (switchWarning !== null) process.stderr.write(`warning: ${switchWarning}\n`);
  ok(
    store.status === "created"
      ? `brain initialized in a new store: ${store.root}`
      : `brain initialized: the store at ${store.root} already exists`,
  );
  info(`  store id:   ${store.storeId}`);
  info(`  partitions: ${store.partitions.join(", ")}`);
  if (store.viewWriter !== null) info(`  ${store.viewWriter.message}`);
  info(
    "  no vault is configured: the brain works without one; note tools and .base views need one",
  );
  return 0;
}

/**
 * Why this device's switch to the store was not recorded, or `null` when
 * it was (or did not need to be): the operator learns the machine is not
 * durably store-only, as `o2b store init` tells it.
 */
function freshSwitchWarning(freshSwitch: BootstrapBrainResult["freshSwitch"]): string | null {
  switch (freshSwitch?.outcome) {
    case "error":
      return `this device's switch to the store was not recorded: ${freshSwitch.detail ?? ""}`;
    case "no-device":
      return (
        "this machine has no device id, so its switch to the store was not recorded; " +
        "set device_id in the machine config and run `o2b brain init` again"
      );
    case "no-store":
      return (
        "this machine holds no shared partition, so its switch to the store was not " +
        "recorded; run `o2b brain init` again once it holds one"
      );
    default:
      return null;
  }
}

/**
 * True when the Brain holds no signal, preference or retired record.
 *
 * Counted through the shared status snapshot rather than a private
 * walk: `computeBrainStatus` is already this codebase's answer to "what
 * is in this Brain", and a second counter here would be a second thing
 * to keep in step with the directory layout. Processed signals count as
 * recorded - a Brain whose inbox has been drained into `processed/` has
 * a history, and telling its operator it is empty would be false.
 */
function brainHasNothingRecorded(vault: string): boolean {
  const { counts } = computeBrainStatus(vault);
  return (
    counts.inbox +
      counts.inbox_processed +
      counts.inbox_archived +
      counts.preferences +
      counts.retired ===
    0
  );
}

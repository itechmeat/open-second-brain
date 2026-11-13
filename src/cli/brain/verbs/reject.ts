import {
  resolveAgentName,
  resolveNearDuplicateRetireSiblingsEnabled,
} from "../../../core/config.ts";
import { scanBrain } from "../../../core/brain/dream-scan.ts";
import { regenerateActiveQuiet } from "../../../core/brain/active.ts";
import { READ_ALL_REFS } from "../../../core/brain/near-duplicate.ts";
import {
  loadPreference,
  moveToRetired,
  parsePreference,
  preferencePresence,
} from "../../../core/brain/preference.ts";
import {
  planRetireSiblings,
  retireSiblingPool,
  type RetireSibling,
} from "../../../core/brain/retire-siblings.ts";
import { preferencePath } from "../../../core/brain/paths.ts";
import { isoDate, isoSecond } from "../../../core/brain/time.ts";
import { renderPrefLink } from "../../../core/brain/wikilink.ts";
import { appendLogEvent, logShardWikilink } from "../../../core/brain/log.ts";
import { BRAIN_LOG_EVENT_KIND, BRAIN_RETIRED_REASON } from "../../../core/brain/types.ts";
import { isStoreOnly } from "../../../core/store/store-only.ts";
import { brainVerbContext, fail, ok, okJson, parse } from "../helpers.ts";

export async function cmdBrainReject(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    id: { type: "string" },
    reason: { type: "string" },
    yes: { type: "boolean" },
    json: { type: "boolean" },
  });
  if (typeof flags["id"] !== "string" || (flags["id"] as string).trim() === "") {
    return fail("brain reject missing required flag: --id");
  }
  if (typeof flags["reason"] !== "string" || (flags["reason"] as string).trim() === "") {
    return fail(
      "brain reject missing required flag: --reason (free-form text; persisted on the retired file)",
    );
  }
  const { config, vault } = brainVerbContext(flags);
  const agent = resolveAgentName(config);

  const rawId = String(flags["id"]).trim();
  const slug = rawId.startsWith("pref-") ? rawId.slice("pref-".length) : rawId;
  const path = preferencePath(vault, slug);
  // The page on an unswitched machine, the store's fold once switched; a
  // store-only machine has no page to point the operator at.
  const storeOnly = isStoreOnly({ vault, configPath: config });
  const notFound = (): number => {
    const where = storeOnly ? "in the brain store" : `at ${path}`;
    process.stderr.write(`preference not found: pref-${slug}; expected ${where}\n`);
    return 2;
  };
  if (preferencePresence(vault, slug) !== "active") return notFound();
  let pref;
  try {
    const loaded = loadPreference(vault, slug);
    // Retired between the two reads: not found, never a parse of a page a
    // store-only machine does not have.
    if (loaded === null && storeOnly) return notFound();
    pref = loaded ?? parsePreference(path);
  } catch (exc) {
    return fail(`failed to parse preference: ${(exc as Error).message ?? exc}`);
  }

  if (pref.pinned && !flags["yes"]) {
    process.stderr.write(`warning: preference '${pref.id}' is pinned; pass --yes to override\n`);
    return 1;
  }

  const now = new Date();
  const todayDate = isoDate(now);
  const retiredBy = logShardWikilink(todayDate);
  const reasonText = String(flags["reason"]).trim();

  try {
    moveToRetired(vault, path, "user-rejected", {
      now,
      retired_by: retiredBy,
      user_rejected_reason: reasonText,
    });
  } catch (exc) {
    return fail(`failed to retire preference: ${(exc as Error).message ?? exc}`);
  }

  try {
    const body: Record<string, string> = {
      preference: renderPrefLink({ id: `ret-${slug}`, principle: pref.principle }),
      agent,
    };
    if (flags["reason"]) body["reason"] = String(flags["reason"]);
    if (pref.pinned) body["was_pinned"] = "true";
    appendLogEvent(vault, {
      timestamp: isoSecond(now),
      eventType: BRAIN_LOG_EVENT_KIND.reject,
      body,
    });
  } catch (err) {
    process.stderr.write(`warning: append reject log failed: ${(err as Error).message}\n`);
  }

  regenerateActiveQuiet(vault, { now, legacyOnly: true });

  // Near-duplicate defense: list (never retire) the active preferences that
  // resemble the one just rejected. The operator's own shell reads the whole
  // vault, hence READ_ALL_REFS. Off, the output is unchanged. The retire
  // has already happened, so a failing scan is a warning, never an error.
  let siblings: ReadonlyArray<RetireSibling> = [];
  if (resolveNearDuplicateRetireSiblingsEnabled(config)) {
    try {
      siblings = planRetireSiblings(
        retireSiblingPool(scanBrain(vault).preferences.map((p) => p.pref)),
        [
          {
            id: `pref-${slug}`,
            principle: pref.principle,
            reason: BRAIN_RETIRED_REASON.userRejected,
          },
        ],
        { readable: READ_ALL_REFS, gated: new Set() },
      );
    } catch (err) {
      process.stderr.write(`warning: retire siblings scan failed: ${(err as Error).message}\n`);
    }
  }

  if (flags["json"]) {
    okJson({
      id: `ret-${slug}`,
      reason: "user-rejected",
      ...(siblings.length > 0 ? { retire_siblings: siblings } : {}),
    });
  } else {
    ok(`retired: ret-${slug} (user-rejected)`);
    if (siblings.length > 0) ok(formatRetireSiblings(siblings));
  }
  return 0;
}

/** One line per sibling with its score, then the command that accepts it. */
function formatRetireSiblings(siblings: ReadonlyArray<RetireSibling>): string {
  return [
    `retire siblings: ${siblings.length}`,
    ...siblings.flatMap((s) => [
      `  ${s.sibling_id} score=${s.score.toFixed(3)} method=${s.method}`,
      `    accept: o2b brain reject --id ${s.sibling_id} --reason <text>`,
    ]),
  ].join("\n");
}

import { existsSync } from "node:fs";
import { resolveAgentName } from "../../../core/config.ts";
import { moveToRetired, parsePreference } from "../../../core/brain/preference.ts";
import { preferencePath } from "../../../core/brain/paths.ts";
import { isoDate, isoSecond } from "../../../core/brain/time.ts";
import { renderPrefLink } from "../../../core/brain/wikilink.ts";
import { appendLogEvent } from "../../../core/brain/log.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../core/brain/types.ts";
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
  if (!existsSync(path)) {
    process.stderr.write(`preference not found: pref-${slug}; expected ${path}\n`);
    return 2;
  }
  let pref;
  try {
    pref = parsePreference(path);
  } catch (exc) {
    return fail(`failed to parse preference: ${(exc as Error).message ?? exc}`);
  }

  if (pref.pinned && !flags["yes"]) {
    process.stderr.write(`warning: preference '${pref.id}' is pinned; pass --yes to override\n`);
    return 1;
  }

  const now = new Date();
  const todayDate = isoDate(now);
  const retiredBy = `[[Brain/log/${todayDate}]]`;
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

  if (flags["json"]) {
    okJson({ id: `ret-${slug}`, reason: "user-rejected" });
  } else {
    ok(`retired: ret-${slug} (user-rejected)`);
  }
  return 0;
}

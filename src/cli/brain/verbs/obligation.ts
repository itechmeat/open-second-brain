/**
 * `o2b brain obligation <add|done|list|show|remove>` (t_f7b82ba4):
 * recurring obligations as first-class Brain pages with a deterministic
 * cadence-driven next-due date.
 */

import {
  addObligation,
  completeObligation,
  listObligations,
  removeObligation,
  showObligation,
  type ObligationListItem,
  type ObligationPage,
} from "../../../core/brain/obligations.ts";
import {
  brainVerbContext,
  fail,
  normalizeFlagString,
  ok,
  okJson,
  parse,
  resolveBrainAgent,
} from "../helpers.ts";

function pageJson(page: ObligationPage): Record<string, unknown> {
  return {
    slug: page.slug,
    title: page.title,
    cadence: page.cadence,
    created_at: page.createdAt,
    anchor: page.anchor,
    last_done: page.lastDone,
    next_due: page.nextDue,
    agent: page.agent,
    completions: page.completions,
    path: page.path,
  };
}

function listItemJson(item: ObligationListItem): Record<string, unknown> {
  return {
    slug: item.slug,
    title: item.title,
    cadence: item.cadence,
    next_due: item.nextDue,
    last_done: item.lastDone,
    overdue: item.overdue,
    days_until_due: item.daysUntilDue,
  };
}

function dueLabel(item: ObligationListItem): string {
  if (item.overdue) return `OVERDUE by ${Math.abs(item.daysUntilDue)}d`;
  if (item.daysUntilDue === 0) return "due today";
  return `in ${item.daysUntilDue}d`;
}

export async function cmdBrainObligation(argv: string[]): Promise<number> {
  const action = argv[0];
  if (!action || !["add", "done", "list", "show", "remove"].includes(action)) {
    return fail(
      "usage: o2b brain obligation <add|done|list|show|remove> [--title T] [--cadence C] [--anchor YYYY-MM-DD] [--date YYYY-MM-DD] [--notes N] [--overdue]",
    );
  }
  const { flags } = parse(argv.slice(1), {
    vault: { type: "string" },
    agent: { type: "string" },
    title: { type: "string" },
    cadence: { type: "string" },
    anchor: { type: "string" },
    date: { type: "string" },
    notes: { type: "string" },
    slug: { type: "string" },
    overdue: { type: "boolean" },
    json: { type: "boolean" },
  });
  const { config, vault } = brainVerbContext(flags);
  const json = flags["json"] === true;

  try {
    if (action === "add") {
      const title = normalizeFlagString(flags["title"]);
      const cadence = normalizeFlagString(flags["cadence"]);
      if (title === null) return fail("brain obligation add requires --title");
      if (cadence === null) return fail("brain obligation add requires --cadence");
      const page = addObligation(vault, {
        title,
        cadence,
        agent: resolveBrainAgent(flags, config),
        ...(normalizeFlagString(flags["anchor"]) !== null
          ? { anchor: normalizeFlagString(flags["anchor"])! }
          : {}),
        ...(normalizeFlagString(flags["notes"]) !== null
          ? { notes: normalizeFlagString(flags["notes"])! }
          : {}),
      });
      if (json) okJson({ ok: true, obligation: pageJson(page) });
      else ok(`obligation ${page.slug} (${page.cadence}) next due ${page.nextDue}`);
      return 0;
    }

    if (action === "list") {
      const items = listObligations(vault, { overdueOnly: flags["overdue"] === true });
      if (json) {
        okJson({ ok: true, obligations: items.map(listItemJson) });
        return 0;
      }
      if (items.length === 0) {
        ok("no obligations");
        return 0;
      }
      for (const item of items) {
        ok(`${item.nextDue}  ${item.slug} (${item.cadence}) — ${dueLabel(item)}`);
      }
      return 0;
    }

    const slug = normalizeFlagString(flags["slug"]) ?? normalizeFlagString(flags["title"]);
    if (action === "show") {
      if (slug === null) return fail("brain obligation show requires --slug (or --title)");
      const page = showObligation(vault, slug);
      if (page === null) {
        if (json) okJson({ ok: true, present: false, slug });
        else ok(`no obligation: ${slug}`);
        return 0;
      }
      if (json) okJson({ ok: true, present: true, obligation: pageJson(page) });
      else {
        ok(`${page.title} [${page.slug}] cadence=${page.cadence} next_due=${page.nextDue}`);
        ok(`  last_done: ${page.lastDone ?? "never"}`);
        for (const c of page.completions) ok(`  done: ${c}`);
      }
      return 0;
    }

    if (action === "done") {
      if (slug === null) return fail("brain obligation done requires --slug (or --title)");
      const page = completeObligation(vault, {
        slug,
        ...(normalizeFlagString(flags["date"]) !== null
          ? { date: normalizeFlagString(flags["date"])! }
          : {}),
      });
      if (json) okJson({ ok: true, obligation: pageJson(page) });
      else ok(`obligation ${page.slug} done ${page.lastDone}; next due ${page.nextDue}`);
      return 0;
    }

    // remove
    if (slug === null) return fail("brain obligation remove requires --slug (or --title)");
    const removed = removeObligation(vault, slug);
    if (json) okJson({ ok: true, slug: removed.slug, archive_path: removed.archivePath });
    else ok(`obligation ${removed.slug} archived: ${removed.archivePath}`);
    return 0;
  } catch (err) {
    return fail((err as Error).message ?? String(err));
  }
}

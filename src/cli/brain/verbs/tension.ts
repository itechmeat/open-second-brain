/**
 * `o2b brain tension <action>` - tension-object lifecycle CLI (Belief
 * lifecycle suite, S2, t_0e3f2bee).
 *
 * Actions:
 *   - `detect [--jaccard <n>] [--path <p>]`  scan the note corpus, persist tensions
 *   - `list [--unresolved]`                 list persisted tensions
 *   - `show <slug>`                         read one tension
 *   - `confirm <slug> [--reason <r>]`       open -> confirmed
 *   - `dismiss <slug> [--reason <r>]`       open|confirmed -> dismissed
 *   - `resolve <slug> [--reason <r>]`       open|confirmed -> resolved
 *
 * CLI mirror of the `brain_tension` MCP tool; both delegate to the core
 * tensions module so the on-disk shape cannot drift. `detect` is the
 * operator trigger that runs the contradiction detector over the
 * configured note corpus (`notes.read_paths`) and persists findings; the
 * other actions triage what detection found.
 */

import { defaultConfigPath } from "../../../core/config.ts";
import {
  confirmTension,
  detectTensionsInVault,
  dismissTension,
  listTensions,
  listUnresolvedTensions,
  resolveTension,
  showTension,
  type TensionRecord,
} from "../../../core/brain/tensions.ts";
import { normalizeFlagString, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

const USAGE_ERROR_EXIT = 2;

function usageError(message: string): number {
  process.stderr.write(`error: ${message}\n`);
  return USAGE_ERROR_EXIT;
}

/** Project a tension record into the CLI's snake_cased JSON shape. */
function renderRow(t: TensionRecord): Record<string, unknown> {
  return {
    id: t.id,
    slug: t.slug,
    status: t.status,
    subject_a: t.subjectA,
    subject_b: t.subjectB,
    stance_a: t.stanceA,
    stance_b: t.stanceB,
    detected_count: t.detectedCount,
    resolution_reason: t.resolutionReason,
  };
}

export async function cmdBrainTension(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    agent: { type: "string" },
    reason: { type: "string" },
    jaccard: { type: "string" },
    unresolved: { type: "boolean" },
    json: { type: "boolean" },
  });

  const action = positional[0];
  if (action === undefined) {
    return usageError(
      "brain tension requires an action: detect | list | show | confirm | dismiss | resolve",
    );
  }

  const config = (flags["config"] as string | undefined) ?? defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const explicitAgent = normalizeFlagString(flags["agent"]);
  const wantsJson = flags["json"] === true;

  const transitionArgs = () => ({
    ...(normalizeFlagString(flags["reason"])
      ? { reason: normalizeFlagString(flags["reason"])! }
      : {}),
    ...(explicitAgent ? { agent: explicitAgent } : {}),
    configPath: config,
  });

  try {
    switch (action) {
      case "detect":
      case "scan": {
        const jaccardRaw = normalizeFlagString(flags["jaccard"]);
        let jaccard: number | undefined;
        if (jaccardRaw !== null) {
          const parsed = Number(jaccardRaw);
          if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
            return usageError("--jaccard must be a number in (0, 1]");
          }
          jaccard = parsed;
        }
        const res = detectTensionsInVault(vault, {
          ...(jaccard !== undefined ? { jaccard } : {}),
          ...(explicitAgent ? { agent: explicitAgent } : {}),
          configPath: config,
        });
        if (wantsJson) {
          okJson({
            created: res.created,
            updated: res.updated,
            scanned_files: res.scannedFiles,
            tensions: res.records.map(renderRow),
          });
        } else {
          ok(
            `scanned ${res.scannedFiles} note(s): ${res.created} created, ` +
              `${res.updated} refreshed`,
          );
        }
        return 0;
      }
      case "list": {
        const rows =
          flags["unresolved"] === true ? listUnresolvedTensions(vault) : listTensions(vault);
        if (wantsJson) {
          okJson({ tensions: rows.map(renderRow) });
        } else if (rows.length === 0) {
          ok(flags["unresolved"] === true ? "no unresolved tensions" : "no tensions");
        } else {
          for (const t of rows) {
            ok(`${t.id} [${t.status}]: ${t.subjectA} vs ${t.subjectB}`);
          }
        }
        return 0;
      }
      case "show": {
        const slug = positional[1];
        if (slug === undefined) return usageError("brain tension show requires a slug");
        const t = showTension(vault, slug);
        if (t === null) {
          process.stderr.write(`error: no tension: ${slug}\n`);
          return 1;
        }
        if (wantsJson) {
          okJson({
            ...renderRow(t),
            subject: t.subject,
            jaccard: t.jaccard,
            quote_a: t.quoteA,
            quote_b: t.quoteB,
            created_at: t.createdAt,
            detected_at: t.detectedAt,
            status_changed_at: t.statusChangedAt,
          });
        } else {
          ok(`${t.id} [${t.status}]: ${t.subjectA} (${t.stanceA}) vs ${t.subjectB} (${t.stanceB})`);
        }
        return 0;
      }
      case "confirm":
      case "dismiss":
      case "resolve": {
        const slug = positional[1];
        if (slug === undefined) return usageError(`brain tension ${action} requires a slug`);
        const fn =
          action === "confirm"
            ? confirmTension
            : action === "dismiss"
              ? dismissTension
              : resolveTension;
        const t = fn(vault, slug, transitionArgs());
        if (wantsJson) {
          okJson(renderRow(t));
        } else {
          ok(`${t.id} -> ${t.status}`);
        }
        return 0;
      }
      default:
        return usageError(`unknown tension action: ${action}`);
    }
  } catch (exc) {
    process.stderr.write(`error: ${(exc as Error).message ?? String(exc)}\n`);
    return 1;
  }
}

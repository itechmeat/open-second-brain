import { createHash } from "node:crypto";
import { basename } from "node:path";

import {
  applyProtect,
  BrainProtectError,
  computeProtect,
  computeUnprotect,
  isProtectTarget,
  printSnippet,
  PROTECT_TARGETS,
  unprotect,
  type ProtectCompute,
  type UnprotectResult,
} from "../../../core/brain/protect.ts";
import type { LaneConsentVerdict } from "../../../core/brain/diagnostics.ts";
import { hookAuditDir } from "../../../core/brain/paths.ts";
import { appendAuditRecord } from "../../../core/reliability/audit.ts";
import { renderUnifiedDiff } from "../../../core/diff.ts";
import {
  brainVerbContext,
  fail,
  info,
  ok,
  okJson,
  parse,
  readSingleLine,
  resolveBrainAgent,
} from "../helpers.ts";

/**
 * Derive the consent verdict the guarded host-write lanes record, from
 * what actually happened (M3): a `--yes` flag that consented to a real
 * write is `yes-flag`, an interactive yes is `interactive-yes`, and a
 * no-op - nothing to change, so the gate never ran, nobody was asked and
 * nothing was written - is `unchanged`. The hard-coded `confirmed` this
 * replaces reported the same verdict for an operator's confirmed write
 * and for an automatic run where no consent was ever asked.
 *
 * Shared with the install lane so the three receipts answer in one
 * vocabulary; the doctor repair lane derives its verdict in the verb for
 * the reason its own ladder spells out (the gate runs before the outcome
 * exists).
 */
export function deriveConsentVerdict(changed: boolean, yesFlag: boolean): LaneConsentVerdict {
  if (!changed) return "unchanged";
  return yesFlag ? "yes-flag" : "interactive-yes";
}

/**
 * The refusal end of the consent ladder (M4). A `--json` or non-TTY run
 * without `--yes` refuses fail-closed; under `--json` the refusal is a
 * JSON envelope on the payload stream carrying the verdict, so a headless
 * consumer reads the answer from the channel it parses instead of
 * scraping stderr prose. The reserved `headless-refused` verdict
 * (CONSENT_VERDICTS in src/core/trust.ts) finally has an emitter; the
 * plain-stderr refusal keeps its wording for humans.
 */
export function consentRefusal(json: boolean, message: string, exitCode = 1): number {
  if (json) {
    process.stdout.write(
      JSON.stringify({ consent: "headless-refused", written: false, error: message }, null, 2) +
        "\n",
    );
    return exitCode;
  }
  return fail(message);
}

/**
 * The unprotect audit receipt (M4): one record in the vault's audit
 * store naming the host file, the sha-256 of the pre-write bytes, the
 * backup, and the consent verdict - the audit trail the docs promise
 * for this lane. Same store and record shape the host-backup hook's
 * receipts use, so the guarded host-write evidence reads one way.
 *
 * Best-effort, like the hook's receipt: the write has already happened,
 * so a failed append must not turn a completed unprotect into a
 * non-zero exit - evidence, not the guard.
 */
function appendUnprotectReceipt(opts: {
  vault: string;
  actor: string;
  consent: LaneConsentVerdict;
  compute: ProtectCompute;
  result: UnprotectResult;
}): void {
  try {
    appendAuditRecord(hookAuditDir(opts.vault), {
      timestamp: new Date().toISOString(),
      actor: opts.actor,
      action: "brain-unprotect",
      target: opts.result.destination,
      ok: true,
      details: {
        pid: process.pid,
        before_hash: `sha256:${createHash("sha256").update(opts.compute.before).digest("hex")}`,
        summary: opts.result.changed
          ? `removed OSB-managed rules from ${basename(opts.result.destination)}`
          : `nothing OSB-managed to remove for ${opts.result.target}`,
        consent: opts.consent,
        changed: opts.result.changed,
        ...(opts.result.backupPath ? { backup: opts.result.backupPath } : {}),
      },
    });
  } catch {
    /* evidence, not the guard */
  }
}

export async function cmdBrainProtect(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    target: { type: "string", required: true },
    vault: { type: "string" },
    apply: { type: "boolean" },
    yes: { type: "boolean" },
    json: { type: "boolean" },
  });
  const rawTarget = typeof flags["target"] === "string" ? flags["target"] : undefined;
  if (!isProtectTarget(rawTarget)) {
    return fail(
      `brain protect --target='${flags["target"]}' is unknown; supported targets: ${PROTECT_TARGETS.join(", ")}`,
    );
  }
  const target = rawTarget;
  const vault = brainVerbContext(flags).vault;

  try {
    if (flags["apply"]) {
      // t_b6bcd984: consent, then write. The compute step is a pure
      // preview - before/after/changed, nothing on disk moves - so the
      // fail-closed ladder (the canonical `brain upgrade --apply` one)
      // can show the unified diff and still refuse without a side
      // effect. A no-op apply needs no consent, exactly as upgrade
      // skips its prompt when nothing is pending.
      const compute = computeProtect({ target, vault });
      if (compute.changed && !flags["yes"]) {
        if (flags["json"] || !process.stdin.isTTY) {
          return consentRefusal(
            flags["json"] === true,
            `brain protect --apply requires --yes in non-interactive mode ` +
              "(--json or non-TTY stdin); nothing was written",
          );
        }
        info(renderUnifiedDiff(compute.before, compute.after, compute.destination));
        process.stderr.write("Proceed? [y/N] ");
        const ans = await readSingleLine();
        if (ans.toLowerCase() !== "y" && ans.toLowerCase() !== "yes") {
          ok("protect cancelled");
          return 0;
        }
      } else if (compute.changed && !flags["json"]) {
        info(renderUnifiedDiff(compute.before, compute.after, compute.destination));
      }
      const result = applyProtect({ target, vault, approved: compute });
      if (flags["json"]) {
        okJson({
          consent: deriveConsentVerdict(result.changed, flags["yes"] === true),
          target: result.target,
          destination: result.destination,
          changed: result.changed,
          backup: result.backupPath || null,
        });
        return 0;
      }
      const head = result.changed
        ? `brain protect: applied to ${result.destination}`
        : `brain protect: no changes (${result.destination} already current)`;
      ok(head);
      if (result.backupPath) ok(`  backup: ${result.backupPath}`);
      return 0;
    }
    const snippet = printSnippet({ target, vault });
    if (flags["json"]) {
      okJson({ target: snippet.target, destination: snippet.destination, body: snippet.body });
      return 0;
    }
    info(`# o2b brain protect --target ${target}`);
    info(`# destination: ${snippet.destination}`);
    info(`# preview only; re-run with --apply to write the file`);
    process.stdout.write(snippet.body);
    return 0;
  } catch (exc) {
    if (exc instanceof BrainProtectError) return fail(`brain protect failed: ${exc.message}`);
    throw exc;
  }
}

export async function cmdBrainUnprotect(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    target: { type: "string", required: true },
    vault: { type: "string" },
    apply: { type: "boolean" },
    yes: { type: "boolean" },
    json: { type: "boolean" },
  });
  const rawTarget = typeof flags["target"] === "string" ? flags["target"] : undefined;
  if (!isProtectTarget(rawTarget)) {
    return fail(
      `brain unprotect --target='${flags["target"]}' is unknown; supported targets: ${PROTECT_TARGETS.join(", ")}`,
    );
  }
  const target = rawTarget;
  const { config, vault } = brainVerbContext(flags);

  // H4: `--yes` without `--apply` used to fall through to the read-only
  // preview and exit 0, so a script migrated per the documented ladder
  // believed the rules were gone while the file kept every one of them.
  // Unprotect writes only through the consent ladder's apply step; the
  // refusal names that remedy instead of quietly previewing.
  if (flags["yes"] && !flags["apply"]) {
    return fail(
      "brain unprotect --yes requires --apply to write; without --apply the verb is a " +
        "read-only preview and nothing was changed. Re-run with --apply to remove the " +
        "OSB-managed rules (--yes consents in a non-interactive run).",
    );
  }

  try {
    if (flags["apply"]) {
      // t_b6bcd984 sibling of the protect ladder, in the canonical
      // `brain upgrade --apply` shape: consent, then write. The compute
      // step is a pure preview - before/after/changed, nothing on disk
      // moves - so the fail-closed ladder can show the unified diff and
      // still refuse without a side effect. A no-op unprotect needs no
      // consent, exactly as upgrade skips its prompt when nothing is
      // pending.
      //
      // The deletion set comes from the in-vault protect.lock.json
      // manifest, which an agent can write; THIS step is the trust
      // answer. The operator sees the exact host-file diff that manifest
      // implies and says yes before anything is removed, so an
      // agent-crafted manifest cannot silently strip protections - it
      // can at most propose a diff a human approved.
      const compute = computeUnprotect({ target, vault });
      if (compute.changed && !flags["yes"]) {
        if (flags["json"] || !process.stdin.isTTY) {
          return consentRefusal(
            flags["json"] === true,
            `brain unprotect --apply requires --yes in non-interactive mode ` +
              "(--json or non-TTY stdin); nothing was written",
          );
        }
        info(renderUnifiedDiff(compute.before, compute.after, compute.destination));
        process.stderr.write("Proceed? [y/N] ");
        const ans = await readSingleLine();
        if (ans.toLowerCase() !== "y" && ans.toLowerCase() !== "yes") {
          ok("unprotect cancelled");
          return 0;
        }
      } else if (compute.changed && !flags["json"]) {
        info(renderUnifiedDiff(compute.before, compute.after, compute.destination));
      }
      // Backup-then-write inside the core; the receipt names both. The
      // approved preview rides along, so the write must still derive the
      // exact bytes this ladder showed - anything else is a refusal
      // before a single byte moves.
      const result = unprotect({ target, vault, approved: compute });
      // M4c: the audit receipt the docs promise for this lane, recorded
      // beside the write with the verdict this run actually earned.
      appendUnprotectReceipt({
        vault,
        actor: resolveBrainAgent(flags, config),
        consent: deriveConsentVerdict(result.changed, flags["yes"] === true),
        compute,
        result,
      });
      if (flags["json"]) {
        okJson({
          consent: deriveConsentVerdict(result.changed, flags["yes"] === true),
          target: result.target,
          destination: result.destination,
          changed: result.changed,
          backup: result.backupPath || null,
        });
        return 0;
      }
      const head = result.changed
        ? `brain unprotect: removed OSB-managed rules for target=${target}`
        : `brain unprotect: no changes (no OSB-managed rules for target=${target})`;
      ok(head);
      if (result.backupPath) ok(`  backup: ${result.backupPath}`);
      return 0;
    }
    // Preview (no --apply): read-only, the same shape protect's print
    // mode keeps - a header and the would-be change, nothing written.
    // The literal `preview` marker (H4) is what lets a headless consumer
    // tell this answer from the apply envelope, which shares the target/
    // destination/changed keys and carries no marker.
    const compute = computeUnprotect({ target, vault });
    if (flags["json"]) {
      okJson({
        preview: true,
        target,
        destination: compute.destination,
        changed: compute.changed,
        before: compute.before,
        after: compute.after,
      });
      return 0;
    }
    info(`# o2b brain unprotect --target ${target}`);
    info(`# destination: ${compute.destination}`);
    info(`# preview only; re-run with --apply to write the file`);
    if (compute.changed) {
      info(renderUnifiedDiff(compute.before, compute.after, compute.destination));
    } else {
      info(`# no OSB-managed rules found for this target`);
    }
    return 0;
  } catch (exc) {
    if (exc instanceof BrainProtectError) return fail(`brain unprotect failed: ${exc.message}`);
    throw exc;
  }
}

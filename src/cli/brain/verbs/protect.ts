import {
  applyProtect,
  BrainProtectError,
  computeProtect,
  computeUnprotect,
  isProtectTarget,
  printSnippet,
  PROTECT_TARGETS,
  unprotect,
} from "../../../core/brain/protect.ts";
import { renderUnifiedDiff } from "../../../core/diff.ts";
import { brainVerbContext, fail, info, ok, okJson, parse, readSingleLine } from "../helpers.ts";

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
          return fail(
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
          consent: "confirmed",
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
  const vault = brainVerbContext(flags).vault;

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
          return fail(
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
      if (flags["json"]) {
        okJson({
          consent: "confirmed",
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
    const compute = computeUnprotect({ target, vault });
    if (flags["json"]) {
      okJson({
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

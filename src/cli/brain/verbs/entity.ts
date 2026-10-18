/**
 * `o2b brain entity <set|get|list|relate|archive|merge>` - canonical entity
 * registry verbs (Memory Integrity Suite). Writes stay on the CLI;
 * the MCP surface exposes the read-only subset (`brain_entity`).
 */

import { resolveAgentName } from "../../../core/config.ts";
import {
  archiveEntity,
  getEntity,
  listEntities,
  relateEntities,
  upsertEntity,
} from "../../../core/brain/entities/registry.ts";
import {
  EntityMergeError,
  applyEntityMerge,
  entityMergePlanHash,
  planEntityMerge,
  type EntityMergePlan,
} from "../../../core/brain/entities/page-merge.ts";
import {
  BRAIN_ENTITY_STATUS_VALUES,
  isBrainEntityStatus,
  type BrainEntity,
} from "../../../core/brain/entities/types.ts";
import { pruneEntityLabels } from "../../../core/brain/entities/label-hygiene.ts";
import {
  deriveEntityLexicon,
  ENTITY_LEXICON_ARTIFACT_REL,
  writeEntityLexicon,
} from "../../../core/brain/entities/lexicon.ts";
import {
  brainVerbContext,
  CliError,
  fail,
  info,
  normalizeFlagString,
  ok,
  okJson,
  parse,
  readSingleLine,
  usageError,
} from "../helpers.ts";
import { shellWord } from "../../cron-recipe.ts";

function entityPayload(entity: BrainEntity): Record<string, unknown> {
  return {
    id: entity.id,
    category: entity.category,
    name: entity.name,
    aliases: [...entity.aliases],
    status: entity.status,
    ...(entity.source_agent !== undefined ? { source_agent: entity.source_agent } : {}),
    ...(entity.confidence !== undefined ? { confidence: entity.confidence } : {}),
    created_at: entity.created_at,
    updated_at: entity.updated_at,
    ...(entity.archived_at !== undefined ? { archived_at: entity.archived_at } : {}),
    relations: entity.relations.map((r) => ({ relation: r.relation, target: r.target })),
    path: entity.path,
  };
}

function entityLine(entity: BrainEntity): string {
  const aliases = entity.aliases.length > 0 ? `  aliases: ${entity.aliases.join(", ")}` : "";
  return `${entity.id}  [${entity.status}]  ${entity.category}/${entity.name}${aliases}`;
}

export async function cmdBrainEntity(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "set":
      return entitySet(rest);
    case "get":
      return entityGet(rest);
    case "list":
      return entityList(rest);
    case "relate":
      return entityRelate(rest);
    case "archive":
      return entityArchive(rest);
    case "prune":
      return entityPrune(rest);
    case "lexicon":
      return entityLexicon(rest);
    case "merge":
      return await entityMerge(rest);
    default:
      return usageError(
        "brain entity requires a subcommand: set <category> <name> | get <name> | list | " +
          "relate <from> <relation> <to> | archive <name> [--restore] | " +
          "prune [--confirm] [--include-advisory] | lexicon rebuild [--apply] | " +
          "merge <keep> <drop> [--dry-run] [--expect-hash <hash>]",
      );
  }
}

function entitySet(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    alias: { type: "string-array" },
    body: { type: "string" },
    confidence: { type: "string" },
    json: { type: "boolean" },
  });
  if (positional.length < 2) {
    return fail("brain entity set requires <category> and <name> arguments");
  }
  const { config, vault } = brainVerbContext(flags);
  const agent = resolveAgentName(config);
  const body = normalizeFlagString(flags["body"]);
  const confidence = normalizeFlagString(flags["confidence"]);
  try {
    const out = upsertEntity(vault, {
      category: positional[0]!,
      name: positional[1]!,
      aliases: (flags["alias"] as string[] | undefined) ?? [],
      agent,
      now: new Date(),
      ...(body !== null ? { body } : {}),
      ...(confidence !== null ? { confidence } : {}),
    });
    if (flags["json"]) {
      okJson({ ...entityPayload(out.entity), created: out.created });
    } else {
      ok(`${out.created ? "created" : "updated"}: ${out.entity.id}`);
    }
    return 0;
  } catch (exc) {
    return fail(`brain entity set failed: ${(exc as Error).message}`);
  }
}

function entityGet(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    category: { type: "string" },
    json: { type: "boolean" },
  });
  if (positional.length < 1) return fail("brain entity get requires a <name-or-alias> argument");
  const vault = brainVerbContext(flags).vault;
  const category = normalizeFlagString(flags["category"]);
  try {
    const entity = getEntity(vault, {
      query: positional[0]!,
      ...(category !== null ? { category } : {}),
    });
    if (entity === null) {
      process.stderr.write(`entity not found: ${positional[0]!}\n`);
      return 2;
    }
    if (flags["json"]) {
      okJson(entityPayload(entity));
    } else {
      ok(entityLine(entity));
      if (entity.body.trim().length > 0) ok(entity.body.trim());
    }
    return 0;
  } catch (exc) {
    return fail(`brain entity get failed: ${(exc as Error).message}`);
  }
}

function entityList(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    category: { type: "string" },
    status: { type: "string" },
    json: { type: "boolean" },
  });
  const vault = brainVerbContext(flags).vault;
  const category = normalizeFlagString(flags["category"]);
  const statusRaw = normalizeFlagString(flags["status"]);
  // Validated against the vocabulary itself rather than a hand-written pair,
  // so a new status is listable the day it exists. `--status quarantine` is
  // how an operator sees what an untrusted intake put aside.
  if (statusRaw !== null && !isBrainEntityStatus(statusRaw)) {
    return fail(`--status must be one of: ${BRAIN_ENTITY_STATUS_VALUES.join(", ")}`);
  }
  try {
    const entities = listEntities(vault, {
      ...(category !== null ? { category } : {}),
      ...(statusRaw !== null ? { status: statusRaw } : {}),
    });
    if (flags["json"]) {
      okJson({ entities: entities.map(entityPayload), total: entities.length });
    } else if (entities.length === 0) {
      ok("no entities");
    } else {
      for (const entity of entities) ok(entityLine(entity));
    }
    return 0;
  } catch (exc) {
    return fail(`brain entity list failed: ${(exc as Error).message}`);
  }
}

function entityRelate(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    "from-category": { type: "string" },
    "to-category": { type: "string" },
    json: { type: "boolean" },
  });
  if (positional.length < 3) {
    return fail("brain entity relate requires <from> <relation> <to> arguments");
  }
  const vault = brainVerbContext(flags).vault;
  const fromCategory = normalizeFlagString(flags["from-category"]);
  const toCategory = normalizeFlagString(flags["to-category"]);
  try {
    const entity = relateEntities(vault, {
      from: { query: positional[0]!, ...(fromCategory !== null ? { category: fromCategory } : {}) },
      relation: positional[1]!,
      to: { query: positional[2]!, ...(toCategory !== null ? { category: toCategory } : {}) },
      now: new Date(),
    });
    if (flags["json"]) {
      okJson(entityPayload(entity));
    } else {
      ok(`${entity.id} ${positional[1]!} -> ${positional[2]!}`);
    }
    return 0;
  } catch (exc) {
    return fail(`brain entity relate failed: ${(exc as Error).message}`);
  }
}

function entityPrune(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    confirm: { type: "boolean" },
    "include-advisory": { type: "boolean" },
    json: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);
  const confirm = flags["confirm"] === true;
  const includeAdvisory = flags["include-advisory"] === true;
  try {
    const result = pruneEntityLabels(vault, { confirm, includeAdvisory, now: new Date() });
    if (flags["json"]) {
      okJson({
        confirmed: result.confirmed,
        candidates: result.candidates.map((c) => ({
          id: c.id,
          category: c.category,
          name: c.name,
          status: c.status,
          reason: c.reason,
          advisory: c.advisory,
          path: c.path,
          inbound_references: [...c.inboundReferences],
        })),
        advisory_skipped: result.advisorySkipped,
        removed: [...result.removed],
        edges_stripped: result.edgesStripped,
        snapshot_run_id: result.snapshotRunId,
        snapshot_path: result.snapshotPath,
      });
      return 0;
    }
    const advisoryNote =
      result.advisorySkipped > 0
        ? ` (${result.advisorySkipped} advisory finding(s) skipped - a single-token shout ` +
          "or a common-word run; the doctor reports them)"
        : "";
    if (result.candidates.length === 0) {
      if (result.advisorySkipped > 0) {
        ok(`entity prune: no structural malformed labels found${advisoryNote}`);
        info("  re-run with --include-advisory to prune the advisory classes too");
      } else {
        ok("entity prune: no malformed labels found");
      }
      return 0;
    }
    if (result.confirmed) {
      ok(`entity prune: removed ${result.removed.length} node(s)${advisoryNote}`);
      for (const c of result.candidates) ok(`  - ${c.id} (${c.reason}) ${JSON.stringify(c.name)}`);
      if (result.edgesStripped > 0) ok(`  stripped ${result.edgesStripped} inbound edge(s)`);
      if (result.snapshotRunId) {
        ok(`  recovery point: snapshot ${result.snapshotRunId}`);
        if (result.snapshotPath) info(`    ${result.snapshotPath}`);
      }
      return 0;
    }
    ok(
      `entity prune (DRY RUN): ${result.candidates.length} malformed label(s) WOULD be ` +
        `removed${advisoryNote}:`,
    );
    for (const c of result.candidates) {
      const edges =
        c.inboundReferences.length > 0
          ? `, ${c.inboundReferences.length} inbound edge(s) from ${c.inboundReferences.join(", ")}`
          : "";
      ok(`  - ${c.id} (${c.reason}) ${JSON.stringify(c.name)}${edges}`);
    }
    info("  re-run with --confirm to remove (a snapshot is taken first)");
    return 0;
  } catch (exc) {
    const message = `brain entity prune failed: ${(exc as Error).message}`;
    if (flags["json"]) {
      okJson({ ok: false, message });
      return 1;
    }
    return fail(message);
  }
}

/**
 * `o2b brain entity lexicon rebuild` (recall-quality A4): re-derive the
 * store-learned entity lexicon over the vault's operator pages. Dry-run
 * report by default; `--apply` writes ONLY the derived artifact
 * (`Brain/entities/lexicon.json`) through the atomic, vault-identity-
 * guarded derived-artifact writer. A derived write mutates no entity node
 * and removes nothing, so it never needs `--confirm` - the flag reserved
 * for destructive work (see `entity prune`).
 */
function entityLexicon(argv: string[]): number {
  const sub = argv[0];
  if (sub !== "rebuild") {
    return fail("brain entity lexicon requires a subcommand: rebuild [--apply]");
  }
  const { flags } = parse(argv.slice(1), {
    vault: { type: "string" },
    apply: { type: "boolean" },
    json: { type: "boolean" },
  });
  const { vault } = brainVerbContext(flags);
  try {
    const doc = deriveEntityLexicon(vault, { now: new Date() });
    const applied = flags["apply"] === true;
    const path = applied ? writeEntityLexicon(vault, doc) : null;
    const entries = Object.keys(doc.entries).length;
    const scope = doc.caseful ? "caseful corpus" : "caseless corpus (case verdicts stay off)";
    if (flags["json"]) {
      okJson({
        applied,
        schema: doc.schema,
        entries,
        caseful: doc.caseful,
        corpus_scope: doc.corpus_scope,
        dataset_hash: doc.dataset_hash,
        generated_at: doc.generated_at,
        ...(path !== null ? { path } : {}),
      });
      return 0;
    }
    if (applied) {
      ok(`entity lexicon rebuild: wrote ${entries} token entries (${scope})`);
      info(`  artifact: ${ENTITY_LEXICON_ARTIFACT_REL}; dataset ${doc.dataset_hash}`);
    } else {
      ok(`entity lexicon rebuild (DRY RUN): ${entries} token entries WOULD be written (${scope})`);
      info(`  dataset ${doc.dataset_hash}`);
      info(`  re-run with --apply to write ${ENTITY_LEXICON_ARTIFACT_REL}`);
    }
    return 0;
  } catch (exc) {
    return fail(`brain entity lexicon rebuild failed: ${(exc as Error).message}`);
  }
}

function entityArchive(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    category: { type: "string" },
    restore: { type: "boolean" },
    json: { type: "boolean" },
  });
  if (positional.length < 1) {
    return fail("brain entity archive requires a <name-or-alias> argument");
  }
  const vault = brainVerbContext(flags).vault;
  const category = normalizeFlagString(flags["category"]);
  try {
    const entity = archiveEntity(
      vault,
      { query: positional[0]!, ...(category !== null ? { category } : {}) },
      { now: new Date(), ...(flags["restore"] ? { restore: true } : {}) },
    );
    if (flags["json"]) {
      okJson(entityPayload(entity));
    } else {
      ok(`${entity.id} -> ${entity.status}`);
    }
    return 0;
  } catch (exc) {
    const message = (exc as Error).message;
    if (message.includes("not found")) {
      process.stderr.write(`${message}\n`);
      return 2;
    }
    return fail(`brain entity archive failed: ${message}`);
  }
}

/** One plan line an operator (or a TTY prompt) reads before consenting. */
function mergePlanLines(plan: EntityMergePlan, hash: string, applyCommand: string): string[] {
  return [
    "merge plan:",
    `  keep: ${plan.keep_id} (${plan.keep_name})`,
    `  drop: ${plan.drop_id} (${plan.drop_name}) -> ${plan.drop_path}`,
    `  alias added: ${plan.alias_added ?? "none - the survivor already answers to that name"}`,
    `  body: ${plan.body_folded ? "folded into the survivor" : "archived (nothing to fold)"}`,
    `  relations absorbed: ${plan.relations_absorbed}; inbound edges retargeted: ` +
      `${plan.inbound_edges_retargeted}; cyclic edges removed: ${plan.cyclic_edges_removed}`,
    // The bypass is a fact about this plan, stated where the consent is
    // given - never left to be inferred from a flag in the echo.
    ...(plan.guard_bypassed
      ? ["  guard: --force bypasses the text-level merge guard for this merge"]
      : []),
    `  plan-hash: ${hash}`,
    `  apply: ${applyCommand}`,
  ];
}

/** Refusals carry the CODE first, then the sentence an agent can skip. */
function entityMergeRefusal(exc: unknown, json: boolean): number {
  if (exc instanceof EntityMergeError) {
    if (json) {
      okJson({ ok: false, code: exc.code, message: exc.message });
      return 1;
    }
    return fail(`brain entity merge: ${exc.message}`);
  }
  // Not a merge refusal - vault identity, snapshot gate, fs. Rethrow so
  // the verb-level wrapper answers a JSON caller on stdout.
  throw exc;
}

/** Refusal code for a merge nobody consented to: consent missing, not wrong. */
const CONSENT_REQUIRED_CODE = "consent-required";

/** The parsed-flag shape `parse` returns, restated for the run helper. */
type EntityMergeFlags = Record<string, string | boolean | string[] | undefined>;

/**
 * `o2b brain entity merge <keep> <drop>` (actionable-now batch, A2 /
 * t_28a8789d): preview-and-apply repair for two entity pages that denote
 * one subject - the doctor's `duplicate-entity` collision, or an opt-in
 * `entity-alias-candidate` nomination. Both subjects accept ids, names
 * and aliases, so either finding resolves.
 *
 * The gate is the plan hash: `--dry-run` renders the plan and echoes its
 * hash; apply requires `--expect-hash <hash>` and re-plans, refusing
 * before any write when the live vault no longer produces the plan the
 * caller read. Consent is a TTY y/N prompt, `--force` for agents, and
 * `--json` refuses without `--force` because the prompt cannot render.
 * The apply itself never bare-deletes: the old page is archived behind
 * the destructive-snapshot gate, the old name becomes an alias on the
 * survivor, and no claim is rewritten.
 *
 * The body runs under one more gate: a failure below the verb's own
 * refusal vocabulary (vault identity, the snapshot gate, the filesystem)
 * still owes a `--json` caller a structured line on stdout instead of
 * prose on a channel the caller never reads.
 */
async function entityMerge(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    "dry-run": { type: "boolean" },
    "expect-hash": { type: "string" },
    force: { type: "boolean" },
    agent: { type: "string" },
    json: { type: "boolean" },
  });
  const json = flags["json"] === true;
  try {
    return await runEntityMerge(flags, positional, json);
  } catch (exc) {
    // A missing or empty --vault stays a usage-level CliError with its own
    // top-level formatting; everything else is an internal failure, and
    // the message travels alone - never a stack.
    if (exc instanceof CliError) throw exc;
    const message = exc instanceof Error ? exc.message : String(exc);
    if (json) {
      okJson({ ok: false, code: "internal-error", message });
      return 1;
    }
    return fail(`brain entity merge failed: ${message}`);
  }
}

async function runEntityMerge(
  flags: EntityMergeFlags,
  positional: string[],
  json: boolean,
): Promise<number> {
  if (positional.length !== 2) {
    return fail("brain entity merge requires <keep> and <drop> (ids, names or aliases)");
  }
  const { config, vault } = brainVerbContext(flags);
  const refs = { keep: positional[0]!, drop: positional[1]! };
  const force = flags["force"] === true;
  const dryRun = flags["dry-run"] === true;
  const expectHash = normalizeFlagString(flags["expect-hash"]);
  // The acting identity, resolved the way the sibling entity verbs do:
  // an explicit --agent wins, a blank one normalizes away, and the
  // configured agent_name attributes what is left - never "unknown"
  // while a config names an agent, and never a null actor at all.
  const agent = normalizeFlagString(flags["agent"]) ?? resolveAgentName(config);

  let plan: EntityMergePlan;
  try {
    // `--force` is the consent for the text-level merge guard bypass, so it
    // reaches the preview too: a guarded pair must be previewable (to get
    // its plan hash) exactly as it is applicable. The plan-hash gate below
    // is separate and stays unbypassable.
    plan = planEntityMerge(vault, refs, { bypassEntityGuard: force });
  } catch (exc) {
    return entityMergeRefusal(exc, json);
  }
  const hash = entityMergePlanHash(plan);
  // The echo is a command an operator (or an agent) pastes back, so every
  // argument a shell would split is quoted: subjects AND the vault. An
  // explicit --vault rides along - against a synced copy with identical
  // ids and paths, an echo that dropped it would apply to whichever vault
  // the paste resolved instead of the one that was previewed.
  const vaultFlag = normalizeFlagString(flags["vault"]);
  const applyCommand =
    `o2b brain entity merge ${shellWord(refs.keep)} ${shellWord(refs.drop)}` +
    (vaultFlag !== null ? ` --vault ${shellWord(vaultFlag)}` : "") +
    ` --expect-hash ${hash}` +
    (force ? " --force" : "");
  const planLines = mergePlanLines(plan, hash, applyCommand);

  if (dryRun) {
    if (json) {
      okJson({ dry_run: true, plan, plan_hash: hash, apply: applyCommand });
    } else {
      for (const line of planLines) ok(line);
      ok("dry-run; no changes written");
    }
    return 0;
  }

  // The hash gate is a fact-check, not a consent gate: it runs before the
  // prompt and refuses regardless of --force, because a stale plan is a
  // vault that moved under the operator.
  if (expectHash === null) {
    return entityMergeRefusal(
      new EntityMergeError(
        "hash-required",
        "no --expect-hash given; run the --dry-run preview first and present the plan hash " +
          "it echoes",
      ),
      json,
    );
  }
  if (expectHash !== hash) {
    // One story, whatever the stance history: the plan hash seals the
    // vault state the preview saw (a guard-passing pair hashes
    // identically at either --force stance - only an override the guard
    // would have refused stamps differently, and a pair the guard
    // refuses cannot be re-planned without it), so a mismatch means the
    // vault moved under the operator, and the refusal says so plainly.
    return entityMergeRefusal(
      new EntityMergeError(
        "hash-mismatch",
        `--expect-hash ${expectHash} does not describe this vault's merge plan any more ` +
          `(${hash}); the vault changed since the preview - re-run the preview and apply ` +
          "the hash it echoes",
      ),
      json,
    );
  }

  if (!force) {
    // Either consent refusal keeps its prose line for a human, but a JSON
    // caller gets the structured shape on stdout - same contract as every
    // other refusal this verb emits.
    const consentRefusal = (message: string): number => {
      if (json) {
        okJson({ ok: false, code: CONSENT_REQUIRED_CODE, message });
        return 1;
      }
      return fail(message);
    };
    if (json) {
      return consentRefusal(
        "brain entity merge: --json without --force is not supported (interactive prompt " +
          "cannot render)",
      );
    }
    if (!process.stdin.isTTY) {
      return consentRefusal(
        "brain entity merge: --force required when stdin is not a TTY (cannot prompt for " +
          "confirmation)",
      );
    }
    for (const line of planLines) process.stderr.write(line + "\n");
    process.stderr.write("Proceed? [y/N] ");
    const ans = (await readSingleLine()).toLowerCase();
    if (ans !== "y" && ans !== "yes") {
      ok("merge cancelled");
      return 0;
    }
  }

  try {
    const result = applyEntityMerge(vault, refs, {
      expectHash,
      bypassEntityGuard: force,
      now: new Date(),
      agent,
    });
    if (json) {
      okJson({
        applied: true,
        keep_id: result.plan.keep_id,
        drop_id: result.plan.drop_id,
        alias_added: result.plan.alias_added,
        body_folded: result.plan.body_folded,
        dropped_path: result.dropped_path,
        plan_hash: result.verified_hash,
        snapshot_run_id: result.snapshot_run_id,
        snapshot_path: result.snapshot_path,
      });
    } else {
      ok(`merged: ${result.plan.drop_id} -> ${result.plan.keep_id}`);
      if (result.plan.alias_added !== null) ok(`  alias added: ${result.plan.alias_added}`);
      ok(`  recovery point: snapshot ${result.snapshot_run_id}`);
      if (result.snapshot_path) info(`    ${result.snapshot_path}`);
    }
    return 0;
  } catch (exc) {
    return entityMergeRefusal(exc, json);
  }
}

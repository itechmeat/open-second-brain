/**
 * `o2b brain entity <set|get|list|relate|archive>` - canonical entity
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
import { BRAIN_ENTITY_STATUS, type BrainEntity } from "../../../core/brain/entities/types.ts";
import { brainVerbContext, fail, normalizeFlagString, ok, okJson, parse } from "../helpers.ts";

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
    default:
      return fail(
        "brain entity requires a subcommand: set <category> <name> | get <name> | list | " +
          "relate <from> <relation> <to> | archive <name> [--restore]",
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
  if (
    statusRaw !== null &&
    statusRaw !== BRAIN_ENTITY_STATUS.active &&
    statusRaw !== BRAIN_ENTITY_STATUS.archived
  ) {
    return fail("--status must be 'active' or 'archived'");
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

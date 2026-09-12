/**
 * `second_brain_wiring` - what this install is wired into.
 *
 * Two questions of one class, and both were answerable only from a
 * shell. `linkedProjectsStatus` reports every registered project link
 * with its pointer state and had one consumer, `o2b brain project
 * status`; the per-adapter `verify()` aggregate behind `o2b install
 * --check` reports whether the hosts this install wrote registrations
 * into can still be reached, and had none outside the CLI. An agent on
 * the MCP surface could not ask either.
 *
 * Nothing here computes health. Both views are a seam onto a reader
 * that already exists, which is why they ship as one tool: a second
 * implementation of connector health would be a second answer to a
 * question that already has one.
 *
 * ## Why one tool with a required `view`
 *
 * The house idiom for a consolidated read is a `view` parameter -
 * `brain_brief`, `brain_analytics` and `schema_inspect` all take one,
 * and `brain/landscape-tools.ts` names the reason: schema tokens are
 * paid by every client on every request. There is deliberately no
 * aggregate member. Every payload stays bounded, and an operator who
 * wants the hosts view does not pay for two host probes to read a
 * project registry.
 *
 * ## Paths
 *
 * The project registry is keyed on absolute host paths and an MCP
 * response lands in model context, so every reference here goes through
 * {@link hostPathReference} - the same `expose_host_paths` contract
 * `vault_path` obeys, generalised to a second path rather than
 * reimplemented for one.
 */

import {
  linkedProjectsStatus,
  type LinkedProjectStatus,
} from "../core/brain/portability/pointer.ts";
import { dispatchByView } from "./brain/shared.ts";
import type { ServerContext, ToolDefinition } from "./tool-contract.ts";
import { VAULT_PATH_OUTPUT_SCHEMA, hostPathReference, vaultPathField } from "./vault-path-field.ts";

/** The tool name, shared with the tests and the registry guard. */
export const WIRING_TOOL_NAME = "second_brain_wiring";

/** The view this tool answers about linked projects. */
const PROJECTS_VIEW = "projects";

/** Membership list of the accepted `view` values, in schema order. */
export const WIRING_VIEWS: ReadonlyArray<string> = Object.freeze([PROJECTS_VIEW]);

/** One registered project link, rendered under the path policy. */
function projectEntry(status: LinkedProjectStatus, ctx: ServerContext): Record<string, unknown> {
  return {
    project_ref: hostPathReference(status.path, ctx),
    vault_ref: hostPathReference(status.vault, ctx),
    pointer: status.pointer,
    vault_exists: status.vaultExists,
  };
}

/**
 * Every project registered against THIS install's config.
 *
 * A server started without a config path has no registry to read, and
 * that is an empty list rather than an error: the registry lives beside
 * the config file, so "no config named" and "no links registered" are
 * the same observable fact from here.
 */
function viewProjects(ctx: ServerContext): Record<string, unknown> {
  const configPath = ctx.configPath;
  const links = configPath === null ? [] : linkedProjectsStatus(configPath);
  return {
    vault_path: vaultPathField(ctx),
    view: PROJECTS_VIEW,
    projects: links.map((status) => projectEntry(status, ctx)),
  };
}

const WIRING_VIEW_HANDLERS: Readonly<
  Record<string, (ctx: ServerContext) => Record<string, unknown>>
> = Object.freeze({
  [PROJECTS_VIEW]: viewProjects,
});

function toolWiring(ctx: ServerContext, args: Record<string, unknown>): unknown {
  return dispatchByView(WIRING_VIEW_HANDLERS, ctx, args);
}

export const WIRING_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: WIRING_TOOL_NAME,
    description:
      "Report what this Open Second Brain install is wired into. view=projects lists every registered project link with its pointer state and whether the vault it names still exists. Paths are opaque references unless expose_host_paths is set. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: [...WIRING_VIEWS],
          description: "Which wiring to report. Required; there is no aggregate view.",
        },
      },
      required: ["view"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["vault_path", "view"],
      properties: {
        vault_path: VAULT_PATH_OUTPUT_SCHEMA,
        view: { type: "string", description: "The view this payload answers." },
        projects: {
          type: "array",
          description: "view=projects: one entry per registered project link.",
          items: {
            type: "object",
            required: ["project_ref", "vault_ref", "pointer", "vault_exists"],
            properties: {
              project_ref: VAULT_PATH_OUTPUT_SCHEMA,
              vault_ref: VAULT_PATH_OUTPUT_SCHEMA,
              pointer: {
                type: "string",
                description: "Pointer-file state: ok, missing, malformed, or mismatch.",
              },
              vault_exists: {
                type: "boolean",
                description: "Whether the vault directory the link names is still present.",
              },
            },
          },
        },
      },
    },
    handler: toolWiring,
  },
]);

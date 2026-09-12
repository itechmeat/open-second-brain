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
 * response lands in model context, so every path-valued FIELD here goes
 * through {@link hostPathReference} - the same `expose_host_paths`
 * contract `vault_path` obeys, generalised to a second path rather than
 * reimplemented for one.
 *
 * The hosts view also carries free-form adapter prose, and `verify()`
 * composes those sentences from `InstallEnv.home`. A store reference
 * cannot render them - it keys the vault, not a third party's config
 * file - so they go through {@link foldHostHome}, which folds the one
 * home prefix this run resolved. The two mechanisms answer the same
 * question, `expose_host_paths`, off the same config.
 */

import {
  linkedProjectsStatus,
  type LinkedProjectStatus,
} from "../core/brain/portability/pointer.ts";
import { defaultConfigPath } from "../core/config.ts";
import { VAULT_NOT_CONFIGURED_REASON, buildInstallEnv } from "../core/install/env.ts";
import { defaultRegistry } from "../core/install/registry.ts";
// The canonical adapter set registers itself into `defaultRegistry` at
// module-load time through this barrel, exactly as the CLI verb does.
import "../core/install/adapters/all.ts";
import type { VerifyResult } from "../core/install/types.ts";
import { dispatchByView } from "./brain/shared.ts";
import { INVALID_PARAMS, MCPError } from "./protocol.ts";
import type { ServerContext, ToolDefinition } from "./tool-contract.ts";
import {
  VAULT_PATH_OUTPUT_SCHEMA,
  type HostPathPolicySource,
  foldHostHome,
  hostPathReference,
  vaultPathField,
} from "./vault-path-field.ts";

/** The tool name, shared with the tests and the registry guard. */
export const WIRING_TOOL_NAME = "second_brain_wiring";

/** The view this tool answers about linked projects. */
const PROJECTS_VIEW = "projects";

/** The view this tool answers about the hosts this install wrote into. */
const HOSTS_VIEW = "hosts";

/** Membership list of the accepted `view` values, in schema order. */
export const WIRING_VIEWS: ReadonlyArray<string> = Object.freeze([PROJECTS_VIEW, HOSTS_VIEW]);

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

/**
 * One adapter's verify answer, as the payload carries it.
 *
 * `details` and `fix_hint` are the adapter's own sentences and name the
 * files it looked at, so they are folded against the home this run
 * verified rather than copied through; see {@link foldHostHome}.
 *
 * Exported for the test that drives a named probe SKIP through it. That
 * branch is only reachable from an installed target verified against a
 * specific host home, and `os.homedir()` in this runtime does not follow
 * a later `process.env.HOME`, so an in-process test cannot redirect the
 * home {@link viewHosts} resolves. It builds the `InstallEnv` by hand -
 * exactly as the adapter suites do - and asserts this mapping over the
 * real `verify()` answer instead of over a synthetic one.
 */
export function hostWiringEntry(
  result: VerifyResult,
  home: string,
  policy: HostPathPolicySource,
): Record<string, unknown> {
  return {
    target: result.target,
    status: result.status,
    details: result.details.map((line) => foldHostHome(line, home, policy)),
    fix_hint: result.fix_hint === null ? null : foldHostHome(result.fix_hint, home, policy),
  };
}

/**
 * Every registered install target, verified.
 *
 * The same `verify()` call per adapter that `o2b install --check`
 * makes, over the same registry and the same `InstallEnv`. Reusing it
 * means one implementation of connector health rather than a second one
 * that can come to disagree with the first.
 *
 * The vault is refused rather than defaulted. `verify()` reads the
 * per-vault sidecar manifest, so an unset vault makes every adapter
 * report `not-installed` off a bogus path - ten runtimes reported
 * absent when the real condition is that nothing was configured. The
 * refusal carries the sentence `runCheck` gives, from the one constant
 * both surfaces read.
 */
function viewHosts(ctx: ServerContext): Record<string, unknown> {
  if (ctx.vault.trim() === "") throw new MCPError(INVALID_PARAMS, VAULT_NOT_CONFIGURED_REASON);
  const env = buildInstallEnv({
    vault: ctx.vault,
    configPath: ctx.configPath ?? defaultConfigPath(),
  });
  return {
    vault_path: vaultPathField(ctx),
    view: HOSTS_VIEW,
    hosts: defaultRegistry
      .list()
      .map((adapter) => hostWiringEntry(adapter.verify(env), env.home, ctx)),
  };
}

const WIRING_VIEW_HANDLERS: Readonly<
  Record<string, (ctx: ServerContext) => Record<string, unknown>>
> = Object.freeze({
  [PROJECTS_VIEW]: viewProjects,
  [HOSTS_VIEW]: viewHosts,
});

function toolWiring(ctx: ServerContext, args: Record<string, unknown>): unknown {
  return dispatchByView(WIRING_VIEW_HANDLERS, ctx, args);
}

export const WIRING_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: WIRING_TOOL_NAME,
    // Under the 300-character registry cap: the path policy and the
    // per-view field tables are long-form guidance, and `registry-guard.ts`
    // states that those belong in docs/mcp.md rather than in a schema every
    // client pays for on every request.
    description:
      "Report what this Open Second Brain install is wired into. view=projects lists each registered project link with its pointer state and whether its vault still exists; view=hosts verifies every install target as `o2b install --check` does, and may ask host CLIs under a bounded wait. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: [...WIRING_VIEWS],
          description:
            "Which wiring to report. Required; there is no aggregate view, so a projects read never pays for a host probe.",
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
        hosts: {
          type: "array",
          description: "view=hosts: one entry per registered install target.",
          items: {
            type: "object",
            required: ["target", "status", "details", "fix_hint"],
            properties: {
              target: { type: "string", description: "The install target id." },
              status: {
                type: "string",
                description: "Verify status: ok, drift, not-installed, or mcp-unreachable.",
              },
              details: {
                type: "array",
                description:
                  "What the adapter observed, one line per finding. Host paths in these " +
                  "sentences are folded to `~` unless `expose_host_paths` is set.",
                items: { type: "string" },
              },
              // Nullable, and the descriptor language has no union form;
              // see VAULT_PATH_OUTPUT_SCHEMA for why empty is the honest
              // shape. Folded against the host home exactly as `details` is.
              fix_hint: {},
            },
          },
        },
      },
    },
    handler: toolWiring,
  },
]);

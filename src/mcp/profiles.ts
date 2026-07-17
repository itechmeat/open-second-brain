/**
 * Adaptive tool-surface profiles (Agent Surface Suite, t_20dcb192).
 *
 * A profile names a curated MCP surface: a ToolScope plus an optional
 * RuntimeCapabilityWindow. Hosts pick one via the `mcp_tool_profile`
 * config key or `o2b mcp --tool-profile <name>` instead of hand-rolling
 * allow/deny flag lists per platform.
 *
 * Contract (mirrors upstream Hermes Tool Slimmer): selection FAILS
 * OPEN - an unknown profile name degrades to the full surface (with
 * the unknown name surfaced for logging), never locks an agent out.
 * Hard-window profiles (`recall`, `minimal`) always retain the
 * `second_brain_capabilities` diagnostic, which reports every withheld
 * tool with its reason; schema hydration via `tool_hydrate` stays on
 * the `catalog` and `full` surfaces, where every catalogued tool is
 * actually callable.
 */

import type { RuntimeCapabilityWindow } from "./capabilities.ts";
import type { ToolScope } from "./tool-contract.ts";

export interface ToolSurfaceProfile {
  readonly name: string;
  readonly description: string;
  readonly scope: ToolScope;
  readonly window?: RuntimeCapabilityWindow;
}

/** The always-loaded Brain writer/reader set (writer scope parity). */
const WRITER_SET = [
  "brain_apply_evidence",
  "brain_context",
  "brain_feedback",
  "brain_note",
  "brain_pinned_context",
] as const;

export const TOOL_SURFACE_PROFILES: Readonly<Record<string, ToolSurfaceProfile>> = Object.freeze({
  full: Object.freeze({
    name: "full",
    description: "Every tool advertised (default).",
    scope: "full",
  }),
  writer: Object.freeze({
    name: "writer",
    description: "Always-loaded Brain writers plus the context reader.",
    scope: "writer",
  }),
  catalog: Object.freeze({
    name: "catalog",
    description: "Two-pass surface: compact first pass, schemas via tool_hydrate.",
    scope: "catalog",
  }),
  recall: Object.freeze({
    name: "recall",
    description: "Memory read/write surface for recall-heavy hosts; no admin tools.",
    scope: "full",
    window: Object.freeze({
      allowedTools: Object.freeze([
        ...WRITER_SET,
        "brain_search",
        "brain_recall_gate",
        "brain_recall_feedback",
        "brain_context_pack",
        "brain_artifact_get",
      ]),
    }),
  }),
  minimal: Object.freeze({
    name: "minimal",
    description: "Floor surface for constrained hosts: writers, context, search.",
    scope: "full",
    window: Object.freeze({
      allowedTools: Object.freeze([...WRITER_SET, "brain_search"]),
    }),
  }),
});

export function toolSurfaceProfileNames(): string[] {
  return Object.keys(TOOL_SURFACE_PROFILES);
}

export interface ResolveToolSurfaceOptions {
  /** Profile name from --tool-profile or the mcp_tool_profile key. */
  readonly profileName?: string | null;
  /** Explicit --scope value; wins over the profile's scope. */
  readonly explicitScope?: ToolScope;
  /** Explicit window flags; fields win over the profile's window. */
  readonly explicitWindow?: RuntimeCapabilityWindow;
}

export interface ResolvedToolSurface {
  readonly scope: ToolScope;
  readonly window?: RuntimeCapabilityWindow;
  /** The profile that applied ("full" when none/unknown). */
  readonly profile: string;
  /** Set when the requested profile did not exist (fail-open marker). */
  readonly unknownProfile?: string;
}

function mergeWindows(
  profile: RuntimeCapabilityWindow | undefined,
  explicit: RuntimeCapabilityWindow | undefined,
): RuntimeCapabilityWindow | undefined {
  if (profile === undefined) return explicit;
  if (explicit === undefined) return profile;
  return {
    ...((explicit.allowedTools ?? profile.allowedTools)
      ? { allowedTools: explicit.allowedTools ?? profile.allowedTools! }
      : {}),
    ...((explicit.disabledTools ?? profile.disabledTools)
      ? { disabledTools: explicit.disabledTools ?? profile.disabledTools! }
      : {}),
    ...((explicit.maxTools ?? profile.maxTools) !== undefined
      ? { maxTools: (explicit.maxTools ?? profile.maxTools)! }
      : {}),
  };
}

/** Resolve the effective surface. Unknown profiles fail OPEN to full. */
export function resolveToolSurface(opts: ResolveToolSurfaceOptions): ResolvedToolSurface {
  const requested = opts.profileName?.trim() || null;
  if (requested === null) {
    return {
      scope: opts.explicitScope ?? "full",
      ...(opts.explicitWindow ? { window: opts.explicitWindow } : {}),
      profile: opts.explicitScope ?? "full",
    };
  }
  const profile = TOOL_SURFACE_PROFILES[requested];
  if (profile === undefined) {
    return {
      scope: opts.explicitScope ?? "full",
      ...(opts.explicitWindow ? { window: opts.explicitWindow } : {}),
      profile: "full",
      unknownProfile: requested,
    };
  }
  const window = mergeWindows(profile.window, opts.explicitWindow);
  return {
    scope: opts.explicitScope ?? profile.scope,
    ...(window ? { window } : {}),
    profile: profile.name,
  };
}

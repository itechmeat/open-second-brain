import {
  RUNTIME_FACTS,
  TOOL_CEILING_KIND,
  type InstallTargetId,
} from "../core/runtime/host-facts.ts";
import type {
  HostCeilingReport,
  ToolCapabilityEntry,
  ToolCapabilityReport,
  ToolDefinition,
  ToolScope,
} from "./tool-contract.ts";

export interface RuntimeCapabilityWindow {
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disabledTools?: ReadonlyArray<string>;
  readonly maxTools?: number;
}

export interface RuntimeCapabilityContext {
  readonly scope: ToolScope;
  readonly serverName: string;
  readonly window?: RuntimeCapabilityWindow;
  /**
   * The runtime that launched this server, from `o2b mcp --host-target`
   * in the registration an install adapter generated. Absent whenever
   * the server was started by hand or by a payload written before the
   * flag existed - which is reported as an unchecked ceiling, never as
   * an absent one.
   */
  readonly hostTarget?: InstallTargetId;
}

export interface ToolCapabilityEvaluation {
  readonly tools: ToolDefinition[];
  readonly report: ToolCapabilityReport;
}

export const CAPABILITY_DIAGNOSTIC_TOOL = "second_brain_capabilities";

export function evaluateToolCapabilities(
  candidates: ReadonlyArray<ToolDefinition>,
  context: RuntimeCapabilityContext,
): ToolCapabilityEvaluation {
  const allowed = nonEmptySet(context.window?.allowedTools);
  const disabled = new Set(context.window?.disabledTools ?? []);
  const maxTools = context.window?.maxTools;
  const tools: ToolDefinition[] = [];
  const available: ToolCapabilityEntry[] = [];
  const withheld: ToolCapabilityEntry[] = [];
  let countedAvailable = 0;

  for (const tool of candidates) {
    if (tool.name === CAPABILITY_DIAGNOSTIC_TOOL) {
      tools.push(tool);
      available.push({
        name: tool.name,
        reason: "diagnostic tool is always available",
      });
      continue;
    }
    const deniedReason = deniedByWindow(tool.name, allowed, disabled, maxTools, countedAvailable);
    if (deniedReason) {
      withheld.push({ name: tool.name, reason: deniedReason });
      continue;
    }
    countedAvailable += 1;
    tools.push(tool);
    available.push({ name: tool.name, reason: "available" });
  }

  const advertised = tools.filter((tool) => tool.hidden !== true).length;
  return {
    tools,
    report: {
      scope: context.scope,
      server_name: context.serverName,
      static_tool_count: candidates.length,
      available_tool_count: tools.length,
      advertised_tool_count: advertised,
      host_ceiling: hostCeiling(context.hostTarget, advertised),
      available,
      withheld,
    },
  };
}

/**
 * Why a server that was never told its host cannot cite a limit.
 *
 * It names the flag rather than shrugging, because the remedy is
 * concrete: re-run `o2b install --target <runtime> --apply` and the
 * generated registration will carry it.
 */
const UNNAMED_HOST_REASON =
  "this server was not told which runtime launched it (no --host-target in its registration), " +
  "so no published per-workspace tool limit can be cited; re-run " +
  "`o2b install --target <runtime> --apply` to regenerate a registration that names the host";

/** The host's published limit, or the stated absence of one. */
function hostCeiling(target: InstallTargetId | undefined, advertised: number): HostCeilingReport {
  if (target === undefined) {
    return {
      target: null,
      kind: TOOL_CEILING_KIND.unknown,
      max_tools: null,
      source: null,
      reason: UNNAMED_HOST_REASON,
      within_ceiling: null,
    };
  }
  const ceiling = RUNTIME_FACTS[target].toolCeiling;
  switch (ceiling.kind) {
    case TOOL_CEILING_KIND.declared:
      return {
        target,
        kind: ceiling.kind,
        max_tools: ceiling.maxTools,
        source: ceiling.source,
        reason: null,
        within_ceiling: advertised <= ceiling.maxTools,
      };
    case TOOL_CEILING_KIND.unbounded:
      return {
        target,
        kind: ceiling.kind,
        max_tools: null,
        source: ceiling.source,
        reason: null,
        within_ceiling: true,
      };
    case TOOL_CEILING_KIND.unknown:
      return {
        target,
        kind: ceiling.kind,
        max_tools: null,
        source: null,
        reason: ceiling.reason,
        within_ceiling: null,
      };
  }
}

function nonEmptySet(values: ReadonlyArray<string> | undefined): ReadonlySet<string> | null {
  if (!values || values.length === 0) return null;
  return new Set(values);
}

function deniedByWindow(
  name: string,
  allowed: ReadonlySet<string> | null,
  disabled: ReadonlySet<string>,
  maxTools: number | undefined,
  countedAvailable: number,
): string | null {
  if (disabled.has(name)) return "disabled by runtime capability window";
  if (allowed !== null && !allowed.has(name)) return "not allowed by runtime capability window";
  if (maxTools !== undefined && countedAvailable >= maxTools) {
    return "outside runtime capability max tool window";
  }
  return null;
}

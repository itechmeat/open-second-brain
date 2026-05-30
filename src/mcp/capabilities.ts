import type { ToolDefinition, ToolScope } from "./tools.ts";

export interface RuntimeCapabilityWindow {
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disabledTools?: ReadonlyArray<string>;
  readonly maxTools?: number;
}

export interface RuntimeCapabilityContext {
  readonly scope: ToolScope;
  readonly serverName: string;
  readonly window?: RuntimeCapabilityWindow;
}

export interface ToolCapabilityEntry {
  readonly name: string;
  readonly reason: string;
}

export interface ToolCapabilityReport {
  readonly scope: ToolScope;
  readonly server_name: string;
  readonly static_tool_count: number;
  readonly available_tool_count: number;
  readonly available: ToolCapabilityEntry[];
  readonly withheld: ToolCapabilityEntry[];
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
    const deniedReason = deniedByWindow(
      tool.name,
      allowed,
      disabled,
      maxTools,
      countedAvailable,
    );
    if (deniedReason) {
      withheld.push({ name: tool.name, reason: deniedReason });
      continue;
    }
    countedAvailable += 1;
    tools.push(tool);
    available.push({ name: tool.name, reason: "available" });
  }

  return {
    tools,
    report: {
      scope: context.scope,
      server_name: context.serverName,
      static_tool_count: candidates.length,
      available_tool_count: tools.length,
      available,
      withheld,
    },
  };
}

function nonEmptySet(
  values: ReadonlyArray<string> | undefined,
): ReadonlySet<string> | null {
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
  if (allowed !== null && !allowed.has(name))
    return "not allowed by runtime capability window";
  if (maxTools !== undefined && countedAvailable >= maxTools) {
    return "outside runtime capability max tool window";
  }
  return null;
}

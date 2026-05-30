import { runBrainWatchdog } from "../core/brain/watchdog.ts";
import { coerceBool, coerceInt, coerceStr } from "./coerce.ts";
import type { ToolDefinition } from "./tools.ts";

export const WATCHDOG_TOOLS: ReadonlyArray<ToolDefinition> = [
  {
    name: "brain_watchdog",
    description:
      "Probe Brain health and return safe recovery recommendations. Read-only unless remediate=true, which only creates missing Brain directories.",
    inputSchema: {
      type: "object",
      properties: {
        remediate: {
          type: "boolean",
          description: "Apply safe remediations such as missing directory creation.",
        },
        dry_run: { type: "boolean", description: "Preview remediation without applying it." },
        restore: { type: "string", description: "Snapshot run id to check restore readiness for." },
        force_restore: {
          type: "boolean",
          description: "Allow restore recommendation to be emitted.",
        },
        attempt: {
          type: "integer",
          description: "Retry attempt for exponential backoff metadata.",
        },
      },
      additionalProperties: false,
    },
    handler: (ctx, args) =>
      runBrainWatchdog(ctx.vault, {
        remediate: coerceBool(args, "remediate"),
        dryRun: coerceBool(args, "dry_run"),
        restoreRunId: coerceStr(args, "restore", false) ?? undefined,
        forceRestore: coerceBool(args, "force_restore"),
        attempt: coerceInt(args, "attempt", 0, 0, 32),
      }),
  },
];

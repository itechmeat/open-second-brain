/**
 * Aggregation seam for the Brain MCP tool surface.
 *
 * The handlers live in per-domain modules under `./brain/` (one
 * module per concern, mirroring the sibling search-tools.ts /
 * schema-tools.ts split). This file only concatenates their tool
 * arrays in a stable order; `tools.ts` and the test suite import
 * `BRAIN_TOOLS` from here, so the registration point is unchanged.
 * The tests/mcp/brain-tools-parity.test.ts guard pins the frozen
 * v1.x tool-name set.
 */

import { FEEDBACK_TOOLS } from "./brain/feedback-tools.ts";
import { REVIEW_TOOLS } from "./brain/review-tools.ts";
import { CONTEXT_TOOLS } from "./brain/context-tools.ts";
import { PACK_TOOLS } from "./brain/pack-tools.ts";
import { QUERY_TOOLS } from "./brain/query-tools.ts";
import { ENTITY_TOOLS } from "./brain/entity-tools.ts";
import { HEALTH_TOOLS } from "./brain/health-tools.ts";
import { BRIEF_TOOLS } from "./brain/brief-tools.ts";
import { ANALYTICS_TOOLS } from "./brain/analytics-tools.ts";
import { KNOWLEDGE_TOOLS } from "./brain/knowledge-tools.ts";
import { ADMIN_TOOLS } from "./brain/admin-tools.ts";
import { RECALL_TOOLS } from "./brain/recall-tools.ts";
import { WORKSPACE_TOOLS } from "./brain/workspace-tools.ts";
import { PROCEDURE_TOOLS } from "./brain/procedure-tools.ts";
import { LANDSCAPE_TOOLS } from "./brain/landscape-tools.ts";
import type { ToolDefinition } from "./tools.ts";

export { vaultRelativeSafe } from "./brain/shared.ts";

export const BRAIN_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  ...FEEDBACK_TOOLS,
  ...REVIEW_TOOLS,
  ...CONTEXT_TOOLS,
  ...PACK_TOOLS,
  ...QUERY_TOOLS,
  ...ENTITY_TOOLS,
  ...HEALTH_TOOLS,
  ...BRIEF_TOOLS,
  ...ANALYTICS_TOOLS,
  ...KNOWLEDGE_TOOLS,
  ...ADMIN_TOOLS,
  ...RECALL_TOOLS,
  ...WORKSPACE_TOOLS,
  ...PROCEDURE_TOOLS,
  ...LANDSCAPE_TOOLS,
]);

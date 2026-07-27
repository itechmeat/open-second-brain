/**
 * Output contracts for Model Context Protocol tools.
 *
 * The JSON-subset checker itself lives in `core/brain/response-shape.ts`,
 * which the agent-authored write paths validate against too. This module is
 * the protocol-facing skin over that ONE definition: it keeps the historical
 * `OutputSchema` vocabulary the tool table is written in, and renders the
 * structured violations as the `<path>: <detail>` lines the contract has
 * always reported.
 */

import {
  SHAPE_ROOT_PATH,
  checkResponseShape,
  formatShapeViolation,
  type ShapeDescriptor,
  type ShapeType,
} from "../core/brain/response-shape.ts";

export type OutputSchemaType = ShapeType;

export type OutputSchema = ShapeDescriptor;

export function validateOutputContract(
  schema: OutputSchema,
  value: unknown,
  path = SHAPE_ROOT_PATH,
): string[] {
  return checkResponseShape(schema, value, path).map(formatShapeViolation);
}

export function assertOutputContract(
  toolName: string,
  schema: OutputSchema | undefined,
  value: unknown,
): void {
  if (!schema) return;
  const errors = validateOutputContract(schema, value);
  if (errors.length > 0) {
    throw new Error(`${toolName} output contract failed: ${errors.join("; ")}`);
  }
}

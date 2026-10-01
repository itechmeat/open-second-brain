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

/**
 * A tool's result did not match the output schema it declares. Named so
 * the boundary classifies it as `output_contract_failed` by class rather
 * than by its message; the message is the one the contract has always
 * reported.
 */
export class OutputContractError extends Error {
  /** The tool whose result broke its contract. */
  readonly toolName: string;
  /** The `<path>: <detail>` violation lines. */
  readonly violations: ReadonlyArray<string>;

  constructor(toolName: string, violations: ReadonlyArray<string>) {
    super(`${toolName} output contract failed: ${violations.join("; ")}`);
    this.name = "OutputContractError";
    this.toolName = toolName;
    this.violations = Object.freeze([...violations]);
  }
}

export function assertOutputContract(
  toolName: string,
  schema: OutputSchema | undefined,
  value: unknown,
): void {
  if (!schema) return;
  const errors = validateOutputContract(schema, value);
  if (errors.length > 0) {
    throw new OutputContractError(toolName, errors);
  }
}

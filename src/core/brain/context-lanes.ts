import type { PageTier } from "./page-meta/tier.ts";

export type ContextLaneName = "directives" | "constraints" | "consider";

export interface ContextLaneSource {
  readonly id: string;
  readonly path: string;
  readonly tier: PageTier;
  readonly tokens: number;
  readonly body: string;
  readonly trimmed: boolean;
  readonly sourceId: string;
  readonly sourcePath: string;
}

export interface ContextLanesReport {
  readonly directives: ReadonlyArray<ContextLaneSource>;
  readonly constraints: ReadonlyArray<ContextLaneSource>;
  readonly consider: ReadonlyArray<ContextLaneSource>;
}

export interface ContextLaneInput {
  readonly id: string;
  readonly path: string;
  readonly tier: PageTier;
  readonly tokens: number;
  readonly body: string;
  readonly trimmed: boolean;
  readonly principle: string;
  readonly manualLane?: ContextLaneName | null;
}

const CONSTRAINT_RE =
  /\b(?:avoid|do not|don't|must not|never|no longer|forbid|forbidden)\b|\b(?:не делай|никогда|запрещено|избегай)\b/iu;

export function normalizeContextLane(raw: unknown): ContextLaneName | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLocaleLowerCase();
  if (value === "directives" || value === "constraints" || value === "consider") return value;
  return null;
}

export function classifyContextLane(input: ContextLaneInput): ContextLaneName {
  if (input.manualLane) return input.manualLane;
  const text = `${input.principle}\n${input.body}`;
  if (CONSTRAINT_RE.test(text)) return "constraints";
  if (input.tier === "peripheral") return "consider";
  return "directives";
}

export function buildContextLanes(inputs: ReadonlyArray<ContextLaneInput>): ContextLanesReport {
  const directives: ContextLaneSource[] = [];
  const constraints: ContextLaneSource[] = [];
  const consider: ContextLaneSource[] = [];

  for (const input of inputs) {
    const source = Object.freeze({
      id: input.id,
      path: input.path,
      tier: input.tier,
      tokens: input.tokens,
      body: input.body,
      trimmed: input.trimmed,
      sourceId: input.id,
      sourcePath: input.path,
    });
    const lane = classifyContextLane(input);
    if (lane === "constraints") constraints.push(source);
    else if (lane === "consider") consider.push(source);
    else directives.push(source);
  }

  return Object.freeze({
    directives: Object.freeze(directives),
    constraints: Object.freeze(constraints),
    consider: Object.freeze(consider),
  });
}

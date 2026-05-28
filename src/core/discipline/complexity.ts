export interface ComplexityFactor {
  readonly name: string;
  readonly value: number;
  readonly weight: number;
}

export interface ComplexityReport {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly score: number;
  readonly ratio: number;
  readonly thinking_activity: number;
  readonly structural_complexity: number;
  readonly warning: boolean;
  readonly factors: ReadonlyArray<ComplexityFactor>;
}

export interface BuildComplexityReportInput {
  readonly thinkingActivity: number;
  readonly structuralFilesChanged: number;
  readonly maxFolderDepth?: number;
  readonly templateChanges?: number;
  readonly configChanges?: number;
}

export interface BuildComplexityReportOptions {
  readonly now?: Date;
}

const WARNING_RATIO = 4;
const WARNING_SCORE = 8;

export function buildComplexityReport(
  input: BuildComplexityReportInput,
  options: BuildComplexityReportOptions = {},
): ComplexityReport {
  const now = options.now ?? new Date();
  const factors: ComplexityFactor[] = [
    {
      name: "structural_files_changed",
      value: input.structuralFilesChanged,
      weight: 1,
    },
    { name: "max_folder_depth", value: input.maxFolderDepth ?? 0, weight: 1 },
    { name: "template_changes", value: input.templateChanges ?? 0, weight: 2 },
    { name: "config_changes", value: input.configChanges ?? 0, weight: 2 },
  ].filter((factor) => factor.value > 0);
  const structuralComplexity = factors.reduce(
    (total, factor) => total + factor.value * factor.weight,
    0,
  );
  const thinkingActivity = Math.max(0, input.thinkingActivity);
  const ratio = structuralComplexity / Math.max(1, thinkingActivity);
  const warning =
    structuralComplexity >= WARNING_SCORE && ratio >= WARNING_RATIO;

  return Object.freeze({
    schema_version: 1 as const,
    generated_at: now.toISOString(),
    score: structuralComplexity,
    ratio,
    thinking_activity: thinkingActivity,
    structural_complexity: structuralComplexity,
    warning,
    factors: Object.freeze(factors),
  });
}

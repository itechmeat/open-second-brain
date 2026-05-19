export type PlanAction =
  | "CREATE"
  | "UPDATE"
  | "RECREATE"
  | "SKIP_UNCHANGED"
  | "CONFLICT";

export interface PlanActionInput {
  readonly basename: string;
  readonly prefId: string;
  readonly sha256: string;
  readonly inManifest: { sha256: string } | null;
  readonly prefExists: boolean;
}

export interface PlannedFile {
  readonly basename: string;
  readonly prefId: string;
  readonly action: PlanAction;
}

export function planAction(input: PlanActionInput): PlannedFile {
  const { basename, prefId, sha256, inManifest, prefExists } = input;
  if (inManifest === null) {
    return { basename, prefId, action: prefExists ? "CONFLICT" : "CREATE" };
  }
  if (inManifest.sha256 === sha256) {
    return { basename, prefId, action: prefExists ? "SKIP_UNCHANGED" : "RECREATE" };
  }
  return { basename, prefId, action: prefExists ? "UPDATE" : "CREATE" };
}

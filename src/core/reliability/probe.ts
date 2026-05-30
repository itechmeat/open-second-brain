export const PROBE_STATUSES = Object.freeze(["ok", "warning", "critical"] as const);

export type ProbeStatus = (typeof PROBE_STATUSES)[number];

export interface ProbeCheck {
  readonly name: string;
  readonly status: ProbeStatus;
  readonly message: string;
  readonly remediation?: string;
}

export interface ProbeReport {
  readonly ok: boolean;
  readonly counts: Record<ProbeStatus, number>;
  readonly checks: ReadonlyArray<ProbeCheck>;
}

export function buildProbeReport(checks: ReadonlyArray<ProbeCheck>): ProbeReport {
  const counts: Record<ProbeStatus, number> = {
    ok: 0,
    warning: 0,
    critical: 0,
  };
  for (const check of checks) {
    counts[check.status]++;
  }
  return Object.freeze({
    ok: counts.critical === 0 && counts.warning === 0,
    counts: Object.freeze(counts),
    checks: Object.freeze([...checks]),
  });
}

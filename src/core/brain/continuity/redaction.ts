import { privateRegionTexts, redactRawOutput, stripPrivateRegions } from "../../redactor.ts";

export interface SafePayloadResult {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly private: boolean;
  readonly redacted: boolean;
}

const REDACTED_RE = /\*\*\*REDACTED\*\*\*/;

export function safeContinuityPayload(
  payload: Readonly<Record<string, unknown>>,
): SafePayloadResult {
  let sawPrivate = false;
  let sawRedaction = false;
  const safe = sanitizeValue(payload) as Readonly<Record<string, unknown>>;
  return Object.freeze({
    payload: safe,
    private: sawPrivate,
    redacted: sawRedaction,
  });

  function sanitizeValue(value: unknown): unknown {
    if (typeof value === "string") {
      // The redactor's own region scan, linear in the value's length and
      // the same rule the strip below applies; a lazy-dot pattern here was
      // quadratic on a run of open tags (21.8 s at 720 KB).
      if (privateRegionTexts(value).length > 0) sawPrivate = true;
      const stripped = stripPrivateRegions(value);
      const redacted = redactRawOutput(stripped);
      if (REDACTED_RE.test(redacted) && redacted !== stripped) sawRedaction = true;
      return redacted;
    }
    if (Array.isArray(value)) return Object.freeze(value.map((item) => sanitizeValue(item)));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) out[key] = sanitizeValue(child);
      return Object.freeze(out);
    }
    return value;
  }
}

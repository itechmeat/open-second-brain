/**
 * The one cut line every injection reports when a budget dropped content
 * (task 4.4, spec `agent-context` "Budgets are enforced and reported"):
 * `<dropped> more <what> are not shown. <command>.` Fixed product text,
 * never user content; empty when nothing was dropped.
 */
export function budgetCutLine(input: {
  readonly dropped: number;
  /** The plural noun phrase (`topics in this project`). */
  readonly what: string;
  /** The singular form for a count of one; `what` when absent. */
  readonly whatOne?: string;
  readonly command: string;
}): string {
  if (input.dropped <= 0) return "";
  const one = input.dropped === 1;
  const what = one ? (input.whatOne ?? input.what) : input.what;
  return `_${input.dropped} more ${what} ${one ? "is" : "are"} not shown. ${input.command}._`;
}

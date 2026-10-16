/**
 * Minimal unified-diff renderer, shared by every guarded write lane
 * (t_b6bcd984): `brain upgrade` per-file plan diffs and `rollback
 * --dry-run`, and now the install JSON-merge, protect and doctor-repair
 * consent previews. Moved here from src/cli/brain/upgrade-render.ts so
 * core adapters can attach a diff to a plan step without reaching into
 * the CLI tree (that module keeps a re-export).
 *
 * The implementation trims matching prefix / suffix and prints the
 * changed window — it is not a drop-in replacement for GNU diff, but
 * it is deterministic and dependency-free.
 */

export function renderUnifiedDiff(before: string, after: string, label: string): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  const lines: string[] = [`--- ${label} (live)`, `+++ ${label} (release)`];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tailA = a.length;
  let tailB = b.length;
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) {
    tailA--;
    tailB--;
  }
  if (head > 0) {
    lines.push(`@@ context: ${head} matching line(s) above @@`);
  }
  for (let i = head; i < tailA; i++) lines.push(`- ${a[i]}`);
  for (let i = head; i < tailB; i++) lines.push(`+ ${b[i]}`);
  if (tailA < a.length || tailB < b.length) {
    const tailCount = Math.max(a.length - tailA, b.length - tailB);
    lines.push(`@@ context: ${tailCount} matching line(s) below @@`);
  }
  return lines.join("\n");
}

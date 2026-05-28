export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;

  const obj = value as object;
  if (seen.has(obj)) return value;
  seen.add(obj);

  for (const nested of Object.values(obj as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}

/**
 * Race `p` against a fixed timeout. The factory builds the rejection
 * value so callers can throw the typed error class they need
 * (`SearchError`, `MCPError`, a plain `Error`, …) without each call
 * site reimplementing this utility.
 */

export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  rejectionFactory: (ms: number) => unknown = (n) => new Error(`timeout after ${n}ms`),
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(rejectionFactory(ms)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

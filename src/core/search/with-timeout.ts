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
    const timer = setTimeout(() => {
      // If a buggy factory throws while building the timeout error, the
      // promise would otherwise hang forever — settle with whatever the
      // factory threw instead.
      try {
        reject(rejectionFactory(ms));
      } catch (e) {
        reject(e);
      }
    }, ms);
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

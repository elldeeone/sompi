export interface ReferencedDeadline {
  readonly signal: AbortSignal;
  dispose(): void;
}

/**
 * AbortSignal.timeout() deliberately uses an unreferenced timer. That is a bad
 * fit for a one-shot CLI whose only remaining work may be the awaited API
 * request: Node can exit while the Promise is still pending. Keep this timer
 * referenced until the request settles, then dispose it explicitly.
 */
export function referencedDeadline(milliseconds: number): ReferencedDeadline {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("The operation timed out", "TimeoutError"));
  }, milliseconds);
  let disposed = false;
  return Object.freeze({
    signal: controller.signal,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
    },
  });
}

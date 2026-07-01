export async function pollUntil<T>(
  fn: () => Promise<T | null>,
  opts: { timeoutMs: number; intervalMs: number; label: string },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  let lastErr: unknown;
  for (;;) {
    // A transient RPC blip (ETIMEDOUT / 5xx) mid-poll must not abort a multi-minute
    // round trip: treat a throw like "not ready yet" and keep polling to the deadline,
    // surfacing the last error only if we never succeed.
    try {
      const r = await fn();
      if (r !== null && r !== undefined) return r;
      lastErr = undefined;
    } catch (err) {
      lastErr = err;
      console.warn(`[${opts.label}] transient poll error (will retry): ${(err as Error).message}`);
    }
    if (Date.now() >= deadline) {
      const suffix = lastErr ? `; last error: ${(lastErr as Error).message}` : "";
      throw new Error(`[${opts.label}] timed out after ${opts.timeoutMs}ms${suffix}`);
    }
    await new Promise((res) => setTimeout(res, opts.intervalMs));
  }
}

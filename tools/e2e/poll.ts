export async function pollUntil<T>(
  fn: () => Promise<T | null>,
  opts: { timeoutMs: number; intervalMs: number; label: string },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const r = await fn();
    if (r !== null && r !== undefined) return r;
    if (Date.now() >= deadline) {
      throw new Error(`[${opts.label}] timed out after ${opts.timeoutMs}ms`);
    }
    await new Promise((res) => setTimeout(res, opts.intervalMs));
  }
}

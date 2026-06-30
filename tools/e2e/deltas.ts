export function assertDelta(label: string, before: bigint, after: bigint, expected: bigint): void {
  const actual = after - before;
  if (actual !== expected) {
    throw new Error(
      `[${label}] balance delta mismatch: before=${before} after=${after} expected=${expected} actual=${actual}`,
    );
  }
}

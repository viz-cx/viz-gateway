import { signChallenge } from "@gateway/viz-watcher/dist/challenge";

export interface RegisterDeps {
  coordinatorUrl: string;
  operatorId: string;
  advertiseUrl: string;
  wif: string;
  heartbeatMs: number;
  fetchImpl?: typeof fetch;
}

/** One challenge -> sign -> register round trip. Throws on any non-OK response. */
export async function registerOnce(d: RegisterDeps): Promise<void> {
  const base = d.coordinatorUrl.replace(/\/$/, "");
  const f = d.fetchImpl ?? fetch;
  const chRes = await f(`${base}/register/challenge?operator=${encodeURIComponent(d.operatorId)}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!chRes.ok) throw new Error(`challenge HTTP ${chRes.status}`);
  const { nonce } = (await chRes.json()) as { nonce: string };
  const sig = signChallenge(d.operatorId, d.advertiseUrl, nonce, d.wif);
  const regRes = await f(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operator: d.operatorId, url: d.advertiseUrl, nonce, sig }),
    signal: AbortSignal.timeout(10000),
  });
  if (!regRes.ok) {
    const detail = await regRes.text().catch(() => "");
    throw new Error(`register HTTP ${regRes.status}${detail ? `: ${detail}` : ""}`);
  }
}

/**
 * Register now, then re-register every heartbeatMs (must be < the coordinator's lease).
 * On failure, retry sooner. Returns a stop() to cancel on shutdown.
 */
export function startRegisterLoop(d: RegisterDeps): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    let nextMs = d.heartbeatMs;
    try {
      await registerOnce(d);
    } catch (err) {
      console.warn(`[signer] registration failed (retrying): ${String(err)}`);
      nextMs = Math.min(d.heartbeatMs, 5000);
    }
    if (!stopped) timer = setTimeout(() => void tick(), nextMs);
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

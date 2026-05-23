import { createServer } from "node:http";
import {
  ApprovalSet,
  loadConfig,
  type Approval,
  type CanonicalAction,
} from "@gateway/common";

/**
 * coordinator: UNTRUSTED. Holds no keys. It only
 *   (1) accepts canonical actions from watchers,
 *   (2) collects operator approvals,
 *   (3) once T distinct approvals exist, assembles and broadcasts.
 *
 * Compromise of the coordinator cannot cause theft (it has no keys and honest
 * operators sign only the canonical digest they recomputed locally). Worst case
 * is a liveness stall, which any operator can resolve by running their own.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const approvals = new ApprovalSet(cfg.federation.threshold, cfg.federation.operators);
  const actions = new Map<string, CanonicalAction>();
  const [host, portStr] = cfg.coordinator.listen.split(":");
  const port = Number.parseInt(portStr ?? "8080", 10);

  const server = createServer((reqStream, res) => {
    let body = "";
    reqStream.on("data", (c) => (body += c));
    reqStream.on("end", () => {
      void handle(reqStream.method ?? "GET", reqStream.url ?? "/", body, res, {
        approvals,
        actions,
        threshold: cfg.federation.threshold,
      });
    });
  });

  server.listen(port, host, () => {
    console.log(
      `[coordinator] listening on ${host}:${port}; threshold=${cfg.federation.threshold}-of-${cfg.federation.n}`,
    );
  });
}

interface Ctx {
  approvals: ApprovalSet;
  actions: Map<string, CanonicalAction>;
  threshold: number;
}

async function handle(
  method: string,
  url: string,
  body: string,
  res: import("node:http").ServerResponse,
  ctx: Ctx,
): Promise<void> {
  const json = (code: number, obj: unknown): void => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  try {
    if (method === "POST" && url === "/action") {
      const action = JSON.parse(body) as CanonicalAction;
      ctx.actions.set(action.id, action);
      json(200, { ok: true, id: action.id });
      return;
    }
    if (method === "POST" && url === "/approval") {
      const a = JSON.parse(body) as Approval;
      const accepted = ctx.approvals.add(a);
      const count = ctx.approvals.count(a.actionId);
      const met = ctx.approvals.isMet(a.actionId);
      if (met) {
        // TODO: assemble + broadcast via the appropriate chain adapter, then
        // mark CONFIRMED in the shared ledger. Broadcast is idempotent on id.
        console.log(`[coordinator] threshold met for ${a.actionId} (${count}/${ctx.threshold}) -> broadcast`);
      }
      json(200, { accepted, count, threshold: ctx.threshold, met });
      return;
    }
    if (method === "GET" && url === "/health") {
      json(200, { ok: true, pending: ctx.actions.size });
      return;
    }
    json(404, { error: "not found" });
  } catch (err) {
    json(500, { error: String(err) });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

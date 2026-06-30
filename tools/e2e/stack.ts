// tools/e2e/stack.ts — launch built gateway services as child processes for an e2e run.
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";

const ENTRY: Record<string, string> = {
  "viz-watcher": "packages/viz-watcher/dist/index.js",
  "ton-watcher": "packages/ton-watcher/dist/index.js",
  "solana-watcher": "packages/solana-watcher/dist/index.js",
  signer: "packages/signer/dist/index.js",
  coordinator: "packages/coordinator/dist/index.js",
  dispatcher: "packages/dispatcher/dist/index.js",
};

export interface LaunchedStack {
  stop(): Promise<void>;
}

export async function launchStack(
  services: string[],
  runEnv: Record<string, string>,
  logDir: string,
): Promise<LaunchedStack> {
  mkdirSync(logDir, { recursive: true });
  const procs: ChildProcess[] = [];
  for (const svc of services) {
    const entry = ENTRY[svc];
    if (!entry) throw new Error(`unknown service: ${svc}`);
    const out = createWriteStream(join(logDir, `${svc}.log`));
    const child = spawn("node", [entry], {
      env: { ...process.env, ...runEnv, SERVICE: svc },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.pipe(out);
    child.stderr?.pipe(out);
    procs.push(child);
  }
  // Give signer + coordinator a moment to bind their ports before watchers connect.
  await new Promise((r) => setTimeout(r, 2000));
  return {
    async stop() {
      for (const p of procs) p.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 1500));
      for (const p of procs) if (!p.killed) p.kill("SIGKILL");
    },
  };
}

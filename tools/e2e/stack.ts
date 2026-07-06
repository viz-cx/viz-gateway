// tools/e2e/stack.ts — launch built gateway services as child processes for an e2e run.
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";

const ENTRY: Record<string, string> = {
  "viz-watcher": "packages/viz-watcher/dist/index.js",
  "gram-watcher": "packages/gram-watcher/dist/index.js",
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

// ---------------------------------------------------------------------------
// Federation stack: M independent signer processes + one coordinator.
// Each signer runs as its own process with its own port and key env.
// ---------------------------------------------------------------------------

export interface SignerHandle {
  operatorId: string;
  url: string;
  kill(): void;
  killed: boolean;
}

export interface FederationStack {
  signers: SignerHandle[];
  stopAll(): Promise<void>;
  stopCoordinator(): Promise<void>;
}

export interface SignerSpec {
  operatorId: string;
  port: number;
  env: Record<string, string>;
}

function spawnProc(entry: string, env: Record<string, string>, logPath: string): ChildProcess {
  mkdirSync(join(logPath, ".."), { recursive: true });
  const out = createWriteStream(logPath);
  const child = spawn("node", [entry], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
  return child;
}

export async function launchFederationStack(
  signerSpecs: SignerSpec[],
  coordinatorEnv: Record<string, string>,
  logDir: string,
): Promise<FederationStack> {
  mkdirSync(logDir, { recursive: true });

  const signerProcs: ChildProcess[] = [];
  const signerHandles: SignerHandle[] = [];

  for (const spec of signerSpecs) {
    const env: Record<string, string> = {
      ...spec.env,
      OPERATOR_ID: spec.operatorId,
      SIGNER_LISTEN: `127.0.0.1:${spec.port}`,
      SERVICE: "signer",
    };
    const proc = spawnProc(
      ENTRY["signer"]!,
      env,
      join(logDir, `signer-${spec.operatorId}.log`),
    );
    signerProcs.push(proc);
    let _killed = false;
    signerHandles.push({
      operatorId: spec.operatorId,
      url: `http://127.0.0.1:${spec.port}`,
      kill() {
        if (!_killed) {
          proc.kill("SIGTERM");
          _killed = true;
        }
      },
      get killed() {
        return _killed;
      },
    });
  }

  const signerEndpoints = signerSpecs.map((s) => `http://127.0.0.1:${s.port}`).join(",");
  const coordProc = spawnProc(
    ENTRY["coordinator"]!,
    {
      ...coordinatorEnv,
      SIGNER_ENDPOINTS: signerEndpoints,
      SERVICE: "coordinator",
    },
    join(logDir, "coordinator.log"),
  );

  // Give processes time to bind their ports.
  await new Promise((r) => setTimeout(r, 2500));

  return {
    signers: signerHandles,
    async stopAll() {
      for (const p of signerProcs) if (!p.killed) p.kill("SIGTERM");
      if (!coordProc.killed) coordProc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 1500));
      for (const p of signerProcs) if (!p.killed) p.kill("SIGKILL");
      if (!coordProc.killed) coordProc.kill("SIGKILL");
    },
    async stopCoordinator() {
      if (!coordProc.killed) coordProc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
    },
  };
}

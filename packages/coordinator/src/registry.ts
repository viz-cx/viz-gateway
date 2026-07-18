import { randomBytes } from "node:crypto";
import type { OperatorRef } from "@gateway/common";
import { recoverChallengeSigner } from "@gateway/viz-watcher/dist/challenge";

export interface Registration {
  operatorId: string;
  url: string;
  expiresAt: number;
}

/**
 * Authenticated signer discovery, KEY-ANCHORED. A signer proves it holds a federation
 * VIZ key by signing a coordinator-issued nonce; the coordinator recovers the key,
 * looks up which operator id that key is labeled for in federation.json, and requires
 * that derived id to equal the claimed OPERATOR_ID. This does NOT depend on the manifest's
 * id<->pubkey pairing being pre-confirmed: a mislabeling surfaces as a loud rejection
 * ("this box's key is labeled for a different operator") at bring-up instead of a silent
 * failure. Registrations are held under a TTL lease and refreshed on a heartbeat.
 * Ephemeral by design: on coordinator restart signers re-register within one lease
 * interval, and correctness of in-flight actions rests on the idempotency store, not here.
 */
export class SignerRegistry {
  private readonly byId = new Map<string, Registration>();
  private readonly nonces = new Map<string, { operatorId: string; expiresAt: number }>();
  private readonly knownIds = new Set<string>();
  private readonly idOfPubkey = new Map<string, string>(); // vizPubkey -> operator id
  private readonly order: string[];

  constructor(
    operators: OperatorRef[],
    private readonly leaseMs: number,
    private readonly nonceTtlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.order = operators.map((o) => o.id);
    for (const o of operators) {
      this.knownIds.add(o.id);
      if (o.vizPubkey) this.idOfPubkey.set(o.vizPubkey, o.id);
    }
  }

  issueChallenge(operatorId: string): { nonce: string } {
    if (!this.knownIds.has(operatorId)) throw new Error(`unknown operator '${operatorId}'`);
    // Opportunistic sweep so unused nonces don't accumulate.
    const t = this.now();
    for (const [n, rec] of this.nonces) if (rec.expiresAt <= t) this.nonces.delete(n);
    const nonce = randomBytes(16).toString("hex");
    this.nonces.set(nonce, { operatorId, expiresAt: t + this.nonceTtlMs });
    return { nonce };
  }

  register(operatorId: string, url: string, nonce: string, sigHex: string): Registration {
    const rec = this.nonces.get(nonce);
    this.nonces.delete(nonce); // single-use regardless of outcome
    if (!rec) throw new Error("unknown or already-used nonce");
    if (rec.operatorId !== operatorId) throw new Error("nonce was not issued to this operator");
    if (this.now() > rec.expiresAt) throw new Error("challenge nonce expired");
    let recovered: string;
    try {
      recovered = recoverChallengeSigner(operatorId, url, nonce, sigHex);
    } catch (err) {
      throw new Error(`registration signature unrecoverable: ${String(err)}`);
    }
    // KEY-ANCHORED: identity comes from the key, not the claimed id. The key must be in
    // the federation set, and the operator it is labeled for must match the claimed id.
    const keyOwnerId = this.idOfPubkey.get(recovered);
    if (!keyOwnerId) {
      throw new Error(`registration key ${recovered} is not in the federation key set`);
    }
    if (keyOwnerId !== operatorId) {
      throw new Error(
        `registration key mismatch: this box claims OPERATOR_ID '${operatorId}' but its VIZ key ` +
          `is labeled '${keyOwnerId}' in federation.json — fix OPERATOR_ID or correct the manifest pairing`,
      );
    }
    const reg: Registration = { operatorId, url, expiresAt: this.now() + this.leaseMs };
    this.byId.set(operatorId, reg);
    return reg;
  }

  live(): Registration[] {
    const t = this.now();
    for (const [id, reg] of this.byId) if (reg.expiresAt <= t) this.byId.delete(id);
    return this.order
      .map((id) => this.byId.get(id))
      .filter((r): r is Registration => r !== undefined);
  }

  count(): { registered: number; expected: number } {
    return { registered: this.live().length, expected: this.order.length };
  }

  /** Which operators are currently live vs missing, in the manifest's fixed order. */
  roster(): { live: string[]; missing: string[] } {
    const liveIds = new Set(this.live().map((r) => r.operatorId));
    return {
      live: this.order.filter((id) => liveIds.has(id)),
      missing: this.order.filter((id) => !liveIds.has(id)),
    };
  }

}

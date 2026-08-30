import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  Approval,
  CanonicalAction,
  GramMintProposal,
  Signer,
  SolanaMintProposal,
  SourceHint,
  VizReleaseProposal,
} from "@gateway/common";
import { routeApproval } from "../src/routeApproval";

/** Records which signing method routeApproval picked, so we assert on the ROUTE not the signature. */
function recordingSigner(): { calls: string[]; signer: Signer; hints: (SourceHint | undefined)[] } {
  const calls: string[] = [];
  const hints: (SourceHint | undefined)[] = [];
  const stub =
    (name: string) =>
    async (a: CanonicalAction, _p: unknown, hint?: SourceHint): Promise<Approval> => {
      calls.push(name);
      hints.push(hint);
      return { actionId: a.id, operatorId: "op-1", signature: "ff" };
    };
  const signer = {
    signVizRelease: stub("signVizRelease"),
    approveGramMint: stub("approveGramMint"),
    approveSolanaMint: stub("approveSolanaMint"),
    approveGramReturn: stub("approveGramReturn"),
  } as unknown as Signer;
  return { calls, signer, hints };
}

function action(over: Partial<CanonicalAction> = {}): CanonicalAction {
  return {
    direction: "PEG_IN",
    id: "a".repeat(64),
    recipient: "EQ" + "C".repeat(46),
    amountMilliViz: 100000n,
    digest: "d".repeat(64),
    ...over,
  };
}

const gramProposal: GramMintProposal = {
  orderSeqno: "1",
  orderAddr: "EQ" + "A".repeat(46),
  toAddress: "EQ" + "C".repeat(46),
  amountMilliViz: "100000",
  destProvisioned: true,
  orderHashHex: "b".repeat(64),
  actionId: "a".repeat(64),
};

const solanaProposal: SolanaMintProposal = {
  recipient: "9".repeat(43),
  amountMilliViz: "100000",
  destProvisioned: true,
  mint: "M".repeat(43),
  multisig: "S".repeat(43),
  signers: ["1".repeat(43)],
  feePayer: "F".repeat(43),
  nonceAccount: "N".repeat(43),
  nonceValue: "V".repeat(43),
  decimals: 3,
  messageB64: Buffer.from("msg").toString("base64"),
} as SolanaMintProposal;

const vizProposal: VizReleaseProposal = {
  refBlockNum: 1,
  refBlockPrefix: 2,
  expiration: "2026-01-01T00:00:00",
  from: "gram.gate",
  to: "alice",
  amount: "100.000 VIZ",
  memo: "a".repeat(64),
};

test("PEG_OUT always routes to the VIZ release signer", async () => {
  const { calls, signer } = recordingSigner();
  await routeApproval(signer, action({ direction: "PEG_OUT", remoteChain: "GRAM" }), vizProposal);
  assert.deepEqual(calls, ["signVizRelease"]);
});

test("GRAM_RETURN routes to approveGramReturn on a well-formed proposal", async () => {
  const { calls, signer } = recordingSigner();
  await routeApproval(signer, action({ direction: "GRAM_RETURN" }), gramProposal);
  assert.deepEqual(calls, ["approveGramReturn"]);
});

test("GRAM_RETURN with an unrecognized proposal shape refuses to sign", async () => {
  const { calls, signer } = recordingSigner();
  await assert.rejects(
    () => routeApproval(signer, action({ direction: "GRAM_RETURN" }), solanaProposal),
    /GRAM_RETURN proposal shape not recognized/,
  );
  assert.deepEqual(calls, [], "nothing may be signed when the shape is unrecognized");
});

test("PEG_IN discriminates by proposal shape when remoteChain is absent", async () => {
  const g = recordingSigner();
  await routeApproval(g.signer, action(), gramProposal);
  assert.deepEqual(g.calls, ["approveGramMint"]);

  const s = recordingSigner();
  await routeApproval(s.signer, action(), solanaProposal);
  assert.deepEqual(s.calls, ["approveSolanaMint"]);
});

test("PEG_IN routes each chain when shape and committed remoteChain agree", async () => {
  const g = recordingSigner();
  await routeApproval(g.signer, action({ remoteChain: "GRAM" }), gramProposal);
  assert.deepEqual(g.calls, ["approveGramMint"]);

  const s = recordingSigner();
  await routeApproval(s.signer, action({ remoteChain: "SOLANA" }), solanaProposal);
  assert.deepEqual(s.calls, ["approveSolanaMint"]);
});

// The chain-confusion backstop: a proposal for chain X must never be signed against an
// action committed to chain Y, or a GRAM peg-in could be paid out as a Solana mint.
test("a Solana proposal against a GRAM-committed action is refused", async () => {
  const { calls, signer } = recordingSigner();
  await assert.rejects(
    () => routeApproval(signer, action({ remoteChain: "GRAM" }), solanaProposal),
    /Solana proposal for a GRAM action/,
  );
  assert.deepEqual(calls, []);
});

test("a GRAM proposal against a SOLANA-committed action is refused", async () => {
  const { calls, signer } = recordingSigner();
  await assert.rejects(
    () => routeApproval(signer, action({ remoteChain: "SOLANA" }), gramProposal),
    /GRAM proposal for a SOLANA action/,
  );
  assert.deepEqual(calls, []);
});

test("a PEG_IN proposal matching neither chain shape is refused", async () => {
  const { calls, signer } = recordingSigner();
  await assert.rejects(
    () => routeApproval(signer, action(), vizProposal as unknown as GramMintProposal),
    /proposal shape not recognized \(neither GRAM nor Solana\)/,
  );
  assert.deepEqual(calls, []);
});

test("the untrusted SourceHint is threaded through to every route", async () => {
  const hint = { blockNum: 42 } as unknown as SourceHint;
  for (const [act, prop] of [
    [action({ direction: "PEG_OUT" }), vizProposal],
    [action({ direction: "GRAM_RETURN" }), gramProposal],
    [action(), gramProposal],
    [action(), solanaProposal],
  ] as const) {
    const { hints, signer } = recordingSigner();
    await routeApproval(signer, act, prop as never, hint);
    assert.deepEqual(hints, [hint]);
  }
});

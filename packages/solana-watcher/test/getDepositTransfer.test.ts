import { test } from "node:test";
import assert from "node:assert/strict";
import { SolanaChain } from "../src/solanaChain";

// SolanaChain.getDepositTransfer is the F2 trust primitive for Solana peg-out (PR #150):
// the signer accepts a release ONLY if this returns the finalized wVIZ transfer into the
// deposit ATA it derived itself. Every branch must fail CLOSED (null) — and, crucially, a
// BURN transaction must never satisfy it: the 2026-08-28 production bug was the validator
// confusing the transfer-signature action id with a burn tx, and the fix inverted the
// contract, so this guards the inversion from ever silently regressing.

const ATA = "Agjq1MDNM4WLPACYKNPkqmN1vukAHwR7XoELPbwJFVdo";
const MINT = "APTCgk1UGYgrCiy6B1yVBxkCuzm2K9Rtk2ZSgEiWMdDD";

function transferTx(destination: string, amount: string, slot = 100) {
  return {
    slot,
    meta: { err: null, innerInstructions: [] },
    transaction: {
      message: {
        instructions: [
          {
            program: "spl-token-2022",
            parsed: {
              type: "transferChecked",
              info: { destination, authority: "sender111", tokenAmount: { amount } },
            },
          },
        ],
      },
    },
  };
}

function burnTx(slot = 100) {
  return {
    slot,
    meta: { err: null, innerInstructions: [] },
    transaction: {
      message: {
        instructions: [
          {
            program: "spl-token-2022",
            parsed: { type: "burnChecked", info: { mint: MINT, authority: ATA, tokenAmount: { amount: "30000" } } },
          },
        ],
      },
    },
  };
}

// finalitySlots=0 unless a test sets it; conn is swapped for a mock (no RPC).
function makeChain(tx: unknown, opts: { finalitySlots?: number; finalizedSlot?: number } = {}) {
  const chain = new SolanaChain("http://localhost:1", MINT, "", opts.finalitySlots ?? 0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (chain as any).conn = {
    getParsedTransaction: async () => tx,
    getSlot: async () => opts.finalizedSlot ?? 1_000,
  };
  return chain;
}

test("finalized transfer into the deposit ATA -> slot + amount", async () => {
  const got = await makeChain(transferTx(ATA, "30000")).getDepositTransfer("sig", ATA);
  assert.deepEqual(got, { slot: 100, amountBaseUnits: 30_000n });
});

test("unknown signature -> null (fail-closed)", async () => {
  assert.equal(await makeChain(null).getDepositTransfer("sig", ATA), null);
});

test("failed transaction (meta.err) -> null", async () => {
  const tx = transferTx(ATA, "30000");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (tx.meta as any).err = { InstructionError: [0, "Custom"] };
  assert.equal(await makeChain(tx).getDepositTransfer("sig", ATA), null);
});

test("transfer into a DIFFERENT token account -> null (recipient binding)", async () => {
  const tx = transferTx("SomeOtherAccount1111111111111111111111111111", "30000");
  assert.equal(await makeChain(tx).getDepositTransfer("sig", ATA), null);
});

test("a BURN tx never satisfies the deposit check (production-bug inversion guard)", async () => {
  assert.equal(await makeChain(burnTx()).getDepositTransfer("sig", ATA), null);
});

test("finality buffer: too-fresh slot -> null; buffered-deep slot -> accepted", async () => {
  // finalizedSlot 1000, buffer 32: slot 990 is inside the buffer (refuse), 900 is past it.
  const fresh = makeChain(transferTx(ATA, "30000", 990), { finalitySlots: 32, finalizedSlot: 1_000 });
  assert.equal(await fresh.getDepositTransfer("sig", ATA), null);
  const deep = makeChain(transferTx(ATA, "30000", 900), { finalitySlots: 32, finalizedSlot: 1_000 });
  assert.deepEqual(await deep.getDepositTransfer("sig", ATA), { slot: 900, amountBaseUnits: 30_000n });
});

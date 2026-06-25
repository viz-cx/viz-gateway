// SPIKE: Solana peg-out deposit parsing across innerInstructions (offline).
// Verifies parseGatewayDeposit detects an SPL transfer into the gateway token
// account whether it is a TOP-LEVEL instruction or a CPI inner instruction, and
// handles both `transfer` and `transferChecked`. Transfers via a router/aggregator
// land in meta.innerInstructions; the old top-level-only scan would lose them.
//
// Run: node tools/solana-innerix-spike.cjs   (after npm run build)
const assert = require("node:assert");
const { parseGatewayDeposit } = require("../packages/solana-watcher/dist/solanaChain");

const GATE = "GateTokenAccount1111111111111111111111111111";
const MEMO_PROGRAM_ID = "MemoSq4gq4PtfDg1xv9JaY9Cz9c6Tn3ANk6tDsj4hf";

// 1) transfer hidden inside a CPI (innerInstructions), memo at top level.
const cpiTx = {
  transaction: {
    message: {
      instructions: [
        { program: "spl-memo", programId: MEMO_PROGRAM_ID, parsed: "alice" },
        { program: "some-router", parsed: null },
      ],
    },
  },
  meta: {
    innerInstructions: [
      {
        index: 1,
        instructions: [
          {
            program: "spl-token",
            parsed: {
              type: "transferChecked",
              info: { destination: GATE, tokenAmount: { amount: "5000" }, authority: "Sender111" },
            },
          },
        ],
      },
    ],
  },
};
let r = parseGatewayDeposit(cpiTx, GATE);
assert.ok(r, "CPI inner transfer must be detected (top-level-only would miss it)");
assert.strictEqual(r.amountBaseUnits, 5000n);
assert.strictEqual(r.memo, "alice");
assert.strictEqual(r.from, "Sender111");
console.log("[innerix] CPI transferChecked in innerInstructions detected OK");

// 2) plain top-level `transfer` still works (no regression).
const topTx = {
  transaction: {
    message: {
      instructions: [
        { program: "spl-token", parsed: { type: "transfer", info: { destination: GATE, amount: "1234", source: "Src1" } } },
      ],
    },
  },
  meta: { innerInstructions: [] },
};
r = parseGatewayDeposit(topTx, GATE);
assert.ok(r && r.amountBaseUnits === 1234n && r.from === "Src1");
console.log("[innerix] top-level transfer still detected OK");

// 3) transfer to a DIFFERENT account is ignored, and missing meta is tolerated.
const otherTx = {
  transaction: {
    message: {
      instructions: [
        { program: "spl-token", parsed: { type: "transfer", info: { destination: "OtherAcct", amount: "99", source: "Src1" } } },
      ],
    },
  },
  meta: null,
};
assert.strictEqual(parseGatewayDeposit(otherTx, GATE), null);
console.log("[innerix] transfer to other account ignored; null meta tolerated OK");

console.log("\nRESULT: parseGatewayDeposit scans top-level + innerInstructions, transfer + transferChecked.");

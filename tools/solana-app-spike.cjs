// SPIKE: prove the Solana bridge app's pure helpers (site/solana-bridge.mjs) agree with
// the gateway's own rules: the app's strict 32-byte base58 check must accept every address
// the mint path accepts in practice (real pubkeys) and reject what would strand a peg-in,
// and the Solana Pay URL must follow the transfer-request spec shape.
//
// Run: node tools/solana-app-spike.cjs
const assert = require("node:assert");
const { PublicKey, Keypair } = require("@solana/web3.js");

(async () => {
  const { base58DecodedLength, isValidSolanaAddress, solanaPayUrl } = await import("../site/solana-bridge.mjs");

  // Real 32-byte pubkeys pass — cross-checked against web3.js as the reference decoder.
  const MINT = "APTCgk1UGYgrCiy6B1yVBxkCuzm2K9Rtk2ZSgEiWMdDD";
  for (const addr of [MINT, "6WMGd1g3mRx7rKn469km6ghp7h1DRmaPQfPWQ4icGP5s", PublicKey.default.toBase58()]) {
    assert.strictEqual(base58DecodedLength(addr), 32, addr);
    assert.ok(isValidSolanaAddress(addr), addr);
    assert.ok(new PublicKey(addr).toBytes().length === 32); // reference agrees
  }
  // 20 random keypairs: app check must never refuse a genuine wallet address.
  for (let i = 0; i < 20; i++) {
    assert.ok(isValidSolanaAddress(Keypair.generate().publicKey.toBase58()));
  }

  // Rejects: empty, non-base58 chars (0OIl), truncated paste, over-long, whitespace-only.
  assert.ok(!isValidSolanaAddress(""));
  assert.ok(!isValidSolanaAddress("   "));
  assert.ok(!isValidSolanaAddress("O" + MINT.slice(1))); // 'O' is not base58
  assert.ok(!isValidSolanaAddress(MINT.slice(0, 30))); // truncated → <32 bytes
  assert.ok(!isValidSolanaAddress(MINT + MINT)); // way too long
  assert.ok(!isValidSolanaAddress("EQCfGcOZtfv7RgUuT0vddjFEinDIiAdZagyj70CvmqqLZ9m0")); // a TON address
  // Trims surrounding whitespace like the app input does.
  assert.ok(isValidSolanaAddress(`  ${MINT}  `));

  // Solana Pay URL: spec shape, amount only when it's a positive number.
  const PDA = "DdEEVMTfPzXHWmJspBMwVX7NehZUJcp6dGGkNvMHFWuu";
  assert.strictEqual(solanaPayUrl({ recipient: PDA, mint: MINT }), `solana:${PDA}?spl-token=${MINT}`);
  assert.strictEqual(
    solanaPayUrl({ recipient: PDA, mint: MINT, amount: "30.5" }),
    `solana:${PDA}?spl-token=${MINT}&amount=30.5`,
  );
  for (const bad of ["", "abc", "0", "-1", "1.2.3"]) {
    assert.strictEqual(solanaPayUrl({ recipient: PDA, mint: MINT, amount: bad }), `solana:${PDA}?spl-token=${MINT}`, bad);
  }

  console.log("solana-app-spike OK");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

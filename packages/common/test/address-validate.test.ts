import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRemoteAddress } from "../src/canonical";

test("SOLANA address must be base58, no ':'", () => {
  // TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA = Solana token program (43 chars, valid base58)
  assert.doesNotThrow(() => validateRemoteAddress("SOLANA", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
  assert.throws(() => validateRemoteAddress("SOLANA", ""), /empty/i);
  assert.throws(() => validateRemoteAddress("SOLANA", "has:colon"), /invalid|base58|colon|':'/i);
});

test("GRAM address must be EQ/UQ base64url form", () => {
  assert.throws(() => validateRemoteAddress("GRAM", ""), /empty/i);
  assert.doesNotThrow(() => validateRemoteAddress("GRAM", "EQBiQBCMGHCRtLGMSSxkNe2DtsMvF-sKlWtcGd9q94mPlA7j"));
});

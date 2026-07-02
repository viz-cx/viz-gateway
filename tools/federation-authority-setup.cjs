#!/usr/bin/env node
// tools/federation-authority-setup.cjs
//
// ONE-TIME: upgrade the VIZ gateway account's active authority from 1-of-1 to
// 2-of-3 using the 3 operator pubkeys generated for Phase A N-of-M federation.
//
// Signs with the CURRENT active key (VIZ_CURRENT_ACTIVE_WIF).
// Does NOT touch the master authority or any other account field.
// Dry-run by default — set APPLY=1 to broadcast.
//
// Usage (dry-run first):
//   node tools/federation-authority-setup.cjs
//
// Apply:
//   APPLY=1 node tools/federation-authority-setup.cjs
//
// Env vars:
//   VIZ_NODE_URL           — node HTTP URL (default: https://node.viz.cx)
//   VIZ_GATEWAY_ACCOUNT    — account name to update (default: tester4)
//   VIZ_CURRENT_ACTIVE_WIF — CURRENT active key WIF (used to sign; read from
//                            .env.e2e E2E_VIZ_GATEWAY_WIF if not set)
//   APPLY                  — set to "1" to broadcast; omit for dry-run

'use strict';
const viz = require('viz-js-lib');

// ── config ──────────────────────────────────────────────────────────────────

const NODE_URL    = process.env.VIZ_NODE_URL           || 'https://node.viz.cx';
const ACCOUNT     = process.env.VIZ_GATEWAY_ACCOUNT    || 'tester4';
// Allow either the federation-specific var or the e2e var
const CURRENT_WIF = process.env.VIZ_CURRENT_ACTIVE_WIF || process.env.E2E_VIZ_GATEWAY_WIF || '';
const APPLY       = process.env.APPLY === '1';

// The 3 operator pubkeys for the 2-of-3 active authority.
// Generated 2026-07-02, see docs/federation-keys.md.
const OPERATOR_PUBKEYS = [
  'VIZ65QRpXcP5TC4grAoB58U4JUSwr7TyPdJoEewYSFLEXf1jgCoJy', // op-1
  'VIZ7UADKgSGMedvKCGPzkquaJd7AP7w3EPXmqLVdvRQV58T45cmjK', // op-3
  'VIZ8KDgP7NqqSJDag78tGco7f5vrM4EFwqSoA2qoeX4CkwNkM5U5G', // op-2
];
// ^ already in lexicographic order (Graphene requires sorted key_auths)

const NEW_THRESHOLD = 2;

// ── helpers ──────────────────────────────────────────────────────────────────

function call(fn) {
  return new Promise((resolve, reject) =>
    fn((err, res) => (err ? reject(err) : resolve(res))),
  );
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!CURRENT_WIF) {
    throw new Error(
      'Set VIZ_CURRENT_ACTIVE_WIF (or E2E_VIZ_GATEWAY_WIF) — the current active key of the gateway account.',
    );
  }

  viz.config.set('websocket', NODE_URL);

  // 1. Fetch current account to preserve master + memo_key + json_metadata.
  const accounts = await call((cb) => viz.api.getAccounts([ACCOUNT], cb));
  const account = accounts[0];
  if (!account) throw new Error(`account '${ACCOUNT}' not found on ${NODE_URL}`);

  const currentActive = account.active_authority;
  const master        = account.master_authority;
  const memoKey       = account.memo_key;
  const jsonMeta      = account.json_metadata ?? '';

  // 2. Build the new 2-of-3 active authority.
  const newActive = {
    weight_threshold: NEW_THRESHOLD,
    account_auths:    [],
    key_auths:        OPERATOR_PUBKEYS.map((k) => [k, 1]),
  };

  // 3. Regular = same as new active (standard gateway setup).
  const newRegular = newActive;

  // 4. Print the plan.
  console.log(`\n[fed-setup] account: ${ACCOUNT} @ ${NODE_URL}`);
  console.log('\n[fed-setup] CURRENT active authority:');
  console.log(JSON.stringify(currentActive, null, 2));
  console.log('\n[fed-setup] NEW active authority (2-of-3):');
  console.log(JSON.stringify(newActive, null, 2));
  console.log('\n[fed-setup] master authority (UNCHANGED):');
  console.log(JSON.stringify(master, null, 2));
  console.log(`\n[fed-setup] memo_key (UNCHANGED): ${memoKey}`);

  if (!APPLY) {
    console.log('\n[fed-setup] DRY-RUN — set APPLY=1 to broadcast.\n');
    return;
  }

  // 5. Broadcast.
  // IMPORTANT: omit `master` from the op — VIZ requires the master key only
  // when master is present in the operation. Active-only update (active+regular
  // fields, no master) needs just the current active key. This is documented in
  // packages/common/src/rotation.ts buildRotationOp (verified against VIZ chain).
  console.log('\n[fed-setup] Broadcasting account_update (active-only, no master field)...');
  const gp = await call((cb) => viz.api.getDynamicGlobalProperties(cb));
  const refBlockNum = gp.head_block_number & 0xffff;
  const refBlockPrefix = Buffer.from(gp.head_block_id, 'hex').readUInt32LE(4);
  const expiration = new Date(Date.now() + 60_000).toISOString().slice(0, 19);

  const op = ['account_update', {
    account: ACCOUNT,
    // master intentionally omitted — active-only update needs active key only
    active: newActive,
    regular: newRegular,
    memo_key: memoKey,
    json_metadata: jsonMeta,
  }];
  const tx = { ref_block_num: refBlockNum, ref_block_prefix: refBlockPrefix, expiration, operations: [op], extensions: [] };
  const signed = viz.auth.signTransaction(tx, [CURRENT_WIF]);

  // Use async (non-blocking) broadcast — broadcastTransactionSynchronous times
  // out over HTTP on the public node. Poll for confirmation instead.
  await call((cb) => viz.api.broadcastTransaction(signed, cb));

  // 6. Verify on-chain — poll up to ~18s (6 blocks).
  console.log('[fed-setup] Polling for confirmation...');
  let live;
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const updated = await call((cb) => viz.api.getAccounts([ACCOUNT], cb));
    live = updated[0]?.active_authority;
    if (live && live.weight_threshold === NEW_THRESHOLD && live.key_auths.length === OPERATOR_PUBKEYS.length) break;
    console.log(`  block ${i + 1}: threshold=${live?.weight_threshold} keys=${live?.key_auths.length} (waiting...)`);
  }
  const ok   = live && live.weight_threshold === NEW_THRESHOLD
    && live.key_auths.length === OPERATOR_PUBKEYS.length;

  if (ok) {
    console.log(`[fed-setup] SUCCESS — ${ACCOUNT} active authority is now ${NEW_THRESHOLD}-of-${OPERATOR_PUBKEYS.length}.`);
    console.log('[fed-setup] You can now run: npm run e2e:federation');
  } else {
    console.warn('[fed-setup] Broadcast sent but on-chain state looks unexpected:');
    console.warn(JSON.stringify(live, null, 2));
  }
}

main().catch((err) => {
  console.error('[fed-setup] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});

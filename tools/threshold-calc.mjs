#!/usr/bin/env node
// Federation threshold analysis for an M-of-N custodial bridge.
//
// Model:
//   N = total independent signers (keys/operators)
//   T = threshold (signatures required to move funds)
//
// Two opposing failure modes for a custody multisig:
//   THEFT  : an adversary that controls >= T keys can move funds.
//            => tolerated compromised keys without theft = T - 1
//   FREEZE : if fewer than T keys remain usable, funds cannot move.
//            => tolerated lost/offline keys without freeze   = N - T
//
// "BFT-clean" point (simultaneous safety+liveness against f faults):
//   N = 3f + 1, T = 2f + 1  -> tolerates f Byzantine AND f crash at once.

function bftFaultBudget(N, T) {
  // largest f such that the config tolerates f Byzantine (theft) AND f crash (freeze) simultaneously
  // theft-safe against f: T - 1 >= f  -> f <= T - 1
  // live  against f crashes: N - T >= f -> f <= N - T
  return Math.min(T - 1, N - T);
}

function pick(N) {
  // recommended threshold: strict majority biased toward theft-resistance,
  // i.e. the 2f+1 of 3f+1 shape when N = 3f+1, otherwise ceil(2N/3) rounded to a strong majority.
  return Math.max(Math.ceil((2 * N) / 3), Math.floor(N / 2) + 1);
}

const rows = [];
for (let N = 3; N <= 15; N++) {
  const T = pick(N);
  rows.push({
    N,
    T: `${T}-of-${N}`,
    theftTol: T - 1,            // compromised keys tolerated before theft is possible
    freezeTol: N - T,           // lost/offline keys tolerated before funds freeze
    bftF: bftFaultBudget(N, T), // simultaneous Byzantine+crash budget
  });
}

const pad = (s, w) => String(s).padEnd(w);
console.log(pad('N', 4) + pad('threshold', 12) + pad('theft-tol', 11) + pad('freeze-tol', 12) + 'BFT f (simultaneous)');
console.log('-'.repeat(60));
for (const r of rows) {
  console.log(pad(r.N, 4) + pad(r.T, 12) + pad(r.theftTol, 11) + pad(r.freezeTol, 12) + r.bftF);
}

console.log('\nBFT-clean optima (N = 3f+1, T = 2f+1):');
for (let f = 1; f <= 4; f++) {
  const N = 3 * f + 1, T = 2 * f + 1;
  console.log(`  f=${f}: ${T}-of-${N}  (tolerates ${f} malicious AND ${f} offline at once; theft needs ${T} keys)`);
}

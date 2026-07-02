# Crypto audit — additive ed25519 deposit-key derivation (item ⑤)

**Scope:** `packages/solana-watcher/src/depositAddress.ts` — the hand-rolled additive
ed25519 key derivation and raw-scalar RFC 8032 signer used for Solana peg-out deposit
addresses (Variant A).
**Reviewer:** internal review (Claude), 2026-07-02. **Not** a substitute for the
independent third-party review recommended in R-1.
**Artifacts:** `tools/signer-f2-spike.cjs` (round-trip proof), `tools/ed25519-audit-probe.cjs`
(adversarial probe substantiating findings below). noble-curves pinned at `1.9.7`.

## 1. The construction

```
a       = leToBigInt(clamp(SHA512(seed)[0:32])) mod L          # master scalar
A       = a·G                                                  # master pub (published)
t(viz)  = leToBigInt(SHA512(A ‖ DERIVATION_DOMAIN ‖ viz)) mod L # per-account tweak
child   = A + t·G   (public path)  ==  (a + t)·G  (secret path) # deposit owner key
```

Signing (raw scalar, deterministic RFC 8032):

```
prefix  = SHA512(NONCE_DOMAIN ‖ seed ‖ viz)[0:32]
r       = SHA512(prefix ‖ M) mod L ;  R = r·G
k       = SHA512(R ‖ child_pub ‖ M) mod L
S       = (r + k·child) mod L ;  sig = R ‖ LE32(S)
```

**Correctness (verified, `[1][2]` in the probe):**
- Because `a` is reduced mod `L`, `A = a·G` holds *exactly*, so the public path
  (`A + t·G`) and secret path (`(a+t)·G`) yield the identical point / address. ✓
- The signer emits standard RFC 8032 signatures: `S·G == R + k·child_pub`, `S` is
  canonical (`S < L` ⇒ non-malleable), signatures are deterministic, and they verify /
  reject-on-tamper under an *independent* verifier (`@noble/curves` `ed25519.verify`). ✓

The core arithmetic is **sound**. The findings below are about blast radius, robustness,
and side channels — not correctness bugs.

## 2. Findings

| # | Sev | Finding |
|---|-----|---------|
| F-1 | **HIGH (by-design)** | A single leaked child scalar ⇒ full master compromise (all deposits). |
| F-2 | LOW | Nonce derivation is independent of the scalar but sound (per-account, deterministic). |
| F-3 | LOW | Secret-scalar BigInt arithmetic is not constant-time (timing side channel). |
| F-4 | **MED** | `DEPOSIT_MASTER_PUB` ↔ seed consistency is assumed, never asserted at runtime. |
| F-5 | INFO | `clamp()` is cosmetic after `mod L`; contributes no cofactor protection (harmless). |
| F-6 | INFO | Only trusted (operator) input is ever point-decoded; no invalid-curve surface. |
| F-7 | INFO | Seed is a UTF-8 string — security = its entropy; no minimum enforced. |
| F-8 | INFO | The signer is a general signing oracle; it does not leak the key, but authorizes any bytes. |

### F-1 — child scalar leak ⇒ master compromise *(HIGH, architectural)*
The tweak `t(viz)` is **publicly computable** (`A`, domain, and `viz` are all public).
So anyone who obtains **one** child scalar recovers the master scalar
`a = child − t(viz) mod L`, and can then re-derive and **sign for every other deposit
account** — i.e. sweep all users' in-transit funds. The probe demonstrates this end to
end (`[3]`): leak `alice`'s scalar → recover `a` → forge a verifying spend for `bob`.
Note (`[4]`) the attacker never needs the seed *string* (the SHA-512 preimage) — the
recovered scalar alone is full spend authority, because the attacker picks their own nonce.

This is the well-known non-hardened/additive-derivation property (BIP32-style). It is
**acceptable in the current architecture** only because a single service (the sweeper)
holds both the seed and all child scalars — there is no party that holds a child scalar
without already holding the seed. But it changes the blast radius of *any* scalar
exposure (a log line, a heap dump, a signing-oracle misuse) from "one user" to
"every user + master". **Invariant to enforce and document: a child scalar is
master-seed-equivalent** — never log it, never persist it, never expose a raw signing
primitive over untrusted input. See R-2/R-3.

### F-4 — master-pub / seed consistency is unchecked *(MEDIUM, robustness)*
`depositAddressFromMasterPub(masterPub, viz)` (signer side) uses the operator-configured
`DEPOSIT_MASTER_PUB` both as the base point and inside the tweak hash, while the sweeper
derives from `a·G`. If `DEPOSIT_MASTER_PUB ≠ masterPubFromSeed(SEED)` (a config drift
across processes), signers validate against a different address than the sweeper controls
→ either peg-out releases are wrongly rejected, or funds land at an address the sweeper
cannot spend. Nothing asserts the two agree at runtime; the spike only checks one seed.
See R-4.

### F-3 — non-constant-time signing arithmetic *(LOW, theoretical)*
`Point.BASE.multiply(scalar)` in noble is constant-time for secret scalars, but the
hand-rolled `k*scalar` and `(r + k*scalar) mod L` are variable-time JS `BigInt` ops on
the secret scalar, and `leToBigInt/bigIntToLe32` are data-dependent. On a shared host
this is a theoretical timing channel. Low risk for a backend sweeper; noble's own
`sign()` avoids it. See R-5.

### F-2 / F-5 / F-6 / F-7 / F-8
- **F-2:** `prefix` binds to `(seed, viz)`, not to the scalar. Since `(seed, viz)` fully
  determines the scalar, this is consistent and safe; per-account prefixes rule out
  cross-account nonce reuse; determinism is the expected ed25519 behaviour. No action.
- **F-5:** after `mod L` the clamp bits carry no meaning; `clamp()` here is effectively
  "take 32 bytes, reduce". Harmless (the master scalar is a trusted private multiplier),
  but the code comment should say so to avoid implying cofactor safety.
- **F-6:** the only value ever decoded to a curve point (`Point.fromHex`) is the trusted
  `masterPub`; the attacker-influenced `vizAccount` only feeds SHA-512. No invalid-curve
  / small-subgroup surface from untrusted input.
- **F-7:** entropy rests entirely on the seed string — SHA-512 does not manufacture
  entropy. A weak passphrase ⇒ brute-forceable ⇒ all deposits swept. Require ≥256-bit
  random. See R-4.
- **F-8:** ed25519 is EUF-CMA with a deterministic nonce, so the oracle does not leak the
  key regardless of chosen message; the only risk is authorizing an unintended *valid*
  transaction — an authorization concern already covered by F2 source validation.

## 3. Recommendations

- **R-1 (own the "external" gate):** this internal review is not a third-party audit.
  Before mainnet with real value, commission an independent review of exactly this file +
  the two spikes, or replace the hand-rolled signer with a vetted primitive (R-6). This
  doc is the package to hand them.
- **R-2 (operational, do now):** codify the F-1 invariant in `RUNBOOK.md` — child scalars
  and `SOLANA_DEPOSIT_MASTER_SEED` are single-blast-radius secrets; sweeper runs isolated,
  no scalar/seed in logs or crash dumps, no general signing endpoint.
- **R-3 (code hygiene):** confirm the scalar never escapes the `deriveDepositSigner`
  closure (it currently does not) and add a lint/comment guard so future edits don't
  return or log it.
- **R-4 (robustness, cheap) — ✅ SHIPPED (`hardening/ed25519-audit-r4`):** (a)
  `masterScalar()` now rejects a seed < 32 chars (`MIN_SEED_LEN`); (b) the lookup service
  and peg-out scanner log `deposit master pub = …` on boot, and `RUNBOOK.md` §5 +
  `.env.example` instruct operators to diff it against the published `DEPOSIT_MASTER_PUB`.
  Closes F-7 and the detectable half of F-4 (silent drift now surfaces at boot).
- **R-5 (defense-in-depth):** consider delegating the final signing step to noble's
  constant-time path where feasible; otherwise accept F-3 explicitly.
- **R-6 (strategic):** evaluate whether Variant A even needs additive derivation. If a
  per-account *hardened* derivation (independent seeds/keys per deposit, or an on-chain
  PDA-based routing) meets the product need, it removes F-1 entirely at the cost of the
  public-only re-derivation property that motivated the additive scheme.
- **R-7 (tests):** add fixed RFC 8032 known-answer vectors to the spike (currently
  conformance is only checked transitively via `noble.verify`), and keep noble pinned.

## 4. Verdict

The additive ed25519 derivation and raw-scalar signer are **cryptographically correct**
and interoperate with a standard verifier. There is **no correctness bug**. The dominant
risk is **F-1's blast radius**, which is contained by the single-holder architecture but
must be documented and operationally enforced (R-2/R-3). F-4 is the most likely real-world
failure (silent config drift) and is cheap to close (R-4). The "external" nature of the
gate (R-1) remains open — this review is internal.

# Vendored wrappers — provenance

Source: https://github.com/ton-blockchain/multisig-contract-v2
Commit: 9a4b13df6345c9c4068ca725e434b40f9ea5ca28
Fetched: 2026-06-21

These are the official multisig-contract-v2 TypeScript wrappers, copied verbatim
(cell encoding + get-methods only — no contract bytecode). Do not edit; re-vendor
from a newer pinned commit if upstream changes. The audited compiled code BOC is
supplied separately via MULTISIG_CODE_BOC (see contracts-ton/README.md).

## tsconfig note

The upstream repo does not set `noUncheckedIndexedAccess`; our base tsconfig does.
This caused TS2345/TS18048 errors on loop-indexed arrays in Multisig.ts and Order.ts.
`contracts-ton/tsconfig.json` overrides `noUncheckedIndexedAccess: false` to compile
these vendored files without modification.

## sha256
ed2089f2fe4a8db3d7c0cf122cae27725a800614c43af98b335837a20b373aea  Constants.ts
58a2ca1fdc10694550091e8e89763e02a10d6d2c9290770b98e1835e408944f6  Multisig.ts
c2b4db393d44d0bd65646b8486a44d0f168c0e0fba6d279903573d19e7321c7f  Order.ts

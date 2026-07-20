export const CONFIG = {
  siteUrl: "https://viz-cx.github.io/viz-gateway/",
  wviz: {
    minter: "EQAHujyCaWPjfNaAKHSPDlJZJd2mhWl203eLWShz8PM3_VIZ",
    multisigOwner: "EQCfGcOZtfv7RgUuT0vddjFEinDIiAdZagyj70CvmqqLZ9m0", // peg-out destination
    gatewayJettonWallet: "EQCjDw0JMwpzK-cQInWKABBspYWi-jP9PQgkQsqZ21UgsPhy", // display only
    decimals: 3,
  },
  pegIn: {
    vizAccount: "gram.gate",
    // WebVIZWallet deep-link: non-hash path, bare numeric amount (the hash-routed
    // "N.NNN VIZ" form from DEEPLINKS.md does not resolve in the live wallet).
    walletTransferUrl: "https://wallet.viz.world/assets/transfer/",
  },
  fees: {
    floorMilliViz: 45000n,               // 45 VIZ (GRAM static floor)
    bps: 20,                             // 0.20%
    activationSurchargeMilliViz: 37500n, // 37.5 VIZ, first peg-in per TON wallet
    mintGasFloorMilliViz: 1000n,         // 1 VIZ
  },
  gas: {
    forwardTonAmount: "0.05", // TON, fires the transfer_notification / carries the comment
    messageValue: "0.1",      // TON, attached to the transfer to the sender's own jetton wallet
  },
  rpc: {
    toncenter: "https://toncenter.com/api/v2/jsonRPC", // NO api key in the static site
    viz: "https://node.viz.cx",
    coordinator: "https://gateway.viz.cx", // base; /health and /fees derived from it
  },
};

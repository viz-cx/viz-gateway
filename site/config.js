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
    // WebVIZWallet deep-link: hash-routed path, bare numeric amount (the wallet is
    // a hash router — the query rides inside the fragment).
    walletTransferUrl: "https://wallet.viz.world/#/assets/transfer/",
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
    // VIZ node failover list (mirrors federation.json vizNodeUrls). Any single node
    // can silently return empty account reads while degraded/out-of-sync, so the
    // site tries them in order — never trust the first one alone.
    viz: ["https://node.viz.cx", "https://api.viz.world", "https://mirror.viz.world"],
    coordinator: "https://gateway.viz.cx", // base; /health and /fees derived from it
  },
  dex: {
    // STON.fi asset endpoint — CORS `*`, browser-fetchable. Append the minter address.
    stonfiAssetUrl: "https://api.ston.fi/v1/assets/",
    // Trade deep-links (both valid today; wVIZ is a standard Jetton). Append minter address.
    stonfiSwapUrl: "https://app.ston.fi/swap?ft=TON&tt=",
    dedustSwapUrl: "https://dedust.io/swap/TON/",
    // Explorer. Append minter address.
    explorerUrl: "https://tonviewer.com/",
  },
};

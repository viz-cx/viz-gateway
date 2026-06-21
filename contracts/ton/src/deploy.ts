import { readFileSync } from "node:fs";
import { Address, beginCell, Cell, contractAddress, internal } from "@ton/core";
import type { KeyPair } from "@ton/crypto";
import { TonClient, WalletContractV4 } from "@ton/ton";

/** Load a compiled contract code cell from a .boc file (built via Blueprint). */
export function loadCodeBoc(path: string): Cell {
  const cells = Cell.fromBoc(readFileSync(path));
  const code = cells[0];
  if (!code) throw new Error(`No cell found in BOC: ${path}`);
  return code;
}

/** Compute the contract address for a (code, data) StateInit in workchain 0. */
export function computeAddress(code: Cell, data: Cell): Address {
  return contractAddress(0, { code, data });
}

/**
 * Deploy a (code, data) StateInit by sending an internal message from the
 * deployer wallet (which must be deployed and funded). Returns the deployed
 * address. Caller should poll until the address is active.
 */
export async function deployStateInit(params: {
  client: TonClient;
  keyPair: KeyPair;
  wallet: WalletContractV4;
  code: Cell;
  data: Cell;
  value: bigint; // nanoton to attach for deploy + storage
  body?: Cell;
}): Promise<Address> {
  const { client, keyPair, wallet, code, data, value, body } = params;
  const address = computeAddress(code, data);
  const opened = client.open(wallet);
  const seqno = await opened.getSeqno();
  await opened.sendTransfer({
    secretKey: keyPair.secretKey,
    seqno,
    messages: [
      internal({
        to: address,
        value,
        init: { code, data },
        body: body ?? beginCell().endCell(),
      }),
    ],
  });
  return address;
}

/** Send an internal message (no init) — used for admin handoff etc. */
export async function sendInternal(params: {
  client: TonClient;
  keyPair: KeyPair;
  wallet: WalletContractV4;
  to: Address;
  value: bigint;
  body: Cell;
}): Promise<void> {
  const { client, keyPair, wallet, to, value, body } = params;
  const opened = client.open(wallet);
  const seqno = await opened.getSeqno();
  await opened.sendTransfer({
    secretKey: keyPair.secretKey,
    seqno,
    messages: [internal({ to, value, body })],
  });
}

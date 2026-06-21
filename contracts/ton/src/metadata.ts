import { createHash } from "node:crypto";
import { beginCell, Cell, Dictionary } from "@ton/core";

/**
 * TEP-64 on-chain Jetton metadata for wrapped VIZ (wVIZ).
 *
 * On-chain content layout: a cell prefixed with 0x00, holding a dictionary that
 * maps sha256(attributeName) -> snake-encoded value cell (each value cell is
 * itself prefixed with 0x00). Keep wVIZ at 3 decimals to match VIZ so the
 * reconciliation invariant is a direct integer comparison in milli-VIZ.
 */

export interface WvizMetadata {
  name: string;
  symbol: string;
  decimals: string; // stringified integer per TEP-64, e.g. "3"
  description: string;
  image?: string;
}

function sha256BigInt(s: string): bigint {
  return BigInt("0x" + createHash("sha256").update(s, "utf8").digest("hex"));
}

function snakeValue(s: string): Cell {
  // First byte 0x00 marks snake-format string content; storeStringTail chunks
  // into a ref chain if the value exceeds a single cell.
  return beginCell().storeUint(0, 8).storeStringTail(s).endCell();
}

export function buildWvizContent(meta: WvizMetadata): Cell {
  const dict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
  const entries: Array<[string, string | undefined]> = [
    ["name", meta.name],
    ["symbol", meta.symbol],
    ["decimals", meta.decimals],
    ["description", meta.description],
    ["image", meta.image],
  ];
  for (const [k, v] of entries) {
    if (v !== undefined && v !== "") dict.set(sha256BigInt(k), snakeValue(v));
  }
  return beginCell().storeUint(0, 8).storeDict(dict).endCell();
}

/** Parse an on-chain content cell back to a flat record (for verification). */
export function parseWvizContent(content: Cell): Record<string, string> {
  const cs = content.beginParse();
  cs.loadUint(8); // 0x00 on-chain tag
  const dict = cs.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
  const out: Record<string, string> = {};
  for (const key of ["name", "symbol", "decimals", "description", "image"]) {
    const cell = dict.get(sha256BigInt(key));
    if (cell) {
      const s = cell.beginParse();
      s.loadUint(8); // snake tag
      out[key] = s.loadStringTail();
    }
  }
  return out;
}

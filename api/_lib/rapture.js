// The RAPTURE collection, and the one chain read the holder check needs.
//
// "Holds a RAPTURE NFT" = balanceOf(wallet) > 0 on RaptureCards, the single ERC-721 ("Rapture Cards", symbol
// RAPTURE) that every Rapture set is minted into (token id = setId << 32 | serial), so ARC 1 and any later ARC
// count alike. PackShop mints only when a pack is opened (a refund covers an unopened pack and burns nothing a
// wallet holds), so the balance is exactly the cards the wallet's library shows.
//
// The read goes straight to the public Liteforge JSON-RPC with plain fetch: no ethers (cold start matters, and
// quest platforms such as Galxe give up after 5 seconds). The constants mirror web/assets/rapture/packshop.json;
// api/test/rapture.test.js fails if the two drift apart.

import { checksumAddress } from './address.js';
import { HttpError } from './http.js';

export const RAPTURE = Object.freeze({
  name: 'Rapture Cards',
  symbol: 'RAPTURE',
  contract: '0x138F1A2E48111aFD0Af865F421F05Fd1B0A72721',
  chainId: 4441,
  network: 'LitVM Liteforge',
});
export const RPC_URL = 'https://liteforge.rpc.caldera.xyz/http';

// Two tries of 2 s each: the worst case still answers inside Galxe's 5 s budget.
export const RPC_ATTEMPTS = 2;
export const RPC_TIMEOUT_MS = 2000;

// A caller's wallet address (any letter case) -> its EIP-55 form, or HttpError(400).
// The zero address is refused too: balanceOf reverts for it, which would read as an outage.
export function parseWallet(value) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/.test(value)) {
    throw new HttpError(400, 'address must be a wallet address: 0x followed by 40 hex digits');
  }
  return checksumAddress(value);
}

// How many RAPTURE tokens `address` holds right now. HttpError(503) when the chain cannot be read: never 0,
// which would fail a real holder. RAPTURE_RPC_URL swaps in another Liteforge RPC (the tests' fake one).
export async function raptureBalanceOf(address) {
  const url = process.env.RAPTURE_RPC_URL || RPC_URL;
  const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, '0')}`; // balanceOf(address)
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: RAPTURE.contract, data }, 'latest'] });
  let lastError;
  for (let attempt = 0; attempt < RPC_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`RPC answered HTTP ${res.status}`);
      const reply = await res.json();
      // "0x" means no contract there (an RPC on another chain): an outage too, not a zero balance.
      if (!/^0x[0-9a-fA-F]{64}$/.test(reply?.result)) {
        throw new Error(`RPC returned no balance: ${JSON.stringify(reply?.error ?? reply?.result)}`);
      }
      return BigInt(reply.result);
    } catch (err) {
      lastError = err;
    }
  }
  console.error('[rapture] balanceOf failed:', lastError.message); // for the Vercel logs; the caller learns only 503
  throw new HttpError(503, 'chain unavailable, try again shortly', { 'Retry-After': '5' });
}

// EIP-55 mixed-case checksum for an Ethereum address.
//
// ethers.getAddress does the same, but importing ethers costs a second or so of
// cold start, and GET /api/auth/me (run on every page load) only needs to
// re-case a lowercase address from the database. keccak-256 alone is enough.
// api/test/address.test.js checks this against ethers on thousands of addresses.

import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';

// "0xabc..." (any case, 40 hex digits) -> EIP-55 checksummed "0xAbC...".
export function checksumAddress(address) {
  const lower = address.slice(2).toLowerCase();
  const hash = bytesToHex(keccak_256(lower)); // hash of the lowercase hex text, not of the bytes
  let out = '0x';
  for (let i = 0; i < lower.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

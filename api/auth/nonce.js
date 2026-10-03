// POST /api/auth/nonce  {"address":"0x..."}  ->  {"nonce","message"}
//
// Step 1 of sign-in: hand the browser an EIP-4361 message to sign, bound to
// this host, this chain and a fresh single-use nonce for that address.

import { getAddress } from 'ethers';
import { getChainId } from '../_lib/config.js';
import { query } from '../_lib/db.js';
import { HttpError, assertHostAllowed, endpoint, readJsonBody, sendJson } from '../_lib/http.js';
import { buildSiweMessage, newNonce } from '../_lib/siwe.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export default endpoint({ methods: ['POST'] }, async (req, res, info) => {
  assertHostAllowed(info);

  const { address } = await readJsonBody(req);
  if (typeof address !== 'string' || !ADDRESS_RE.test(address)) {
    throw new HttpError(400, 'address must be a 0x-prefixed 20-byte hex string');
  }
  let checksummed;
  try {
    checksummed = getAddress(address); // throws on a mixed-case address with a bad checksum
  } catch {
    throw new HttpError(400, 'address has an invalid checksum');
  }

  const nonce = newNonce();
  const { message, expiresAt } = buildSiweMessage({
    address: checksummed,
    info,
    chainId: getChainId(),
    nonce,
  });

  // The nonce lives in the database (not in a signed blob) so it can be used
  // exactly once: /verify deletes it atomically. Expired rows are purged here
  // in the same statement, so the table cannot grow without bound.
  await query(
    `with purge as (delete from auth_nonces where expires_at <= now())
     insert into auth_nonces (nonce, address, expires_at)
     values ($1, $2, $3::timestamptz)`,
    [nonce, checksummed.toLowerCase(), expiresAt.toISOString()],
  );

  sendJson(res, 200, { nonce, message });
});

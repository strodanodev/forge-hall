// api/_lib/address.js re-implements EIP-55 so the hot /api/auth/me path does not
// have to load ethers. Prove it agrees with ethers.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { getAddress } from 'ethers';
import { checksumAddress } from '../_lib/address.js';

describe('checksumAddress (EIP-55)', () => {
  // Test vectors from the EIP-55 specification.
  const VECTORS = [
    '0x52908400098527886E0F7030069857D2E4169EE7',
    '0x8617E340B3D01FA5F11F306F4090FD50E238070D',
    '0xde709f2102306220921060314715629080e2fb77',
    '0x27b1fdb04752bbc536007a920d24acb045561c26',
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ];

  it('reproduces the specification vectors from any input casing', () => {
    for (const vector of VECTORS) {
      assert.equal(checksumAddress(vector.toLowerCase()), vector.toLowerCase() === vector ? getAddress(vector) : vector);
      assert.equal(checksumAddress(vector), getAddress(vector));
      assert.equal(checksumAddress(`0x${vector.slice(2).toUpperCase()}`), getAddress(vector));
    }
  });

  it('agrees with ethers.getAddress on 3000 random addresses', () => {
    for (let i = 0; i < 3000; i++) {
      const lower = `0x${randomBytes(20).toString('hex')}`;
      assert.equal(checksumAddress(lower), getAddress(lower), lower);
    }
  });

  it('handles the edge cases: all zeros, all f, digits only', () => {
    for (const address of [`0x${'0'.repeat(40)}`, `0x${'f'.repeat(40)}`, `0x${'1234567890'.repeat(4)}`]) {
      assert.equal(checksumAddress(address), getAddress(address));
    }
  });
});

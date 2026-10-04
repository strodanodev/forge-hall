// GET /api/rapture/holder?address=0x…  ->  does this wallet hold any RAPTURE NFT?
//
// Public and read-only, for partners and quest platforms running a CTA campaign: any origin may call it (CORS),
// there is no key, no cookie is read, and everything it answers is public on chain anyway.
//
// 200 { "address": "0xAbC…", "holder": true, "balance": 3,
//       "collection": { "name", "symbol", "contract", "chainId", "network" },
//       "data": { "result": true }, "result": { "isValid": true } }
// `data.result` and `result.isValid` repeat `holder` in the shapes quest platforms read with no setup (QuestN /
// SoQuest, and TaskOn). Galxe takes any JSON plus an expression: function(resp) { return resp.holder ? 1 : 0 }
//
// 400: not a wallet address. 503: the chain could not be read (never "holder": false, which would fail a real holder).
// Nothing is cached: a player who opened a pack a moment ago must pass at once.

import { endpoint, sendJson } from '../_lib/http.js';
import { RAPTURE, parseWallet, raptureBalanceOf } from '../_lib/rapture.js';

export default endpoint({ methods: ['GET'], cors: true }, async (req, res) => {
  const address = parseWallet(new URL(req.url, 'http://localhost').searchParams.get('address'));
  const balance = Number(await raptureBalanceOf(address));
  const holder = balance > 0;
  sendJson(res, 200, { address, holder, balance, collection: RAPTURE, data: { result: holder }, result: { isValid: holder } });
});

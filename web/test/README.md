# FORGE wallet layer tests

Tests for `web/abi.js`, `web/chain.js`, `web/wallet.js`, `web/packshop.js`, `web/auth.js`, `web/shopflow.js` and the Card Library (`web/holdings.js`, `web/librarymodel.js`, `web/collections.js`). They run on Node's built-in
test runner (Node 22+; developed on v25) with no browser, no network and no npm install of their own.

## Run

From the repository root:

```
node --test "web/test/*.test.mjs"      # each suite in its own process (quotes matter on Windows: Node expands the glob)
node --test web/test/                  # same tests, one process (web/test/index.js imports every suite)
node --test web/test/wallet.test.mjs   # one suite
```

Expect `tests 146 / pass 146 / fail 0` in a few seconds. `node --test web/test/` needs `index.js` because Node 21+ no longer
scans a directory argument; on older Node it scans the directory and runs `index.js` and the suites (twice, harmlessly).

A `MODULE_TYPELESS_PACKAGE_JSON` warning at the top of the output is expected and harmless: the browser modules are plain
`.js` with `import` syntax and there is no `package.json` marking them as ESM, so Node detects it.

## Prerequisites

* `packshop/node_modules` (ethers v6 is the independent oracle: the tests import it from there, the browser code never does).
* The compiled ABIs: `cd packshop && npx hardhat compile` (reads `packshop/artifacts/contracts/**`). Without them the
  suites fail at import with a message saying exactly that. Recompiling after a contract change is how the tests notice a
  changed selector, event or error.

## What is checked

| Suite | Against |
| --- | --- |
| `abi.test.mjs` | every hard-coded function selector, event topic0 and error selector equals ethers' value for the compiled ABIs; calldata is byte-identical to `Interface.encodeFunctionData`; log decoders read logs made by `Interface.encodeEventLog` (empty, 1, 5 and 8 element arrays, ids past 2^53) and refuse hostile data; the `recentPacks` result decoder (three dynamic arrays: empty, 1, 16 entries, huge values, hostile data) matches `Interface.decodeFunctionResult`; revert-data decoding for custom errors, `Error(string)`, `Panic` and every error shape a client meets |
| `chain.test.mjs` | JSON-RPC wire format, retry/backoff/jitter, HTTP and RPC error classification, per-request timeouts, abort, receipt polling |
| `wallet.test.mjs` | a mock EIP-1193 wallet and a mock EIP-6963 window: discovery, connect / restore / disconnect, chain switch (`4902` -> add -> switch), refusals, `-32002`, account and chain events, `personal_sign` encoding (checked with a real signer), sending, error normalisation |
| `packshop.test.mjs` | the real `wallet.js` + `chain.js` + `abi.js` against the mock wallet and `createFakeChain()` (below): buy -> receipt -> `PackBought`, the Waiting -> Openable state machine and abort, open -> `PackOpened`, refund, resume after reload (`findMyPacks` is one `recentPacks` call: every phase, none / 16 / more than 16 packs, failures, no log scan), gas headroom, low balance, config loading, formatting |
| `auth.test.mjs` | the `/api/auth/*` contract against a mock `fetch` and a mock wallet |
| `holdings.test.mjs` | the Card Library's data layer (`web/holdings.js`) on a fake ERC-721 (`ownerOf` / `balanceOf` / `totalSupply` / `tokenURI`) and a fake Blockscout: explorer paging, a lagging index completed by a newest-first `ownerOf` scan that stops at the `balanceOf` count, stale rows dropped, the explorer or balance being down, the scan cap, aborts, remembered pack mints verified before trusted, the NEW baseline (marking one token seen must not flag the rest), edition matching by design hash / design doc / image / name, hostile ABI strings and token URIs, and a blocked `localStorage` |
| `library.test.mjs` | the library's view model (`web/librarymodel.js`: rows, set progress, filters, search that cannot reveal a locked card's name, sort modes) and the set registry (`web/collections.js`) |
| `shopflow.test.mjs` | the page-facing adapter (`web/shopflow.js`) on the fake chain: preview vs live, `?shop=` switches, template-to-card mapping, buy -> wait -> open returning minted cards (own token ids, best last), resume after a reload with no second purchase, dead/expired packs and refunds, a lagging node cannot resurrect an opened pack, the local dev chain's collection |

## Fixtures (`helpers.mjs`, not a test file)

* `createMockProvider()` - a MetaMask-shaped EIP-1193 provider. `provider.once(method, behaviour)` queues a one-shot error or answer.
* `createMockWindow(wallets, ethereum?)` - an `EventTarget` whose installed wallets answer `eip6963:requestProvider`.
* `createFakeChain()` - a JSON-RPC server behind a fake `fetch`, keeping just enough PackShop state (packs, phases, daily limit,
  the per-buyer pack index behind `recentPacks` / `packCountOf`) to run the flows end to end. Every log and result is encoded by ethers. `chain.mineL1(n)` advances the contract-visible
  `block.number` (what moves a pack Waiting -> Openable -> Expired); `st.l2Block` is the separate RPC block number, as on Nitro.
  Knobs: `st.cfg`, `st.balances`, `st.gasPrice`, `st.estimate`, `st.receiptDelay`, `st.failNext`, `st.hooks[method]`.
* `memoryStorage()`, `captureConsole()`, `jsonRpcFetch()`, `hangingFetch()`.

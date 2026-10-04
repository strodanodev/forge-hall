# PackShop — pay zkLTC, get 5 Rapture cards minted to your wallet

A separate contract from the card collection. It sells sealed packs for the chain's native token (zkLTC) and mints
the cards into the buyer's wallet. Liteforge testnet (chain 4441), Arbitrum Nitro.

```
buyPack()  --pay 0.001 zkLTC-->  sealed pack (id, commit block)
   ...two block numbers later (~12-24 s)...
openPack(id)  -->  5 cards drawn from blockhash(commit + 1), minted to the buyer through StudioMinter
```

## How it fits the collection (nothing is redeployed)

`RaptureCards` only mints for a registered drop, and the Studio Test set's only drop is `StudioMinter`, which has
minter roles. PackShop is one more minter:

| Contract | Address (Liteforge) | PackShop's relationship |
|---|---|---|
| StudioMinter | `0x52Ad7703dB1dab3Cc75F29d5281b5b815d493b94` | `setMinter(PackShop, true)` — the only wiring |
| RaptureCards | `0x138F1A2E48111aFD0Af865F421F05Fd1B0A72721` | receives the mints (real ERC-721 tokens, `Transfer` from 0x0) |
| CardDesign | `0x75Fa6d1a80dea2Bf266f32bF5084497607e6A8C1` | one design record written per minted token |

PackShop holds a pool of **templates**: a card's Kind, traits, stats and design record, exactly what
`StudioMinter.mintBatch` takes minus the recipient. The pool is the 50 finished ARC 1 cards, read back from chain by
`scripts/export-templates.mjs` (10 per Kind). Every open mints **new tokens** from those templates, so the same design
can live in many wallets, each token with its own id. The collection contracts are unchanged; the original 50 tokens
stay where they are.

## Settings (testnet)

| | |
|---|---|
| Price | 0.001 zkLTC, exact (`msg.value == price`; anything else reverts). Owner-adjustable. |
| Cards per pack | 5 (fixed at deploy; a different size is a new PackShop) |
| Odds per card slot | Mortal 30 · King 25 · Demigod 20 · Titan 15 · God 10 (the Studio's testnet weights); a template within a Kind is uniform |
| Limit | 3 packs per wallet per UTC day (owner-adjustable, 0 = unlimited) |
| Duplicates | allowed inside a pack (editions) |

## Randomness — read this before mainnet

Two transactions (buy, then open) so a buyer cannot simulate a pull and revert a bad one. The seed is
`blockhash(commitBlock + 1)` mixed with the pack id and buyer.

**This is testnet-grade.** Liteforge is Arbitrum Nitro: `block.number` follows the parent chain (~12 s per number),
`block.prevrandao` is the constant 1, and Arbitrum documents `blockhash` as "cryptographically insecure". The sequencer
can see or influence the seed. Known limits:

- A buyer can compute their pull before opening (`blockhash` is public once it exists) but cannot change it. The only
  way to skip a pull is to let the pack expire and take the full refund. **The daily limit does not bound this.** It is
  per wallet, and one transaction can create dozens of buyer contracts (the audit's proof used 24): a determined grinder
  previews every pull at commit + 2, opens only the good ones and refunds the rest, paying ~0.2M gas plus ~50 minutes of
  locked price per extra look. That is acceptable while the cards have no market value. Before mainnet: a VRF or drand
  seed, or a keeper that opens every pack in the first openable block together with lossy expired refunds.
- The blockhash window is 255 block numbers (~50 min). After that `openPack` reverts `Expired` and anyone can call
  `refundExpired(id)`: the buyer gets exactly what they paid.

Before real value rides on a pull, replace `_seed()` with a VRF or drand beacon (the Rapture repo already has a
`DrandBeacon` waiting on its BLS verifier).

## Trust and known limits

An independent adversarial review (`test/review/adversarial.test.js`, 33 tests) found no way to steal or permanently lock
funds, open a pack twice, re-enter, or divide by zero. Four low-severity defects it found are fixed (sales now require the
MINTER role, the constructor rejects a code-less minter, templates are stat-band checked at load, a retired design can be
re-added). What remains, by design or accepted for a testnet:

- **Skip-and-refund grinding** (above): needs a VRF/keeper before mainnet.
- **The owner is trusted with the pool and the odds.** They are read when a pack is opened, not when it is bought, so an
  owner can change what a sealed pack draws (retire a template, `setWeights`, and `addTemplates`: a Kind's pool length is part
  of the draw, so adding cards to a Kind re-rolls every sealed pack of that Kind). Use a multisig and pause first on mainnet.
- A refund to a buyer *contract* that cannot receive ETH fails for good (its own funds; its `liability` is never released).
- `recentPacks` returns the newest 16 packs; an older expired pack can still be refunded by id (`refundExpired`).
- Price 0 with limit 0 (both owner settings) would mint unlimited cards for free. `MAX_TEMPLATES` counts retired templates.
- **Anything that reads `RaptureCards.revealedOf`** (RaptureAccess, NodeLicense) treats these cards as holdings, and packs
  make the Studio Test set purchasable: do not gate anything valuable on that set.

## Money

`liability` is the price paid for still-sealed packs. `withdraw` can only take balance above it, so the owner can
never touch funds a buyer could still be refunded. Ownership is two-step and cannot be renounced.

## Views a page uses

| View | For |
|---|---|
| `config()` | price, cards per pack, daily limit, paused, ready, odds, template count — one call draws the buy button |
| `packsLeftToday(address)` | packs this wallet may still buy today |
| `phaseOf(id)` / `packOf(id)` | None, Waiting, Openable, Expired, Opened, Refunded |
| `recentPacks(address, n)` | the wallet's last n (≤ 16) packs with phase and commit block: resume a sealed pack or offer a refund with **one call** (the public RPC serves `eth_getLogs` slowly, 3–27 s for 20k blocks) |
| `templateOf(id)`, `activeTemplates(kind)` | what the shop can mint |

## Cost to the player

Opening mints 5 cards with a design record and a registry mirror each: ~4.4M gas. At Liteforge's ~0.2 gwei that is
roughly **0.0009 zkLTC on top of the 0.001 price**. Measured on the live StudioMinter with `scripts/simulate-live.mjs`
(read-only) and matches the local test (4.39M).

## Live on Liteforge (launched 2026-10-01)

| | |
|---|---|
| PackShop | `0x3E39be64A4dE8752E45067d6Bbe4787b4D272B0c` (deploy tx `0x6f28f357…dd46`) |
| Owner | `0x869790B388299FA1E73B8Ad3f188d1f10d4087b5` (the StudioMinter admin; also the only address that can withdraw revenue and pause) |
| State | price 0.001 zkLTC, 5 cards, 3 packs/day, odds 30/25/20/15/10, 50 templates, sales open, holds MINTER on StudioMinter |
| Site | https://forge-hall.vercel.app reads `web/assets/rapture/packshop.json` (written by `scripts/write-web-config.mjs`) |

Re-verify any time, read-only: `npm run simulate-live` (templates mint), `node scripts/write-web-config.mjs` (re-checks the shop on chain).

### Source code on the explorer (verified 2026-10-02)

The PackShop's source is published and **fully verified** on the Liteforge explorer
(<https://liteforge.explorer.caldera.xyz/address/0x3E39be64A4dE8752E45067d6Bbe4787b4D272B0c?tab=contract>): solc 0.8.28, optimizer 200 runs,
viaIR, evm shanghai, Apache-2.0, seven source files (PackShop, the shared Rapture interface file, five OpenZeppelin files). Nothing
secret is in it; the bytecode, storage and the 50 templates were already public on chain.

`node scripts/make-verification.mjs` (read-only: only `eth_getCode`) rebuilds the package in `verification/` and proves the match first:
it finds the Hardhat build whose runtime code equals the code on chain (immutables masked, metadata hash included), writes the minimal
standard JSON input, the ABI-encoded constructor arguments (checked against the creation transaction) and `result.json`. Anyone can redo
that check by compiling with the same settings. To publish (Blockscout's Etherscan-compatible endpoint returns a job id you can poll):

```bash
E=https://liteforge.explorer.caldera.xyz; A=0x3E39be64A4dE8752E45067d6Bbe4787b4D272B0c; cd verification
curl -X POST "$E/api?module=contract&action=verifysourcecode" \
  --data-urlencode codeformat=solidity-standard-json-input --data-urlencode contractaddress=$A \
  --data-urlencode contractname=contracts/PackShop.sol:PackShop --data-urlencode compilerversion=v0.8.28+commit.7893614a \
  --data-urlencode "constructorArguments=$(cat PackShop.constructor-args.txt)" \
  --data-urlencode "constructorArguements=$(cat PackShop.constructor-args.txt)" \
  --data-urlencode licenseType=apache_2_0 --data-urlencode sourceCode@PackShop.standard-input.json
# (both spellings of the constructor-arguments field are sent: Etherscan's own is misspelled and explorers differ on which they read)
curl "$E/api?module=contract&action=checkverifystatus&guid=<result of the call above>"
```

The explorer is flaky (its API answers 500 now and then, and its indexer lags): the first submission sat at "Pending in queue" for twelve
minutes, the resubmission verified within seconds. If a job is still pending after a couple of minutes, post it again. Other Rapture
contracts (RaptureCards, StudioMinter) are deliberately not published from here: that is the owner's call.

## Run it

```bash
npm install
npm test                    # 28 contract tests against the real Rapture contracts (vendored copy)
npm run export-templates    # read the 50 cards from Liteforge -> data/templates.liteforge.json (read-only)
npm run simulate-live       # would every template mint on the live StudioMinter? gas? (read-only, no key)
```

Local dev chain (its own port 8547 and chain id 31338, so it never collides with another local chain):

```bash
npm run node               # terminal 1: Hardhat node, a block every 3 s (like a Nitro block.number tick)
npm run local-setup        # terminal 2: studio stack + PackShop + 50 templates + sales open
                           #   -> ../web/assets/rapture/packshop.local.json
```

### Launch on Liteforge (sends transactions; needs the StudioMinter admin key)

The signer must be the StudioMinter admin (`0x8697…87b5`) with ~0.02 zkLTC. It deploys PackShop (and owns it),
grants the role, loads the pool and opens sales. Every stage checks the chain first, so it is safe to re-run.

```bash
# dry run (default): prints what it would do
DEPLOYER_KEY=0x… npx hardhat run scripts/launch.js --network liteforge
# for real
PACKSHOP_CONFIRM=liteforge DEPLOYER_KEY=0x… npx hardhat run scripts/launch.js --network liteforge
node scripts/write-web-config.mjs          # checks the shop on chain, writes ../web/assets/rapture/packshop.json
```

Estimated cost: deploy ~2.9M gas, pool ~16M gas (5 batches), a few small calls: ≈ 0.004 zkLTC at 0.2 gwei.

## Layout

```
contracts/PackShop.sol             the shop
contracts/test/Harness.sol         test-only: draw statistics, a re-entrant buyer
contracts/vendor/rapture/          copy of the Rapture contracts the tests run against (deployed versions)
test/packshop.test.js              28 tests: stocking, buying, opening, odds, expiry/refund, money, re-entrancy
scripts/export-templates.mjs       chain -> data/templates.liteforge.json
scripts/simulate-live.mjs          read-only rehearsal against the live StudioMinter
scripts/launch.js                  Liteforge launch (idempotent stages, dry run by default)
scripts/make-verification.mjs      read-only: proves the build matches the live code, writes verification/ (explorer package)
scripts/local-setup.js             the same on the local dev chain
deployments/liteforge.json         public addresses (PackShop is recorded here after launch)
```

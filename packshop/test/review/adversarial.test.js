// Adversarial review of PackShop (Solidity 0.8.28, OZ 5.0.2, vendored Rapture Studio stack). Written by an independent
// reviewer on 2026-09-30; the fixes below were applied the same day.
//
// Naming: `fixed: ...` tests were `BUG:` proofs of a defect that has since been fixed (they now assert the good outcome).
// `blocked: ...` tests show an attack that does not work. `BUG: ...` tests that REMAIN document a known limitation: they
// PASS while the limitation exists (they assert the bad outcome, so fixing it makes them fail on purpose). Severity is in
// brackets. See "Trust and known limits" in ../../README.md.
//
//   FIXED  [low]    sales continued while PackShop was not a StudioMinter minter (buyPack now needs the role; ready() includes it)
//   FIXED  [low]    the constructor accepted a minter with no code (BadMinter)
//   FIXED  [low]    addTemplates skipped the stat-band check (now checks minter.bandOf)
//   FIXED  [low]    a design hash was burned forever once added (retireTemplate now frees it)
//
//   KNOWN [medium]  skip-and-refund grinding is not bounded by the daily limit (Sybil buyers in ONE tx). Needs a VRF /
//                   keeper before mainnet; acceptable on a testnet whose cards have no market value
//   KNOWN [low]     pool and odds are read at OPEN time: the (trusted) owner can re-roll or re-weight sealed packs
//   KNOWN [low]     a buyer contract that cannot receive ETH loses its own refund and its `liability` is never released
//   KNOWN [info]    MAX_TEMPLATES counts retired templates; price 0 / limit 0 = free unlimited minting (owner config);
//                   recentPacks cannot reach a pack older than the newest 16 (refund by id still works)
//
// Helper contracts (Adversary, NoReceiveBuyer, SybilFactory) live in contracts/test/review/Adversaries.sol.
"use strict";
const assert = require("node:assert/strict");
const hre = require("hardhat");
const { ethers } = hre;
const { deployStudio, STAT_MIN, STAT_MAX } = require("../helpers/deployStudio.js");

const PRICE = ethers.parseEther("0.001");
const WEIGHTS = [30, 25, 20, 15, 10]; // Mortal, King, Demigod, Titan, God
const KIND_NAMES = ["Mortal", "King", "Demigod", "Titan", "God"];
const PHASE = { None: 0, Waiting: 1, Openable: 2, Expired: 3, Opened: 4, Refunded: 5 };
const WINDOW = 255; // REVEAL_WINDOW
const coder = ethers.AbiCoder.defaultAbiCoder();
const rpc = (method, params = []) => ethers.provider.send(method, params);
const mine = (n) => rpc("hardhat_mine", ["0x" + n.toString(16)]);

// ---------------------------------------------------------------------------------------------- error helpers
const ERROR_SIGS = [
  "BadTemplate()", "DuplicateDesign()", "BadTraits()", "BadParts()", "BadKit()", "BadDesign()", "BadName()", "OutOfBand()",
  "NotMinter()", "ZeroAddress()", "NotStocked()", "WrongPayment()", "DailyLimitReached()", "NotSealed()", "TooEarly()",
  "Expired()", "NotExpired()", "UnknownTemplate()", "LastOfKind()", "TooManyTemplates()", "Insufficient()", "TransferFailed()",
  "RenounceDisabled()", "BadWeights()", "BadPackSize()", "EnforcedPause()", "ExpectedPause()",
  "OwnableUnauthorizedAccount(address)", "OwnableInvalidOwner(address)", "ReentrancyGuardReentrantCall()",
];
const SELECTOR_NAME = Object.fromEntries(ERROR_SIGS.map((s) => [ethers.id(s).slice(0, 10), s.split("(")[0]]));
const NAMES_LONGEST_FIRST = [...new Set(Object.values(SELECTOR_NAME))].sort((a, b) => b.length - a.length);
const selectorOf = (name) => ethers.id(`${name}()`).slice(0, 10);
/** The custom error a failed call/tx carries, by selector first, by name (longest first: NotExpired before Expired) second. */
function errName(e) {
  const blob = String(e?.message ?? "") + " " + JSON.stringify(e?.data ?? "") + " " + JSON.stringify(e?.info ?? "");
  for (const m of blob.matchAll(/0x[0-9a-fA-F]{8}/g)) if (SELECTOR_NAME[m[0].toLowerCase()]) return SELECTOR_NAME[m[0].toLowerCase()];
  for (const n of NAMES_LONGEST_FIRST) if (blob.includes(n)) return n;
  return "unknown(" + blob.slice(0, 200) + ")";
}
async function rejects(promise, error) {
  await assert.rejects(promise, (e) => {
    const got = errName(e);
    assert.equal(got, error, `expected ${error}, got ${got}`);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------- fixtures
/** A template that satisfies StudioMinter's, CardDesign's and RaptureCards' rules for its Kind (same as packshop.test.js). */
function template(kind, i) {
  const head = kind === 3 ? 0 : i % 4;
  const facet = kind === 0 ? 0 : i % 2;
  const circuit = i % 3;
  const bodyType = kind === 3 ? 0 : i % 2;
  const span = STAT_MAX[kind] - STAT_MIN[kind];
  const stat = (n) => STAT_MIN[kind] + ((i * 977 + n * 4051) % (span + 1));
  const divine = kind === 2 || kind === 4;
  return {
    kind,
    traits: {
      faction: i % 2, alignment: [0, 1, 2, 255][i % 4], element: i % 4, frame: (i >> 1) % 4,
      bodyparts: head | (facet << 8) | (circuit << 16) | (bodyType << 24),
      strength: stat(1), agility: stat(2), resilience: stat(3), intelligence: stat(4),
    },
    styleSource: { chainId: 0, collection: ethers.ZeroAddress, tokenId: 0 },
    design: {
      designHash: ethers.id(`design-${kind}-${i}`), art: ethers.id(`art-${kind}-${i}`),
      turntable: ethers.ZeroHash, overridesHash: ethers.ZeroHash,
      avatar: ethers.id(`avatar-${kind}-${i}`), avatarPlain: ethers.id(`plain-${kind}-${i}`), soul: ethers.id(`soul-${kind}-${i}`),
      kit: divine ? 1 + (i % 5) : 0, name: `${KIND_NAMES[kind]} Number ${i}`, epithet: `the ${KIND_NAMES[kind]}`,
    },
  };
}
const POOL = [0, 1, 2, 3, 4].flatMap((k) => Array.from({ length: 10 }, (_, i) => template(k, i))); // ids 10*kind .. 10*kind+9

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("PackShop adversarial review", function () {
  this.timeout(900000);

  let deployer, owner, alice, bob, carol, dave, stranger, attacker;
  let studio, shop, shopAddr, snap;

  async function deployShop({ name = "PackShop", limit = 3, weights = WEIGHTS, size = 5, price = PRICE } = {}) {
    const f = await ethers.getContractFactory(name);
    const s = await f.deploy(await studio.minter.getAddress(), owner.address, price, size, weights, limit);
    await s.waitForDeployment();
    return s;
  }
  async function stock(s, pool = POOL) {
    for (let i = 0; i < pool.length; i += 10) await (await s.connect(owner).addTemplates(pool.slice(i, i + 10))).wait();
  }
  const grant = async (s, on = true) => (await studio.minter.connect(deployer).setMinter(await s.getAddress(), on)).wait();
  /** unpaused, stocked, minter role granted */
  async function openShop(opts = {}, pool = POOL) {
    const s = await deployShop(opts);
    await stock(s, pool);
    await (await s.connect(owner).unpause()).wait();
    await grant(s);
    return s;
  }
  const logOf = (rc, s, name) => rc.logs.map((l) => { try { return s.interface.parseLog(l); } catch { return null; } }).find((l) => l?.name === name);
  async function buy(who = alice, s = shop, value) {
    const rc = await (await s.connect(who).buyPack({ value: value ?? (await s.price()) })).wait();
    const ev = logOf(rc, s, "PackBought");
    return { packId: ev.args.packId, commitBlock: ev.args.commitBlock, rc };
  }
  async function open(packId, who = alice, s = shop) {
    const rc = await (await s.connect(who).openPack(packId)).wait();
    const ev = logOf(rc, s, "PackOpened");
    return { tokenIds: ev.args.tokenIds, templateIds: ev.args.templateIds.map(Number), rc };
  }
  const phase = async (id, s = shop) => Number(await s.phaseOf(id));
  const revealHash = async (commit) => (await ethers.provider.getBlock(Number(commit) + 1)).hash;

  /** Off-chain replica of PackShop._seed/_draw: what ANY buyer can compute for free once blockhash(commit + 1) exists. */
  async function predict(s, packId, buyer, h) {
    const c = await s.config();
    const w = [...c.weights_].map(Number);
    const total = w.reduce((a, b) => a + b, 0);
    const pools = await Promise.all([0, 1, 2, 3, 4].map((k) => s.activeTemplates(k)));
    const seed = BigInt(ethers.keccak256(coder.encode(["bytes32", "uint256", "address", "address"], [h, packId, buyer, await s.getAddress()])));
    const out = [];
    for (let i = 0; i < Number(c.packSize_); i++) {
      const r = BigInt(ethers.keccak256(coder.encode(["uint256", "uint256"], [seed, i])));
      let roll = Number(r % BigInt(total));
      let kind = 0;
      while (roll >= w[kind]) { roll -= w[kind]; kind++; }
      const pool = pools[kind];
      out.push(Number(pool[Number((r >> 128n) % BigInt(pool.length))]));
    }
    return out;
  }

  before(async () => {
    [deployer, owner, alice, bob, carol, dave, stranger, attacker] = await ethers.getSigners();
    studio = await deployStudio(ethers, { minters: [deployer.address] });
    shop = await openShop();
    shopAddr = await shop.getAddress();
  });
  beforeEach(async () => { snap = await rpc("evm_snapshot"); });
  afterEach(async () => {
    await rpc("evm_setAutomine", [true]).catch(() => {});
    await rpc("evm_revert", [snap]);
  });

  // ==================================================================================== randomness / grinding
  describe("randomness and grinding", () => {
    it("BUG: [medium] the daily limit does not bound skip-and-refund looks: ONE transaction creates 24 buyers, only packs holding a God are opened, every other pack refunds in full", async () => {
      const K = 24;
      const factory = await (await ethers.getContractFactory("SybilFactory")).connect(attacker).deploy(shopAddr);
      await factory.waitForDeployment();
      const spent0 = await ethers.provider.getBalance(attacker.address);
      await (await factory.spawn(K, { value: PRICE * BigInt(K) })).wait(); // 24 packs, 24 distinct msg.sender, one block number
      assert.equal(await factory.childCount(), BigInt(K));

      // the README's "at most 3 looks a day" is per address: nothing here was ever limited
      const ids = [];
      for (let i = 0; i < K; i++) ids.push(await factory.packIdOf(i));
      const children = [];
      for (let i = 0; i < K; i++) children.push((await shop.packOf(ids[i])).buyer);
      assert.equal(new Set(children).size, K, "24 distinct buyers");
      const commits = new Set();
      for (const id of ids) commits.add((await shop.packOf(id)).commitBlock);
      assert.equal(commits.size, 1, "all 24 packs share one commit block number");
      const commit = [...commits][0];
      assert.equal(await shop.packsLeftToday(children[0]), 2n, "each Sybil still has 2 of its 3 daily packs unused");
      assert.ok(K > 3, "24 looks in one go, the README promises at most 3 a day");

      await mine(3); // the reveal hash now exists; nobody has opened anything
      const h = await revealHash(commit);
      const goodIdx = [];
      for (let i = 0; i < K; i++) {
        const cards = await predict(shop, ids[i], children[i], h); // free, off-chain, exact
        if (cards.some((t) => POOL[t].kind === 4)) goodIdx.push(i);
      }
      assert.ok(goodIdx.length >= 1 && goodIdx.length < K, `got ${goodIdx.length} God packs out of ${K}`);

      // open ONLY the packs with a God in them
      const godTokens = [];
      for (const i of goodIdx) {
        const { tokenIds, templateIds } = await open(ids[i], stranger);
        assert.ok(templateIds.some((t) => POOL[t].kind === 4), "prediction was exact");
        godTokens.push({ i, tokenIds });
      }
      // ... and leave the rest sealed: after the window each is refunded in full, by anyone
      await mine(300);
      for (let i = 0; i < K; i++) if (!goodIdx.includes(i)) await (await shop.connect(stranger).refundExpired(ids[i])).wait();
      assert.equal(await shop.liability(), 0n);
      const refunded = PRICE * BigInt(K - goodIdx.length);
      assert.equal(await ethers.provider.getBalance(await factory.getAddress()), refunded, "every skipped pack came back at 100%");

      // the attacker walks away with the cards and pays only for the packs it kept
      for (const { i, tokenIds } of godTokens) await (await factory.connect(attacker).sweepChild(i, await studio.cards.getAddress(), [...tokenIds], attacker.address)).wait();
      await (await factory.connect(attacker).cashOut()).wait();
      assert.equal(await studio.cards.balanceOf(attacker.address), BigInt(5 * goodIdx.length));
      const net = spent0 - (await ethers.provider.getBalance(attacker.address));
      console.log(`        Sybil: ${K} looks, kept ${goodIdx.length} God packs, refunded ${K - goodIdx.length}; an honest buyer pays ${K}x price for the same ${goodIdx.length} God packs (${(K / goodIdx.length).toFixed(1)}x per God pack)`);
      assert.ok(net < PRICE * BigInt(goodIdx.length) + ethers.parseEther("0.1"), "net cost is the kept packs plus gas only");
    });

    it("blocked: a keeper that opens every pack in the first openable block removes the skip option (the buyer cannot refund an opened pack)", async () => {
      const { packId } = await buy(alice);
      await mine(1); // reveal hash exists: the buyer could now preview and decide
      const { tokenIds } = await open(packId, stranger); // a keeper does not care about the pull
      for (const id of tokenIds) assert.equal(await studio.cards.ownerOf(id), alice.address);
      await mine(300);
      await rejects(shop.connect(alice).refundExpired(packId), "NotSealed");
    });

    it("blocked: a buyer cannot change a pull; only the reveal hash, pack id and buyer feed the draw, and the off-chain replica matches the chain", async () => {
      const a = await buy(alice), b = await buy(alice);
      await mine(3);
      const pa = await predict(shop, a.packId, alice.address, await revealHash(a.commitBlock));
      const pb = await predict(shop, b.packId, alice.address, await revealHash(b.commitBlock));
      const before = await rpc("evm_snapshot");
      assert.deepEqual((await open(a.packId, stranger)).templateIds, pa);
      await rpc("evm_revert", [before]);
      await mine(50); // opening later, or by someone else, changes nothing
      assert.deepEqual((await open(a.packId, bob)).templateIds, pa);
      assert.deepEqual((await open(b.packId, alice)).templateIds, pb);
      assert.notDeepEqual(pa, pb);
    });

    it("blocked: many transactions in ONE block number (Nitro cadence): buy+open in the same number is TooEarly, and every pack of that number opens on c+2", async () => {
      await rpc("evm_setAutomine", [false]);
      const t1 = await shop.connect(alice).buyPack({ value: PRICE });
      const t2 = await shop.connect(bob).buyPack({ value: PRICE });
      const t3 = await shop.connect(alice).openPack(1, { gasLimit: 6_000_000 }); // same block number as the purchase
      await rpc("evm_mine");
      await rpc("evm_setAutomine", [true]);
      const [r1, r2, r3] = await Promise.all([t1, t2, t3].map((t) => ethers.provider.getTransactionReceipt(t.hash)));
      assert.equal(r1.blockNumber, r2.blockNumber);
      assert.equal(r1.blockNumber, r3.blockNumber, "all three share one block number");
      assert.equal(r3.status, 0, "opening in the commit number reverts (TooEarly)");
      // NB: on Hardhat a plain call runs at block.number = latest, a transaction (or a "pending" call) at latest + 1
      assert.equal(await phase(1), PHASE.Waiting);
      await rejects(shop.openPack.staticCall(1), "TooEarly"); // at c
      await mine(1); // latest = c + 1: a call sees c + 1 (the reveal number itself), the next transaction will run at c + 2
      assert.equal(await phase(1), PHASE.Waiting);
      await rejects(shop.openPack.staticCall(1), "TooEarly");
      assert.equal(await shop.phaseOf(1, { blockTag: "pending" }), BigInt(PHASE.Openable), "the next transaction can open");
      const h = await revealHash(r1.blockNumber);
      const p1 = await predict(shop, 1n, alice.address, h), p2 = await predict(shop, 2n, bob.address, h);
      assert.deepEqual((await open(1, alice)).templateIds, p1);
      assert.deepEqual((await open(2, bob)).templateIds, p2);
      assert.notDeepEqual(p1, p2, "same reveal hash, different pack id and buyer: independent pulls");
    });

    it("blocked: the reveal window edges neither overlap nor leave a gap (open at reveal+255, refund from reveal+256, never both)", async () => {
      // On Hardhat a failed transaction is still mined (a new block), so edge checks use "pending" calls: they run at latest + 1,
      // the number the next transaction gets.
      const { packId, commitBlock } = await buy(alice); // latest = C = commit, reveal = C + 1
      assert.equal(BigInt(await ethers.provider.getBlockNumber()), commitBlock);
      const at = (n) => shop.phaseOf(packId, { blockTag: "pending" }).then(Number);
      await mine(WINDOW); // latest = C + 255: the next transaction runs at C + 256 = reveal + 255, the last openable number
      assert.equal(await at(), PHASE.Openable);
      await rejects(shop.refundExpired.staticCall(packId, { blockTag: "pending" }), "NotExpired");
      const s1 = await rpc("evm_snapshot");
      await open(packId, bob); // blockhash(reveal) is still inside the 256-block window: the transaction succeeds
      await rpc("evm_revert", [s1]);
      await mine(1); // latest = C + 256: the next transaction runs at reveal + 256, the first expired number
      assert.equal(await at(), PHASE.Expired);
      await rejects(shop.openPack.staticCall(packId, { blockTag: "pending" }), "Expired");
      const before = await ethers.provider.getBalance(alice.address);
      await (await shop.connect(bob).refundExpired(packId)).wait();
      assert.equal(await ethers.provider.getBalance(alice.address), before + PRICE);
    });
  });

  // ==================================================================================== money
  describe("money", () => {
    it("blocked: forced ETH (selfdestruct-style) cannot lock, steal or skew liability; the owner only gains it", async () => {
      const bal0 = await ethers.provider.getBalance(shopAddr);
      await rpc("hardhat_setBalance", [shopAddr, ethers.toQuantity(bal0 + ethers.parseEther("5"))]);
      const { packId } = await buy(alice);
      assert.equal(await shop.liability(), PRICE, "liability counts msg.value only");
      await rejects(shop.connect(owner).withdraw(owner.address, ethers.parseEther("5") + 1n), "Insufficient");
      await rejects(shop.connect(owner).withdraw(ethers.ZeroAddress, 1n), "ZeroAddress");
      const before = await ethers.provider.getBalance(bob.address);
      await (await shop.connect(owner).withdraw(bob.address, ethers.parseEther("5"))).wait();
      assert.equal(await ethers.provider.getBalance(bob.address), before + ethers.parseEther("5"));
      await rejects(shop.connect(owner).withdraw(bob.address, 1n), "Insufficient");
      await mine(300);
      const a0 = await ethers.provider.getBalance(alice.address);
      await (await shop.connect(stranger).refundExpired(packId)).wait();
      assert.equal(await ethers.provider.getBalance(alice.address), a0 + PRICE, "the buyer is still refunded in full");
      assert.equal(await shop.liability(), 0n);
    });

    it("blocked: only the owner reaches any admin function; a pending owner has no powers; ownership cannot be renounced or thrown away", async () => {
      const denied = "OwnableUnauthorizedAccount";
      await rejects(shop.connect(stranger).addTemplates([POOL[0]]), denied);
      await rejects(shop.connect(stranger).retireTemplate(0), denied);
      await rejects(shop.connect(stranger).setPrice(1), denied);
      await rejects(shop.connect(stranger).setDailyLimit(1), denied);
      await rejects(shop.connect(stranger).setWeights(WEIGHTS), denied);
      await rejects(shop.connect(stranger).pause(), denied);
      await rejects(shop.connect(stranger).unpause(), denied);
      await rejects(shop.connect(stranger).withdraw(stranger.address, 0), denied);
      await rejects(shop.connect(stranger).transferOwnership(stranger.address), denied);
      await (await shop.connect(owner).transferOwnership(bob.address)).wait();
      await rejects(shop.connect(bob).setPrice(1), denied); // pending owner cannot act
      await rejects(shop.connect(stranger).acceptOwnership(), denied);
      await (await shop.connect(owner).transferOwnership(ethers.ZeroAddress)).wait(); // nobody can accept address(0)
      await rejects(shop.connect(bob).acceptOwnership(), denied);
      await rejects(shop.connect(owner).renounceOwnership(), "RenounceDisabled");
      await rejects(shop.connect(stranger).renounceOwnership(), "RenounceDisabled");
      assert.equal(await shop.owner(), owner.address);
      await (await shop.connect(owner).setPrice(PRICE)).wait(); // the owner keeps full control
    });

    it("blocked: a hostile receiver cannot re-enter buyPack, openPack, refundExpired or (as withdraw target) buyPack while it is being paid", async () => {
      const adv = await (await ethers.getContractFactory("Adversary")).deploy(shopAddr);
      await adv.waitForDeployment();
      const advAddr = await adv.getAddress();
      const reenter = [
        ["buyPack", shop.interface.encodeFunctionData("buyPack"), PRICE],
        ["openPack", shop.interface.encodeFunctionData("openPack", [1]), 0n],
        ["refundExpired", shop.interface.encodeFunctionData("refundExpired", [2]), 0n],
      ];
      for (const [label, data, value] of reenter) {
        const snap2 = await rpc("evm_snapshot");
        await adv.buy({ value: PRICE }); // pack 1: the attacker's
        await buy(bob); // pack 2: someone else's, also expired by then
        await mine(300);
        await (await adv.setMode(3, data, value)).wait();
        const b0 = await ethers.provider.getBalance(advAddr);
        await (await shop.connect(stranger).refundExpired(1)).wait();
        assert.equal(await adv.reenterCount(), 1n, `${label}: the receiver did try`);
        assert.equal(await adv.reenterOk(), false, `${label}: the re-entrant call must fail`);
        assert.equal(await adv.reenterError(), selectorOf("ReentrancyGuardReentrantCall"), label);
        assert.equal(await ethers.provider.getBalance(advAddr), b0 + PRICE, `${label}: paid exactly once`);
        assert.equal(await shop.liability(), PRICE, `${label}: only pack 2 is still owed`);
        await rpc("evm_revert", [snap2]);
      }
      // withdraw() pays an arbitrary address: it must not be able to re-enter either
      await buy(bob);
      await mine(3);
      await open(1, bob); // revenue = PRICE
      await (await adv.setMode(3, shop.interface.encodeFunctionData("buyPack"), PRICE)).wait();
      await (await shop.connect(owner).withdraw(advAddr, PRICE)).wait();
      assert.equal(await adv.reenterOk(), false);
      assert.equal(await adv.reenterError(), selectorOf("ReentrancyGuardReentrantCall"));
      assert.equal(await shop.nextPackId(), 2n, "no pack was bought through the re-entry");
    });

    it("blocked: a reverting or gas-burning receiver is confined to its own pack: the refund is atomic, other packs and the owner are unaffected, and it heals the moment the receiver behaves", async () => {
      const adv = await (await ethers.getContractFactory("Adversary")).deploy(shopAddr);
      await adv.buy({ value: PRICE }); // pack 1: the hostile buyer's
      await buy(bob); // pack 2: an honest buyer's
      await mine(300);
      for (const mode of [1, 2]) {
        await (await adv.setMode(mode, "0x", 0)).wait();
        await rejects(shop.connect(stranger).refundExpired(1), "TransferFailed");
        assert.equal(await shop.liability(), PRICE * 2n, `mode ${mode}: nothing moved`);
        assert.equal(await phase(1), PHASE.Expired);
      }
      const b0 = await ethers.provider.getBalance(bob.address);
      await (await shop.connect(stranger).refundExpired(2)).wait(); // the honest buyer is not held up by pack 1
      assert.equal(await ethers.provider.getBalance(bob.address), b0 + PRICE);
      assert.equal(await shop.liability(), PRICE);
      await (await adv.setMode(0, "0x", 0)).wait();
      await (await shop.connect(stranger).refundExpired(1)).wait();
      assert.equal(await ethers.provider.getBalance(await adv.getAddress()), PRICE);
      assert.equal(await shop.liability(), 0n);
      await rejects(shop.connect(stranger).refundExpired(1), "NotSealed");
    });

    it("BUG: [low] a buyer contract that can never receive ETH loses its refund forever, and the shop's liability for it can never be released", async () => {
      const nb = await (await ethers.getContractFactory("NoReceiveBuyer")).deploy();
      await nb.waitForDeployment();
      await (await nb.connect(alice).buy(shopAddr, { value: PRICE })).wait(); // pack 1
      await mine(400);
      assert.equal(await phase(1), PHASE.Expired);
      await rejects(shop.connect(stranger).refundExpired(1), "TransferFailed");
      await rejects(shop.connect(owner).refundExpired(1), "TransferFailed");
      await mine(5000);
      await rejects(shop.connect(stranger).refundExpired(1), "TransferFailed");
      assert.equal(await shop.liability(), PRICE, "the price stays 'owed' forever");
      // and the owner cannot reach it either: there is no sweep for dead liabilities
      await rejects(shop.connect(owner).withdraw(owner.address, 1n), "Insufficient");
      assert.equal(await ethers.provider.getBalance(shopAddr), PRICE);
    });

    it("BUG: [info] there is no floor on price: price 0 with limit 0 (both owner-settable, both accepted by the constructor) mints unlimited cards for free", async () => {
      const free = await openShop({ price: 0n, limit: 0 });
      for (let i = 0; i < 5; i++) await buy(alice, free, 0n);
      assert.equal(await free.packCountOf(alice.address), 5n);
      assert.equal(await free.liability(), 0n);
      await mine(3);
      const { tokenIds } = await open(1, alice, free);
      assert.equal(tokenIds.length, 5, "five real cards for the price of gas");
      // a free pack bought by a non-payable contract can never even be 'refunded' (call{value: 0} still needs a receiver)
      const nb = await (await ethers.getContractFactory("NoReceiveBuyer")).deploy();
      await (await nb.buy(await free.getAddress(), { value: 0 })).wait();
      await mine(400);
      await rejects(free.refundExpired(6), "TransferFailed");
    });
  });

  // ==================================================================================== state machine
  describe("state machine", () => {
    it("blocked: liability, balance, phases and draws stay consistent under a random mix of buys, opens, refunds, withdrawals, forced ETH and owner changes", async function () {
      this.timeout(900000);
      const rng = mulberry32(20260930);
      const rnd = (n) => Math.floor(rng() * n);
      const pick = (a) => a[rnd(a.length)];
      const fz = await openShop({ limit: 0 });
      const addr = await fz.getAddress();
      const users = [alice, bob, carol, dave];
      const packs = new Map(); // id -> { buyer, commit, paid, state: S sealed | O opened | R refunded }
      const byBuyer = new Map(users.map((u) => [u.address, []]));
      const active = [0, 1, 2, 3, 4].map((k) => new Set(Array.from({ length: 10 }, (_, i) => k * 10 + i)));
      const kindOfId = POOL.map((t) => t.kind);
      let nextDesign = 1000, price = PRICE, paused = false, weights = [...WEIGHTS];
      let revenue = 0n, forced = 0n, withdrawn = 0n;
      const n = { buys: 0, opens: 0, refunds: 0, withdrawals: 0, forcings: 0 };
      const MAX_OPENS = 14;
      const bnNext = async () => (await ethers.provider.getBlockNumber()) + 1; // a transaction runs at latest + 1 (a plain call at latest)
      const phaseModel = (p, bn) => {
        if (p.state === "O") return PHASE.Opened;
        if (p.state === "R") return PHASE.Refunded;
        if (bn <= p.commit + 1) return PHASE.Waiting;
        return bn - (p.commit + 1) > WINDOW ? PHASE.Expired : PHASE.Openable;
      };

      async function check(label, full) {
        const bn = await ethers.provider.getBlockNumber(); // a plain call runs at block.number = latest
        let sealed = 0n;
        for (const p of packs.values()) if (p.state === "S") sealed += p.paid;
        assert.equal(await fz.liability(), sealed, `${label}: liability == sum(paid of sealed packs)`);
        assert.equal(await ethers.provider.getBalance(addr), sealed + revenue + forced - withdrawn, `${label}: balance == liability + revenue + forced - withdrawn`);
        const ids = [...packs.keys()];
        const sample = full ? ids : Array.from({ length: Math.min(4, ids.length) }, () => pick(ids));
        for (const id of sample) {
          const p = packs.get(id);
          assert.equal(await phase(id, fz), phaseModel(p, bn), `${label}: phaseOf(${id})`);
          const po = await fz.packOf(id);
          assert.equal(po.buyer, p.buyer);
          assert.equal(po.commitBlock, BigInt(p.commit));
          assert.equal(po.paid, p.paid);
        }
        const who = pick(users).address;
        const rp = await fz.recentPacks(who, 16);
        const mineIds = byBuyer.get(who).slice(-16);
        assert.deepEqual([...rp.ids].map(Number), mineIds, `${label}: recentPacks ids`);
        assert.deepEqual([...rp.phases].map(Number), mineIds.map((id) => phaseModel(packs.get(id), bn)), `${label}: recentPacks phases`);
        assert.equal(await fz.packCountOf(who), BigInt(byBuyer.get(who).length));
        assert.deepEqual([...(await fz.config()).weights_].map(Number), weights, `${label}: weights`);
        for (let k = 0; k < 5; k++) {
          const chain = (await fz.activeTemplates(k)).map(Number);
          assert.equal(chain.length, new Set(chain).size, `${label}: no duplicate ids in pool ${k}`);
          assert.deepEqual(new Set(chain), active[k], `${label}: pool ${k} membership`);
          if (weights[k] > 0) assert.ok(chain.length > 0, `${label}: Kind ${k} has odds but an empty pool (would divide by zero)`);
        }
      }

      async function doOpen(id, caller) {
        const p = packs.get(id);
        const pred = await predict(fz, BigInt(id), p.buyer, await revealHash(p.commit));
        const rc = await (await fz.connect(caller).openPack(id)).wait();
        const ev = logOf(rc, fz, "PackOpened");
        assert.deepEqual(ev.args.templateIds.map(Number), pred, "on-chain draw == replica");
        assert.equal(ev.args.buyer, p.buyer);
        assert.equal(ev.args.tokenIds.length, 5);
        for (const t of ev.args.templateIds.map(Number)) assert.ok(active[kindOfId[t]].has(t), "drawn from an active template");
        for (const tid of [ev.args.tokenIds[0], ev.args.tokenIds[4]]) assert.equal(await studio.cards.ownerOf(tid), p.buyer);
        p.state = "O"; revenue += p.paid; n.opens++;
      }

      const ops = {
        async buy() {
          const u = pick(users);
          if (rng() < 0.1) await rejects(fz.connect(u).buyPack({ value: price + 1n }), paused ? "EnforcedPause" : "WrongPayment");
          if (paused) return rejects(fz.connect(u).buyPack({ value: price }), "EnforcedPause");
          const rc = await (await fz.connect(u).buyPack({ value: price })).wait();
          const ev = logOf(rc, fz, "PackBought");
          const id = Number(ev.args.packId);
          assert.equal(Number(ev.args.commitBlock), rc.blockNumber);
          packs.set(id, { buyer: u.address, commit: rc.blockNumber, paid: price, state: "S" });
          byBuyer.get(u.address).push(id);
          n.buys++;
        },
        async mine() { await mine(pick([1, 1, 2, 3, 5, 20, 60, 140, 254, 300])); },
        async open() {
          const ids = [...packs.keys()];
          const id = ids.length && rng() < 0.9 ? pick(ids) : 9999;
          const caller = pick([...users, stranger]);
          const p = packs.get(id);
          if (!p || p.state !== "S") return rejects(fz.connect(caller).openPack(id), "NotSealed");
          const ph = phaseModel(p, await bnNext());
          if (ph === PHASE.Waiting) return rejects(fz.connect(caller).openPack(id), "TooEarly");
          if (ph === PHASE.Expired) return rejects(fz.connect(caller).openPack(id), "Expired");
          if (n.opens >= MAX_OPENS) return;
          await doOpen(id, caller);
        },
        async refund() {
          const ids = [...packs.keys()];
          const id = ids.length && rng() < 0.9 ? pick(ids) : 9999;
          const p = packs.get(id);
          if (!p || p.state !== "S") return rejects(fz.connect(stranger).refundExpired(id), "NotSealed");
          if (phaseModel(p, await bnNext()) !== PHASE.Expired) return rejects(fz.connect(stranger).refundExpired(id), "NotExpired");
          const before = await ethers.provider.getBalance(p.buyer);
          await (await fz.connect(stranger).refundExpired(id)).wait();
          assert.equal((await ethers.provider.getBalance(p.buyer)) - before, p.paid, "refund == what was paid, whatever the price is now");
          p.state = "R"; n.refunds++;
        },
        async setPrice() { price = pick([0n, PRICE, PRICE * 2n, PRICE / 2n]); await (await fz.connect(owner).setPrice(price)).wait(); },
        async setWeights() {
          const w = Array.from({ length: 5 }, () => pick([0, 0, 1, 5, 30, 65535]));
          if (w.every((x) => x === 0)) return rejects(fz.connect(owner).setWeights(w), "BadWeights");
          if (w.some((x, k) => x > 0 && active[k].size === 0)) return rejects(fz.connect(owner).setWeights(w), "NotStocked");
          await (await fz.connect(owner).setWeights(w)).wait();
          weights = w;
        },
        async retire() {
          const id = rnd(kindOfId.length + 3);
          const isActive = id < kindOfId.length && active[kindOfId[id]].has(id);
          if (!isActive) return rejects(fz.connect(owner).retireTemplate(id), "UnknownTemplate");
          const k = kindOfId[id];
          if (active[k].size === 1 && weights[k] > 0) return rejects(fz.connect(owner).retireTemplate(id), "LastOfKind");
          await (await fz.connect(owner).retireTemplate(id)).wait();
          active[k].delete(id);
        },
        async add() {
          if (rng() < 0.2) return rejects(fz.connect(owner).addTemplates([POOL[rnd(POOL.length)]]), "DuplicateDesign");
          const batch = Array.from({ length: 1 + rnd(3) }, () => template(rnd(5), nextDesign++));
          await (await fz.connect(owner).addTemplates(batch)).wait();
          for (const t of batch) { kindOfId.push(t.kind); active[t.kind].add(kindOfId.length - 1); }
        },
        async pause() { paused = !paused; await (await fz.connect(owner)[paused ? "pause" : "unpause"]()).wait(); },
        async force() {
          const x = BigInt(1 + rnd(1000)) * 10n ** 12n;
          await rpc("hardhat_setBalance", [addr, ethers.toQuantity((await ethers.provider.getBalance(addr)) + x)]);
          forced += x; n.forcings++;
        },
        async withdraw() {
          let liab = 0n;
          for (const p of packs.values()) if (p.state === "S") liab += p.paid;
          const avail = (await ethers.provider.getBalance(addr)) - liab;
          const to = pick(users);
          if (rng() < 0.25) return rejects(fz.connect(owner).withdraw(to.address, avail + 1n), "Insufficient");
          const amount = avail > 0n ? BigInt(rnd(Number(avail / 10n ** 9n) + 1)) * 10n ** 9n : 0n;
          const before = await ethers.provider.getBalance(to.address);
          await (await fz.connect(owner).withdraw(to.address, amount)).wait();
          assert.equal((await ethers.provider.getBalance(to.address)) - before, amount);
          withdrawn += amount; n.withdrawals++;
        },
      };
      const menu = [["buy", 30], ["mine", 20], ["open", 12], ["refund", 10], ["setPrice", 5], ["setWeights", 6], ["retire", 5], ["add", 4], ["pause", 3], ["force", 3], ["withdraw", 5]]
        .flatMap(([name, w]) => Array(w).fill(name));

      for (let step = 0; step < 150; step++) {
        const op = pick(menu);
        await ops[op]();
        await check(`step ${step} (${op})`, step % 10 === 0);
        if (step === 60 || step === 110) { // make sure the run really opens packs, whatever the dice said
          if (paused) await ops.pause();
          await ops.buy();
          const last = Math.max(...packs.keys());
          await mine(3);
          if (packs.get(last).state === "S" && phaseModel(packs.get(last), await bnNext()) === PHASE.Openable) await doOpen(last, stranger);
        }
      }
      await check("final", true);
      console.log(`        fuzz: ${n.buys} buys, ${n.opens} opens, ${n.refunds} refunds, ${n.withdrawals} withdrawals, ${n.forcings} forced deposits, ${packs.size} packs`);
      assert.ok(n.buys > 15 && n.opens >= 3 && n.refunds >= 2 && n.withdrawals >= 2 && n.forcings >= 1, "the run exercised every path: " + JSON.stringify(n));
    });

    it("blocked: nothing can be opened, refunded or opened again after a terminal transition (open/open, open/refund, refund/open, refund/refund)", async () => {
      const a = await buy(alice), b = await buy(alice);
      await mine(3);
      await open(a.packId, alice);
      await rejects(shop.connect(alice).openPack(a.packId), "NotSealed");
      await mine(300);
      await rejects(shop.connect(stranger).refundExpired(a.packId), "NotSealed"); // refund after open
      await (await shop.connect(stranger).refundExpired(b.packId)).wait();
      await rejects(shop.connect(alice).openPack(b.packId), "NotSealed"); // open after refund
      await rejects(shop.connect(stranger).refundExpired(b.packId), "NotSealed"); // refund twice
      assert.equal(await shop.liability(), 0n);
      assert.equal((await shop.packOf(b.packId)).phase, BigInt(PHASE.Refunded));
    });

    it("blocked: whoever opens (EOA keeper, contract, the buyer), the cards go to the recorded buyer; a contract buyer with no ERC-721 support still gets them", async () => {
      const adv = await (await ethers.getContractFactory("Adversary")).deploy(shopAddr);
      const nb = await (await ethers.getContractFactory("NoReceiveBuyer")).deploy();
      const p1 = await buy(alice), p2 = await buy(bob), p3 = await buy(carol);
      await (await nb.connect(dave).buy(shopAddr, { value: PRICE })).wait(); // pack 4, buyer = a contract with no onERC721Received
      await mine(3);
      const r1 = await open(p1.packId, stranger);
      const rc2 = await (await adv.open(p2.packId)).wait();
      const r3 = await open(p3.packId, carol);
      const r4 = await open(4, stranger);
      const cards = studio.cards;
      for (const id of r1.tokenIds) assert.equal(await cards.ownerOf(id), alice.address);
      for (const id of logOf(rc2, shop, "PackOpened").args.tokenIds) assert.equal(await cards.ownerOf(id), bob.address);
      for (const id of r3.tokenIds) assert.equal(await cards.ownerOf(id), carol.address);
      for (const id of r4.tokenIds) assert.equal(await cards.ownerOf(id), await nb.getAddress(), "RaptureCards uses _mint: no receiver check, opening cannot be blocked by the buyer");
      assert.equal(await cards.balanceOf(stranger.address), 0n);
      assert.equal(await cards.balanceOf(await adv.getAddress()), 0n);
    });

    it("blocked: events tell the truth: bought/opened/refunded/withdrawn/template events match state, and each minted token's design record is the drawn template's", async () => {
      const cardsAddr = await studio.cards.getAddress();
      const { packId, rc: buyRc } = await buy(alice);
      const bought = logOf(buyRc, shop, "PackBought");
      assert.equal(bought.args.buyer, alice.address);
      assert.equal(bought.args.paid, PRICE);
      assert.equal(bought.args.commitBlock, BigInt(buyRc.blockNumber));
      await mine(3);
      const { tokenIds, templateIds, rc } = await open(packId, stranger);
      assert.equal(logOf(rc, shop, "PackOpened").args.buyer, alice.address);
      const parse = (iface, addr) => rc.logs.filter((l) => l.address === addr).map((l) => { try { return iface.parseLog(l); } catch { return null; } }).filter(Boolean);
      const minted = parse(studio.minter.interface, await studio.minter.getAddress()).filter((l) => l.name === "StudioMinted");
      const transfers = parse(studio.cards.interface, cardsAddr).filter((l) => l.name === "Transfer");
      assert.equal(minted.length, 5);
      assert.equal(transfers.length, 5);
      for (let i = 0; i < 5; i++) {
        assert.equal(minted[i].args.tokenId, tokenIds[i]);
        assert.equal(minted[i].args.to, alice.address);
        assert.equal(minted[i].args.minter, shopAddr);
        assert.equal(minted[i].args.designHash, POOL[templateIds[i]].design.designHash, "the token carries the design of the template the event names");
        assert.equal(transfers[i].args.from, ethers.ZeroAddress);
        assert.equal(transfers[i].args.to, alice.address);
        assert.equal(transfers[i].args.tokenId, tokenIds[i]);
      }
      // revenue: Withdrawn
      const wrc = await (await shop.connect(owner).withdraw(bob.address, PRICE)).wait();
      const w = logOf(wrc, shop, "Withdrawn");
      assert.equal(w.args.to, bob.address);
      assert.equal(w.args.amount, PRICE);
      // refund: PackRefunded
      const b = await buy(carol);
      await mine(300);
      const rrc = await (await shop.connect(stranger).refundExpired(b.packId)).wait();
      const rf = logOf(rrc, shop, "PackRefunded");
      assert.equal(rf.args.buyer, carol.address);
      assert.equal(rf.args.amount, PRICE);
      // admin events
      const fresh = await deployShop({ weights: [0, 5, 0, 0, 0] }); // Mortal has no odds, so its only template may be retired
      const arc = await (await fresh.connect(owner).addTemplates([template(0, 0), template(1, 0)])).wait();
      const added = arc.logs.map((l) => fresh.interface.parseLog(l)).filter((l) => l?.name === "TemplateAdded");
      assert.deepEqual(added.map((e) => [Number(e.args.templateId), Number(e.args.kind), e.args.designHash]), [[0, 0, template(0, 0).design.designHash], [1, 1, template(1, 0).design.designHash]]);
      assert.equal(logOf(await (await fresh.connect(owner).retireTemplate(0)).wait(), fresh, "TemplateRetired").args.templateId, 0n);
      assert.equal(logOf(await (await fresh.connect(owner).setPrice(7)).wait(), fresh, "PriceSet").args.price, 7n);
      assert.equal(logOf(await (await fresh.connect(owner).setDailyLimit(9)).wait(), fresh, "DailyLimitSet").args.limit, 9n);
      assert.deepEqual([...logOf(await (await fresh.connect(owner).setWeights([0, 5, 0, 0, 0])).wait(), fresh, "WeightsSet").args.weights].map(Number), [0, 5, 0, 0, 0]);
    });

    it("blocked: the daily limit is exactly `limit` per UTC calendar day, whatever the block cadence (2x across midnight is by design)", async () => {
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      let midnight = (Math.floor(now / 86400) + 1) * 86400;
      if (midnight - 60 <= now) midnight += 86400;
      await rpc("evm_setNextBlockTimestamp", [midnight - 40]);
      await mine(1);
      for (let i = 0; i < 3; i++) await buy(alice);
      assert.equal(await shop.packsLeftToday(alice.address), 0n);
      await rejects(shop.connect(alice).buyPack({ value: PRICE }), "DailyLimitReached");
      await rpc("evm_setNextBlockTimestamp", [midnight]);
      await mine(1);
      assert.equal(await shop.packsLeftToday(alice.address), 3n, "the new UTC day");
      for (let i = 0; i < 3; i++) await buy(alice);
      await rejects(shop.connect(alice).buyPack({ value: PRICE }), "DailyLimitReached");
      // owner changes: lowering below today's count blocks, raising unblocks
      await (await shop.connect(owner).setDailyLimit(1)).wait();
      assert.equal(await shop.packsLeftToday(alice.address), 0n);
      await (await shop.connect(owner).setDailyLimit(4)).wait();
      assert.equal(await shop.packsLeftToday(alice.address), 1n);
      await buy(alice);
      await rejects(shop.connect(alice).buyPack({ value: PRICE }), "DailyLimitReached");
    });

    it("BUG: [info] recentPacks (newest 16 only) cannot reach an older expired pack: the UI never offers its refund, though phaseOf, packOf and refundExpired still work by id", async () => {
      await (await shop.connect(owner).setDailyLimit(0)).wait();
      for (let i = 0; i < 20; i++) await buy(alice);
      await buy(bob);
      await mine(300);
      const r = await shop.recentPacks(alice.address, 1000);
      assert.equal(r.ids.length, 16);
      assert.deepEqual([...r.ids].map(Number), Array.from({ length: 16 }, (_, i) => i + 5));
      assert.equal(await phase(1), PHASE.Expired, "pack 1 is refundable ...");
      assert.equal(await shop.packCountOf(alice.address), 20n);
      assert.ok(![...r.ids].includes(1n), "... but no view lists it");
      const b0 = await ethers.provider.getBalance(alice.address);
      await (await shop.connect(stranger).refundExpired(1)).wait();
      assert.equal(await ethers.provider.getBalance(alice.address), b0 + PRICE);
    });
  });

  // ==================================================================================== mint path
  describe("mint path and templates", () => {
    /** A valid template for a random Kind, then 0-2 random mutations that each break exactly one rule (or a band). */
    function randTemplate(rng) {
      const r = (n) => Math.floor(rng() * n);
      const p = (a) => a[r(a.length)];
      const kind = r(5);
      const divine = kind === 2 || kind === 4;
      const parts = { head: kind === 3 ? 0 : r(4), facet: kind === 0 ? 0 : r(2), circuit: r(3), bodyType: kind === 3 ? 0 : r(2) };
      const id = (tag) => ethers.id(`${tag}-${r(1e9)}-${r(1e9)}`);
      const stat = () => STAT_MIN[kind] + r(STAT_MAX[kind] - STAT_MIN[kind] + 1);
      const t = {
        kind,
        traits: { faction: r(2), alignment: p([0, 1, 2, 255]), element: r(4), frame: r(4), bodyparts: 0, strength: stat(), agility: stat(), resilience: stat(), intelligence: stat() },
        styleSource: { chainId: r(3), collection: rng() < 0.7 ? ethers.ZeroAddress : ethers.getAddress("0x" + id("c").slice(26)), tokenId: r(1e6) },
        design: {
          designHash: id("d"), art: id("a"), turntable: rng() < 0.5 ? ethers.ZeroHash : id("t"), overridesHash: rng() < 0.5 ? ethers.ZeroHash : id("o"),
          avatar: id("v"), avatarPlain: id("p"), soul: rng() < 0.5 ? ethers.ZeroHash : id("s"), kit: divine ? 1 + r(5) : 0,
          name: p(["Ares", "A", "Number 7", "Ok Name-1.2:3_4, 'q'", "x".repeat(40), "Zed: the 1st. Ok"]), epithet: p(["", "the Bold", "y".repeat(48), "ok, fine: 1-2."]),
        },
      };
      const setParts = () => { t.traits.bodyparts = (parts.head | (parts.facet << 8) | (parts.circuit << 16) | (parts.bodyType << 24)) >>> 0; };
      setParts();
      const zero = ethers.ZeroHash;
      const mutations = [
        () => { t.kind = p([5, 9, 255]); },
        () => { t.kind = (kind + 1 + r(4)) % 5; }, // another valid Kind: stale kit / body parts / band
        () => { t.traits.faction = p([2, 255]); },
        () => { t.traits.alignment = p([3, 4, 254]); },
        () => { t.traits.element = p([4, 255]); },
        () => { t.traits.frame = p([4, 255]); },
        () => { parts.head = p([4, 255]); setParts(); },
        () => { parts.facet = p([2, 255]); setParts(); },
        () => { parts.circuit = p([3, 255]); setParts(); },
        () => { parts.bodyType = p([2, 255]); setParts(); },
        () => { parts.facet = 1; setParts(); }, // a Mortal with a chrome facet (legal for the other Kinds)
        () => { parts.head = 1 + r(3); setParts(); }, // a Titan with a head (legal for the other Kinds)
        () => { parts.bodyType = 1; setParts(); },
        () => { t.design.kit = divine ? p([0, 6, 255]) : p([1, 5, 255]); },
        () => { t.design.designHash = zero; },
        () => { t.design.art = zero; },
        () => { t.design.avatar = zero; },
        () => { t.design.avatarPlain = zero; },
        () => { t.design.name = p(["", "x".repeat(41), 'Ares "the" Bold', "Zo\u00eb", "a\nb", "back\slash", "tab\there", "semi;colon", "wild*card"]); },
        () => { t.design.epithet = p(["y".repeat(49), "semi;colon", 'quote"', "Zo\u00eb"]); },
        () => { t.traits[p(["strength", "agility", "resilience", "intelligence"])] = p([0, 1, STAT_MIN[kind] - 1, STAT_MAX[kind] + 1, 65535]); }, // band only
        () => { t.traits[p(["strength", "agility", "resilience", "intelligence"])] = p([0, 1, STAT_MIN[kind] - 1, STAT_MAX[kind] + 1, 65535]); },
      ];
      const n = rng() < 0.35 ? 0 : rng() < 0.75 ? 1 : 2;
      for (let i = 0; i < n; i++) p(mutations)();
      return t;
    }

    it("blocked: addTemplates mirrors StudioMinter + CardDesign + the stat band exactly (differential fuzz over 500 random templates); no template is accepted here yet refused at mint", async () => {
      const rng = mulberry32(77);
      const fresh = await deployShop();
      const tally = { both: 0, neither: 0, bandGap: 0, otherGap: [], overStrict: [] };
      for (let i = 0; i < 500; i++) {
        const t = randTemplate(rng);
        let a = "ok", b = "ok";
        try { await fresh.connect(owner).addTemplates.staticCall([t]); } catch (e) { a = errName(e); }
        try { await studio.minter.connect(deployer).mintStudio.staticCall({ to: alice.address, ...t }); } catch (e) { b = errName(e); }
        if (a === "ok" && b === "ok") tally.both++;
        else if (a !== "ok" && b !== "ok") tally.neither++;
        else if (a === "ok" && b === "OutOfBand") tally.bandGap++;
        else if (a === "ok") tally.otherGap.push({ b, t });
        else tally.overStrict.push({ a, t });
      }
      console.log(`        differential: ${tally.both} both accept, ${tally.neither} both reject, ${tally.bandGap} accepted here but OutOfBand at mint`);
      assert.equal(tally.otherGap.length, 0, "no template passes addTemplates yet reverts at mint for a non-band reason: " + JSON.stringify(tally.otherGap[0] ?? null));
      assert.equal(tally.overStrict.length, 0, "addTemplates never refuses a template the minter would accept: " + JSON.stringify(tally.overStrict[0] ?? null));
      assert.equal(tally.bandGap, 0, "the stat band is checked at load time (this was the audit's one divergence)");
      assert.ok(tally.both > 100 && tally.neither > 100, "the fuzz reaches both outcomes: " + JSON.stringify({ both: tally.both, neither: tally.neither }));
    });

    it("fixed: addTemplates refuses a template whose stats are outside its Kind's band, so a paid pack can never draw one that RaptureCards would reject", async () => {
      const bad = template(0, 0);
      bad.traits.strength = 1; // Mortal band is [12000, 22000]
      const fresh = await deployShop({ weights: [1, 0, 0, 0, 0] });
      await rejects(studio.minter.connect(deployer).mintStudio.staticCall({ to: alice.address, ...bad }), "OutOfBand"); // the minter itself refuses it
      await rejects(fresh.connect(owner).addTemplates([bad]), "BadTemplate"); // ... and now so does the shop, at load time
      for (const field of ["strength", "agility", "resilience", "intelligence"]) {
        for (const v of [STAT_MIN[0] - 1, STAT_MAX[0] + 1]) {
          const t = template(0, 1);
          t.traits[field] = v;
          await rejects(fresh.connect(owner).addTemplates([t]), "BadTemplate");
        }
      }
      const edge = template(0, 2);
      Object.assign(edge.traits, { strength: STAT_MIN[0], agility: STAT_MAX[0], resilience: STAT_MIN[0], intelligence: STAT_MAX[0] });
      await (await fresh.connect(owner).addTemplates([edge])).wait(); // the band's own edges are legal
      assert.equal(await fresh.templateCount(), 1n);
    });

    it("fixed: retiring a template frees its design hash, so a corrected version of the same design can be loaded", async () => {
      const fresh = await deployShop();
      const t = template(0, 0);
      await (await fresh.connect(owner).addTemplates([t, template(0, 1)])).wait();
      const fixed = structuredClone(t);
      fixed.traits.strength = STAT_MIN[0] + 5; // e.g. the stats or kit were wrong the first time
      await rejects(fresh.connect(owner).addTemplates([fixed]), "DuplicateDesign"); // while the original is live it is still a duplicate
      await (await fresh.connect(owner).retireTemplate(0)).wait();
      assert.equal(await fresh.hasDesign(t.design.designHash), false, "free again after retirement");
      await (await fresh.connect(owner).addTemplates([fixed])).wait();
      assert.equal(await fresh.hasDesign(t.design.designHash), true);
      assert.equal((await fresh.templateOf(2)).traits.strength, BigInt(STAT_MIN[0] + 5));
      await rejects(fresh.connect(owner).addTemplates([fixed]), "DuplicateDesign");
    });

    it("BUG: [info] MAX_TEMPLATES counts retired templates: capacity is never freed, and 4095 is the last usable id", async () => {
      // storage slot 11 is _templates.length (0 owner, 1 pendingOwner+paused, 2 guard, 3 price, 4 limit, 5 weights,
      // 6 nextPackId, 7 liability, 8 _packs, 9 _daily, 10 _packsOf, 11 _templates)
      const fresh = await deployShop({ weights: [1, 0, 0, 0, 0] });
      const fa = await fresh.getAddress();
      await (await fresh.connect(owner).addTemplates([template(0, 0)])).wait();
      assert.equal(BigInt(await ethers.provider.getStorage(fa, 11)), 1n, "storage slot 11 is the template count");
      await rpc("hardhat_setStorageAt", [fa, "0xb", ethers.toBeHex(4093, 32)]);
      assert.equal(await fresh.templateCount(), 4093n);
      await (await fresh.connect(owner).addTemplates([template(0, 1), template(0, 2), template(0, 3)])).wait(); // ids 4093, 4094, 4095
      assert.equal(await fresh.templateCount(), 4096n);
      assert.deepEqual([...(await fresh.activeTemplates(0))].map(Number), [0, 4093, 4094, 4095]);
      await rejects(fresh.connect(owner).addTemplates([template(0, 4)]), "TooManyTemplates");
      await (await fresh.connect(owner).retireTemplate(4093)).wait();
      await (await fresh.connect(owner).retireTemplate(4094)).wait();
      assert.equal((await fresh.activeTemplates(0)).length, 2);
      await rejects(fresh.connect(owner).addTemplates([template(0, 4)]), "TooManyTemplates"); // BUG: retired slots are not reclaimed
      // id 4095 is a normal, drawable template (the uint16 bound holds)
      await (await fresh.connect(owner).retireTemplate(0)).wait();
      await (await fresh.connect(owner).unpause()).wait();
      await grant(fresh);
      const { packId } = await buy(alice, fresh);
      await mine(3);
      assert.deepEqual((await open(packId, alice, fresh)).templateIds, [4095, 4095, 4095, 4095, 4095]);
    });

    it("blocked: no owner sequence can empty a Kind that has odds (the only route to a division by zero): an 80-call random walk that keeps hitting LastOfKind, and a pack sealed before it still opens", async function () {
      this.timeout(600000);
      const rng = mulberry32(99);
      const rnd = (k) => Math.floor(rng() * k);
      const tiny = [0, 1, 2, 3, 4].flatMap((k) => [template(k, 0), template(k, 1)]); // 2 per Kind: LastOfKind is reached constantly
      const fz = await openShop({}, tiny);
      const kindOfId = tiny.map((t) => t.kind);
      const active = [0, 1, 2, 3, 4].map((k) => new Set([2 * k, 2 * k + 1]));
      let weights = [...WEIGHTS], design = 500;
      const hits = { last: 0, notStocked: 0, retired: 0, weights: 0, added: 0 };
      const { packId } = await buy(alice, fz); // a pack sealed BEFORE the owner starts churning the pool
      for (let step = 0; step < 80; step++) {
        const roll = rng();
        if (roll < 0.55) {
          const id = rnd(kindOfId.length);
          const k = kindOfId[id];
          if (!active[k].has(id)) await rejects(fz.connect(owner).retireTemplate(id), "UnknownTemplate");
          else if (active[k].size === 1 && weights[k] > 0) { await rejects(fz.connect(owner).retireTemplate(id), "LastOfKind"); hits.last++; }
          else { await (await fz.connect(owner).retireTemplate(id)).wait(); active[k].delete(id); hits.retired++; }
        } else if (roll < 0.8) {
          const w = Array.from({ length: 5 }, () => (rng() < 0.15 ? 0 : 1 + rnd(50)));
          if (w.every((x) => x === 0)) await rejects(fz.connect(owner).setWeights(w), "BadWeights");
          else if (w.some((x, k) => x > 0 && active[k].size === 0)) { await rejects(fz.connect(owner).setWeights(w), "NotStocked"); hits.notStocked++; }
          else { await (await fz.connect(owner).setWeights(w)).wait(); weights = w; hits.weights++; }
        } else {
          const t = template(rnd(5), design++);
          await (await fz.connect(owner).addTemplates([t])).wait();
          kindOfId.push(t.kind); active[t.kind].add(kindOfId.length - 1); hits.added++;
        }
        const chain = await Promise.all([0, 1, 2, 3, 4].map((k) => fz.activeTemplates(k)));
        chain.forEach((pool, k) => { if (weights[k] > 0) assert.ok(pool.length > 0, `step ${step}: Kind ${k} has odds and an empty pool`); });
        assert.equal(await fz.ready(), true);
      }
      console.log("        pool walk:", JSON.stringify(hits));
      assert.ok(hits.last > 0 && hits.retired > 0 && hits.weights > 0, "the walk really hits the guards");
      await mine(3);
      const { tokenIds } = await open(packId, alice, fz); // the pack sealed before all this churn still opens
      assert.equal(tokenIds.length, 5);
    });

    it("blocked: editions - one template minted ten times gives ten distinct tokens, design records, metadata documents and registry twins; transfers stay independent", async () => {
      const ed = await deployShop({ weights: [0, 0, 0, 1, 0] }); // a single Titan template: every slot is the same design
      await (await ed.connect(owner).addTemplates([template(3, 0)])).wait();
      await (await ed.connect(owner).unpause()).wait();
      await grant(ed);
      const p1 = await buy(alice, ed), p2 = await buy(bob, ed);
      await mine(3);
      const r1 = await open(p1.packId, alice, ed), r2 = await open(p2.packId, bob, ed);
      const ids = [...r1.tokenIds, ...r2.tokenIds];
      assert.equal(new Set(ids.map(String)).size, 10, "ten distinct token ids");
      assert.ok([...r1.templateIds, ...r2.templateIds].every((t) => t === 0), "all the same template");
      const cfgHashes = new Set(), tokenIdsInDocs = new Set();
      for (const id of ids) {
        assert.equal((await studio.design.designOf(id)).designHash, template(3, 0).design.designHash, "same design hash, one record per token");
        const regId = await studio.cards.registryIdOf(id);
        assert.equal(await studio.registry.ownerOf(regId), await studio.cards.getAddress(), "each edition has its own registry twin");
        cfgHashes.add((await studio.registry.manifestOf(regId)).characterConfigHash);
        const doc = JSON.parse(Buffer.from((await studio.cards.tokenURI(id)).split(",")[1], "base64").toString("utf8"));
        assert.equal(doc.name, template(3, 0).design.name);
        assert.equal(doc.rapture.tokenId, id.toString());
        tokenIdsInDocs.add(doc.rapture.tokenId);
      }
      assert.equal(cfgHashes.size, 10, "characterConfigHash differs per token (the JSON carries the token id)");
      assert.equal(tokenIdsInDocs.size, 10);
      assert.equal(await studio.cards.revealedOf(alice.address, studio.setId), 5n);
      assert.equal(await studio.cards.revealedOf(bob.address, studio.setId), 5n);
      // move one edition: the others do not notice
      await (await studio.cards.connect(alice).transferFrom(alice.address, carol.address, r1.tokenIds[0])).wait();
      assert.equal(await studio.cards.revealedOf(alice.address, studio.setId), 4n);
      assert.equal(await studio.cards.revealedOf(carol.address, studio.setId), 1n);
      const twin = await studio.registry.manifestOf(await studio.cards.registryIdOf(r1.tokenIds[0]));
      assert.equal(twin.agentController, carol.address);
      const other = await studio.registry.manifestOf(await studio.cards.registryIdOf(r1.tokenIds[1]));
      assert.equal(other.agentController, alice.address);
    });

    it("BUG: [low] the pool is read at OPEN time: after the reveal hash is public the owner (or a careless owner) can re-roll a sealed pack just by retiring a template, so a previewed pull is not final", async () => {
      const { packId, commitBlock } = await buy(alice);
      await mine(3);
      const h = await revealHash(commitBlock);
      const previewed = await predict(shop, packId, alice.address, h); // what the buyer (or a UI) can compute now
      await (await shop.connect(owner).retireTemplate(previewed[0])).wait(); // legal: its Kind has 10 templates
      const rolled = await predict(shop, packId, alice.address, h);
      assert.notEqual(rolled[0], previewed[0], "slot 0 can no longer be the previewed card");
      assert.deepEqual((await open(packId, alice)).templateIds, rolled, "the preview lied: the pack opened with the re-rolled cards");
    });

    it("BUG: [low] the odds are read at OPEN time too: a pack sealed under 30/25/20/15/10 opens under whatever setWeights says by then (here: five Gods, or by symmetry five Mortals)", async () => {
      const { packId } = await buy(bob);
      await mine(3);
      await (await shop.connect(owner).setWeights([0, 0, 0, 0, 1])).wait();
      const r = await open(packId, bob);
      assert.ok(r.templateIds.every((t) => POOL[t].kind === 4), "odds changed after purchase: every card is a God");
    });
  });

  // ==================================================================================== integration and admin
  describe("integration and admin", () => {
    it("fixed: sales stop while PackShop is not a StudioMinter minter: no money is taken, ready() says so, and a pack sealed earlier stays safe", async () => {
      const sealed = await buy(alice); // bought while the role was held
      await grant(shop, false); // the StudioMinter admin revokes (or never granted) the role
      assert.equal(await studio.minter.minters(shopAddr), false);
      assert.equal(await shop.ready(), false, "ready() now includes the role");
      assert.equal((await shop.config()).ready_, false, "so the page shows the shop as not ready");
      const before = await ethers.provider.getBalance(shopAddr);
      await rejects(shop.connect(bob).buyPack({ value: PRICE }), "NotMinter"); // no money for a pack that cannot open
      assert.equal(await ethers.provider.getBalance(shopAddr), before, "nothing was taken");
      assert.equal(await shop.packsLeftToday(bob.address), 3n, "and no daily-limit slot was spent");
      await mine(3);
      await rejects(shop.connect(alice).openPack(sealed.packId), "NotMinter"); // the earlier pack cannot open yet ...
      assert.equal(await phase(sealed.packId), PHASE.Openable);
      await grant(shop, true); // ... and opens as soon as the role is back
      assert.equal(await shop.ready(), true);
      await open(sealed.packId, alice);
      await buy(bob); // sales resume
    });

    it("fixed: the constructor refuses a minter address with no code, so a typo cannot yield a shop that sells packs it can never open", async () => {
      const f = await ethers.getContractFactory("PackShop");
      // (a failed deployment has no ABI to decode against, so match the custom error's name in the node's message)
      await assert.rejects(f.deploy(alice.address /* an EOA, not a StudioMinter */, owner.address, PRICE, 5, WEIGHTS, 3), /BadMinter/);
      await assert.rejects(f.deploy(ethers.ZeroAddress, owner.address, PRICE, 5, WEIGHTS, 3), /ZeroAddress/);
      // a contract that is not a StudioMinter still deploys (its code is non-empty) but cannot sell: buyPack reverts before taking money
      const other = await f.deploy(await studio.cards.getAddress() /* a contract without minters() */, owner.address, PRICE, 5, WEIGHTS, 3);
      await other.waitForDeployment();
      await stock(other).catch(() => {}); // templates cannot even be validated without bandOf(): loading reverts
      await assert.rejects(other.connect(owner).unpause().then((t) => t.wait()).then(() => other.connect(alice).buyPack({ value: PRICE })));
    });

    it("blocked: the IStudioMinter ABI PackShop calls has the same mintBatch selector and tuple layout as StudioMinter", async () => {
      const mine_ = new ethers.Interface((await hre.artifacts.readArtifact("IStudioMinter")).abi).getFunction("mintBatch");
      const theirs = studio.minter.interface.getFunction("mintBatch");
      assert.equal(mine_.selector, theirs.selector);
      assert.equal(mine_.format("sighash"), theirs.format("sighash"), "identical canonical signature, tuple by tuple");
    });

    it("blocked: pause never blocks open, refund or withdraw, and a paused shop takes no money", async () => {
      const a = await buy(alice), b = await buy(bob);
      await mine(3);
      await (await shop.connect(owner).pause()).wait();
      await rejects(shop.connect(carol).buyPack({ value: PRICE }), "EnforcedPause");
      await open(a.packId, alice);
      await (await shop.connect(owner).withdraw(owner.address, PRICE)).wait(); // pack a is revenue now
      await mine(300);
      await (await shop.connect(stranger).refundExpired(b.packId)).wait();
      assert.equal(await shop.liability(), 0n);
      assert.equal(await ethers.provider.getBalance(shopAddr), 0n);
    });

    it("blocked: the compiled bytecode targets Shanghai (no MCOPY / TSTORE / TLOAD / BLOBHASH / BLOBBASEFEE) and fits EIP-170", async () => {
      const banned = { 0x49: "BLOBHASH", 0x4a: "BLOBBASEFEE", 0x5c: "TLOAD", 0x5d: "TSTORE", 0x5e: "MCOPY" };
      for (const name of ["PackShop", "StudioMinter", "RaptureCards", "CardDesign", "RaptureMetadata", "SetRegistry", "NullIdentity"]) {
        const b = Buffer.from((await hre.artifacts.readArtifact(name)).deployedBytecode.slice(2), "hex");
        const codeEnd = b.length - (b.readUInt16BE(b.length - 2) + 2); // strip the CBOR metadata tail
        for (let i = 0; i < codeEnd;) {
          const op = b[i];
          assert.ok(!banned[op], `${name}: ${banned[op]} at ${i}`);
          i += op >= 0x60 && op <= 0x7f ? 1 + (op - 0x5f) : 1;
        }
        assert.ok(b.length <= 24576, `${name} size ${b.length}`);
      }
    });
  });

  // ==================================================================================== gas
  describe("gas and DoS", () => {
    it("blocked: recentPacks costs the same for a wallet with 60 packs as for one with 1 (only the newest 16 are read)", async () => {
      await (await shop.connect(owner).setDailyLimit(0)).wait();
      for (let i = 0; i < 60; i++) await buy(alice);
      await buy(bob);
      const gas = async (who) => ethers.provider.estimateGas({ to: shopAddr, data: shop.interface.encodeFunctionData("recentPacks", [who, 16]) });
      const big = await gas(alice.address), small = await gas(bob.address);
      console.log(`        recentPacks(16) gas: 60 packs ${big}, 1 pack ${small}`);
      assert.ok(big < 400_000n, `bounded: ${big}`);
      assert.equal((await shop.recentPacks(alice.address, 16)).ids.length, 16);
    });

    it("blocked: retireTemplate on a full-size 4096-entry pool (worst case: the id is last) stays far below the block gas limit", async () => {
      // forged storage: slot 12 is _byKind[0].length, its data starts at keccak256(12), 16 uint16 per slot, element 0 lowest
      const fresh = await deployShop({ weights: [1, 0, 0, 0, 0] });
      const fa = await fresh.getAddress();
      await (await fresh.connect(owner).addTemplates([template(0, 0), template(0, 1)])).wait(); // pool [0, 1]
      assert.equal(BigInt(await ethers.provider.getStorage(fa, 12)), 2n, "slot 12 is _byKind[0].length");
      await rpc("hardhat_setStorageAt", [fa, "0xc", ethers.toBeHex(4096, 32)]);
      const base = BigInt(ethers.keccak256(ethers.toBeHex(12, 32)));
      await rpc("hardhat_setStorageAt", [fa, ethers.toQuantity(base), ethers.toBeHex(0, 32)]); // clear the real [0, 1]: every entry is 0 ...
      await rpc("hardhat_setStorageAt", [fa, ethers.toQuantity(base + 255n), ethers.toBeHex(1n << 240n, 32)]); // ... except the last, template 1
      assert.equal((await fresh.activeTemplates(0)).length, 4096);
      const rc = await (await fresh.connect(owner).retireTemplate(1)).wait();
      console.log(`        retireTemplate on a 4096-entry pool: ${rc.gasUsed.toLocaleString()} gas`);
      assert.ok(rc.gasUsed < 4_000_000n, `gas ${rc.gasUsed}`);
      assert.equal((await fresh.activeTemplates(0)).length, 4095);
    });

    it("blocked: an 8-card pack (the maximum) opens for about 7M gas, far below Nitro's 32M transaction cap; 9 is refused at deploy", async () => {
      const big = await openShop({ size: 8 });
      const { packId, commitBlock } = await buy(alice, big);
      await mine(3);
      const pred = await predict(big, packId, alice.address, await revealHash(commitBlock));
      const { rc, tokenIds, templateIds } = await open(packId, alice, big);
      console.log(`        openPack (8 cards) gas: ${rc.gasUsed.toLocaleString()}`);
      assert.equal(tokenIds.length, 8);
      assert.deepEqual(templateIds, pred, "the immutable packSize drives the draw exactly as the replica says");
      assert.ok(rc.gasUsed < 10_000_000n, `gas ${rc.gasUsed}`);
      await rejects(deployShop({ size: 9 }), "BadPackSize");
      await rejects(deployShop({ size: 0 }), "BadPackSize");
    });
  });
});

const assert = require("node:assert/strict");
const { ethers } = require("hardhat");
const { deployStudio, STAT_MIN, STAT_MAX } = require("./helpers/deployStudio.js");

const PRICE = ethers.parseEther("0.001");
const WEIGHTS = [30, 25, 20, 15, 10]; // Mortal, King, Demigod, Titan, God
const KIND_NAMES = ["Mortal", "King", "Demigod", "Titan", "God"];
const PHASE = { None: 0, Waiting: 1, Openable: 2, Expired: 3, Opened: 4, Refunded: 5 };

// Hardhat names a custom error only when one contract declares it: match the selector too.
async function rejects(promise, error) {
  const selector = ethers.id(`${error}()`).slice(0, 10);
  await assert.rejects(promise, (e) => {
    const msg = String(e.message) + JSON.stringify(e.data ?? "");
    assert.ok(msg.includes(error) || msg.includes(selector), `expected ${error}, got: ${msg.slice(0, 240)}`);
    return true;
  });
}
const mine = (n) => ethers.provider.send("hardhat_mine", ["0x" + n.toString(16)]);
const tick = (seconds) => ethers.provider.send("evm_increaseTime", [seconds]).then(() => mine(1));
const decodeUri = (uri) => JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString("utf8"));

/** A template that satisfies StudioMinter's and CardDesign's rules for its Kind. */
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
      faction: i % 2,
      alignment: [0, 1, 2, 255][i % 4],
      element: i % 4,
      frame: (i >> 1) % 4,
      bodyparts: head | (facet << 8) | (circuit << 16) | (bodyType << 24),
      strength: stat(1), agility: stat(2), resilience: stat(3), intelligence: stat(4),
    },
    styleSource: { chainId: 0, collection: ethers.ZeroAddress, tokenId: 0 },
    design: {
      designHash: ethers.id(`design-${kind}-${i}`),
      art: ethers.id(`art-${kind}-${i}`),
      turntable: ethers.ZeroHash,
      overridesHash: ethers.ZeroHash,
      avatar: ethers.id(`avatar-${kind}-${i}`),
      avatarPlain: ethers.id(`plain-${kind}-${i}`),
      soul: ethers.id(`soul-${kind}-${i}`),
      kit: divine ? 1 + (i % 5) : 0,
      name: `${KIND_NAMES[kind]} Number ${i}`,
      epithet: `the ${KIND_NAMES[kind]}`,
    },
  };
}
const POOL = [0, 1, 2, 3, 4].flatMap((k) => Array.from({ length: 10 }, (_, i) => template(k, i))); // 10 per Kind, like ARC 1

async function deployShop(studio, owner, name = "PackShop", { limit = 3, weights = WEIGHTS } = {}) {
  const f = await ethers.getContractFactory(name);
  const shop = await f.deploy(await studio.minter.getAddress(), owner.address, PRICE, 5, weights, limit);
  await shop.waitForDeployment();
  return shop;
}
async function stock(shop, owner, pool = POOL) {
  for (let i = 0; i < pool.length; i += 10) await (await shop.connect(owner).addTemplates(pool.slice(i, i + 10))).wait();
}

describe("PackShop", function () {
  this.timeout(900000);

  let deployer, owner, alice, bob, stranger;
  let studio, shop, harness;
  let snap;

  before(async () => {
    [deployer, owner, alice, bob, stranger] = await ethers.getSigners();
    studio = await deployStudio(ethers, { minters: [deployer.address] });
    shop = await deployShop(studio, owner);
    harness = await deployShop(studio, owner, "PackShopHarness");
    await stock(shop, owner);
    await stock(harness, owner);
    await (await shop.connect(owner).unpause()).wait();
    // PackShop is a MINTER on the existing StudioMinter: this one call is all the "wiring" the collection needs
    await (await studio.minter.connect(deployer).setMinter(await shop.getAddress(), true)).wait();
  });
  beforeEach(async () => { snap = await ethers.provider.send("evm_snapshot", []); });
  afterEach(async () => { await ethers.provider.send("evm_revert", [snap]); });

  const buy = async (who = alice, s = shop) => {
    const rc = await (await s.connect(who).buyPack({ value: PRICE })).wait();
    const ev = rc.logs.map((l) => s.interface.parseLog(l)).find((l) => l?.name === "PackBought");
    return { packId: ev.args.packId, commitBlock: ev.args.commitBlock, rc };
  };
  const open = async (packId, who = alice, s = shop) => {
    const rc = await (await s.connect(who).openPack(packId)).wait();
    const ev = rc.logs.map((l) => s.interface.parseLog(l)).find((l) => l?.name === "PackOpened");
    return { tokenIds: ev.args.tokenIds, templateIds: ev.args.templateIds.map(Number), rc };
  };

  describe("setup and stocking", () => {
    it("deploys paused, not ready, with the owner and config it was given", async () => {
      const fresh = await deployShop(studio, owner);
      const c = await fresh.config();
      assert.equal(c.paused_, true);
      assert.equal(c.ready_, false);
      assert.equal(c.price_, PRICE);
      assert.equal(c.packSize_, 5n);
      assert.equal(c.dailyLimit_, 3n);
      assert.deepEqual([...c.weights_].map(Number), WEIGHTS);
      assert.equal(await fresh.owner(), owner.address);
    });

    it("refuses a minter address that has no code", async () => {
      const f = await ethers.getContractFactory("PackShop");
      await rejects(f.deploy(alice.address, owner.address, PRICE, 5, WEIGHTS, 3), "BadMinter");
      await rejects(f.deploy(ethers.ZeroAddress, owner.address, PRICE, 5, WEIGHTS, 3), "ZeroAddress");
    });

    it("only the owner loads templates; a paused or unstocked shop cannot sell", async () => {
      const fresh = await deployShop(studio, owner);
      await rejects(fresh.connect(stranger).addTemplates([POOL[0]]), "OwnableUnauthorizedAccount");
      await rejects(fresh.connect(alice).buyPack({ value: PRICE }), "EnforcedPause");
      await (await fresh.connect(owner).unpause()).wait();
      await rejects(fresh.connect(alice).buyPack({ value: PRICE }), "NotStocked");
      await stock(fresh, owner, POOL.slice(0, 40)); // Mortal..Titan, no God yet
      assert.equal(await fresh.ready(), false, "a Kind with odds and no template");
      await rejects(fresh.connect(alice).buyPack({ value: PRICE }), "NotStocked");
      await stock(fresh, owner, POOL.slice(40));
      assert.equal(await fresh.ready(), false, "fully stocked, but PackShop is not a StudioMinter minter yet");
      await rejects(fresh.connect(alice).buyPack({ value: PRICE }), "NotMinter"); // no money for a pack that could not open
      assert.equal(await ethers.provider.getBalance(await fresh.getAddress()), 0n);
      await (await studio.minter.connect(deployer).setMinter(await fresh.getAddress(), true)).wait();
      assert.equal(await fresh.ready(), true);
      assert.equal(await fresh.templateCount(), 50n);
      assert.equal((await fresh.activeTemplates(4)).length, 10);
      await (await fresh.connect(alice).buyPack({ value: PRICE })).wait(); // and now it sells
    });

    it("rejects templates StudioMinter would refuse, so a paid pack can never draw one", async () => {
      const fresh = await deployShop(studio, owner);
      const bad = (mut) => { const t = structuredClone(POOL[0]); mut(t); return t; };
      const cases = {
        "kind out of range": bad((t) => { t.kind = 5; }),
        "faction out of range": bad((t) => { t.traits.faction = 2; }),
        "alignment out of range": bad((t) => { t.traits.alignment = 3; }),
        "Mortal with a chrome facet": bad((t) => { t.traits.bodyparts = 1 << 8; }),
        "head out of range": bad((t) => { t.traits.bodyparts = 4; }),
        "Mortal with a kit": bad((t) => { t.design.kit = 1; }),
        "God without a kit": { ...POOL[40], design: { ...POOL[40].design, kit: 0 } },
        "Titan with a head": { ...POOL[30], traits: { ...POOL[30].traits, bodyparts: 1 } },
        "no art": bad((t) => { t.design.art = ethers.ZeroHash; }),
        "no avatar": bad((t) => { t.design.avatar = ethers.ZeroHash; }),
        "no plain avatar": bad((t) => { t.design.avatarPlain = ethers.ZeroHash; }),
        "no design hash": bad((t) => { t.design.designHash = ethers.ZeroHash; }),
        "empty name": bad((t) => { t.design.name = ""; }),
        "name with a quote character": bad((t) => { t.design.name = 'Ares "the" Bold'; }),
        "name too long": bad((t) => { t.design.name = "x".repeat(41); }),
        "epithet too long": bad((t) => { t.design.epithet = "y".repeat(49); }),
        // RaptureCards refuses stats outside the Kind's band at mint, so the shop refuses them at load
        "strength below the band": bad((t) => { t.traits.strength = STAT_MIN[0] - 1; }),
        "intelligence above the band": bad((t) => { t.traits.intelligence = STAT_MAX[0] + 1; }),
      };
      for (const [label, t] of Object.entries(cases)) {
        await assert.rejects(fresh.connect(owner).addTemplates([t]), (e) => /BadTemplate/.test(String(e.message)) || String(e.message).includes(ethers.id("BadTemplate()").slice(0, 10)), label);
      }
      await fresh.connect(owner).addTemplates([POOL[0]]);
      await rejects(fresh.connect(owner).addTemplates([POOL[0]]), "DuplicateDesign");
    });

    it("cannot retire the last template of a Kind with odds, or give odds to an empty Kind", async () => {
      const fresh = await deployShop(studio, owner, "PackShop", { weights: [30, 25, 20, 15, 0] });
      await stock(fresh, owner, POOL.slice(0, 40));
      await (await fresh.connect(owner).unpause()).wait();
      await rejects(fresh.connect(owner).setWeights(WEIGHTS), "NotStocked"); // God has no template yet
      const titans = [...(await fresh.activeTemplates(3))].map(Number);
      for (const id of titans.slice(0, -1)) await fresh.connect(owner).retireTemplate(id);
      await rejects(fresh.connect(owner).retireTemplate(titans.at(-1)), "LastOfKind");
      await (await fresh.connect(owner).setWeights([30, 25, 20, 0, 0])).wait();
      await (await fresh.connect(owner).retireTemplate(titans.at(-1))).wait(); // Titan has no odds now
      assert.equal((await fresh.activeTemplates(3)).length, 0);
      await (await studio.minter.connect(deployer).setMinter(await fresh.getAddress(), true)).wait();
      assert.equal(await fresh.ready(), true);
    });
  });

  describe("buying", () => {
    it("takes the exact price only, and records a sealed pack", async () => {
      await rejects(shop.connect(alice).buyPack({ value: PRICE - 1n }), "WrongPayment");
      await rejects(shop.connect(alice).buyPack({ value: PRICE + 1n }), "WrongPayment");
      await rejects(shop.connect(alice).buyPack(), "WrongPayment");
      const { packId, commitBlock, rc } = await buy();
      assert.equal(packId, 1n);
      assert.equal(commitBlock, BigInt(rc.blockNumber));
      assert.equal(await shop.liability(), PRICE);
      assert.equal(await ethers.provider.getBalance(await shop.getAddress()), PRICE);
      const p = await shop.packOf(packId);
      assert.equal(p.buyer, alice.address);
      assert.equal(p.phase, BigInt(PHASE.Waiting));
      assert.equal(p.paid, PRICE);
    });

    it("indexes each buyer's packs so a page can resume or refund with one call (no log scan)", async () => {
      assert.equal(await shop.packCountOf(alice.address), 0n);
      let r = await shop.recentPacks(alice.address, 10);
      assert.equal(r.ids.length, 0);
      const a = await buy(alice), b = await buy(bob), c = await buy(alice);
      assert.equal(await shop.packCountOf(alice.address), 2n);
      assert.equal(await shop.packCountOf(bob.address), 1n);
      r = await shop.recentPacks(alice.address, 10);
      assert.deepEqual([...r.ids], [a.packId, c.packId], "oldest first, only alice's");
      // Hardhat mines each transaction as its own block, so by now the first pack (two blocks older) is Openable
      assert.deepEqual([...r.phases].map(Number), [PHASE.Openable, PHASE.Waiting]);
      assert.deepEqual([...r.commitBlocks], [a.commitBlock, c.commitBlock]);
      await mine(3);
      await open(a.packId, alice);
      r = await shop.recentPacks(alice.address, 10);
      assert.deepEqual([...r.phases].map(Number), [PHASE.Opened, PHASE.Openable], "phases are live, per pack");
      await mine(300);
      r = await shop.recentPacks(alice.address, 10);
      assert.deepEqual([...r.phases].map(Number), [PHASE.Opened, PHASE.Expired]);
      r = await shop.recentPacks(alice.address, 1);
      assert.deepEqual([...r.ids], [c.packId], "n counts from the newest");
      assert.equal((await shop.recentPacks(bob.address, 5)).ids.length, 1);
      assert.equal((await shop.recentPacks(stranger.address, 5)).ids.length, 0);
      assert.equal(b.packId, 2n);
    });

    it("recentPacks never returns more than 16", async () => {
      await (await shop.connect(owner).setDailyLimit(0)).wait();
      for (let i = 0; i < 18; i++) await buy();
      const r = await shop.recentPacks(alice.address, 100);
      assert.equal(r.ids.length, 16);
      assert.equal(r.ids.at(-1), 18n);
      assert.equal(r.ids[0], 3n);
    });

    it("limits each wallet per UTC day and resets on the next day", async () => {
      assert.equal(await shop.packsLeftToday(alice.address), 3n);
      for (let i = 0; i < 3; i++) await buy();
      assert.equal(await shop.packsLeftToday(alice.address), 0n);
      await rejects(shop.connect(alice).buyPack({ value: PRICE }), "DailyLimitReached");
      await buy(bob); // another wallet is unaffected
      await tick(86400);
      assert.equal(await shop.packsLeftToday(alice.address), 3n);
      await buy();
      assert.equal(await shop.packsLeftToday(alice.address), 2n);
    });

    it("no limit when the daily limit is 0", async () => {
      await (await shop.connect(owner).setDailyLimit(0)).wait();
      for (let i = 0; i < 5; i++) await buy();
      assert.equal(await shop.packsLeftToday(alice.address), ethers.MaxUint256);
    });

    it("pausing stops sales but never stops opening or refunding sealed packs", async () => {
      const { packId } = await buy();
      await (await shop.connect(owner).pause()).wait();
      await rejects(shop.connect(bob).buyPack({ value: PRICE }), "EnforcedPause");
      await mine(3);
      const { tokenIds } = await open(packId);
      assert.equal(tokenIds.length, 5);
    });
  });

  describe("opening: cards are minted on the buyer's wallet", () => {
    it("is too early until the block after the reveal block exists", async () => {
      // Hardhat mines every transaction in its own block, so a call is evaluated at (latest + 1). On Liteforge many
      // transactions share one block.number and it moves once per ~12 s; the contract rule is the same:
      // block.number must be >= commit + 2.
      const { packId } = await buy();                // mined in block C = commit
      await rejects(shop.connect(alice).openPack(packId), "TooEarly");   // would run in C + 1 = the reveal block itself
      assert.equal((await shop.packOf(packId)).phase, BigInt(PHASE.Waiting));
      await mine(1);                                  // latest = C + 1
      assert.equal((await shop.packOf(packId)).phase, BigInt(PHASE.Openable));   // evaluated at C + 2
      await open(packId);
    });

    it("mints 5 fresh tokens to the buyer, each a real card built from a template", async () => {
      const { packId } = await buy();
      await mine(3);
      const before = await studio.cards.totalSupply();
      const { tokenIds, templateIds, rc } = await open(packId);
      console.log(`        openPack (5 cards) gas: ${rc.gasUsed.toLocaleString()}`);
      assert.equal(tokenIds.length, 5);
      assert.equal(await studio.cards.totalSupply(), before + 5n);
      assert.equal(await studio.cards.balanceOf(alice.address), 5n);
      const base = BigInt(studio.setId) << 32n;
      tokenIds.forEach((id, i) => assert.equal(id, base + BigInt(i), "sequential ids from the drop's counter"));
      for (let i = 0; i < 5; i++) {
        const t = POOL[templateIds[i]];
        const id = tokenIds[i];
        assert.equal(await studio.cards.ownerOf(id), alice.address, "minted, not transferred: it is on the user's wallet");
        const card = await studio.cards.cardOf(id);
        assert.equal(Number(card.kind), t.kind);
        assert.equal(card.revealed, true);
        assert.equal(Number(card.faction), t.traits.faction);
        assert.equal(Number(card.element), t.traits.element);
        assert.equal(Number(card.bodyparts), t.traits.bodyparts);
        const st = await studio.cards.coreStats(id);
        assert.equal(Number(st.strength), t.traits.strength);
        assert.equal(Number(st.intelligence), t.traits.intelligence);
        const doc = decodeUri(await studio.cards.tokenURI(id));
        assert.equal(doc.name, t.design.name);
        assert.equal(doc.rapture.design.hash, t.design.designHash);
        assert.equal((await studio.design.designOf(id)).designHash, t.design.designHash);
      }
      const p = await shop.packOf(packId);
      assert.equal(p.phase, BigInt(PHASE.Opened));
      assert.equal(await shop.liability(), 0n);
    });

    it("cannot be opened twice", async () => {
      const { packId } = await buy();
      await mine(3);
      await open(packId);
      await rejects(shop.connect(alice).openPack(packId), "NotSealed");
      await rejects(shop.connect(alice).openPack(99), "NotSealed");
    });

    it("anyone may open, and the cards still go to the buyer", async () => {
      const { packId } = await buy(alice);
      await mine(3);
      const { tokenIds } = await open(packId, stranger);
      for (const id of tokenIds) assert.equal(await studio.cards.ownerOf(id), alice.address);
      assert.equal(await studio.cards.balanceOf(stranger.address), 0n);
    });

    it("two packs bought together draw differently (the seed binds the pack id)", async () => {
      const a = await buy(alice), b = await buy(alice);
      await mine(3);
      const ra = await open(a.packId), rb = await open(b.packId);
      assert.notDeepEqual(ra.templateIds, rb.templateIds);
    });

    it("an opened pull is fixed: the same pack replayed from a snapshot draws the same cards", async () => {
      const { packId } = await buy();
      await mine(3);
      const s2 = await ethers.provider.send("evm_snapshot", []);
      const first = await open(packId);
      await ethers.provider.send("evm_revert", [s2]);
      const second = await open(packId);
      assert.deepEqual(first.templateIds, second.templateIds);
    });

    it("reverts whole (pack stays sealed) if PackShop loses its minter role, and works once it is back", async () => {
      const { packId } = await buy();
      await mine(3);
      await (await studio.minter.connect(deployer).setMinter(await shop.getAddress(), false)).wait();
      await rejects(shop.connect(alice).openPack(packId), "NotMinter");
      assert.equal((await shop.packOf(packId)).phase, BigInt(PHASE.Openable));
      assert.equal(await shop.liability(), PRICE, "still owed");
      await (await studio.minter.connect(deployer).setMinter(await shop.getAddress(), true)).wait();
      await open(packId);
    });
  });

  describe("odds", () => {
    it("draws Kinds at the testnet weights 30/25/20/15/10 and every template of a Kind evenly", async () => {
      const kinds = [0, 0, 0, 0, 0];
      const per = new Array(50).fill(0);
      const CALLS = 30, N = 100; // 3000 packs = 15000 cards
      for (let c = 0; c < CALLS; c++) {
        const r = await harness.drawStats(c * N, N);
        r.kinds.forEach((v, k) => { kinds[k] += Number(v); });
        r.perTemplate.forEach((v, t) => { per[t] += Number(v); });
      }
      const total = kinds.reduce((a, b) => a + b, 0);
      assert.equal(total, CALLS * N * 5);
      kinds.forEach((n, k) => {
        const got = n / total, want = WEIGHTS[k] / 100;
        assert.ok(Math.abs(got - want) < 0.015, `${KIND_NAMES[k]}: ${(got * 100).toFixed(2)}% vs ${want * 100}%`);
      });
      for (let k = 0; k < 5; k++) {
        const ids = [...(await harness.activeTemplates(k))].map(Number);
        const mean = kinds[k] / ids.length;
        for (const id of ids) assert.ok(Math.abs(per[id] - mean) / mean < 0.2, `template ${id} of ${KIND_NAMES[k]}: ${per[id]} vs mean ${mean.toFixed(0)}`);
      }
      console.log("        kinds:", kinds.map((n, k) => `${KIND_NAMES[k]} ${(100 * n / total).toFixed(1)}%`).join("  "));
    });

    it("odds of 0 exclude a Kind entirely", async () => {
      await (await harness.connect(owner).setWeights([50, 50, 0, 0, 0])).wait();
      const r = await harness.drawStats(0, 100);
      assert.deepEqual([...r.kinds].map(Number), [Number(r.kinds[0]), Number(r.kinds[1]), 0, 0, 0]);
      assert.equal(Number(r.kinds[0]) + Number(r.kinds[1]), 500);
    });
  });

  describe("expiry and refunds", () => {
    it("a pack left unopened past the blockhash window cannot be opened, and is refunded to the buyer", async () => {
      const { packId } = await buy();
      await rejects(shop.connect(alice).refundExpired(packId), "NotExpired");
      await mine(200);
      await rejects(shop.connect(alice).refundExpired(packId), "NotExpired");
      await mine(80);
      assert.equal((await shop.packOf(packId)).phase, BigInt(PHASE.Expired));
      await rejects(shop.connect(alice).openPack(packId), "Expired");
      const before = await ethers.provider.getBalance(alice.address);
      await (await shop.connect(stranger).refundExpired(packId)).wait(); // anyone can trigger; it pays the buyer
      assert.equal(await ethers.provider.getBalance(alice.address), before + PRICE);
      assert.equal(await shop.liability(), 0n);
      assert.equal((await shop.packOf(packId)).phase, BigInt(PHASE.Refunded));
      await rejects(shop.connect(alice).refundExpired(packId), "NotSealed");
      await rejects(shop.connect(alice).openPack(packId), "NotSealed");
    });

    it("refunding right after the purchase is a clean NotExpired, not an arithmetic panic", async () => {
      const { packId } = await buy();
      await rejects(shop.connect(alice).refundExpired(packId), "NotExpired");
      await rejects(shop.connect(alice).refundExpired(12345), "NotSealed");
    });

    it("a refunded pack still counts against the daily limit (no free re-rolls)", async () => {
      for (let i = 0; i < 3; i++) await buy();
      await mine(300);
      for (const id of [1n, 2n, 3n]) await (await shop.refundExpired(id)).wait();
      await rejects(shop.connect(alice).buyPack({ value: PRICE }), "DailyLimitReached");
    });

    it("a hostile buyer cannot re-enter while being refunded", async () => {
      const f = await ethers.getContractFactory("ReentrantBuyer");
      const atk = await f.deploy(await shop.getAddress());
      await atk.waitForDeployment();
      await (await atk.buy({ value: PRICE })).wait();
      await mine(300);
      await (await atk.arm()).wait();
      await (await shop.connect(stranger).refundExpired(await atk.packId())).wait();
      assert.equal(await atk.reenterSucceeded(), false);
      assert.equal(await atk.lastReenterError(), ethers.id("ReentrancyGuardReentrantCall()").slice(0, 10));
      assert.equal(await ethers.provider.getBalance(await atk.getAddress()), PRICE, "refunded exactly once");
      assert.equal(await shop.liability(), 0n);
    });
  });

  describe("money", () => {
    it("the owner withdraws revenue from opened packs, never the price of sealed ones", async () => {
      const a = await buy(alice), b = await buy(bob);
      await mine(3);
      await open(a.packId, alice);
      // one pack opened (revenue = PRICE), one still sealed (owed)
      assert.equal(await shop.liability(), PRICE);
      await rejects(shop.connect(owner).withdraw(owner.address, PRICE + 1n), "Insufficient");
      await rejects(shop.connect(stranger).withdraw(stranger.address, 1n), "OwnableUnauthorizedAccount");
      const before = await ethers.provider.getBalance(stranger.address);
      await (await shop.connect(owner).withdraw(stranger.address, PRICE)).wait();
      assert.equal(await ethers.provider.getBalance(stranger.address), before + PRICE);
      await rejects(shop.connect(owner).withdraw(stranger.address, 1n), "Insufficient");
      await open(b.packId, bob);
      await (await shop.connect(owner).withdraw(stranger.address, PRICE)).wait();
      assert.equal(await ethers.provider.getBalance(await shop.getAddress()), 0n);
    });

    it("price changes apply to new packs only; each pack refunds what it paid", async () => {
      const a = await buy();
      await (await shop.connect(owner).setPrice(PRICE * 2n)).wait();
      await rejects(shop.connect(bob).buyPack({ value: PRICE }), "WrongPayment");
      const b = await (await shop.connect(bob).buyPack({ value: PRICE * 2n })).wait();
      assert.equal(await shop.liability(), PRICE * 3n);
      await mine(300);
      const before = await ethers.provider.getBalance(alice.address);
      await (await shop.refundExpired(a.packId)).wait();
      assert.equal(await ethers.provider.getBalance(alice.address), before + PRICE);
      assert.equal(b.status, 1);
    });

    it("ownership cannot be renounced (it would strand the revenue)", async () => {
      await rejects(shop.connect(owner).renounceOwnership(), "RenounceDisabled");
      assert.equal(await shop.owner(), owner.address);
    });

    it("ownership moves in two steps", async () => {
      await (await shop.connect(owner).transferOwnership(bob.address)).wait();
      assert.equal(await shop.owner(), owner.address);
      await (await shop.connect(bob).acceptOwnership()).wait();
      assert.equal(await shop.owner(), bob.address);
      await rejects(shop.connect(owner).setPrice(1n), "OwnableUnauthorizedAccount");
    });
  });
});

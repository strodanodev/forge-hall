// abi.js against ethers: every hard-coded selector/topic, every encoder byte for byte, every decoder on ethers-made data.
import test from "node:test";
import assert from "node:assert/strict";
import {
  AbiError, SELECTORS, TOPICS, ERROR_SELECTORS, ERROR_STRING, PANIC, isHex, isAddress, hexToBytes, bytesToHex, utf8ToHex,
  toBigInt, toQuantity, fromQuantity, encodeUint, encodeAddress, encodeBool, encodeArgs, encodeCall,
  words, uintAt, addressAt, boolAt, uintArrayAt, decodePackBought, decodePackOpened, decodePackRefunded, decodeRecentPacks,
  decodeRevert, extractRevertData,
} from "../abi.js";
import { ethers, shopIface, otherIfaces, ALICE, BOB, SHOP, revertData } from "./helpers.mjs";

const coder = ethers.AbiCoder.defaultAbiCoder();
// small deterministic PRNG so the "random" cases are the same on every run
const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const randBig = (r, bits) => { let v = 0n; for (let i = 0; i < Math.ceil(bits / 32); i++) v = (v << 32n) | BigInt(Math.floor(r() * 2 ** 32)); return v & ((1n << BigInt(bits)) - 1n); };

test("function selectors equal ethers' for the compiled PackShop ABI", () => {
  for (const [name, selector] of Object.entries(SELECTORS)) {
    assert.equal(selector, shopIface.getFunction(name).selector, name);
  }
  assert.deepEqual(Object.keys(SELECTORS).sort(), ["buyPack", "config", "openPack", "packsLeftToday", "phaseOf", "recentPacks", "refundExpired"]);
  assert.equal(SELECTORS.recentPacks, "0xd3ee9e8d");
  // the views the client leans on really are views, with the argument and result shapes it decodes
  assert.equal(shopIface.getFunction("recentPacks").format("sighash"), "recentPacks(address,uint256)");
  assert.deepEqual(shopIface.getFunction("recentPacks").outputs.map((o) => o.type), ["uint256[]", "uint8[]", "uint256[]"]);
  assert.deepEqual(shopIface.getFunction("recentPacks").outputs.map((o) => o.name), ["ids", "phases", "commitBlocks"]);
  assert.equal(shopIface.getFunction("recentPacks").stateMutability, "view");
});

test("event topic0 values equal ethers' for the compiled PackShop ABI", () => {
  for (const [name, topic] of Object.entries(TOPICS)) {
    assert.equal(topic, shopIface.getEvent(name).topicHash, name);
  }
});

test("error selectors equal ethers' (PackShop, OpenZeppelin, and the card contracts it mints through)", () => {
  const all = [shopIface, ...otherIfaces];
  for (const [name, selector] of Object.entries(ERROR_SELECTORS)) {
    const frag = all.map((i) => i.getError(name)).find(Boolean);
    assert.ok(frag, `${name} is not in any compiled ABI`);
    assert.equal(selector, frag.selector, name);
  }
  // every PackShop-declared custom error a player can trigger is covered
  for (const name of ["TooEarly", "Expired", "NotSealed", "NotExpired", "NotStocked", "WrongPayment", "DailyLimitReached", "TransferFailed", "EnforcedPause"]) {
    assert.ok(ERROR_SELECTORS[name], `${name} missing from ERROR_SELECTORS`);
  }
  assert.equal(ERROR_STRING, ethers.id("Error(string)").slice(0, 10));
  assert.equal(PANIC, ethers.id("Panic(uint256)").slice(0, 10));
});

test("hex helpers round-trip and reject garbage", () => {
  const r = rng(1);
  for (let n = 0; n < 40; n++) {
    const bytes = Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
    const hex = bytesToHex(bytes);
    assert.equal(hex, ethers.hexlify(bytes));
    assert.deepEqual(hexToBytes(hex), bytes);
  }
  assert.equal(bytesToHex(new Uint8Array()), "0x");
  for (const bad of ["", "0x1", "0xzz", "12", 12, null, undefined, "0x 12"]) {
    assert.equal(isHex(bad), false, String(bad));
    assert.throws(() => hexToBytes(bad), AbiError);
  }
  assert.equal(isHex("0x"), true);
  assert.equal(isHex("0xAbCd", 2), true);
  assert.equal(isHex("0xabcd", 3), false);
  assert.equal(isAddress(ALICE), true);
  assert.equal(isAddress(ALICE.toLowerCase()), true);
  assert.equal(isAddress(ALICE.slice(0, 40)), false);
  assert.equal(isAddress("0x" + "g".repeat(40)), false);
  assert.equal(utf8ToHex("héllo ✓ 🔥"), ethers.hexlify(ethers.toUtf8Bytes("héllo ✓ 🔥")));
});

test("quantities: minimal hex both ways, bigint-safe", () => {
  const cases = [[0, "0x0"], [1, "0x1"], [255, "0xff"], [256, "0x100"], [4441, "0x1159"], [(1n << 64n) + 5n, "0x10000000000000005"], [(1n << 256n) - 1n, "0x" + "f".repeat(64)]];
  for (const [n, hex] of cases) {
    assert.equal(toQuantity(n), hex);
    assert.equal(fromQuantity(hex), BigInt(n));
    assert.equal(toQuantity(hex), hex);              // hex strings pass through
    assert.equal(toQuantity(String(BigInt(n))), hex); // and so do decimal strings
    assert.equal(toQuantity(BigInt(n)), hex);
    assert.equal(toQuantity("0x000" + hex.slice(2)), hex, "leading zeros are trimmed");
  }
  assert.equal(toQuantity(4441), ethers.toQuantity(4441));
  for (const bad of [-1, -1n, 1.5, NaN, Infinity, 2 ** 60, "1.5", "-3", "0x", "abc", null, undefined, {}]) {
    assert.throws(() => toQuantity(bad), AbiError, String(bad));
  }
  for (const bad of ["0x", "1", 1, null, "0xzz"]) assert.throws(() => fromQuantity(bad), AbiError, String(bad));
  assert.equal(toBigInt("0007"), 7n);
});

test("encoders: calldata is byte-identical to ethers.Interface.encodeFunctionData", () => {
  assert.equal(encodeCall(SELECTORS.buyPack), shopIface.encodeFunctionData("buyPack"));
  assert.equal(encodeCall(SELECTORS.config), shopIface.encodeFunctionData("config"));
  const r = rng(7);
  const ids = [0n, 1n, 2n, 255n, 256n, 2n ** 32n, 2n ** 53n, 2n ** 64n - 1n, 2n ** 128n, 2n ** 255n, 2n ** 256n - 1n];
  for (let i = 0; i < 40; i++) ids.push(randBig(r, 256), randBig(r, 64), randBig(r, 20));
  for (const id of ids) {
    for (const name of ["openPack", "phaseOf", "refundExpired"]) {
      assert.equal(encodeCall(SELECTORS[name], ["uint256"], [id]), shopIface.encodeFunctionData(name, [id]), `${name}(${id})`);
    }
  }
  // the same integer as bigint / safe number / decimal string / hex string
  const same = ["12345", 12345, 12345n, "0x3039"];
  for (const v of same) assert.equal(encodeCall(SELECTORS.openPack, ["uint256"], [v]), shopIface.encodeFunctionData("openPack", [12345n]));
  // addresses: checksummed, lowercase and uppercase all encode to the same word
  for (const a of [ALICE, ALICE.toLowerCase(), "0x" + ALICE.slice(2).toUpperCase(), BOB, SHOP]) {
    assert.equal(encodeCall(SELECTORS.packsLeftToday, ["address"], [a]), shopIface.encodeFunctionData("packsLeftToday", [ethers.getAddress(a.toLowerCase())]));
  }
  // the per-buyer view: (address, n)
  for (const a of [ALICE, ALICE.toLowerCase(), "0x" + BOB.slice(2).toUpperCase(), SHOP]) {
    const checksummed = ethers.getAddress(a.toLowerCase());
    for (const n of [0, 1, 16, 17, "16", 16n, 2n ** 256n - 1n]) {
      assert.equal(encodeCall(SELECTORS.recentPacks, ["address", "uint256"], [a, n]), shopIface.encodeFunctionData("recentPacks", [checksummed, n]), `recentPacks(${a}, ${n})`);
    }
  }
  // other static types, against ethers' own coder
  assert.equal(encodeArgs(["uint256", "address", "bool", "uint16", "uint8"], [7n, BOB, true, 65535, 255]),
    coder.encode(["uint256", "address", "bool", "uint16", "uint8"], [7n, BOB, true, 65535, 255]).slice(2));
  assert.equal(encodeBool(false), coder.encode(["bool"], [false]).slice(2));
  assert.equal(encodeUint(0), "0".repeat(64));
});

test("encoders refuse what does not fit or is not what it claims", () => {
  assert.throws(() => encodeUint(-1), AbiError);
  assert.throws(() => encodeUint(2n ** 256n), AbiError);
  assert.throws(() => encodeUint(256, 8), AbiError);
  assert.throws(() => encodeUint(65536, 16), AbiError);
  assert.doesNotThrow(() => encodeUint(65535, 16));
  assert.throws(() => encodeUint(1.5), AbiError);
  assert.throws(() => encodeUint(2 ** 53), AbiError, "unsafe integers are refused, not rounded");
  assert.throws(() => encodeUint("banana"), AbiError);
  for (const bad of ["0x1234", ALICE.slice(0, -1), ALICE + "00", "0x" + "z".repeat(40), "", null, 5]) {
    assert.throws(() => encodeAddress(bad), AbiError, String(bad));
  }
  assert.throws(() => encodeBool(1), AbiError);
  assert.throws(() => encodeArgs(["uint256"], []), AbiError);
  assert.throws(() => encodeArgs(["string"], ["x"]), /unsupported type/);
  assert.throws(() => encodeCall("0x1234", [], []), AbiError);
  assert.throws(() => encodeCall("c37b9bcd"), AbiError);
});

test("word decoders read static values", () => {
  const data = coder.encode(["uint256", "address", "bool", "bool"], [2n ** 200n + 3n, BOB, true, false]);
  const ws = words(data);
  assert.equal(ws.length, 4);
  assert.equal(uintAt(ws, 0), 2n ** 200n + 3n);
  assert.equal(addressAt(ws, 1), BOB.toLowerCase());
  assert.equal(boolAt(ws, 2), true);
  assert.equal(boolAt(ws, 3), false);
  assert.throws(() => uintAt(ws, 4), AbiError, "past the end");
  assert.throws(() => uintAt(ws, -1), AbiError);
  assert.throws(() => boolAt(words(coder.encode(["uint256"], [2n])), 0), AbiError, "2 is not a bool");
  assert.throws(() => addressAt(words(coder.encode(["uint256"], [2n ** 160n])), 0), AbiError, "dirty upper bits");
  assert.throws(() => words("0x" + "00".repeat(31)), AbiError, "not a whole number of words");
  assert.throws(() => words("nope"), AbiError);
  assert.deepEqual(words("0x"), []);
});

test("config() result decodes word by word", () => {
  const price = 123456789012345678901n;
  const raw = shopIface.encodeFunctionResult("config", [price, 5, 3, false, true, [50, 28, 15, 5, 2], 12]);
  const ws = words(raw);
  assert.equal(ws.length, 11);
  assert.equal(uintAt(ws, 0), price);
  assert.equal(Number(uintAt(ws, 1)), 5);
  assert.equal(Number(uintAt(ws, 2)), 3);
  assert.equal(boolAt(ws, 3), false);
  assert.equal(boolAt(ws, 4), true);
  assert.deepEqual([5, 6, 7, 8, 9].map((i) => Number(uintAt(ws, i))), [50, 28, 15, 5, 2]);
  assert.equal(Number(uintAt(ws, 10)), 12);
});

const eventLog = (name, args) => ({ address: SHOP.toLowerCase(), ...shopIface.encodeEventLog(shopIface.getEvent(name), args) });

test("PackBought decodes ethers-encoded logs", () => {
  const r = rng(3);
  const cases = [[1n, BOB, 10n ** 17n, 5_000_000n], [0n, ALICE, 0n, 0n], [2n ** 256n - 1n, ALICE, 2n ** 256n - 1n, 2n ** 64n]];
  for (let i = 0; i < 20; i++) cases.push([randBig(r, 256), i % 2 ? ALICE : BOB, randBig(r, 128), randBig(r, 40)]);
  for (const [packId, buyer, paid, commit] of cases) {
    const ev = decodePackBought(eventLog("PackBought", [packId, buyer, paid, commit]));
    assert.deepEqual(ev, { packId, buyer: buyer.toLowerCase(), paid, commitBlock: commit });
  }
});

test("PackRefunded decodes ethers-encoded logs", () => {
  const ev = decodePackRefunded(eventLog("PackRefunded", [42n, ALICE, 10n ** 17n]));
  assert.deepEqual(ev, { packId: 42n, buyer: ALICE.toLowerCase(), amount: 10n ** 17n });
});

test("PackOpened decodes dynamic arrays: empty, one, five (the pack size), eight (the maximum), huge ids", () => {
  const r = rng(11);
  const big = (7n << 32n) + 123n;
  const cases = [
    [[], []],
    [[big], [3]],
    [[1n, 2n, 3n, 4n, 5n], [0, 1, 2, 3, 4]],
    [Array.from({ length: 5 }, (_, i) => big + BigInt(i)), [0, 4095, 65535, 7, 11]],
    [Array.from({ length: 8 }, () => randBig(r, 256)), Array.from({ length: 8 }, () => Math.floor(r() * 65536))],
    [[2n ** 256n - 1n, 0n], [0, 65535]],
  ];
  for (const [tokenIds, templateIds] of cases) {
    const ev = decodePackOpened(eventLog("PackOpened", [9n, BOB, tokenIds, templateIds]));
    assert.equal(ev.packId, 9n);
    assert.equal(ev.buyer, BOB.toLowerCase());
    assert.deepEqual(ev.tokenIds, tokenIds);
    assert.deepEqual(ev.templateIds, templateIds);
    assert.ok(ev.templateIds.every((t) => typeof t === "number"));
  }
});

test("log decoders reject the wrong event, the wrong shape and hostile data", () => {
  const opened = eventLog("PackOpened", [1n, BOB, [1n, 2n], [1, 2]]);
  const bought = eventLog("PackBought", [1n, BOB, 5n, 6n]);
  assert.throws(() => decodePackBought(opened), /not a PackBought/);
  assert.throws(() => decodePackOpened(bought), /not a PackOpened/);
  assert.throws(() => decodePackRefunded(bought), /not a PackRefunded/);
  assert.throws(() => decodePackBought({ ...bought, topics: bought.topics.slice(0, 2) }), AbiError, "missing indexed topic");
  assert.throws(() => decodePackBought({ ...bought, topics: [...bought.topics, bought.topics[1]] }), AbiError, "extra topic");
  assert.throws(() => decodePackBought({ ...bought, data: bought.data.slice(0, -64) }), AbiError, "short data");
  assert.throws(() => decodePackBought({ ...bought, data: "0x" }), AbiError);
  assert.throws(() => decodePackBought({ topics: [], data: "0x" }), AbiError);
  assert.throws(() => decodePackBought(null), AbiError);
  assert.throws(() => decodePackBought({ ...bought, topics: [bought.topics[0], "0x1234", bought.topics[2]] }), AbiError, "malformed topic");

  // hostile PackOpened payloads: every one must throw AbiError (never hang, never a RangeError)
  const head = (a, b) => [a, b].map((n) => n.toString(16).padStart(64, "0")).join("");
  const w = (n) => BigInt(n).toString(16).padStart(64, "0");
  const withData = (hex) => ({ ...opened, data: "0x" + hex });
  assert.throws(() => decodePackOpened(withData(head(0x40, 0x60) + w(0) )), AbiError, "second array missing its length");
  assert.throws(() => decodePackOpened(withData(head(0x41, 0x60) + w(0) + w(0))), AbiError, "misaligned offset");
  assert.throws(() => decodePackOpened(withData(head(2n ** 200n, 0x60) + w(0) + w(0))), AbiError, "offset far past the data");
  assert.throws(() => decodePackOpened(withData(head(0x40, 0x60) + w(2n ** 200n) + w(0))), AbiError, "absurd length");
  assert.throws(() => decodePackOpened(withData(head(0x40, 0x60) + w(5000) + w(0))), AbiError, "length over the cap");
  assert.throws(() => decodePackOpened(withData(head(0x40, 0x80) + w(1) + w(7) + w(2) + w(1))), AbiError, "array runs past the end");
  assert.throws(() => decodePackOpened(withData(head(0x40, 0x80) + w(1) + w(7) + w(1) + w(65536))), AbiError, "uint16 element out of range");
  assert.doesNotThrow(() => decodePackOpened(withData(head(0x40, 0x80) + w(1) + w(7) + w(1) + w(65535))));
});

test("recentPacks() result decodes: empty, one, a few, the full 16, huge values", () => {
  const r = rng(21);
  const enc = (ids, phases, commits) => shopIface.encodeFunctionResult("recentPacks", [ids, phases, commits]);
  const seq = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const cases = [
    [[], [], []],
    [[1n], [1], [5_000_000n]],
    [[4n, 9n, 12n], [4, 2, 1], [100n, 200n, 300n]],
    [seq(16, (i) => BigInt(i + 1)), seq(16, (i) => i % 6), seq(16, (i) => 5_000_000n + BigInt(i) * 7n)],
    [[2n ** 256n - 1n, 0n], [5, 0], [2n ** 256n - 1n, 2n ** 64n]],
    [seq(16, () => randBig(r, 256)), seq(16, () => Math.floor(r() * 6)), seq(16, () => randBig(r, 256))],
    [seq(3, () => randBig(r, 20)), [0, 255, 7], seq(3, () => randBig(r, 40))],       // the decoder bounds phases by width (uint8), not by the enum
  ];
  for (const [ids, phases, commits] of cases) {
    const raw = enc(ids, phases, commits);
    const d = decodeRecentPacks(raw);
    assert.deepEqual(d.ids, ids);
    assert.deepEqual(d.phases, phases);
    assert.deepEqual(d.commitBlocks, commits);
    assert.ok(d.phases.every((p) => typeof p === "number"), "phases are plain numbers");
    assert.ok(d.ids.every((i) => typeof i === "bigint") && d.commitBlocks.every((c) => typeof c === "bigint"));
    const e = shopIface.decodeFunctionResult("recentPacks", raw);                    // and ethers agrees
    assert.deepEqual(d.ids, [...e.ids]);
    assert.deepEqual(d.phases, [...e.phases].map(Number));
    assert.deepEqual(d.commitBlocks, [...e.commitBlocks]);
  }
  // the wire layout it relies on: three offsets, then three length-prefixed arrays
  const raw = enc([7n, 8n], [1, 2], [70n, 80n]);
  const ws = words(raw);
  assert.equal(ws.length, 3 + 3 * 3);
  assert.deepEqual(ws.slice(0, 3).map((w) => Number(BigInt("0x" + w))), [0x60, 0xc0, 0x120]);
  assert.equal(words(enc([], [], [])).length, 6, "empty: three offsets and three zero lengths");
});

test("recentPacks() decoder refuses hostile or broken answers with AbiError", () => {
  const w = (n) => BigInt(n).toString(16).padStart(64, "0");
  const hex = (...ns) => "0x" + ns.map(w).join("");
  const good = shopIface.encodeFunctionResult("recentPacks", [[1n, 2n], [1, 2], [10n, 20n]]);
  assert.doesNotThrow(() => decodeRecentPacks(good));
  for (const [label, data] of Object.entries({
    "no data at all": "0x",
    "not hex": "nope",
    "truncated by one word": good.slice(0, -64),
    "truncated to the head": good.slice(0, 2 + 64 * 3),
    "arrays of different lengths": hex(0x60, 0xc0, 0x120, 2, 1, 2, 1, 1, 2, 2, 5, 6),    // ids 2, phases 1, commits 2
    "phases longer than ids": hex(0x60, 0xa0, 0x120, 1, 1, 2, 1, 2, 3, 1, 5),
    "misaligned offset": hex(0x61, 0xc0, 0x120, 0, 0, 0),
    "offset far past the data": hex(2n ** 200n, 0xc0, 0x120, 0, 0, 0),
    "absurd length": hex(0x60, 0x80, 0xa0, 2n ** 200n, 0, 0),
    "length past the cap": hex(0x60, 0x80, 0xa0, 5000, 0, 0),
    "array runs past the end": hex(0x60, 0x80, 0xa0, 3, 0, 0),
    "phase does not fit a uint8": hex(0x60, 0xa0, 0xe0, 1, 1, 1, 256, 1, 9),
  })) {
    assert.throws(() => decodeRecentPacks(data), AbiError, label);
  }
  assert.throws(() => decodeRecentPacks(shopIface.encodeFunctionResult("recentPacks", [[1n, 2n, 3n, 4n, 5n], [1, 1, 1, 1, 1], [1n, 1n, 1n, 1n, 1n]]), 4), /longer than 4/);
});

test("uintArrayAt honours the length cap and bit width on its own", () => {
  const data = coder.encode(["uint256[]"], [[1n, 2n, 3n]]);          // head offset 0x20, len 3
  assert.deepEqual(uintArrayAt(words(data), 0), [1n, 2n, 3n]);
  assert.throws(() => uintArrayAt(words(data), 0, 256, 2), /longer than 2/);
  assert.throws(() => uintArrayAt(words(data), 0, 1), /does not fit in uint1/);
});

test("decodeRevert: custom errors, Error(string), Panic, unknown, nothing", () => {
  for (const name of Object.keys(ERROR_SELECTORS)) {
    const d = decodeRevert(revertData(name));
    assert.equal(d.name, name);
    assert.equal(d.selector, ERROR_SELECTORS[name]);
  }
  const errorString = (s) => ERROR_STRING + coder.encode(["string"], [s]).slice(2);
  for (const s of ["", "nope", "x".repeat(31), "x".repeat(32), "x".repeat(33), "y".repeat(200), "héllo ✓ 🔥"]) {
    assert.deepEqual(decodeRevert(errorString(s)), { selector: ERROR_STRING, name: "Error", reason: s });
  }
  const panic = decodeRevert(PANIC + coder.encode(["uint256"], [0x11n]).slice(2));
  assert.deepEqual(panic, { selector: PANIC, name: "Panic", code: 0x11n });
  assert.deepEqual(decodeRevert("0xdeadbeef"), { selector: "0xdeadbeef", name: null });
  assert.deepEqual(decodeRevert("0xDEADBEEF" + "00".repeat(32)), { selector: "0xdeadbeef", name: null });
  for (const none of ["0x", "0x1234", "", null, undefined, "nope", 5]) assert.equal(decodeRevert(none), null, String(none));
  // a truncated reason string keeps the name and drops the text instead of throwing
  const cut = errorString("hello world").slice(0, -64);
  assert.deepEqual(decodeRevert(cut), { selector: ERROR_STRING, name: "Error", reason: "" });
  assert.equal(decodeRevert(ERROR_STRING).reason, "");
});

test("extractRevertData finds revert bytes in every error shape a client meets", () => {
  const data = revertData("TooEarly");
  const shapes = {
    "geth / Nitro JSON-RPC error": { code: 3, message: "execution reverted", data },
    "MetaMask (nested data)": { code: -32603, message: "Internal JSON-RPC error.", data: { code: 3, message: "execution reverted", data } },
    "MetaMask (originalError)": { code: -32603, data: { originalError: { code: 3, data } } },
    "Hardhat node": { code: -32603, message: "VM Exception", data: { message: "reverted with custom error", data } },
    "ethers v6 CALL_EXCEPTION": { code: "CALL_EXCEPTION", data, info: { error: { code: 3, data } } },
    "ethers info only": { info: { error: { data } } },
    "wrapped cause": { message: "x", cause: { data } },
  };
  for (const [label, err] of Object.entries(shapes)) assert.equal(extractRevertData(err), data, label);
  assert.equal(extractRevertData(data), data, "a bare hex string");
  for (const none of [null, undefined, {}, { data: "0x" }, { data: "0x1234" }, { data: "not hex" }, { data: { data: 5 } }, 5, "0x12"]) {
    assert.equal(extractRevertData(none), null, JSON.stringify(none));
  }
  const cyclic = { message: "loop" };
  cyclic.cause = cyclic;
  cyclic.error = cyclic;
  assert.equal(extractRevertData(cyclic), null, "cyclic errors terminate");
});

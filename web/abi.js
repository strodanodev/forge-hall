// FORGE — just enough ABI for the PackShop client: hex helpers, static encoders, word/array decoders, the PackShop
// log decoders and revert-data decoding. Dependency-free, and there is no keccak in the browser, so every function
// selector, event topic0 and error selector below is a hard-coded constant. web/test/abi.test.mjs proves each one
// equals ethers' value for the compiled PackShop ABI (and that the encoders/decoders match ethers byte for byte).

export class AbiError extends Error {
  constructor(message) { super(message); this.name = "AbiError"; }
}

// ------------------------------------------------------------------ hex <-> bytes, quantities
/** True for a 0x-prefixed, even-length hex string (optionally of an exact byte length). */
export const isHex = (s, bytes) =>
  typeof s === "string" && s.length % 2 === 0 && /^0x[0-9a-fA-F]*$/.test(s) && (bytes == null || s.length === 2 + bytes * 2);
export const isAddress = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
export function bytesToHex(bytes) {
  let s = "0x";
  for (const b of bytes) s += HEX[b];
  return s;
}
export function hexToBytes(hex) {
  if (!isHex(hex)) throw new AbiError("not a 0x-prefixed, even-length hex string");
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}
/** UTF-8 text -> 0x hex (what personal_sign wants). */
export const utf8ToHex = (text) => bytesToHex(new TextEncoder().encode(text));

/** bigint | safe integer | decimal or 0x string -> bigint. Anything else throws (never silently coerces). */
export function toBigInt(v) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new AbiError(`not a safe integer: ${v}`);
    return BigInt(v);
  }
  if (typeof v === "string" && /^(?:0x[0-9a-fA-F]+|\d+)$/.test(v)) return BigInt(v);
  throw new AbiError(`cannot read ${typeof v === "string" ? JSON.stringify(v) : String(v)} as an integer`);
}
/** JSON-RPC quantity: minimal hex, no leading zeros ("0x0" for zero). */
export function toQuantity(v) {
  const n = toBigInt(v);
  if (n < 0n) throw new AbiError("a quantity cannot be negative");
  return "0x" + n.toString(16);
}
export function fromQuantity(hex) {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) throw new AbiError(`not a hex quantity: ${String(hex)}`);
  return BigInt(hex);
}

// ------------------------------------------------------------------ encoding (static types only)
// Everything PackShop takes is a static word (uint256 / address), so no offsets or padding rules are needed.
export function encodeUint(v, bits = 256) {
  const n = toBigInt(v);
  if (n < 0n || n >= 1n << BigInt(bits)) throw new AbiError(`${String(v)} does not fit in uint${bits}`);
  return n.toString(16).padStart(64, "0");
}
export function encodeAddress(a) {
  if (!isAddress(a)) throw new AbiError(`not an address: ${String(a)}`);
  return a.slice(2).toLowerCase().padStart(64, "0");
}
export function encodeBool(b) {
  if (typeof b !== "boolean") throw new AbiError("not a boolean");
  return (b ? "1" : "0").padStart(64, "0");
}
/** Concatenated ABI words (no 0x). types: "address" | "bool" | "uint<N>" (default uint256). */
export function encodeArgs(types, values) {
  if (types.length !== values.length) throw new AbiError("argument count does not match the type list");
  return types.map((t, i) => {
    if (t === "address") return encodeAddress(values[i]);
    if (t === "bool") return encodeBool(values[i]);
    const m = /^uint(\d*)$/.exec(t);
    if (m) return encodeUint(values[i], m[1] ? Number(m[1]) : 256);
    throw new AbiError(`unsupported type ${t}`);
  }).join("");
}
/** Calldata: 4-byte selector (0x...) + encoded args. */
export function encodeCall(selector, types = [], values = []) {
  if (!isHex(selector, 4)) throw new AbiError("a selector is 4 bytes of 0x hex");
  return selector + encodeArgs(types, values);
}
/** An address as a 32-byte log topic (for eth_getLogs filters on indexed address params). */
export const addressTopic = (a) => "0x" + encodeAddress(a);
export const uintTopic = (v) => "0x" + encodeUint(v);

// ------------------------------------------------------------------ decoding
/** Split ABI data into 32-byte words (64 hex chars each, no 0x). */
export function words(data) {
  if (!isHex(data)) throw new AbiError("malformed ABI data (not hex)");
  const h = data.slice(2);
  if (h.length % 64) throw new AbiError(`malformed ABI data (${h.length / 2} bytes is not a whole number of words)`);
  const out = [];
  for (let i = 0; i < h.length; i += 64) out.push(h.slice(i, i + 64));
  return out;
}
const word = (ws, i) => {
  if (!(i >= 0 && i < ws.length)) throw new AbiError("ABI data is too short");
  return ws[i];
};
export const wordToUint = (w) => BigInt("0x" + w);
export function wordToAddress(w) {
  if (!/^0{24}[0-9a-f]{40}$/i.test(w)) throw new AbiError("malformed address word");
  return "0x" + w.slice(24).toLowerCase();
}
export function wordToBool(w) {
  if (/^0{64}$/.test(w)) return false;
  if (/^0{63}1$/.test(w)) return true;
  throw new AbiError("malformed bool word");
}
/** Static values by word index of a decoded `words()` result. */
export const uintAt = (ws, i) => wordToUint(word(ws, i));
export const addressAt = (ws, i) => wordToAddress(word(ws, i));
export const boolAt = (ws, i) => wordToBool(word(ws, i));

/**
 * A dynamic uint array whose offset sits in head slot `headIndex` (event data and function results put dynamic
 * values behind an offset). Works for uint256[] and uint16[] alike, since ABI pads every element to a full word;
 * `bits` only bounds the values. Returns bigint[]. Bounds are checked, so hostile data cannot make it loop or throw
 * anything but AbiError.
 */
export function uintArrayAt(ws, headIndex, bits = 256, maxLen = 1024) {
  const offset = wordToUint(word(ws, headIndex));
  if (offset % 32n) throw new AbiError("array offset is not word aligned");
  const at = offset / 32n > BigInt(ws.length) ? ws.length : Number(offset / 32n); // clamp: word() then rejects it
  const len = wordToUint(word(ws, at));
  if (len > BigInt(maxLen)) throw new AbiError(`array of ${len} elements is longer than ${maxLen}`);
  const n = Number(len);
  if (at + 1 + n > ws.length) throw new AbiError("array runs past the end of the data");
  const max = (1n << BigInt(bits)) - 1n;
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = wordToUint(ws[at + 1 + i]);
    if (v > max) throw new AbiError(`array element does not fit in uint${bits}`);
    out.push(v);
  }
  return out;
}

// ------------------------------------------------------------------ PackShop constants
// Verified against the compiled ABI by web/test/abi.test.mjs. Function names match the Solidity names.
export const SELECTORS = Object.freeze({
  buyPack: "0xc37b9bcd",          // buyPack()
  openPack: "0x50a88c7e",         // openPack(uint256)
  refundExpired: "0x1402b17a",    // refundExpired(uint256)
  phaseOf: "0x9a243ebf",          // phaseOf(uint256) -> uint8 Phase
  packOf: "0xafac6b21",           // packOf(uint256) -> (buyer, commitBlock, phase, paid)
  config: "0x79502c55",           // config() -> (price, packSize, dailyLimit, paused, ready, weights[5], templateCount)
  packsLeftToday: "0x9d3a3ee5",   // packsLeftToday(address) -> uint256
  recentPacks: "0xd3ee9e8d",      // recentPacks(address,uint256) -> (uint256[] ids, uint8[] phases, uint256[] commitBlocks)
  packCountOf: "0x91675f42",      // packCountOf(address) -> uint256 (every pack the address ever bought)
});
export const TOPICS = Object.freeze({
  PackBought: "0x903fd5359768866b00d366f17280045a07752297ccbb24e26a6e2ebed4f00262",   // (uint256 indexed,address indexed,uint256,uint256)
  PackOpened: "0x30586b2d3dad0c3599ca4232dee054c6422b872e33ef40f0d117c0c35e1f583d",   // (uint256 indexed,address indexed,uint256[],uint16[])
  PackRefunded: "0xc12715bc2bc409ada9f137a81e6d2fd088d140056431b45d123389d03ad4b0bf", // (uint256 indexed,address indexed,uint256)
});
/** Custom errors a player can meet: PackShop's own, OpenZeppelin's Pausable/ReentrancyGuard, and the card
 *  contracts PackShop mints through (a misconfigured minter role or template surfaces as one of those). */
export const ERROR_SELECTORS = Object.freeze({
  // PackShop
  TooEarly: "0x085de625", Expired: "0x203d82d8", NotSealed: "0xc1f31ec9", NotExpired: "0xd0404f85",
  NotStocked: "0x5a0998b5", WrongPayment: "0x788a686f", DailyLimitReached: "0xf402e5b1", TransferFailed: "0x90b8ec18",
  // OpenZeppelin
  EnforcedPause: "0xd93c0665", ReentrancyGuardReentrantCall: "0x3ee5aeb5",
  // StudioMinter / CardDesign / RaptureCards
  NotMinter: "0xf8d2906c", NotRegistered: "0xaba47339", BadTraits: "0x05cc5c09", BadParts: "0x2011b3c6",
  BadKit: "0x36ef3e93", EmptyBatch: "0xc2e5347d", AlreadyWritten: "0xd19dddcd", BadDesign: "0xaa3fa472",
  OutOfBand: "0x8d4ddc34",
});
export const ERROR_STRING = "0x08c379a0";   // Error(string)
export const PANIC = "0x4e487b71";          // Panic(uint256)
const ERROR_NAMES = Object.freeze(Object.fromEntries(Object.entries(ERROR_SELECTORS).map(([n, s]) => [s, n])));

// ------------------------------------------------------------------ PackShop logs
// A log is the raw JSON-RPC object: { topics: [topic0, ...], data }. Indexed params live in the topics.
const topicUint = (t) => {
  if (!isHex(t, 32)) throw new AbiError("malformed topic");
  return BigInt(t);
};
const topicAddress = (t) => {
  if (!isHex(t, 32)) throw new AbiError("malformed topic");
  return wordToAddress(t.slice(2));
};
function check(log, name, indexed) {
  const t = log?.topics;
  if (!Array.isArray(t) || String(t[0]).toLowerCase() !== TOPICS[name] || t.length !== 1 + indexed) {
    throw new AbiError(`not a ${name} log`);
  }
  return words(log.data ?? "0x");
}
/** PackBought(packId indexed, buyer indexed, paid, commitBlock) -> bigints (buyer lowercase address). */
export function decodePackBought(log) {
  const ws = check(log, "PackBought", 2);
  if (ws.length !== 2) throw new AbiError("PackBought data must be two words");
  return { packId: topicUint(log.topics[1]), buyer: topicAddress(log.topics[2]), paid: uintAt(ws, 0), commitBlock: uintAt(ws, 1) };
}
/** PackOpened(packId indexed, buyer indexed, uint256[] tokenIds, uint16[] templateIds). */
export function decodePackOpened(log) {
  const ws = check(log, "PackOpened", 2);
  return {
    packId: topicUint(log.topics[1]),
    buyer: topicAddress(log.topics[2]),
    tokenIds: uintArrayAt(ws, 0, 256),
    templateIds: uintArrayAt(ws, 1, 16).map(Number),
  };
}
/** PackRefunded(packId indexed, buyer indexed, amount). */
export function decodePackRefunded(log) {
  const ws = check(log, "PackRefunded", 2);
  if (ws.length !== 1) throw new AbiError("PackRefunded data must be one word");
  return { packId: topicUint(log.topics[1]), buyer: topicAddress(log.topics[2]), amount: uintAt(ws, 0) };
}

// ------------------------------------------------------------------ PackShop views
/**
 * recentPacks(who, n) result: (uint256[] ids, uint8[] phases, uint256[] commitBlocks), the buyer's newest packs, oldest
 * first. All three arrays are dynamic (three offsets, then three length-prefixed arrays). Returns
 * { ids: bigint[], phases: number[], commitBlocks: bigint[] }, equal lengths or AbiError. maxLen bounds what a hostile
 * answer can make us allocate; the contract itself never returns more than 16.
 */
export function decodeRecentPacks(data, maxLen = 256) {
  const ws = words(data);
  const ids = uintArrayAt(ws, 0, 256, maxLen);
  const phases = uintArrayAt(ws, 1, 8, maxLen).map(Number);
  const commitBlocks = uintArrayAt(ws, 2, 256, maxLen);
  if (phases.length !== ids.length || commitBlocks.length !== ids.length) throw new AbiError("recentPacks arrays differ in length");
  return { ids, phases, commitBlocks };
}

// ------------------------------------------------------------------ reverts
/**
 * Dig revert data (0x + at least a 4-byte selector) out of whatever error shape a JSON-RPC client, MetaMask,
 * Hardhat or ethers produced: geth puts it in error.data; MetaMask nests it (data.originalError.data, data.data);
 * Hardhat nests it under data.data. Returns null when the error carries none.
 */
export function extractRevertData(err, depth = 0) {
  if (err == null || depth > 5) return null;
  if (typeof err === "string") return isHex(err) && err.length >= 10 ? err : null;
  if (typeof err !== "object") return null;
  for (const key of ["data", "originalError", "error", "info", "cause"]) {
    const found = extractRevertData(err[key], depth + 1);
    if (found) return found;
  }
  return null;
}
/**
 * Revert data -> { selector, name, reason?, code? }. name is a known custom error, "Error" (with .reason),
 * "Panic" (with .code, a bigint), or null for a selector we do not know. Returns null when there is no data.
 */
export function decodeRevert(data) {
  if (!isHex(data) || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();
  if (selector === ERROR_STRING) {
    const out = { selector, name: "Error", reason: "" };
    try {
      const ws = words("0x" + data.slice(10));
      const at = Number(wordToUint(word(ws, 0)) / 32n);
      const len = Number(wordToUint(word(ws, at)));
      const hex = ws.slice(at + 1).join("").slice(0, len * 2);
      if (hex.length === len * 2) out.reason = new TextDecoder().decode(hexToBytes("0x" + hex));
    } catch { /* malformed reason string: keep the name, drop the text */ }
    return out;
  }
  if (selector === PANIC) {
    let code = null;
    try { code = uintAt(words("0x" + data.slice(10)), 0); } catch { /* keep null */ }
    return { selector, name: "Panic", code };
  }
  return { selector, name: ERROR_NAMES[selector] ?? null };
}

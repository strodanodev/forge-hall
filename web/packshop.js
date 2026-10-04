// FORGE — PackShop client: read the shop, buy a sealed pack, wait until it can be opened, open it, refund a pack that
// expired, and find a player's packs again after a page reload. Writes and signatures go through wallet.js; every read,
// gas estimate and receipt goes through chain.js (see the note there on why reads bypass the wallet).
//
// Conventions: money is bigint wei; ids that must survive JSON (pack ids, token ids) are decimal strings; every failure
// is a ShopError/WalletError whose .message is fit to show a player and whose .code / .reason a UI can branch on.
//
// LITEFORGE IS ARBITRUM NITRO. The contract's block.number is the parent chain's number (one per ~12 s) while RPC block
// numbers are L2 numbers (~4 per second), so a pack's `commitBlock` (a contract-side number) must never be compared with
// an RPC block number. Readiness therefore always comes from the contract itself (phaseOf / recentPacks), never from
// block arithmetic or log scans (the public RPC also serves eth_getLogs slowly: seconds to tens of seconds).

import {
  SELECTORS, TOPICS, encodeCall, toBigInt, fromQuantity, isAddress, words, uintAt, boolAt,
  decodePackBought, decodePackOpened, decodePackRefunded, decodeRecentPacks, decodeRevert, extractRevertData,
} from "./abi.js";
import { createChain, RpcError, isAbort, sleep } from "./chain.js";
import { LITEFORGE, WalletError } from "./wallet.js";

/** PackShop.Phase, as the contract enumerates it. */
export const PHASE = Object.freeze({ None: 0, Waiting: 1, Openable: 2, Expired: 3, Opened: 4, Refunded: 5 });
export const PHASE_NAMES = Object.freeze(["None", "Waiting", "Openable", "Expired", "Opened", "Refunded"]);

const RECENT_PACKS = 16;                     // recentPacks(who, n) never returns more than 16 (the contract caps n)
// Gas. eth_estimateGas is a simulation against the newest state: on Nitro it also prices the parent-chain data the
// transaction posts, and an openPack mints five cards (~5-10M gas, storage-heavy), so the true cost can drift above the
// estimate by the time the transaction lands. Running out of gas mid-mint burns the fee and leaves the pack unopened, and
// unused gas is refunded, so we bid the estimate + 25% as an explicit limit instead of trusting the wallet's own guess.
const GAS_HEADROOM_PERCENT = 25n;
const BUY_GAS_RESERVE = 600_000n;            // gas units to keep in the wallet for the buy transaction ...
const OPEN_GAS_RESERVE = 12_000_000n;        // ... and for opening the pack afterwards (a player who cannot afford to open is stuck)
const FEE_CAP_FACTOR = 2n;                   // the max fee we pass the wallet (and reserve funds for): 2x the current gas price
const FALLBACK_GAS_PRICE = 1_000_000_000n;   // 1 gwei, used only if eth_gasPrice itself fails

// ------------------------------------------------------------------ errors
/** WalletError plus the shop's own codes: not_configured, low_balance, unavailable (paused / out of stock / daily limit /
 *  price changed), pack_none | pack_waiting | pack_openable | pack_expired | pack_opened | pack_refunded (the pack is not in
 *  a state the action needs; .phase / .phaseName say which), reverted (.reason = custom error name), timeout (.txHash),
 *  aborted, busy, rpc, bad_response. */
export class ShopError extends WalletError {
  constructor(code, message, props = {}) {
    super(code, message, props);
    this.name = "ShopError";
  }
}

const UNAVAILABLE = new Set(["EnforcedPause", "NotStocked", "NotMinter", "DailyLimitReached", "WrongPayment"]);
const CARD_CONTRACT = new Set(["NotMinter", "NotRegistered", "BadTraits", "BadParts", "BadKit", "EmptyBatch", "AlreadyWritten", "BadDesign", "OutOfBand"]);
const ERROR_MESSAGES = {
  TooEarly: "Your pack is not ready to open yet. Give it a few more seconds and try again.",
  Expired: "This pack waited too long to be opened, so it can no longer be drawn. Claim the refund instead.",
  NotSealed: "This pack has already been opened or refunded.",
  NotExpired: "This pack can still be opened, so it cannot be refunded yet.",
  NotStocked: "The shop is being restocked. Try again in a little while.",
  // PackShop refuses to sell without its minting permission (buy time), and StudioMinter refuses to mint without it (open time)
  NotMinter: "The shop cannot mint cards right now: its minting permission is missing. Nothing was charged, and a pack you already bought stays sealed and safe. Please tell the team.",
  WrongPayment: "The pack price just changed. Reload the page and try again.",
  DailyLimitReached: "You have bought your packs for today. Come back after midnight UTC.",
  TransferFailed: "The refund could not be sent to your wallet. Try again in a moment.",
  EnforcedPause: "The shop is paused right now. Try again soon.",
  ReentrancyGuardReentrantCall: "The shop is busy with another request. Try again.",
};
const short = (s, n = 160) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

/** Decoded revert data (abi.js decodeRevert) -> ShopError with a player-facing message and .reason = error name. */
function revertError(decoded, props = {}) {
  const name = decoded?.name ?? null;
  let message;
  if (name && ERROR_MESSAGES[name]) message = ERROR_MESSAGES[name];
  else if (name && CARD_CONTRACT.has(name)) message = `The card contract refused to mint this pack (${name}). Your pack is still sealed. Please tell the team.`;
  else if (name === "Error" && decoded.reason) message = `The contract refused this: ${short(decoded.reason)}`;
  else if (name === "Panic") message = `The contract hit an internal error (panic ${decoded.code != null ? "0x" + decoded.code.toString(16) : "?"}). Nothing was changed. Please tell the team.`;
  else message = `The network says this would fail${decoded?.selector ? ` (${decoded.selector})` : ""}. Nothing was changed.`;
  return new ShopError(UNAVAILABLE.has(name) ? "unavailable" : "reverted", message, { reason: name, selector: decoded?.selector ?? null, ...props });
}

const PHASE_MESSAGES = {
  None: "This pack does not exist.",
  Waiting: "Your pack is not ready yet. Give it a few more seconds.",
  Openable: "This pack is ready to open.",
  Expired: "This pack was not opened in time, so it can no longer be drawn. You can claim a refund.",
  Opened: "This pack has already been opened. Its cards are in your wallet.",
  Refunded: "This pack was already refunded.",
};
const REFUND_MESSAGES = {
  ...PHASE_MESSAGES,
  Waiting: "This pack is still waiting to be opened, so it cannot be refunded yet.",
  Openable: "This pack can still be opened, so it cannot be refunded.",
  Opened: "This pack was opened, so there is nothing to refund.",
};
/** The pack is not in the state an action needs -> ShopError(code "pack_<phase>"). */
function phaseError(phase, messages = PHASE_MESSAGES) {
  const name = PHASE_NAMES[phase] ?? "None";
  return new ShopError(`pack_${name.toLowerCase()}`, messages[name], { phase, phaseName: name });
}

/** chain.js / wallet failures -> what a caller should see. Programming errors pass through unchanged. */
function asShopError(e) {
  if (e instanceof WalletError) return e;
  if (isAbort(e)) return new ShopError("aborted", "Cancelled.", { cause: e });
  if (e instanceof RpcError) {
    const data = extractRevertData(e);
    if (e.isRevert || data) return revertError(decodeRevert(data), { cause: e, data });
    return new ShopError("rpc", `Could not reach the ${LITEFORGE.name} network (${short(e.message, 100)}). Check your connection and try again.`, { cause: e, detail: e.message });
  }
  return e;
}
const stager = (onStage) => (name) => {
  if (typeof onStage !== "function") return;
  try { onStage(name); } catch (e) { console.error("[packshop] onStage callback threw", e); }   // a UI bug must not abort a purchase mid-flight
};

// ------------------------------------------------------------------ config
/**
 * The chain object createWallet() wants, taken from the deploy config (so wallet and shop can never disagree).
 * Only what the config says is used: a local dev chain (explorer/faucet null) gets no explorer link and no faucet hint.
 */
export function chainFromConfig(cfg) {
  const chain = {
    chainId: cfg.chainId,
    name: cfg.chainName || (cfg.chainId === LITEFORGE.chainId ? LITEFORGE.name : cfg.network ? `${cfg.network} (chain ${cfg.chainId})` : `Chain ${cfg.chainId}`),
    nativeCurrency: cfg.currency ?? LITEFORGE.nativeCurrency,
    rpcUrls: [cfg.rpc],
  };
  if (cfg.explorer) chain.explorer = cfg.explorer;
  if (cfg.faucet) chain.faucet = cfg.faucet;
  return chain;
}

function normalizeConfig(j) {
  if (!j || typeof j !== "object" || !isAddress(j.packShop)) {
    throw new ShopError("not_configured", "The pack shop configuration is incomplete (no valid packShop address).");
  }
  const chainId = j.chainId == null ? LITEFORGE.chainId : Number(j.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new ShopError("not_configured", "The pack shop configuration has an invalid chainId.");
  // Liteforge's public endpoints are the defaults for a config that omits them; any other chain must say where it is.
  // An explicit null (a local dev chain has no explorer or faucet) stays null.
  const known = chainId === LITEFORGE.chainId;
  const pick = (v, fallback) => (typeof v === "string" && v ? v : v === null ? null : fallback);
  const rpc = pick(j.rpc, known ? LITEFORGE.rpcUrls[0] : null);
  if (!rpc) throw new ShopError("not_configured", "The pack shop configuration has no rpc url.");
  return {
    ...j,
    chainId,
    rpc,
    explorer: pick(j.explorer, known ? LITEFORGE.explorer : null),
    faucet: pick(j.faucet, known ? LITEFORGE.faucet : null),
    packShop: j.packShop,
    templates: Array.isArray(j.templates) ? j.templates : [],
  };
}

/**
 * Fetch the deploy config { chainId, rpc, explorer, faucet, currency, packShop, cards, templates:[{id, sourceTokenId,
 * designHash}], ... } (what packshop/scripts/write-web-config.mjs writes). Resolves null when the file does not exist
 * (404: the shop has not been deployed); throws ShopError(not_configured) for anything else that is wrong with it
 * (unreachable, other HTTP error, not JSON, no packShop address, no rpc). explorer / faucet are null when absent.
 */
export async function loadShopConfig(url = "./assets/rapture/packshop.json", { fetch: f = globalThis.fetch } = {}) {
  let res;
  try { res = await f(url, { cache: "no-cache" }); }
  catch (e) { throw new ShopError("not_configured", "The pack shop configuration could not be loaded. Check your connection and reload.", { cause: e }); }
  if (res.status === 404) return null;
  if (!res.ok) throw new ShopError("not_configured", `The pack shop configuration could not be loaded (HTTP ${res.status}).`, { status: res.status });
  let j;
  try { j = await res.json(); }
  catch (e) { throw new ShopError("not_configured", "The pack shop configuration is not valid JSON.", { cause: e }); }
  return normalizeConfig(j);
}

/** The read-only RPC client for this config (one per RPC url). `cfg.client` overrides it (tests, custom retry policy). */
const clients = new Map();
export function rpcFor(cfg) {
  if (!cfg || !isAddress(cfg.packShop) || typeof cfg.rpc !== "string") {
    throw new ShopError("not_configured", "The pack shop is not available yet.");
  }
  if (cfg.client) return cfg.client;
  let c = clients.get(cfg.rpc);
  if (!c) { c = createChain(cfg.rpc); clients.set(cfg.rpc, c); }
  return c;
}

// ------------------------------------------------------------------ reads
/** One eth_call to the shop -> the raw return data. Empty data means there is no contract at that address. */
async function readRaw(cfg, selector, types, values, o) {
  let raw;
  try { raw = await rpcFor(cfg).call({ to: cfg.packShop, data: encodeCall(selector, types, values) }, o); }
  catch (e) { throw asShopError(e); }
  if (raw === "0x") {
    throw new ShopError("not_configured", "The pack shop contract was not found on this network. It may not be deployed yet.", { packShop: cfg.packShop });
  }
  return raw;
}
const decoding = (fn) => {
  try { return fn(); }
  catch (e) { throw new ShopError("bad_response", "The network sent back something the shop could not read.", { cause: e }); }
};
const readWords = async (cfg, selector, types, values, o) => {
  const raw = await readRaw(cfg, selector, types, values, o);
  return decoding(() => words(raw));
};

/** Packs the address may still buy today: a number, or Infinity when the shop has no daily limit. */
export async function packsLeftToday(cfg, address, o) {
  const ws = await readWords(cfg, SELECTORS.packsLeftToday, ["address"], [address], o);
  const n = decoding(() => uintAt(ws, 0));
  return n > 0xffffn ? Infinity : Number(n);     // the contract answers uint256.max for "no limit"
}

/**
 * config() decoded: { price (bigint wei), packSize, dailyLimit (0 = none), paused, ready, weights:[5], templateCount }.
 * With an address it also carries packsLeft (see packsLeftToday).
 */
export async function readShop(cfg, address, o) {
  const [ws, packsLeft] = await Promise.all([
    readWords(cfg, SELECTORS.config, [], [], o),
    address ? packsLeftToday(cfg, address, o) : undefined,
  ]);
  const shop = decoding(() => {
    if (ws.length < 11) throw new Error("config() returned too few words");
    return {
      price: uintAt(ws, 0),
      packSize: Number(uintAt(ws, 1)),
      dailyLimit: Number(uintAt(ws, 2)),
      paused: boolAt(ws, 3),
      ready: boolAt(ws, 4),
      weights: [5, 6, 7, 8, 9].map((i) => Number(uintAt(ws, i))),
      templateCount: Number(uintAt(ws, 10)),
    };
  });
  if (packsLeft !== undefined) shop.packsLeft = packsLeft;
  return shop;
}

/** phaseOf(packId) as the PHASE number. Anything unknown to this client is an error, not a guess. */
export async function phaseOf(cfg, packId, o) {
  const ws = await readWords(cfg, SELECTORS.phaseOf, ["uint256"], [packId], o);
  const phase = Number(decoding(() => uintAt(ws, 0)));
  if (!(phase >= 0 && phase < PHASE_NAMES.length)) throw new ShopError("bad_response", `The shop reported an unknown pack state (${phase}).`);
  return phase;
}

// ------------------------------------------------------------------ transactions
// One purchase / open / refund at a time per wallet: a double click must not put two identical prompts in front of the player.
const busy = new WeakSet();
async function exclusive(wallet, fn) {
  if (busy.has(wallet)) throw new ShopError("busy", "Another shop transaction is already in progress. Finish it in your wallet first.");
  busy.add(wallet);
  try { return await fn(); } finally { busy.delete(wallet); }
}

function needWallet(wallet, cfg) {
  rpcFor(cfg);
  if (!wallet?.connected) throw new WalletError("not_connected", "Connect your wallet first.");
  if (wallet.chain && wallet.chain.chainId !== cfg.chainId) {
    throw new ShopError("not_configured", `This wallet is set up for chain ${wallet.chain.chainId} but the shop lives on chain ${cfg.chainId}.`);
  }
}

const bump = (gas) => gas + (gas * GAS_HEADROOM_PERCENT + 99n) / 100n;    // + 25%, rounded up

/** The failed transaction's revert reason: replay it with eth_call (the block before it, then latest) and decode. */
async function explainFailure(chain, tx, from, gas, receipt, txHash) {
  const mined = receipt.blockNumber ? fromQuantity(receipt.blockNumber) : null;
  const tags = [...(mined && mined > 0n ? [mined - 1n] : []), "latest"];   // historic state may be pruned: latest is the fallback
  let lastError;
  for (const tag of tags) {
    try {
      await chain.call({ ...tx, from, blockTag: tag });
    } catch (e) {
      const data = extractRevertData(e);
      if (data) return revertError(decodeRevert(data), { cause: e, data, txHash });
      lastError = e;
    }
  }
  if (receipt.gasUsed && fromQuantity(receipt.gasUsed) >= gas) {
    return new ShopError("reverted", "The transaction ran out of gas. Only the network fee was spent. Please try again.", { reason: "OutOfGas", txHash });
  }
  return new ShopError("reverted", "The transaction failed on the network for a reason the shop could not read. Nothing was changed except the network fee.", { reason: null, txHash, cause: lastError });
}

/**
 * Explicit EIP-1559 fee caps for the wallet, 2x the current gas price. Left to itself a wallet picks its own, and on a
 * chain whose base fee idles at its floor and then drifts ~1% a block (Liteforge / Nitro: 0.01 gwei) some wallets bid
 * EXACTLY the floor, so a transaction signed a moment later is refused: "max fee per gas less than block base fee"
 * (seen live: maxFeePerGas 10000000 vs baseFee 10009000, which broke the second signature of a pack). The cap is only a
 * ceiling, the player still pays the actual base fee, so the extra headroom costs nothing. Returns {} (the wallet
 * decides) when the node cannot even say what gas costs.
 */
async function feeCaps(chain) {
  let gasPrice;
  try { gasPrice = await chain.gasPrice(); }
  catch (e) { console.warn("[packshop] eth_gasPrice failed; leaving the network fee to the wallet", e); return {}; }
  if (gasPrice <= 0n) return {};
  const maxFeePerGas = gasPrice * FEE_CAP_FACTOR;
  let tip = 0n;
  try { tip = await chain.maxPriorityFeePerGas(); }
  catch (e) { /* a node without the method: Nitro takes no tip anyway */ }
  return { maxFeePerGas, maxPriorityFeePerGas: tip < maxFeePerGas ? tip : maxFeePerGas };
}

/** estimate -> +25% -> sign -> wait for the receipt -> fail loudly if it reverted. Stages: signing, pending, confirmed. */
async function transact(wallet, cfg, tx, { onStage, signal, pollMs, timeoutMs } = {}) {
  const chain = rpcFor(cfg);
  const stage = stager(onStage);
  const from = wallet.address;
  let estimate;
  try { estimate = await chain.estimateGas({ from, ...tx }); }
  catch (e) { throw asShopError(e); }     // a revert here is the friendliest place to learn about it: nothing was signed yet
  const gas = bump(estimate);
  const fees = await feeCaps(chain);      // fetched last, right before signing: the closest we can get to the price at send time

  stage("signing");
  const txHash = await wallet.sendTransaction({ ...tx, gas, ...fees });    // WalletError (rejected, pending, wrong chain...) propagates as is

  stage("pending");
  let receipt;
  try { receipt = await chain.waitForReceipt(txHash, { signal, pollMs, timeoutMs }); }
  catch (e) {
    if (isAbort(e)) throw new ShopError("aborted", "Stopped waiting. Your transaction was already sent and may still confirm.", { txHash, cause: e });
    if (e instanceof RpcError && e.timeout) {
      throw new ShopError("timeout", "Your transaction was sent but has not confirmed yet. It may still go through. Check the explorer, then reload this page.", { txHash, cause: e });
    }
    throw asShopError(e);
  }
  if (receipt.status !== "0x1") throw await explainFailure(chain, tx, from, gas, receipt, txHash);
  stage("confirmed");
  return { txHash, receipt };
}

/** The first log of this shop matching an event (and `match`), decoded. */
function findEvent(receipt, cfg, name, decode, match, txHash) {
  const shop = cfg.packShop.toLowerCase();
  let failure;
  for (const log of receipt.logs ?? []) {
    if (String(log.address).toLowerCase() !== shop || String(log.topics?.[0]).toLowerCase() !== TOPICS[name]) continue;
    try {
      const ev = decode(log);
      if (match(ev)) return ev;
    } catch (e) { failure = e; }
  }
  throw new ShopError("bad_response", `The transaction confirmed, but its ${name} event is missing. Reload the page: the pack will show up if it was created.`, { txHash, cause: failure });
}

/** Wallet balance vs price + the gas for buying and (later) opening; throws ShopError(low_balance) with the faucet hint. */
async function requireFunds(wallet, cfg, chain, price) {
  const [balance, gasPrice] = await Promise.all([
    chain.getBalance(wallet.address).catch((e) => { throw asShopError(e); }),
    chain.gasPrice().catch((e) => { console.warn("[packshop] eth_gasPrice failed; assuming 1 gwei", e); return FALLBACK_GAS_PRICE; }),
  ]);
  const fees = (BUY_GAS_RESERVE + OPEN_GAS_RESERVE) * gasPrice * FEE_CAP_FACTOR;
  const need = price + fees;
  if (balance >= need) return;
  const symbol = wallet.chain?.nativeCurrency?.symbol ?? "zkLTC";
  const faucet = wallet.chain?.faucet ?? null;       // only what the chain config names: never another network's faucet
  throw new ShopError("low_balance",
    `Not enough ${symbol}: a pack costs ${formatZkltc(price, 4, "ceil")} and network fees need about ${formatZkltc(fees, 4, "ceil")} more, but your wallet has ${formatZkltc(balance, 4, "floor")}.${faucet ? ` Get free test ${symbol} at ${faucet}` : ""}`,
    { have: balance, need, price, fees, faucet });
}

/**
 * Buy one sealed pack for the shop's price. Resolves { packId (decimal string), txHash, commitBlock } once the
 * transaction is mined. onStage("signing" | "pending" | "confirmed"). Opts: signal (stops the wait, not the
 * transaction), pollMs, timeoutMs. Keep the packId: waitUntilOpenable / openPack take it, and findMyPacks recovers it
 * after a reload.
 */
export async function buyPack(wallet, cfg, opts = {}) {
  needWallet(wallet, cfg);
  return exclusive(wallet, async () => {
    const chain = rpcFor(cfg);
    await wallet.ensureChain();
    const address = wallet.address;
    const [shop, left] = await Promise.all([readShop(cfg), packsLeftToday(cfg, address)]);
    if (shop.paused) throw revertError({ name: "EnforcedPause" });
    if (!shop.ready) throw revertError({ name: "NotStocked" });
    if (left === 0) throw revertError({ name: "DailyLimitReached" });
    await requireFunds(wallet, cfg, chain, shop.price);
    const { txHash, receipt } = await transact(wallet, cfg, { to: cfg.packShop, data: encodeCall(SELECTORS.buyPack), value: shop.price }, opts);
    const ev = findEvent(receipt, cfg, "PackBought", decodePackBought, (e) => e.buyer === address, txHash);
    return { packId: ev.packId.toString(), txHash, commitBlock: Number(ev.commitBlock) };
  });
}

/**
 * Poll phaseOf(packId) every pollMs (default 2000) until the pack is Openable. Resolves { phase, phaseName, waitedMs }.
 * Rejects with ShopError pack_expired | pack_opened | pack_refunded | pack_none when it can never open, "aborted" when
 * `signal` fires. onTick({ attempt, elapsedMs, phase, phaseName, error }) runs after every poll (error is set when that
 * poll failed; up to maxFailures network failures in a row are tolerated so a blip does not lose the wait).
 * The public RPC is load balanced, so right after a purchase one node can still answer "None" for a pack another node
 * just mined: the first noneGrace "None" answers are treated as "not visible yet" rather than "no such pack".
 */
export async function waitUntilOpenable(cfg, packId, { signal, onTick, pollMs = 2000, maxFailures = 5, noneGrace = 5 } = {}) {
  rpcFor(cfg);
  const id = toBigInt(packId);
  const t0 = Date.now();
  let failures = 0;
  let nones = 0;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new ShopError("aborted", "Cancelled.");
    let phase = null;
    let error = null;
    try {
      phase = await phaseOf(cfg, id, { signal });
      failures = 0;
    } catch (e) {
      if (e.code === "aborted" || isAbort(e)) throw new ShopError("aborted", "Cancelled.", { cause: e });
      if (e.code !== "rpc" || ++failures >= maxFailures) throw e;
      error = e;
    }
    if (typeof onTick === "function") {
      try { onTick({ attempt, elapsedMs: Date.now() - t0, phase, phaseName: phase == null ? null : PHASE_NAMES[phase], error }); }
      catch (e) { console.error("[packshop] onTick callback threw", e); }
    }
    if (phase === PHASE.Openable) return { phase, phaseName: "Openable", waitedMs: Date.now() - t0 };
    if (phase !== PHASE.None) nones = 0;
    if (phase === PHASE.None && ++nones > noneGrace) throw phaseError(phase);
    if (phase != null && phase !== PHASE.Waiting && phase !== PHASE.None) throw phaseError(phase);
    try { await sleep(pollMs, signal); }
    catch (e) { throw new ShopError("aborted", "Cancelled.", { cause: e }); }
  }
}

/**
 * Open a sealed pack: the contract draws the cards and mints them to the buyer. Resolves
 * { tokenIds: [decimal string], templateIds: [number], txHash } in the pack's slot order.
 * onStage("signing" | "pending" | "confirmed"); opts as buyPack. Anyone may open anyone's pack; the cards always go to the buyer.
 */
export async function openPack(wallet, cfg, packId, opts = {}) {
  needWallet(wallet, cfg);
  const id = toBigInt(packId);
  return exclusive(wallet, async () => {
    await wallet.ensureChain();
    const phase = await phaseOf(cfg, id);
    if (phase !== PHASE.Openable) throw phaseError(phase);
    const { txHash, receipt } = await transact(wallet, cfg, { to: cfg.packShop, data: encodeCall(SELECTORS.openPack, ["uint256"], [id]) }, opts);
    const ev = findEvent(receipt, cfg, "PackOpened", decodePackOpened, (e) => e.packId === id, txHash);
    return { tokenIds: ev.tokenIds.map(String), templateIds: ev.templateIds, txHash };
  });
}

/** Claim back the price of a pack that was not opened inside the blockhash window. Resolves { txHash, amount (bigint wei) }. */
export async function refundExpired(wallet, cfg, packId, opts = {}) {
  needWallet(wallet, cfg);
  const id = toBigInt(packId);
  return exclusive(wallet, async () => {
    await wallet.ensureChain();
    const phase = await phaseOf(cfg, id);
    if (phase !== PHASE.Expired) throw phaseError(phase, REFUND_MESSAGES);
    const { txHash, receipt } = await transact(wallet, cfg, { to: cfg.packShop, data: encodeCall(SELECTORS.refundExpired, ["uint256"], [id]) }, opts);
    const ev = findEvent(receipt, cfg, "PackRefunded", decodePackRefunded, (e) => e.packId === id, txHash);
    return { txHash, amount: ev.amount };
  });
}

// ------------------------------------------------------------------ resume after a reload
/**
 * The address's most recent packs (at most 16: the contract's cap), oldest first, from ONE eth_call to
 * recentPacks(address, 16): [{ packId (decimal string), phase (PHASE number), phaseName, commitBlock }]. The contract
 * keeps a per-buyer index, so nothing is scanned and no pack is missed inside the 16; filter on phase to find what to
 * resume (Waiting / Openable) or refund (Expired). A buyer with more than 16 packs sees only the newest 16.
 * `o` is passed to the RPC call (e.g. { signal }).
 */
export async function findMyPacks(cfg, address, o) {
  if (!isAddress(address)) throw new TypeError("findMyPacks needs the buyer's 0x address");
  let raw;
  try { raw = await readRaw(cfg, SELECTORS.recentPacks, ["address", "uint256"], [address, RECENT_PACKS], o); }
  catch (e) {
    // A view that reverts with no reason means the function is not there: a shop deployed before the pack index existed.
    if (e.code === "reverted" && e.reason === null) {
      throw new ShopError("not_configured", "This pack shop was deployed before pack lookup existed (it has no recentPacks). Use a newer deployment.", { cause: e, packShop: cfg.packShop });
    }
    throw e;
  }
  const { ids, phases, commitBlocks } = decoding(() => decodeRecentPacks(raw));
  return ids.map((id, i) => {
    const phase = phases[i];
    if (phase >= PHASE_NAMES.length) throw new ShopError("bad_response", `The shop reported an unknown pack state (${phase}).`);
    return { packId: id.toString(), phase, phaseName: PHASE_NAMES[phase], commitBlock: Number(commitBlocks[i]) };
  });
}

// ------------------------------------------------------------------ display
/**
 * Wei -> "0.1235" (up to `digits` decimals, trailing zeros trimmed). mode: "nearest" (default), "floor" (balances: never
 * show more than there is) or "ceil" (prices: never show less than it costs). A non-zero amount that would print as
 * zero prints as "<0.0001" instead.
 */
export function formatZkltc(wei, digits = 4, mode = "nearest") {
  let v = toBigInt(wei);
  const neg = v < 0n;
  if (neg) v = -v;
  const d = Math.min(18, Math.max(0, Math.floor(digits)));
  const scale = 10n ** BigInt(18 - d);
  let q = v / scale;
  const r = v % scale;
  if (mode === "ceil" ? r > 0n : mode === "floor" ? false : r * 2n >= scale) q += 1n;
  const sign = neg ? "-" : "";
  if (q === 0n) return v === 0n ? "0" : `${sign}<${d ? "0." + "0".repeat(d - 1) + "1" : "1"}`;
  const unit = 10n ** BigInt(d);
  const whole = (q / unit).toString();
  const frac = (q % unit).toString().padStart(d, "0").replace(/0+$/, "");
  return `${sign}${whole}${frac ? "." + frac : ""}`;
}

// FORGE — dependency-free EIP-1193 wallet layer for the LitVM Liteforge testnet (MetaMask first).
//
// One createWallet() per page. It finds the wallet (EIP-6963, then window.ethereum), connects only when the player
// asks, remembers that they did so the next page load can restore the session without a popup, keeps address/chain
// state in sync with the wallet's events, and turns every provider failure into a WalletError with a message that is
// fit to show a player. It never touches keys or seed phrases, and the only wallet methods it ever issues are:
// eth_requestAccounts / eth_accounts / eth_chainId / eth_getBalance, wallet_switchEthereumChain,
// wallet_addEthereumChain, wallet_revokePermissions (best effort), personal_sign and eth_sendTransaction.
//
// Safe to import anywhere: nothing runs (and nothing reads window/localStorage) until createWallet() is called.

import { toBigInt, toQuantity, fromQuantity, isHex, isAddress, utf8ToHex, bytesToHex, extractRevertData } from "./abi.js";

/** LitVM Liteforge testnet. NOTE: an Arbitrum Nitro chain, so contracts see the *parent* chain's block.number
 *  (one number per ~12 s) while RPC block numbers are L2 numbers (~4 per second). */
export const LITEFORGE = Object.freeze({
  chainId: 4441,
  chainIdHex: "0x1159",
  name: "LitVM Liteforge",
  nativeCurrency: Object.freeze({ name: "zkLTC", symbol: "zkLTC", decimals: 18 }),
  rpcUrls: Object.freeze(["https://liteforge.rpc.caldera.xyz/http"]),
  explorer: "https://liteforge.explorer.caldera.xyz",
  faucet: "https://liteforge.hub.caldera.xyz",
});

/** Every `code` a WalletError can carry. The first six are the contract with the UI; not_connected and
 *  low_balance are the two extras this layer needs (packshop.js adds its own on ShopError). */
export const WALLET_ERROR_CODES = Object.freeze([
  "user_rejected",    // the player pressed Reject (EIP-1193 4001)
  "request_pending",  // the wallet already has an unanswered request (-32002)
  "wrong_chain",      // the wallet is on another network / has not added this one
  "no_wallet",        // no EIP-1193 provider on this page
  "rpc",              // anything else the provider or its node reported
  "reverted",         // the network says the transaction would fail
  "not_connected",    // an action that needs an account was called before connect()
  "low_balance",      // not enough native token for value + gas
  "fee_too_low",      // the wallet bid a max fee below the chain's current base fee (it moved while signing)
]);

export class WalletError extends Error {
  /** code: one of WALLET_ERROR_CODES (subclasses add more). message: safe to show a player.
   *  props: rpcCode (raw EIP-1193 code), detail (the provider's own message), data (revert bytes), cause, ...extras. */
  constructor(code, message, props = {}) {
    const { cause, ...rest } = props;
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "WalletError";
    this.code = code;
    Object.assign(this, rest);
  }
}

const NO_WALLET = "No browser wallet found. Install MetaMask (https://metamask.io) or open this page in the MetaMask app, then reload.";
const short = (s, n = 180) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

/** Provider failure (any shape) -> WalletError. Already-normalised errors pass through untouched. */
export function normalizeError(e, method = "", chain = LITEFORGE) {
  if (e instanceof WalletError) return e;
  const raw = typeof e === "string" ? e : typeof e?.message === "string" ? e.message : "";
  const rpcCode = typeof e?.code === "number" ? e.code : typeof e?.error?.code === "number" ? e.error.code : null;
  const nestedCode = typeof e?.data?.originalError?.code === "number" ? e.data.originalError.code : null;   // MetaMask mobile / older builds
  const props = { cause: e, rpcCode, detail: raw, data: extractRevertData(e), method };
  const symbol = chain?.nativeCurrency?.symbol ?? "zkLTC";

  if (rpcCode === 4001 || e?.code === "ACTION_REJECTED" || /user (rejected|denied|cancell?ed)|rejected the request|request rejected/i.test(raw)) {
    return new WalletError("user_rejected", "You cancelled the request in your wallet.", props);
  }
  if (rpcCode === -32002 || /already (processing|pending)|request .*already pending/i.test(raw)) {
    return new WalletError("request_pending", "Your wallet already has a request waiting. Open MetaMask, finish or reject it, then try again.", props);
  }
  if (rpcCode === 4100) {
    return new WalletError("not_connected", "Your wallet has not shared an account with this site yet. Press Connect first.", props);
  }
  if (rpcCode === 4902 || nestedCode === 4902 || /unrecognized chain|try adding the chain/i.test(raw)) {
    return new WalletError("wrong_chain", `${chain?.name ?? "This network"} is not in your wallet yet.`, props);
  }
  if (rpcCode === 4900 || rpcCode === 4901) {
    return new WalletError("rpc", "Your wallet lost its connection to the network. Check your internet connection and try again.", props);
  }
  if (rpcCode === 4200 || rpcCode === -32601) {
    return new WalletError("rpc", `Your wallet does not support this action${method ? ` (${method})` : ""}.`, props);
  }
  if (/insufficient funds/i.test(raw)) {
    const hint = chain?.faucet ? ` Get free test ${symbol} at ${chain.faucet}.` : "";
    return new WalletError("low_balance", `Your wallet does not have enough ${symbol} to pay for this.${hint}`, props);
  }
  // e.g. "max fee per gas less than block base fee: ... maxFeePerGas: 10000000 baseFee: 10009000". A chain whose base fee idles
  // at a floor and drifts ~1% a block (Liteforge: 0.01 gwei) refuses a wallet that bid exactly the floor a block ago.
  if (/max fee per gas less than block base fee|fee cap less than block base fee|max fee .* (lower|less) than .*base fee|transaction underpriced|gas price too low/i.test(raw)) {
    return new WalletError("fee_too_low", "The network fee your wallet chose fell just below what the chain charged by the time it was sent. Nothing was charged. Please try again; if it repeats, raise the \"max fee\" in your wallet's fee settings a little.", props);
  }
  if (props.data || /execution reverted|\brevert/i.test(raw)) {
    return new WalletError("reverted", "The network says this transaction would fail, so it was not sent.", props);
  }
  return new WalletError("rpc", raw ? `Your wallet reported an error: ${short(raw)}` : "Your wallet reported an error without saying why. Please try again.", props);
}

// ------------------------------------------------------------------ discovery (EIP-6963, then window.ethereum)
const defaultWindow = () => (typeof window !== "undefined" ? window : undefined);
const METAMASK = "io.metamask";

/** MetaMask first, then the rest in the order they announced. */
function sortProviders(list) {
  return [...list.filter((e) => e.info.rdns === METAMASK), ...list.filter((e) => e.info.rdns !== METAMASK)];
}
/** Pre-EIP-6963 injection: window.ethereum, or its .providers array when several wallets fought over the slot. */
function legacyProviders(win) {
  const eth = win?.ethereum;
  if (!eth) return [];
  const all = Array.isArray(eth.providers) && eth.providers.length ? eth.providers : [eth];
  return all.filter((p) => typeof p?.request === "function").map((p, i) => ({
    info: { uuid: `window.ethereum:${i}`, name: p.isMetaMask ? "MetaMask" : "Browser wallet", icon: "", rdns: p.isMetaMask ? METAMASK : "" },
    provider: p,
  }));
}

/**
 * Ask every installed wallet to announce itself (EIP-6963) and collect the answers for `timeoutMs`.
 * Returns [{ info: { uuid, name, icon, rdns }, provider }], MetaMask first; falls back to window.ethereum when
 * nothing announced. `win` is any EventTarget-like with an optional .ethereum (tests pass a stub).
 */
export function discoverProviders({ win = defaultWindow(), timeoutMs = 300 } = {}) {
  return new Promise((resolve) => {
    if (!win) return resolve([]);
    const found = new Map();
    const onAnnounce = (ev) => {
      const { info, provider } = ev?.detail ?? {};
      if (!info?.uuid || typeof provider?.request !== "function" || found.has(info.uuid)) return;
      found.set(info.uuid, {
        info: { uuid: String(info.uuid), name: String(info.name ?? "Wallet"), icon: String(info.icon ?? ""), rdns: String(info.rdns ?? "") },
        provider,
      });
    };
    win.addEventListener?.("eip6963:announceProvider", onAnnounce);
    try { win.dispatchEvent?.(new Event("eip6963:requestProvider")); }
    catch (e) { console.warn("[wallet] could not ask wallets to announce themselves", e); }
    setTimeout(() => {
      win.removeEventListener?.("eip6963:announceProvider", onAnnounce);
      const list = found.size ? [...found.values()] : legacyProviders(win);
      resolve(sortProviders(list));
    }, timeoutMs);
  });
}

/** Prefer the wallet the player used last (by uuid, then rdns), else MetaMask, else the first one. */
export function pickProvider(list, prefer = {}) {
  return (prefer.uuid && list.find((e) => e.info.uuid === prefer.uuid))
    || (prefer.rdns && list.find((e) => e.info.rdns === prefer.rdns))
    || list.find((e) => e.info.rdns === METAMASK)
    || list[0]
    || null;
}

// ------------------------------------------------------------------ helpers
export function parseChainId(v) {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = /^0x/i.test(v) ? parseInt(v, 16) : parseInt(v, 10);
    if (Number.isInteger(n)) return n;
  }
  return null;
}
const firstAccount = (accounts) => (Array.isArray(accounts) && isAddress(accounts[0]) ? accounts[0].toLowerCase() : null);

function normalizeChain(c) {
  const id = Number(c?.chainId);
  if (!Number.isInteger(id) || id <= 0) throw new TypeError("createWallet needs a chain with a numeric chainId");
  return Object.freeze({
    ...c,
    chainId: id,
    chainIdHex: toQuantity(id),
    name: c.name ?? `Chain ${id}`,
    nativeCurrency: c.nativeCurrency ?? LITEFORGE.nativeCurrency,
    rpcUrls: c.rpcUrls ?? [],
  });
}
/** wallet_addEthereumChain parameters (EIP-3085). */
export function chainParams(chain) {
  const p = {
    chainId: chain.chainIdHex,
    chainName: chain.name,
    nativeCurrency: { ...chain.nativeCurrency },
    rpcUrls: [...chain.rpcUrls],
  };
  if (chain.explorer) p.blockExplorerUrls = [chain.explorer];
  return p;
}

const STORE_KEY = "forge.wallet.v1";
/** localStorage, or null when it is missing or unusable (private mode, sandboxed iframe, Node's stub). */
function defaultStorage() {
  try {
    const s = globalThis.localStorage;
    if (s && typeof s.getItem === "function" && typeof s.setItem === "function" && typeof s.removeItem === "function") return s;
  } catch { /* access itself can throw: treat as no storage */ }
  return null;
}

// ------------------------------------------------------------------ the wallet
/**
 * createWallet({ chain = LITEFORGE, provider, info, storage, win, discoverMs }) -> wallet.
 *   provider  an EIP-1193 provider to use instead of discovering one (tests, or a wallet the UI let the player pick)
 *   storage   localStorage-like ({getItem,setItem,removeItem}) or null to keep nothing; default: localStorage if usable
 *   win       window-like used for discovery (default: window)
 * Discovery starts immediately (when there is a window) so connect() can call the wallet inside the click that asked.
 */
export function createWallet({ chain: chainArg = LITEFORGE, provider = null, info = null, storage, win, discoverMs = 300 } = {}) {
  const chain = normalizeChain(chainArg);
  const store = storage === undefined ? defaultStorage() : storage;
  const w = win ?? defaultWindow();
  const listeners = new Set();
  const inflight = new Map();

  let prov = provider;
  let provInfo = info ?? (provider ? { uuid: "injected", name: provider.isMetaMask ? "MetaMask" : "Wallet", icon: "", rdns: provider.isMetaMask ? METAMASK : "" } : null);
  let bound = null;
  let account = null;
  let chainId = null;
  let wantConnected = false;   // the player asked for a connection in this page (or a previous one) and has not disconnected

  // -- persistence (never throws: a blocked localStorage only costs the auto-restore)
  function recall() {
    try { const raw = store?.getItem(STORE_KEY); return raw ? JSON.parse(raw) : null; }
    catch (e) { console.debug("[wallet] could not read the saved session", e); return null; }
  }
  function remember() {   // which wallet, not which account: enough to reconnect quietly, nothing personal kept
    try { store?.setItem(STORE_KEY, JSON.stringify({ rdns: provInfo?.rdns ?? "", uuid: provInfo?.uuid ?? "" })); }
    catch (e) { console.debug("[wallet] could not save the session", e); }
  }
  function forget() {
    try { store?.removeItem(STORE_KEY); }
    catch (e) { console.debug("[wallet] could not clear the saved session", e); }
  }

  // -- provider discovery
  let ready;
  function discover() {
    return discoverProviders({ win: w, timeoutMs: discoverMs }).then((list) => {
      if (prov) return;
      const pick = pickProvider(list, recall() ?? {});
      if (pick) { prov = pick.provider; provInfo = pick.info; }
    });
  }
  ready = provider || !w ? Promise.resolve() : discover();

  async function needProvider() {
    await ready;
    if (!prov && w) { ready = discover(); await ready; }   // a wallet extension can inject after the first look
    if (!prov) throw new WalletError("no_wallet", NO_WALLET);
    return prov;
  }
  async function call(method, params) {
    const p = await needProvider();
    bind(p);
    try { return await p.request(params === undefined ? { method } : { method, params }); }
    catch (e) { throw normalizeError(e, method, chain); }
  }
  /** Single-flight: a double click must not send a second eth_requestAccounts (MetaMask answers that with -32002). */
  function once(key, fn) {
    if (inflight.has(key)) return inflight.get(key);
    const p = fn().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  // -- state + subscribers
  const snapshot = () => ({ address: account, chainId, connected: account !== null, onCorrectChain: chainId === chain.chainId });
  function emit(kind) {
    const s = snapshot();
    for (const fn of [...listeners]) {
      try { fn(s, kind); } catch (e) { console.error("[wallet] a subscriber threw", e); }
    }
  }
  function subscribe(fn) {
    if (typeof fn !== "function") throw new TypeError("subscribe needs a function");
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  // -- provider events
  const onAccounts = (accounts) => {
    if (!wantConnected) return;           // the player disconnected in this page: an account switch must not reconnect it
    const next = firstAccount(accounts);
    const changed = next !== account;
    account = next;
    if (next) remember();
    if (changed) emit("accountsChanged");
  };
  const onChain = (id) => {
    const next = parseChainId(id);
    if (next === chainId) return;
    chainId = next;
    emit("chainChanged");
  };
  const onProviderDisconnect = () => {     // EIP-1193: the provider can no longer reach any chain
    account = null;
    chainId = null;
    emit("providerDisconnect");
  };
  const onProviderConnect = (e) => {
    if (e?.chainId != null) chainId = parseChainId(e.chainId);
    // re-read the account through onAccounts: it re-checks wantConnected when the answer lands (a disconnect made
    // meanwhile stays a disconnect) and only announces a change
    if (wantConnected) call("eth_accounts").then(onAccounts).catch((err) => console.warn("[wallet] could not refresh accounts after reconnect", err));
    emit("providerConnect");
  };
  function bind(p) {
    if (bound === p) return;
    unbind();
    bound = p;
    if (typeof p.on === "function") {
      p.on("accountsChanged", onAccounts);
      p.on("chainChanged", onChain);
      p.on("disconnect", onProviderDisconnect);
      p.on("connect", onProviderConnect);
    }
  }
  function unbind() {
    const p = bound;
    bound = null;
    if (!p) return;
    const off = typeof p.removeListener === "function" ? p.removeListener.bind(p) : typeof p.off === "function" ? p.off.bind(p) : null;
    if (!off) return;
    off("accountsChanged", onAccounts);
    off("chainChanged", onChain);
    off("disconnect", onProviderDisconnect);
    off("connect", onProviderConnect);
  }

  // -- actions
  /** Ask for an account. Call it from a click: it opens the wallet's approval popup. Resolves the lowercase address. */
  const connect = () => once("connect", async () => {
    const accounts = await call("eth_requestAccounts");
    const acct = firstAccount(accounts);
    if (!acct) throw new WalletError("rpc", "Your wallet did not share an account. Unlock it, pick an account and try again.");
    wantConnected = true;
    account = acct;
    chainId = parseChainId(await call("eth_chainId"));
    remember();
    emit("connect");
    return account;
  });

  /** Page-load reconnect without a popup: only if the player connected before (and did not disconnect), and only
   *  if the wallet still lists an account for this site. Resolves the address or null. force skips the "before" check. */
  const restore = ({ force = false } = {}) => once("restore", async () => {
    const saved = recall();
    if (!saved && !force) return null;
    try { await needProvider(); } catch (e) { if (e.code === "no_wallet") return null; throw e; }
    const acct = firstAccount(await call("eth_accounts"));
    if (!acct) {
      // Locked, or the site was disconnected inside the wallet. A returning player still wants to be connected, so
      // follow the wallet's accountsChanged once it unlocks / reconnects instead of waiting for a click.
      if (saved) wantConnected = true;
      return null;
    }
    wantConnected = true;
    account = acct;
    chainId = parseChainId(await call("eth_chainId"));
    remember();
    emit("restore");
    return account;
  });

  /** Forget the session here. MetaMask cannot be disconnected from a page, so also ask it to revoke the permission. */
  async function disconnect() {
    const had = account !== null;
    wantConnected = false;
    account = null;
    forget();
    if (had) emit("disconnect");
    if (!prov) return;
    try { await prov.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }); }
    catch (e) { console.debug("[wallet] wallet_revokePermissions is not available here; the session was forgotten locally", e?.message ?? e); }
  }

  /** Make the wallet use this chain: switch, or add it first when the wallet has never seen it. Call from a click. */
  const ensureChain = () => once("ensureChain", async () => {
    let current = parseChainId(await call("eth_chainId"));
    if (current !== chain.chainId) {
      try {
        await call("wallet_switchEthereumChain", [{ chainId: chain.chainIdHex }]);
      } catch (e) {
        // 4902 is the standard "unknown chain"; some MetaMask builds send -32603 "Unrecognized chain ID" instead.
        if (e.code !== "wrong_chain") throw e;
        await call("wallet_addEthereumChain", [chainParams(chain)]);
        await call("wallet_switchEthereumChain", [{ chainId: chain.chainIdHex }]);
      }
      current = parseChainId(await call("eth_chainId"));   // do not trust the event alone; some wallets answer before it fires
    }
    if (current !== chainId) { chainId = current; emit("chainChanged"); }
    if (current !== chain.chainId) {
      throw new WalletError("wrong_chain", `Your wallet is on a different network. Switch to ${chain.name} (chain ${chain.chainId}) and try again.`, { expected: chain.chainId, actual: current });
    }
    return true;
  });

  const needAccount = () => {
    if (!account) throw new WalletError("not_connected", "Connect your wallet first.");
    return account;
  };

  /** eth_sendTransaction from the connected account. value/gas: bigint | number | decimal or 0x string. Resolves the hash. */
  async function sendTransaction({ to, data = "0x", value, gas, maxFeePerGas, maxPriorityFeePerGas } = {}) {
    const from = needAccount();
    if (!isAddress(to)) throw new TypeError("sendTransaction needs a 0x address in `to`");
    if (!isHex(data)) throw new TypeError("sendTransaction `data` must be 0x hex");
    // A transaction that lands on the wrong network would pay this address *there* (usually nobody). Cached state can
    // be stale, so ask the wallet right now.
    const now = parseChainId(await call("eth_chainId"));
    if (now !== chainId) { chainId = now; emit("chainChanged"); }
    if (now !== chain.chainId) {
      throw new WalletError("wrong_chain", `Your wallet is on a different network. Switch to ${chain.name} (chain ${chain.chainId}) before sending.`, { expected: chain.chainId, actual: now });
    }
    const tx = { from, to, data };
    if (value != null && toBigInt(value) !== 0n) tx.value = toQuantity(value);
    if (gas != null) tx.gas = toQuantity(gas);
    // EIP-1559 caps are optional: given, the wallet must not bid below them (see packshop.js feeCaps); omitted, it decides
    if (maxFeePerGas != null) tx.maxFeePerGas = toQuantity(maxFeePerGas);
    if (maxPriorityFeePerGas != null) tx.maxPriorityFeePerGas = toQuantity(maxPriorityFeePerGas);
    const hash = await call("eth_sendTransaction", [tx]);
    if (!isHex(hash, 32)) throw new WalletError("rpc", "Your wallet did not return a transaction hash.", { detail: String(hash) });
    return hash;
  }

  /** personal_sign of a UTF-8 message (or bytes). The wallet takes [hexMessage, address]. Resolves the 0x signature. */
  async function personalSign(message) {
    const from = needAccount();
    let hex;
    if (typeof message === "string") hex = utf8ToHex(message);
    else if (message instanceof Uint8Array) hex = bytesToHex(message);
    else throw new TypeError("personalSign needs a string or Uint8Array");
    const sig = await call("personal_sign", [hex, from]);
    if (!isHex(sig) || sig.length <= 2) throw new WalletError("rpc", "Your wallet returned an unreadable signature.", { detail: String(sig) });
    return sig;
  }

  /** The connected account's native balance in wei (bigint), as the wallet sees it. */
  async function balance() {
    return fromQuantity(await call("eth_getBalance", [needAccount(), "latest"]));
  }

  return {
    get address() { return account; },
    get chainId() { return chainId; },
    get connected() { return account !== null; },
    get onCorrectChain() { return chainId === chain.chainId; },
    get chain() { return chain; },
    /** { uuid, name, icon, rdns } of the wallet in use, or null until one is found. */
    get info() { return provInfo; },
    /** Resolves when wallet discovery has finished. */
    get ready() { return ready; },
    snapshot,
    subscribe,
    connect,
    restore,
    disconnect,
    ensureChain,
    sendTransaction,
    personalSign,
    balance,
  };
}

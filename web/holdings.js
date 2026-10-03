// FORGE — what a wallet holds of a Rapture collection, and which card each token is. No DOM: library.js draws it.
//
// The collection is an ERC-721 that is NOT enumerable, and a pack mints NEW tokens (editions) from a template, so a
// player's cards are token ids the snapshot has never seen. Three sources are combined, and the chain has the last word:
//
//   explorer   Blockscout's holder-filtered instance list: fast and complete for a settled wallet, but the index lags a
//              fresh deployment (it listed 35 of the 50 tokens an address really held), so it is a hint, never the truth
//   remembered token ids this browser saw minted (pack opens) or read before: instant paint, verified before trusted
//   chain      balanceOf(wallet) is the authoritative COUNT. If the other sources agree with it we are done after one call.
//              More than it: some are stale, so each is checked with ownerOf. Fewer: an ownerOf scan of the set's
//              ids (newest first, stopping the moment the count is met) finds the ones the explorer missed
//
// Reads use the public RPC directly (chain.js), like the shop: they need no wallet and answer for the right chain.

import { createChain, isAbort, AbortError } from "./chain.js";
import { encodeCall, isAddress, isHex, hexToBytes, bytesToHex, words, uintAt, addressAt } from "./abi.js";

// ERC-721 selectors (no keccak in the browser: constants, checked against the deployed contract)
const SEL = { ownerOf: "0x6352211e", balanceOf: "0x70a08231", totalSupply: "0x18160ddd", tokenURI: "0xc87b56dd" };
const EXPLORER_PAGES = 40;          // x50 items: far more than a testnet wallet will ever hold
const EXPLORER_TIMEOUT_MS = 8000;
const SCAN_LIMIT = 1500;            // ownerOf calls one deep read may spend looking for tokens the explorer missed
const URI_LIMIT = 256 * 1024;       // a tokenURI bigger than this is not a card
const RPC_CONCURRENCY = 8;

const norm = (a) => String(a).toLowerCase();
const byId = (a, b) => { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; };

// ------------------------------------------------------------------ pure helpers (exported for the tests)
/** The snapshot's slug for a card name (scripts/rapture_snapshot.mjs uses the same rule). */
export const slugOf = (name) => String(name ?? "").toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** A token id's position in its set (id = setId << 32 | serial), 0-based. */
export const serialOf = (tokenId) => Number(BigInt(tokenId) & 0xffffffffn);

/** The ABI-encoded `string` an eth_call returns -> JS string. Bounds are checked: hostile data throws, never loops. */
export function decodeAbiString(hex) {
  const b = hexToBytes(hex);
  const word = (at) => {
    if (at < 0 || at + 32 > b.length) throw new Error("ABI string is truncated");
    return BigInt(bytesToHex(b.subarray(at, at + 32)));
  };
  const offset = word(0);
  if (offset > BigInt(b.length)) throw new Error("ABI string offset is out of range");
  const at = Number(offset);
  const len = word(at);
  if (len > BigInt(URI_LIMIT) || at + 32 + Number(len) > b.length) throw new Error("ABI string length is out of range");
  return new TextDecoder().decode(b.subarray(at + 32, at + 32 + Number(len)));
}

/** A `data:application/json` tokenURI -> its JSON, or null when it is anything else (an ipfs:// or https:// pointer). */
export function parseTokenUri(uri) {
  // data:application/json[;charset=..|;utf8][;base64],<payload>
  const m = /^data:application\/json((?:;[^;,]*)*),([\s\S]*)$/.exec(String(uri));
  if (!m) return null;
  let text;
  if (/;base64$/i.test(m[1])) {
    text = new TextDecoder().decode(Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)));
  } else {
    try { text = decodeURIComponent(m[2]); } catch { text = m[2]; }      // raw JSON may itself contain a stray "%"
  }
  return JSON.parse(text);
}

/**
 * How a token is matched to a snapshot card. The snapshot holds one card per DESIGN, and every edition of a design
 * shares its design hash, design doc (external_url) and painting (image); the name is the last resort.
 * templates: the live shop's [{ sourceTokenId, designHash }], when there is one.
 */
export function cardIndex(cards, templates = []) {
  const byToken = new Map(), byMeta = new Map(), byImage = new Map(), bySlug = new Map(), byDesign = new Map();
  for (const c of cards) {
    byToken.set(String(c.tokenId), c);
    if (c.metadata) byMeta.set(c.metadata, c);
    if (c.image) byImage.set(c.image, c);
    if (c.slug) bySlug.set(c.slug, c);
  }
  for (const t of templates) {
    const c = byToken.get(String(t.sourceTokenId));
    if (c && t.designHash) byDesign.set(norm(t.designHash), c);
  }
  return {
    byToken,
    /** The snapshot card a decoded tokenURI JSON is an edition of, or null. */
    match(json) {
      const design = json?.rapture?.design?.hash;
      return (design && byDesign.get(norm(design))) || byMeta.get(json?.external_url) || byImage.get(json?.image) || bySlug.get(slugOf(json?.name)) || null;
    },
  };
}

/** A deterministic sample library for ?demo: about a third of the set, some cards in several editions, some NEW. */
export function demoTokens(cards, setId = 1) {
  const base = BigInt(setId) << 32n;
  const tokens = [];
  cards.forEach((c, i) => {
    if ((i * 7 + 3) % 5 > 1) return;                                       // ~40% of the cards
    tokens.push({ tokenId: String(base + 1000n + BigInt(i)), cardTokenId: c.tokenId });
    if (i % 4 === 0) tokens.push({ tokenId: String(base + 2000n + BigInt(i)), cardTokenId: c.tokenId });   // a duplicate edition
  });
  return tokens.sort((a, b) => byId(a.tokenId, b.tokenId));
}

// ------------------------------------------------------------------ small async helpers
/** fetch JSON with a hard timeout and an optional outer signal. */
async function getJson(f, url, signal, timeoutMs = EXPLORER_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await f(url, { signal: ctl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (signal?.aborted) throw new AbortError();
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Run fn over items, n at a time. Stops early (and rejects) if the signal fires. */
async function pool(items, n, fn, signal) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      if (signal?.aborted) throw new AbortError();
      const k = next++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

// ------------------------------------------------------------------ persistence (never throws: a blocked storage only costs the instant paint)
function defaultStorage() {
  try {
    const s = globalThis.localStorage;
    if (s && typeof s.getItem === "function" && typeof s.setItem === "function") return s;
  } catch { /* access itself can throw */ }
  return null;
}
const readJson = (store, key, fallback) => {
  try { const raw = store?.getItem(key); return raw ? JSON.parse(raw) : fallback; }
  catch (e) { console.debug("[library] could not read", key, e?.message ?? e); return fallback; }
};
const writeJson = (store, key, value) => {
  try { store?.setItem(key, JSON.stringify(value)); }
  catch (e) { console.debug("[library] could not save", key, e?.message ?? e); }
};

// ------------------------------------------------------------------ holdings
/**
 * createHoldings({ collection, rpc, templates, fetch, storage, chain }) -> reader for ONE collection.
 *   collection  loadCollection() result: { address, chainId, setId, explorer, cards[] }
 *   rpc         JSON-RPC url (default collection.rpc; the local dev chain passes its own)
 *   templates   the live shop's cfg.templates, for matching editions by design hash
 *   storage     localStorage-like or null (default: localStorage when usable)
 */
export function createHoldings({ collection, rpc = collection.rpc, templates = [], fetch: fetchArg, storage, chain } = {}) {
  if (!collection || !isAddress(collection.address)) throw new TypeError("createHoldings needs a collection with a contract address");
  const nft = collection.address;
  const store = storage === undefined ? defaultStorage() : storage;
  const client = chain ?? (rpc ? createChain(rpc) : null);
  const f = (...a) => (fetchArg ?? globalThis.fetch)(...a);
  const index = cardIndex(collection.cards ?? [], templates);
  const base = BigInt(collection.setId ?? 1) << 32n;
  const keyOf = (w) => `forge.library.v1:${collection.chainId}:${norm(nft)}:${norm(w)}`;
  const identKey = `forge.library.ident.v1:${collection.chainId}:${norm(nft)}`;
  const ident = readJson(store, identKey, {});               // tokenId -> the snapshot card's tokenId (immutable, so cached for good)

  // -- chain reads
  async function ethCall(selector, types, values, signal) {
    if (!client) throw new Error("no RPC configured");
    return client.call({ to: nft, data: encodeCall(selector, types, values) }, { signal });
  }
  /** The owner of a token (lowercase), null when the token does not exist (ownerOf reverts). Other failures throw. */
  async function ownerOf(tokenId, signal) {
    try { return norm(addressAt(words(await ethCall(SEL.ownerOf, ["uint256"], [tokenId], signal)), 0)); }
    catch (e) { if (e?.isRevert) return null; throw e; }
  }
  const balanceOf = async (wallet, signal) => Number(uintAt(words(await ethCall(SEL.balanceOf, ["address"], [wallet], signal)), 0));
  const totalSupply = async (signal) => Number(uintAt(words(await ethCall(SEL.totalSupply, [], [], signal)), 0));

  // -- explorer (best effort)
  async function fromExplorer(wallet, signal) {
    if (!collection.explorer) return null;
    const ids = new Set();
    let more = "";
    for (let page = 0; page < EXPLORER_PAGES; page++) {
      const j = await getJson(f, `${collection.explorer}/api/v2/tokens/${nft}/instances?holder_address_hash=${wallet}${more}`, signal);
      for (const it of j?.items ?? []) {
        const owner = it?.owner?.hash ?? (typeof it?.owner === "string" ? it.owner : null);
        if (owner && norm(owner) !== wallet) continue;          // the filter says it is theirs; a listed owner must agree
        if (it?.id != null && /^\d+$/.test(String(it.id))) ids.add(String(it.id));
      }
      const next = j?.next_page_params;
      if (!next) return ids;
      more = `&${new URLSearchParams(next).toString()}`;
    }
    return ids;
  }

  // -- persisted per-wallet state: what we last saw them hold, what a pack minted here, what they have looked at.
  // Storage is the truth (other tabs share it); the in-memory copy only covers a browser that will not let us save
  // (private mode), so NEW badges and the just-opened pack still work for this page's lifetime.
  const mem = new Map();
  const loadState = (w) => {
    const s = readJson(store, keyOf(w), null) ?? mem.get(keyOf(w));
    return { ids: s?.ids ?? [], opened: s?.opened ?? [], seen: Array.isArray(s?.seen) ? s.seen : null };
  };
  const saveState = (w, s) => {
    const v = { v: 1, ...s };
    mem.set(keyOf(w), v);
    writeJson(store, keyOf(w), v);
  };

  const api = {
    collection,
    /** Token ids this browser remembers for the wallet (instant paint before the chain answers). */
    remembered: (wallet) => loadState(wallet).ids,

    /** A pack minted these to the wallet: remember them at once (the explorer takes a while) and flag them NEW. */
    remember(wallet, tokenIds) {
      const s = loadState(wallet);
      const ids = tokenIds.map(String);
      saveState(wallet, { ...s, ids: [...new Set([...s.ids, ...ids])].sort(byId), opened: [...new Set([...s.opened, ...ids])] });
    },

    /** Token ids held but not yet looked at. The first read of a wallet counts everything as seen, except what a pack minted here. */
    unseen(wallet, owned) {
      const s = loadState(wallet);
      const seen = new Set(s.seen ?? owned.filter((id) => !s.opened.includes(id)));
      return owned.filter((id) => !seen.has(id));
    },
    /** ids: the tokens just looked at. owned: everything the wallet holds now, so the first-read baseline is kept intact. */
    markSeen(wallet, ids, owned = ids) {
      const s = loadState(wallet);
      const looked = ids.map(String);
      const baseline = s.seen ?? owned.map(String).filter((id) => !s.opened.includes(id));
      saveState(wallet, { ...s, seen: [...new Set([...baseline, ...looked])], opened: s.opened.filter((id) => !looked.includes(id)) });
    },

    /**
     * The wallet's tokens, chain-checked. deep = false skips the ownerOf scan (a background poll must stay cheap).
     * -> { tokens: string[] (ascending ids), balance, complete, partial, explorer: "ok"|"failed"|"none", scanned }
     */
    async read(wallet, { signal, deep = true } = {}) {
      if (!isAddress(wallet)) throw new TypeError("read needs a wallet address");
      const w = norm(wallet);
      const state = loadState(w);
      const [ex, bal] = await Promise.allSettled([fromExplorer(w, signal), balanceOf(w, signal)]);
      if (signal?.aborted) throw new AbortError();
      const balance = bal.status === "fulfilled" ? bal.value : null;
      const have = new Set(ex.status === "fulfilled" && ex.value ? ex.value : []);
      const explorer = !collection.explorer ? "none" : ex.status === "fulfilled" ? "ok" : "failed";
      if (ex.status === "rejected" && isAbort(ex.reason)) throw ex.reason;
      let partial = false, scanned = 0;

      // an ownerOf that fails for a reason other than "no such token" only makes the answer partial
      const owns = async (id) => {
        try { return (await ownerOf(id, signal)) === w; }
        catch (e) { if (isAbort(e)) throw e; partial = true; return null; }
      };
      const verify = async (ids) => {
        const ok = await pool(ids, RPC_CONCURRENCY, owns, signal);
        return ids.filter((id, i) => ok[i]);
      };

      // remembered ids the explorer did not list: only the chain can say whether they are still theirs
      const extra = state.ids.filter((id) => !have.has(id));
      for (const id of await verify(extra)) have.add(id);

      if (balance != null) {
        if (have.size > balance) {                       // the index still lists something they have since sent away
          const keep = new Set(await verify([...have]));
          for (const id of [...have]) if (!keep.has(id)) have.delete(id);
        }
        if (have.size < balance && deep && client) {     // the index is missing some: look for them, newest first
          let supply = null;
          try { supply = await totalSupply(signal); } catch (e) { if (isAbort(e)) throw e; partial = true; }
          if (supply != null) {
            const top = Math.min(supply, SCAN_LIMIT);
            if (supply > SCAN_LIMIT) partial = true;     // older ids are not scanned
            let n = supply - 1;                          // ids are set-local serials 0..supply-1; the newest are last
            const stop = () => have.size >= balance;
            await Promise.all(Array.from({ length: RPC_CONCURRENCY }, async () => {
              while (!stop() && n >= 0 && scanned < top) {
                if (signal?.aborted) throw new AbortError();
                const id = String(base + BigInt(n--));
                if (have.has(id)) continue;
                scanned++;
                if (await owns(id)) have.add(id);
              }
            }));
          }
        }
      }

      const tokens = [...have].sort(byId);
      // Every non-empty read is worth remembering; an empty one is too when the chain confirmed it (balance 0).
      if (tokens.length || balance === 0) saveState(w, { ...state, ids: tokens });
      return { tokens, balance, complete: balance != null && tokens.length === balance, partial, explorer, scanned };
    },

    /** A pack just minted this token from a card we hold: record what it is, so the library needs no tokenURI call for it. */
    learn(tokenId, cardTokenId) {
      if (!index.byToken.has(String(cardTokenId))) return;
      ident[String(tokenId)] = String(cardTokenId);
      writeJson(store, identKey, ident);
    },

    /**
     * Which snapshot card each token is -> Map(tokenId -> card | null). The snapshot's own 50 tokens need no call; an
     * edition is matched through its tokenURI (cached for good: a token's design never changes). A token whose URI
     * cannot be read stays null this time and is retried on the next read.
     */
    async identify(tokenIds, { signal } = {}) {
      const out = new Map();
      const need = [];
      for (const id of tokenIds.map(String)) {
        const direct = index.byToken.get(id) ?? index.byToken.get(ident[id]);
        if (direct) out.set(id, direct); else need.push(id);
      }
      await pool(need, 4, async (id) => {
        let card = null;
        try {
          const json = parseTokenUri(decodeAbiString(await ethCall(SEL.tokenURI, ["uint256"], [id], signal)));
          card = json ? index.match(json) : null;
        } catch (e) {
          if (isAbort(e)) throw e;
          console.debug("[library] could not identify token", id, e?.message ?? e);
        }
        out.set(id, card);
        if (card) ident[id] = card.tokenId;
      }, signal);
      if (need.some((id) => out.get(id))) writeJson(store, identKey, ident);
      return out;
    },
  };
  return api;
}

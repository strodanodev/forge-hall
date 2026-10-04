// FORGE — the live pack shop, as the pack sequence sees it.
//
// pack.js drives the story (wallet -> sealed pack idling -> tear -> reveal); this module does the wallet and chain work
// behind it and hands back real, minted cards. Nothing here draws anything.
//
//   const shop = await createShop({ collection });      // always resolves an object; shop.live tells if packs can be bought
//   shop.buy() -> shop.waitOpenable() -> shop.open()  -> cards[]   (pack.js: startLive / liveOpen)
//
// The shop is "live" only when web/assets/rapture/packshop.json exists and names a PackShop. Without it (not deployed,
// or ?shop=off) the hall keeps its free preview and the wallet button still lets a player connect and sign in.
import { LITEFORGE, WalletError, createWallet } from "./wallet.js";
import { PHASE, buyPack, chainFromConfig, findMyPacks, formatZkltc, loadShopConfig, openPack, packsLeftToday, readShop, refundExpired, waitUntilOpenable } from "./packshop.js";
import { RANK } from "./tiers.js";

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])$/;

// "signing" | "pending" | "confirmed" from packshop.js, worded for a player
const BUY_TEXT = { signing: "Confirm the purchase in your wallet…", pending: "Purchase sent. Waiting for the chain to confirm it…", confirmed: "Purchase confirmed. The pack is sealed." };
const OPEN_TEXT = { signing: "Confirm the second signature in your wallet to break the seal…", pending: "Breaking the seal. Minting your cards on chain…", confirmed: "Minted! The cards are in your wallet." };

/** Which config file to read: ?shop=off disables it, ?shop=local reads the local dev chain's (localhost hosts only). */
function configUrl() {
  const q = new URLSearchParams(location.search).get("shop");
  if (q === "off") return null;
  if (q === "local" && LOCAL_HOSTS.test(location.hostname)) return "./assets/rapture/packshop.local.json";
  return "./assets/rapture/packshop.json";
}

export async function createShop({ collection }) {
  const url = configUrl();
  let cfg = null, configError = null;
  if (url) {
    try { cfg = await loadShopConfig(url); }
    catch (e) { configError = e; console.warn("[shop] the pack shop configuration is unusable; the hall stays in preview", e); }
  }
  const wallet = createWallet({ chain: cfg ? chainFromConfig(cfg) : LITEFORGE });

  // template id -> the snapshot card it was minted from (same design, painting, avatar and lore)
  const source = new Map();
  if (cfg) {
    const bySource = new Map(collection.cards.map((c) => [c.tokenId, c]));
    for (const t of cfg.templates) {
      const card = bySource.get(String(t.sourceTokenId));
      if (card) source.set(Number(t.id), card);
    }
    if (source.size !== cfg.templates.length) {
      configError = new Error(`the shop has ${cfg.templates.length} templates but the snapshot only knows ${source.size} of their cards`);
      console.warn("[shop]", configError.message);
      cfg = null;
    }
  }

  const listeners = new Set();
  // packs opened or refunded in this page: the public RPC is load balanced, so a lagging node can still report the
  // phase they had before
  const opened = new Set(), refunded = new Set();
  // one chain read at a time; a refresh asked for while one runs queues exactly one more, so a stale answer never
  // lands after a newer one (refresh() was fired unawaited from five places)
  let reading = null, readAgain = false;
  async function readOnce() {
    try { shop.info = await readShop(cfg, wallet.address ?? undefined); }
    catch (e) { console.warn("[shop] could not read the shop", e); }
    if (wallet.connected) {
      try {
        const mine = await findMyPacks(cfg, wallet.address);
        const waiting = mine.filter((p) => (p.phase === PHASE.Waiting || p.phase === PHASE.Openable) && !opened.has(p.packId));
        if (!shop.pending && waiting.length) shop.pending = { packId: waiting.at(-1).packId };   // resume after a reload
        shop.expired = mine.filter((p) => p.phase === PHASE.Expired && !refunded.has(p.packId));
        // the pack we were holding can no longer be opened (expired, opened from another tab, refunded): drop it
        const held = shop.pending && mine.find((p) => p.packId === String(shop.pending.packId));
        if (held && held.phase !== PHASE.Waiting && held.phase !== PHASE.Openable) shop.pending = null;
      } catch (e) { console.warn("[shop] could not look up your packs", e); }
    } else { shop.pending = null; shop.expired = []; }
    shop.changed();
  }
  const shop = {
    live: !!cfg,
    cfg,
    wallet,
    configError,
    /** Latest readShop(): { price, packSize, dailyLimit, paused, ready, weights, templateCount, packsLeft }. */
    info: null,
    /** The sealed pack this wallet owns and has not opened: { packId, txHash? }. */
    pending: null,
    /** Packs found unopened past the blockhash window: refundable. */
    expired: [],

    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    changed() { for (const fn of [...listeners]) { try { fn(shop); } catch (e) { console.error("[shop] subscriber threw", e); } } },

    /** The collection as the panel should describe it: on the local dev chain the tokens are not on Liteforge. */
    adaptCollection(c) {
      if (!cfg || cfg.chainId === c.chainId) return c;
      return { ...c, chainId: cfg.chainId, address: cfg.cards, explorer: cfg.explorer ?? null, local: true };
    },

    /** "0.001 zkLTC" (the price is rounded up: a label never shows less than it costs). */
    priceText() { return shop.info ? `${formatZkltc(shop.info.price, 4, "ceil")} zkLTC` : "zkLTC"; },

    /** Text for the main button in the resting hall. */
    label() {
      if (!cfg) return "Open Pack";
      if (shop.pending) return "Open Sealed Pack";
      if (shop.info?.paused) return "Shop Paused";
      return wallet.connected ? "Open Pack" : "Connect & Open";
    },

    /** Smaller second line under label(): what the click will cost, or "" when it buys nothing. */
    subLabel() { return cfg && !shop.pending && !shop.info?.paused ? shop.priceText() : ""; },

    /** Re-read the shop and this wallet's packs. Never throws: a flaky RPC only means stale labels. Overlapping calls
     *  are merged; the promise resolves once the newest requested read has landed. */
    refresh() {
      if (!cfg) { shop.changed(); return Promise.resolve(); }
      if (reading) { readAgain = true; return reading; }
      reading = (async () => { do { readAgain = false; await readOnce(); } while (readAgain); })().finally(() => { reading = null; });
      return reading;
    },

    /** Connect (in the click that asked), make sure the wallet is on the shop's chain, buy one pack. Sets `pending`. */
    async buy({ onStage } = {}) {
      if (!cfg) throw new WalletError("rpc", "The pack shop is not open yet.");
      if (!wallet.connected) await wallet.connect();
      const bought = await buyPack(wallet, cfg, { onStage: (s) => onStage?.(BUY_TEXT[s] ?? "") });
      shop.pending = { packId: bought.packId, txHash: bought.txHash };
      shop.changed();
      shop.refresh();
      return shop.pending;
    },

    /** Resolve once the pack's reveal block exists. onStage gets a running text while it waits. */
    async waitOpenable({ onStage } = {}) {
      const { packId } = shop.pending;
      await waitUntilOpenable(cfg, packId, {
        onTick: ({ elapsedMs }) => onStage?.(`Sealed on chain. Waiting for the reveal block… ${Math.round(elapsedMs / 1000)}s`),
      });
    },

    /** Open the pending pack (second signature) and return the minted cards, best last. */
    async open({ onStage } = {}) {
      const { packId } = shop.pending;
      const r = await openPack(wallet, cfg, packId, { onStage: (s) => onStage?.(OPEN_TEXT[s] ?? "") });
      const cards = r.tokenIds.map((tokenId, i) => {
        const src = source.get(r.templateIds[i]);
        if (!src) throw new WalletError("rpc", `The shop minted a card (template ${r.templateIds[i]}) this page does not know. Reload the page.`);
        return {
          ...src,
          tokenId,                                             // the minted token, not the template's source token
          serial: Number(BigInt(tokenId) & 0xffffffffn),       // position in the set, printed on the card face
          serialSource: src.serial + 1,
          owned: true,
          txHash: r.txHash,
        };
      });
      return cards.sort((a, b) => RANK[a.rarity] - RANK[b.rarity]);   // crescendo: best card flips last
    },

    /** The pending pack is dead (see pack.js DEAD_PACK): forget it so the button offers a fresh purchase. */
    abandon() { shop.pending = null; shop.changed(); shop.refresh(); },

    /** pack.js calls this after the reveal: the pending pack is spent. */
    spent() { if (shop.pending) opened.add(String(shop.pending.packId)); shop.pending = null; shop.changed(); shop.refresh(); },

    /** Claim back the price of the oldest expired pack. */
    async refundOne({ onStage } = {}) {
      const p = shop.expired[0];
      if (!p) return null;
      const r = await refundExpired(wallet, cfg, p.packId, { onStage: (s) => onStage?.(s) });
      refunded.add(String(p.packId));                  // a lagging node must not offer this refund again
      await shop.refresh();
      return r;
    },

    async packsLeft() { return wallet.address && cfg ? packsLeftToday(cfg, wallet.address) : null; },
  };

  wallet.subscribe(() => shop.refresh());
  if (cfg) shop.refresh();
  // quiet reconnect (no popup) when the player connected here before
  wallet.restore().then((a) => { if (a) shop.refresh(); }).catch((e) => console.debug("[shop] restore skipped", e?.message ?? e));
  return shop;
}

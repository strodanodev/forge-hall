// FORGE — the inspect panel: a Rapture card's traits, stats, SOUL lore and on-chain provenance (TESTNET).
import { ELEMENT, RARITY } from "./rapture.js";

const GATEWAY = "https://ipfs.filebase.io/ipfs/";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (h) => `${h.slice(0, 6)}…${h.slice(-4)}`;
const ipfsUrl = (uri) => uri?.replace(/^ipfs:\/\//, GATEWAY);

export class CardPanel {
  /** @param {HTMLElement} el  empty #card-panel   @param {object} collection  loadCollection() result */
  constructor(el, collection, onClose) {
    this.el = el; this.collection = collection;
    el.hidden = true;
    el.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) onClose(); });
    // keep wheel/touch scrolling inside the panel from reaching the canvas
    for (const ev of ["pointerdown", "wheel", "touchstart"]) el.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
  }

  show(card) {
    const C = this.collection, R = RARITY[card.rarity], el = ELEMENT[card.element] ?? "#ffd37a";
    const stat = (label, k) => {
      const [lo, hi] = C.range[k], f = Math.max(0.04, (card.stats[k] - lo) / (hi - lo || 1));
      return `<div class="cp-stat"><span>${label}</span><b>${card.stats[k].toLocaleString("en-US")}</b><i style="--f:${f.toFixed(3)}"></i></div>`;
    };
    const soul = card.soul ?? {};
    const lore = [
      soul.intro && `<p>${esc(soul.intro)}</p>`,
      soul.voice && `<h4>Voice</h4><p>${esc(soul.voice)}</p>`,
      soul.values && `<h4>Values</h4><p>${esc(soul.values)}</p>`,
      soul.fight && `<h4>In a fight</h4><p>${esc(soul.fight)}</p>`,
    ].filter(Boolean).join("");
    // a local snapshot (scripts/rapture_snapshot.mjs --local) has no explorer: the Studio's own test chain
    const link = (href, text) => href ? `<a href="${href}" target="_blank" rel="noopener">${text} ↗</a>` : text;
    const token = C.explorer && `${C.explorer}/token/${C.address}/instance/${card.tokenId}`;
    const net = C.local ? `Local test chain · ${C.chainId}` : `Liteforge testnet · chain ${C.chainId}`;
    // a card pulled from the live shop is a real token in the player's wallet: its own id, its mint transaction
    const mintTx = card.owned && card.txHash && C.explorer && `${C.explorer}/tx/${card.txHash}`;
    this.el.style.setProperty("--el", el);
    this.el.style.setProperty("--tier", R.css);
    this.el.innerHTML = `
      <button class="cp-close" data-close aria-label="Close">✕</button>
      <div class="cp-top"><span class="cp-kind">${esc(card.kind)} · ${esc(card.path)}</span><span class="cp-net${card.owned ? " own" : ""}">${card.owned ? (C.local ? "MINTED · LOCAL" : "MINTED · TESTNET") : C.local ? "LOCAL PREVIEW" : "TESTNET PREVIEW"}</span></div>
      <h2>${esc(card.name)}</h2>
      <div class="cp-epithet">${esc(card.epithet)}</div>
      <div class="cp-traits">
        <span class="cp-el"><i></i>${esc(card.element)}</span><span>${esc(card.alignment)}</span><span>${esc(card.faction)}</span>
        <span>${esc(card.frame)} frame</span>${card.kit ? `<span>${esc(card.kit)} kit</span>` : ""}
      </div>
      <div class="cp-stats">${stat("STR", "str")}${stat("AGI", "agi")}${stat("RES", "res")}${stat("INT", "int")}</div>
      <div class="cp-lore">${lore || `<p>${esc(card.bio)}</p>`}</div>
      <details class="cp-chain">
        <summary>On-chain provenance</summary>
        <dl>
          <dt>Token</dt><dd>${link(token, `#${esc(card.tokenId)}`)}</dd>
          <dt>Collection</dt><dd>${link(C.explorer && `${C.explorer}/address/${C.address}`, short(C.address))}</dd>
          <dt>Network</dt><dd>${net}</dd>
          <dt>Metadata</dt><dd><a href="${ipfsUrl(card.metadata)}" target="_blank" rel="noopener">design doc${C.local ? "" : " (IPFS)"} ↗</a> · <a href="${ipfsUrl(card.image)}" target="_blank" rel="noopener">card image ↗</a></dd>
          ${card.avatar ? `<dt>Avatar</dt><dd title="${esc(card.avatar.sha256)}">sha256 ${short(card.avatar.sha256)} <span class="cp-ok">✓ matches token</span></dd>` : ""}
          ${card.owned
            ? `<dt>Minted</dt><dd>${link(mintTx, card.txHash ? short(card.txHash) : "in your wallet")}</dd><dt>Design</dt><dd>edition of ARC 1 design #${esc(card.serialSource ?? "")}</dd>`
            : `<dt>Snapshot</dt><dd>${new Date(C.snapshotAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} · preview only, nothing minted</dd>`}
        </dl>
      </details>`;
    this.el.scrollTop = 0;
    this.el.hidden = false;
    requestAnimationFrame(() => this.el.classList.add("on"));
  }

  hide() {
    this.el.classList.remove("on");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (!this.el.classList.contains("on")) this.el.hidden = true; }, 350);
  }
}

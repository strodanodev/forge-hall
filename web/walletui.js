// FORGE — the wallet button (top right): connect MetaMask, see the network and balance, sign in, disconnect.
//
// Connecting never asks for more than the account. Signing in (a free message signature, no transaction) is optional
// and only offered when the sign-in API exists on this host; buying packs needs the wallet only, not a session.
import { LITEFORGE } from "./wallet.js";
import { formatZkltc } from "./packshop.js";
import * as auth from "./auth.js";

import { esc, shortAddress as short } from "./util.js";
const MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/**
 * @param {HTMLElement} root  empty #wallet
 * @param {object} shop       createShop() result
 * @param {(text: string, tone?: string) => void} say  shows a message in the hall's status line
 */
export function mountWalletUI(root, shop, say) {
  const { wallet } = shop;
  const chain = wallet.chain ?? LITEFORGE;
  const faucet = shop.cfg?.faucet ?? LITEFORGE.faucet;
  const explorer = shop.cfg?.explorer ?? chain.explorer ?? LITEFORGE.explorer;
  let balance = null, packsLeft = null, session = null, apiUp = false, busy = false, open = false;

  root.hidden = false;
  root.innerHTML = `<button class="w-pill" type="button" aria-haspopup="true" aria-expanded="false"></button><div class="w-menu" hidden></div>`;
  const pill = root.querySelector(".w-pill"), menu = root.querySelector(".w-menu");

  const run = async (fn) => {
    if (busy) return;
    busy = true; render();
    try { await fn(); }
    catch (e) { say(e?.message || String(e), "error"); }
    finally { busy = false; render(); }
  };

  async function readBalance() {
    if (!wallet.connected || !wallet.onCorrectChain) { balance = null; return; }
    try { balance = await wallet.balance(); } catch (e) { console.debug("[wallet ui] balance unavailable", e?.message ?? e); }
  }
  async function readSession() {
    try { session = await auth.me(); apiUp = true; }
    // a 5xx means the API is deployed but not usable (e.g. no database configured yet): do not offer a sign-in that cannot work
    catch (e) { apiUp = !(e instanceof auth.ApiUnavailable) && !(e?.status >= 500); session = null; }
  }
  async function readAll() {
    await Promise.all([readBalance(), readSession(), shop.packsLeft().then((n) => { packsLeft = n; }).catch(() => { packsLeft = null; })]);
    render();
  }

  function render() {
    const s = wallet.snapshot();
    const a = s.address;
    pill.disabled = busy;
    if (!a) {
      pill.innerHTML = `<i class="w-dot off"></i>${busy ? "Connecting…" : "Connect Wallet"}`;
    } else if (!s.onCorrectChain) {
      pill.innerHTML = `<i class="w-dot bad"></i>Wrong network`;
    } else {
      pill.innerHTML = `<i class="w-dot"></i>${short(a)}${balance != null ? `<span class="w-bal">${formatZkltc(balance, 4, "floor")} zkLTC</span>` : ""}`;
    }
    pill.setAttribute("aria-expanded", String(open && !!a));
    menu.hidden = !(open && !!a);
    if (!a) return;

    const signedIn = session && session.address.toLowerCase() === a;
    const left = packsLeft == null ? "" : packsLeft === Infinity ? "" : `<div class="w-row">Packs left today: <b>${packsLeft}${shop.info ? ` / ${shop.info.dailyLimit || "∞"}` : ""}</b></div>`;
    menu.innerHTML = `
      <div class="w-row">${esc(wallet.info?.name ?? "Wallet")} · <b>${esc(a)}</b></div>
      <div class="w-row">${s.onCorrectChain ? `Network: <b>${esc(chain.name)}</b>` : `On chain ${s.chainId ?? "?"}. This hall lives on <b>${esc(chain.name)}</b>.`}</div>
      ${s.onCorrectChain ? "" : `<button data-act="switch">Switch to ${esc(chain.name)}</button>`}
      ${balance != null ? `<div class="w-row">Balance: <b>${formatZkltc(balance, 5, "floor")} zkLTC</b></div>` : ""}
      ${left}
      <a href="${esc(faucet)}" target="_blank" rel="noopener">Get free test zkLTC ↗</a>
      <hr>
      ${apiUp ? (signedIn
        ? `<div class="w-row">Signed in ✓</div><button data-act="signout">Sign out</button>`
        : `<button data-act="signin">Sign in with wallet <span class="w-bal">(free signature)</span></button>`) : ""}
      ${shop.expired.length ? `<button data-act="refund">Refund an expired pack</button>` : ""}
      <a href="${esc(explorer)}/address/${esc(a)}" target="_blank" rel="noopener">View on explorer ↗</a>
      <button data-act="disconnect">Disconnect</button>`;
  }

  pill.addEventListener("click", () => {
    if (!wallet.connected) {
      // no wallet at all: point to one instead of a dead button (a phone browser has no extension: open the dapp inside MetaMask)
      return run(async () => {
        try { await wallet.connect(); open = false; }
        catch (e) {
          if (e.code === "no_wallet") {
            const href = MOBILE ? `https://metamask.app.link/dapp/${location.host}${location.pathname}` : "https://metamask.io/download/";
            say(`${e.message} ${MOBILE ? "Open this page inside the MetaMask app." : ""}`.trim(), "error");
            window.open(href, "_blank", "noopener");
          } else throw e;
        }
      });
    }
    open = !open; render();
    if (open) readAll();
  });

  menu.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    if (act === "switch") return run(async () => { await wallet.ensureChain(); await readAll(); });
    if (act === "disconnect") return run(async () => { await wallet.disconnect(); if (session) await auth.signOut().catch(() => {}); session = null; balance = null; open = false; });
    if (act === "signin") return run(async () => { await wallet.ensureChain(); session = await auth.signIn(wallet); say(`Signed in as ${short(session.address)}.`); });
    if (act === "signout") return run(async () => { await auth.signOut(); session = null; });
    if (act === "refund") return run(async () => { say("Confirm the refund in your wallet…"); const r = await shop.refundOne({ onStage: () => {} }); say(r ? `Refunded ${formatZkltc(r.amount)} zkLTC.` : "Nothing to refund."); await readAll(); });
  });
  addEventListener("pointerdown", (e) => { if (open && !root.contains(e.target)) { open = false; render(); } });

  wallet.subscribe(() => { balance = null; render(); readAll(); });
  shop.subscribe(() => { render(); if (wallet.connected) readBalance().then(render); });
  render();
  readSession().then(render);
  setInterval(() => { if (wallet.connected && !document.hidden) readBalance().then(render); }, 20000);
}

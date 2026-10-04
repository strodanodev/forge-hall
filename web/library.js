// FORGE — the Card Library: a wallet's collection as a full-screen overlay over the hall.
//
// Shows every card of each set (owned ones as art, the rest as silhouettes), set progress, filters and sorting, and a
// full-size card view that reuses the hall's own inspect panel. Data comes from holdings.js (chain + explorer); the
// filters and progress maths are in librarymodel.js (Node-tested); this file is the DOM.
//
// It reuses, and does not replace, the wallet layer: the wallet, the RPC settings and the "Connect Wallet" flow are the
// shop's (shopflow.js / walletui.js). The library only READS a wallet's tokens; it never asks the wallet to sign or send.
//
//   ?demo                     sample collection, no wallet needed (for looking at the UI)
//   ?holder=0x...             read-only view of any address (local dev hosts only)

import { drawFace, ELEMENT, KIND_TIER, RARITY } from "./rapture.js";
import { createHoldings, demoTokens, serialOf } from "./holdings.js";
import { ELEMENTS, KINDS, SORTS, buildRows, filterRows, progress, serialLabel, sortRows } from "./librarymodel.js";

import { esc, shortAddress as short, REDUCED_MOTION as reduced } from "./util.js";
const sameAddr = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])$/;
const HOLDER = LOCAL_HOSTS.test(location.hostname) && /^0x[0-9a-fA-F]{40}$/.test(params.get("holder") ?? "") ? params.get("holder").toLowerCase() : null;
const DEMO_WALLET = "0x00000000000000000000000000000000000de0de";
const POLL_MS = 30000;
const STALE_MS = 15000;            // opening the library re-reads only if the last read is older than this
const DEEP_EVERY_MS = 5 * 60000;   // the costly ownerOf scan for tokens the explorer missed: at most this often, unless forced
const OPENABLE = new Set(["idle", "sealed", "done"]);       // pack states in which the hall is at rest

function injectStyles() {
  if (document.querySelector("link[data-library]")) return;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = new URL("./library.css", import.meta.url).href;
  l.dataset.library = "";
  document.head.append(l);
}

/**
 * @param {object}   o
 * @param {Array}    o.sets  loadSets() result: [{ id, title, subtitle, collection }]
 * @param {object}   o.shop  createShop() result (wallet, cfg)
 * @param {object}   o.pack  PackOpening (state, events, panel, inspect)
 * @param {(text: string, tone?: string) => void} [o.say]  the hall's status line
 * @returns {{ open, close, toggle, refresh, onToggle, isOpen, sets }}
 */
export function mountLibrary({ sets: setList, shop, pack, say = () => {} }) {
  if (!setList?.length) return null;
  injectStyles();
  const wallet = shop.wallet;
  const cfgFor = (c) => (shop.cfg && sameAddr(shop.cfg.cards, c.address) ? shop.cfg : null);
  const sets = setList.map((s) => {
    const cfg = cfgFor(s.collection);
    return {
      ...s,
      holdings: createHoldings({ collection: s.collection, rpc: cfg?.rpc ?? s.collection.rpc, templates: cfg?.templates ?? [] }),
      view: { tokens: [], rows: [], unknown: [], fresh: new Set(), status: "idle", read: null, version: 0 },
      seq: 0, ctl: null,
    };
  });
  // every card of each set is a (locked) row from the start, so the guest view and the first paint are already the full set
  for (const s of sets) { const b = buildRows(s.collection.cards, []); s.view.rows = b.rows; }

  const S = {
    open: false, openedAt: 0, setIdx: 0, detail: null, order: [], gridKey: "", detailSeq: 0,
    filters: { kind: "all", element: "all", status: "all", q: "", sort: "set" },
  };
  const cur = () => sets[S.setIdx];
  const who = () => (DEMO ? DEMO_WALLET : HOLDER ?? wallet.address ?? null);
  const toggles = new Set();

  // ------------------------------------------------------------------ DOM
  const root = document.createElement("div");
  root.id = "library"; root.hidden = true;
  root.setAttribute("role", "dialog"); root.setAttribute("aria-modal", "true"); root.setAttribute("aria-label", "Card Library");
  root.innerHTML = `
    <header class="lb-head">
      <button class="lb-back" type="button" data-act="close" aria-label="Close the library">←</button>
      <h1>CARD LIBRARY</h1>
      <nav class="lb-sets" hidden></nav>
    </header>
    <section class="lb-summary" aria-live="polite"></section>
    <section class="lb-tools">
      <input type="search" data-q placeholder="Search cards" aria-label="Search cards" autocomplete="off" spellcheck="false">
      <select data-sort aria-label="Sort">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
      <div class="lb-chips" data-kinds role="group" aria-label="Kind"></div>
      <span class="lb-sep"></span>
      <div class="lb-chips" data-els role="group" aria-label="Element"></div>
      <span class="lb-sep"></span>
      <div class="lb-chips" data-status role="group" aria-label="Show"></div>
    </section>
    <div class="lb-banner" hidden role="status"></div>
    <div class="lb-scroll"><div class="lb-grid"></div><div class="lb-other" hidden><h2 class="lb-title">Other tokens in this wallet</h2><div class="lb-grid"></div></div></div>
    <div class="lb-hero" hidden>
      <button class="lb-back" type="button" data-act="close-detail" aria-label="Back to the library">←</button>
      <div class="lb-stage">
        <button class="lb-nav prev" type="button" data-act="prev" aria-label="Previous card">‹</button>
        <div class="lb-card"></div>
        <button class="lb-nav next" type="button" data-act="next" aria-label="Next card">›</button>
      </div>
      <div class="lb-eds-wrap"><div class="lb-eds-title"></div><div class="lb-eds"></div></div>
    </div>
    <div class="lb-toast" role="status" aria-live="polite"></div>`;
  // just before the inspect panel, so the panel (same z-index) paints above the library
  const panelEl = document.getElementById("card-panel");
  if (panelEl) panelEl.before(root); else document.body.append(root);

  const btn = document.createElement("button");
  btn.id = "library-btn"; btn.type = "button";
  document.body.append(btn);

  const $ = (sel) => root.querySelector(sel);
  const el = {
    sets: $(".lb-sets"), summary: $(".lb-summary"), q: $("[data-q]"), kinds: $("[data-kinds]"), els: $("[data-els]"), status: $("[data-status]"),
    sort: $("[data-sort]"), banner: $(".lb-banner"), scroll: $(".lb-scroll"), grid: $(".lb-grid"), other: $(".lb-other"), otherGrid: $(".lb-other .lb-grid"),
    hero: $(".lb-hero"), stage: $(".lb-stage"), card: $(".lb-card"), eds: $(".lb-eds"), edsTitle: $(".lb-eds-title"),
    prev: $(".lb-nav.prev"), next: $(".lb-nav.next"), close: $(".lb-head .lb-back"), toast: $(".lb-toast"),
  };
  let tiles = [];
  // the hall's own status line sits under the library, so the library speaks through its own
  let toastTimer = 0;
  function toast(text) {
    el.toast.textContent = text;
    el.toast.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove("on"), 3600);
  }

  // ------------------------------------------------------------------ data
  /**
   * Re-read the active (or given) set. deep = false is the cheap path (after a pack); a deep read may also scan the chain
   * for tokens the explorer missed, which is costly, so it runs at most every DEEP_EVERY_MS unless forced (the Retry button).
   */
  async function load(set = cur(), { deep = true, force = false } = {}) {
    const v = set.view;
    const my = ++set.seq;
    set.ctl?.abort();
    const ctl = (set.ctl = new AbortController());
    const addr = who();
    deep = deep && (force || !set.deepAt || Date.now() - set.deepAt > DEEP_EVERY_MS);
    if (deep) set.deepAt = Date.now();
    set.busy = true;
    const finish = (patch) => { if (my !== set.seq) return false; Object.assign(v, patch); rebuild(set); render(); return true; };

    if (DEMO) {
      const tokens = demoTokens(set.collection.cards, set.collection.setId).map((t) => ({ tokenId: t.tokenId, card: set.collection.cards.find((c) => c.tokenId === t.cardTokenId) }));
      finish({ tokens, fresh: new Set(tokens.slice(-3).map((t) => t.tokenId)), status: "ready", read: { complete: true, partial: false, balance: tokens.length, explorer: "none" } });
      set.busy = false; set.doneAt = Date.now();
      return;
    }
    if (!addr) { finish({ tokens: [], fresh: new Set(), status: "ready", read: null }); set.busy = false; return; }

    // paint what this browser remembers first, so a returning player sees their cards at once
    if (!v.tokens.length) {
      const known = set.holdings.remembered(addr);
      let painted = false;
      if (known.length) {
        try {
          const m = await set.holdings.identify(known, { signal: ctl.signal });
          painted = finish({ tokens: known.map((id) => ({ tokenId: id, card: m.get(id) ?? null })), fresh: new Set(set.holdings.unseen(addr, known)), status: "loading", read: null });
        } catch (e) { if (e?.name !== "AbortError") console.debug("[library] instant paint skipped", e?.message ?? e); }
      }
      if (!painted && v.status !== "loading") finish({ status: "loading" });
    }

    try {
      const r = await set.holdings.read(addr, { signal: ctl.signal, deep });
      const m = await set.holdings.identify(r.tokens, { signal: ctl.signal });
      const tokens = r.tokens.map((id) => ({ tokenId: id, card: m.get(id) ?? null }));
      if (finish({ tokens, fresh: new Set(set.holdings.unseen(addr, r.tokens)), status: "ready", read: r })) set.doneAt = Date.now();
    } catch (e) {
      if (e?.name === "AbortError") return;
      console.warn("[library] could not read the wallet's cards", e);
      finish({ status: "error", read: { complete: false, partial: true, balance: null, explorer: "failed", error: e?.message ?? String(e) } });
    } finally {
      if (my === set.seq) set.busy = false;          // a newer load owns the flag now
    }
  }
  const loadAll = (o) => Promise.all(sets.map((s) => load(s, o)));

  function rebuild(set) {
    const v = set.view;
    const built = buildRows(set.collection.cards, v.tokens, v.fresh);
    v.rows = built.rows; v.unknown = built.unknown; v.version++;
  }

  const freshCount = () => sets.reduce((n, s) => n + s.view.rows.filter((r) => r.isNew).length, 0);

  // ------------------------------------------------------------------ rendering
  function render() {
    renderButton();
    if (!S.open) return;
    renderSets(); renderSummary(); renderChips(); renderBanner(); renderGrid(); applyView();
    if (S.detail) refreshDetail();
  }

  function renderButton() {
    const set = cur(), p = progress(set.view.rows);
    const n = freshCount();
    const count = who() && set.view.status !== "idle" && set.view.status !== "loading" ? `<span class="lb-btn-n">${p.owned}/${p.total}</span>` : "";
    btn.innerHTML = `Library${count}${n ? `<span class="lb-btn-new">+${n} NEW</span>` : ""}`;
    btn.title = n ? `${n} new card${n === 1 ? "" : "s"} in your library (L)` : "Open your card library (L)";
  }

  function renderSets() {
    el.sets.hidden = sets.length < 2;
    if (sets.length < 2) return;
    el.sets.innerHTML = sets.map((s, i) => `<button type="button" data-set="${i}" aria-pressed="${i === S.setIdx}">${esc(s.title)}</button>`).join("");
  }

  function renderSummary() {
    const set = cur(), p = progress(set.view.rows);
    const f = p.total ? p.owned / p.total : 0;
    const dupes = p.tokens - p.owned;
    const meta = [set.subtitle, p.tokens ? `${p.tokens} card${p.tokens === 1 ? "" : "s"} owned${dupes > 0 ? ` (${dupes} duplicate${dupes === 1 ? "" : "s"})` : ""}` : ""].filter(Boolean);
    el.summary.innerHTML = `
      <div class="lb-set"><b>${p.owned} / ${p.total}</b><span>${esc(set.title)}</span></div>
      ${meta.length ? `<div class="lb-meta">${meta.map(esc).join(" · ")}</div>` : ""}
      <div class="lb-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${p.total}" aria-valuenow="${p.owned}" aria-label="Set completion"><i style="--f:${f.toFixed(3)}"></i></div>`;
  }

  function renderChips() {
    const set = cur(), p = progress(set.view.rows), F = S.filters;
    const kindChip = (k) => {
      const tier = RARITY[KIND_TIER[k]]?.css ?? "#ffd37a", c = p.byKind[k];
      return `<button class="lb-chip" type="button" data-kind="${k}" style="--c:${tier}" aria-pressed="${F.kind === k}"><i></i>${k}<small>${c.owned}/${c.total}</small></button>`;
    };
    el.kinds.innerHTML = `<button class="lb-chip" type="button" data-kind="all" aria-pressed="${F.kind === "all"}">All kinds</button>${KINDS.filter((k) => p.byKind[k].total).map(kindChip).join("")}`;
    el.els.innerHTML = ELEMENTS.map((e) => `<button class="lb-chip" type="button" data-el="${e}" style="--c:${ELEMENT[e]}" aria-pressed="${F.element === e}"><i></i>${e}</button>`).join("");
    const n = set.view.rows.filter((r) => r.isNew).length;
    const opts = [["all", "All"], ["owned", "Owned"], ["missing", "Missing"], ...(n ? [["new", `New (${n})`]] : [])];
    if (F.status === "new" && !n) F.status = "all";
    el.status.innerHTML = opts.map(([k, l]) => `<button class="lb-chip" type="button" data-status="${k}" aria-pressed="${F.status === k}">${l}</button>`).join("");
    el.sort.value = F.sort;
  }

  function renderBanner() {
    const set = cur(), v = set.view, r = v.read, addr = who();
    let html = "", bad = false;
    const action = (act, label) => `<button type="button" data-act="${act}">${label}</button>`;
    if (DEMO) html = `<span class="lb-msg"><b>DEMO DATA.</b> A sample collection to look at the library; it is not read from any wallet.</span>`;
    else if (HOLDER) html = `<span class="lb-msg">Read-only preview of <b>${short(HOLDER)}</b>.</span>`;
    else if (!addr) html = `<span class="lb-msg">Connect your wallet to reveal the cards you own. Every card of the set is shown below as a silhouette.</span>${action("connect", "Connect wallet")}`;
    else if (v.status === "loading" && !v.tokens.length) html = `<span class="lb-msg">Reading your cards from the chain…</span>`;
    else if (v.status === "error" || (r && r.balance == null && !r.complete && !v.tokens.length)) {
      bad = true;
      html = `<span class="lb-msg">Couldn't reach the network to check your cards. Showing what this browser remembers.</span>${action("retry", "Retry")}`;
    } else if (r && !r.complete && r.balance != null) {
      html = `<span class="lb-msg">The wallet holds ${r.balance} cards but ${v.tokens.length} could be found${r.partial ? " (older cards may not be searched)" : " so far; the explorer is still catching up"}.</span>${action("retry", "Look again")}`;
    } else if (v.status === "ready" && !v.tokens.length && r?.complete) {
      html = `<span class="lb-msg">Your library is empty. Open a pack to start your collection.</span>${action("open-pack", "Open a pack")}`;
    }
    el.banner.hidden = !html;
    el.banner.classList.toggle("bad", bad);
    el.banner.innerHTML = html;
  }

  const tileHtml = (row) => {
    const c = row.card, R = RARITY[c.rarity], elc = ELEMENT[c.element] ?? "#ffd37a";
    const own = row.owned;
    return `<button class="lb-tile" type="button" data-i="${row.index}" data-state="${own ? "owned" : "locked"}" style="--tier:${R.css};--el:${elc}"
        aria-label="${own ? `${esc(c.name)}, ${esc(c.kind)}${row.count > 1 ? `, ${row.count} owned` : ""}${row.isNew ? ", new" : ""}` : `Locked ${esc(c.kind)} card`}" ${own ? "" : 'aria-disabled="true"'}>
      <img src="${esc(c.art)}" alt="" loading="lazy" decoding="async" draggable="false">
      ${row.count > 1 ? `<span class="lb-badge count">×${row.count}</span>` : ""}${row.isNew ? `<span class="lb-badge new">NEW</span>` : ""}
      <span class="lb-cap"><span class="lb-name">${own ? esc(c.name) : "???"}</span><span class="lb-sub"><i></i>${esc(c.kind)}${own ? ` · ${esc(c.path)}` : ""}</span></span>
    </button>`;
  };
  const unknownHtml = (id) => `<div class="lb-tile" data-state="unknown" style="--tier:#8d7f68;--el:#8d7f68"><span class="lb-q">?</span>
      <span class="lb-cap"><span class="lb-name">Unknown card</span><span class="lb-sub"><i></i>Token ${serialLabel(serialOf(id))}</span></span></div>`;

  /** Build the tiles once per data change; filtering and sorting only toggle `hidden` and `order` (applyView). */
  function renderGrid() {
    const v = cur().view, key = `${cur().id}:${v.version}`;
    if (S.gridKey === key) return;
    S.gridKey = key;
    el.grid.innerHTML = v.rows.map(tileHtml).join("") + `<p class="lb-none" hidden>No cards match these filters.</p>`;
    tiles = [...el.grid.querySelectorAll(".lb-tile")];
    el.otherGrid.innerHTML = v.unknown.map(unknownHtml).join("");
  }

  function applyView() {
    const v = cur().view, F = S.filters;
    const shown = new Set(filterRows(v.rows, F));
    const order = sortRows(v.rows, F.sort);
    S.order = order.filter((r) => shown.has(r));
    order.forEach((r, k) => { const t = tiles[r.index]; if (!t) return; t.hidden = !shown.has(r); t.style.order = k; });
    const none = el.grid.querySelector(".lb-none");
    if (none) { none.hidden = shown.size > 0; none.style.order = 9999; }
    const filtering = F.kind !== "all" || F.element !== "all" || F.status !== "all" || F.q.trim();
    el.other.hidden = !v.unknown.length || !!filtering;
    updateNav();
  }

  // ------------------------------------------------------------------ detail (full-size card + the shared inspect panel)
  const tokenCard = (row, tokenId) => ({ ...row.card, tokenId, serial: serialOf(tokenId), owned: true });

  async function openDetail(row, tokenId) {
    const set = cur();
    if (!row.owned) return;
    const fresh = set.view.fresh;
    tokenId = tokenId ?? row.tokens.find((t) => fresh.has(t)) ?? row.tokens[0];
    const n = ++S.detailSeq;
    S.detail = { set, row, tokenId, n };
    root.classList.add("detail");
    el.hero.hidden = false;
    const card = tokenCard(row, tokenId);
    root.style.setProperty("--tier", RARITY[card.rarity].css);
    root.style.setProperty("--el", ELEMENT[card.element] ?? "#ffd37a");
    renderEditions();
    updateNav();
    pack?.panel?.show(card);
    el.card.innerHTML = `<div class="lb-wait">DRAWING…</div>`;
    try {
      const tex = await drawFace(card);
      if (S.detail?.n !== n) { tex.dispose(); return; }
      el.card.replaceChildren(tex.image);
      tex.dispose();                                   // the canvas is all we want; nothing was uploaded to the GPU
    } catch (e) {
      console.warn("[library] the card face could not be drawn", e);
      if (S.detail?.n === n) el.card.innerHTML = `<img src="${esc(card.art)}" alt="${esc(card.name)}">`;
    }
    seen(set, row.tokens);
  }

  function renderEditions() {
    const d = S.detail;
    if (!d) return;
    const fresh = d.set.view.fresh;
    el.edsTitle.textContent = d.row.count > 1 ? `Your ${d.row.count} copies` : "Your copy";
    el.eds.innerHTML = d.row.tokens.map((t) => `<button class="lb-chip" type="button" data-token="${t}" aria-pressed="${t === d.tokenId}"><i></i>${serialLabel(serialOf(t))}${fresh.has(t) ? " <b>NEW</b>" : ""}</button>`).join("");
  }

  // the data was reloaded while a card was open: keep showing it (its row may have changed)
  function refreshDetail() {
    const d = S.detail;
    const row = d && cur().view.rows[d.row.index];
    if (!row?.owned) { closeDetail(); return; }
    d.row = row;
    if (!row.tokens.includes(d.tokenId)) d.tokenId = row.tokens[0];
    renderEditions();
  }

  function closeDetail() {
    if (!S.detail) return;
    const idx = S.detail.row.index;
    S.detail = null; S.detailSeq++;
    root.classList.remove("detail");
    el.hero.hidden = true;
    el.card.style.removeProperty("--rx"); el.card.style.removeProperty("--ry");
    pack?.panel?.hide?.();
    tiles[idx]?.focus({ preventScroll: true });
  }

  function step(dir) {
    if (!S.detail) return;
    const list = S.order.filter((r) => r.owned);
    if (list.length < 2) return;
    const at = list.findIndex((r) => r.index === S.detail.row.index);
    openDetail(list[(at + dir + list.length) % list.length]);
  }
  function updateNav() {
    const many = S.order.filter((r) => r.owned).length > 1;
    el.prev.disabled = el.next.disabled = !many;
  }

  /** The player has looked at these tokens: they stop being NEW. */
  function seen(set, ids) {
    if (!ids.some((t) => set.view.fresh.has(t))) return;
    const addr = who();
    if (addr && !DEMO) set.holdings.markSeen(addr, ids, set.view.tokens.map((t) => t.tokenId));
    ids.forEach((t) => set.view.fresh.delete(t));
    rebuild(set);
    render();
  }

  // ------------------------------------------------------------------ open / close
  const canOpen = () => !pack || OPENABLE.has(pack.state);
  function syncButton() { btn.disabled = !S.open && !canOpen(); if (btn.disabled) btn.title = "Finish the pack first"; }

  function open() {
    if (S.open || !canOpen()) return;
    if (pack?.inspected) pack.inspect(null);
    S.open = true; S.openedAt = performance.now();
    root.hidden = false;
    document.body.classList.add("lib-open");
    render();
    requestAnimationFrame(() => root.classList.add("on"));
    el.close.focus({ preventScroll: true });
    for (const fn of toggles) fn(true);
    // catch up with anything that arrived since the last read, but never cut short a read that is already running
    const set = cur();
    if (!set.busy && Date.now() - (set.doneAt ?? 0) > STALE_MS) load(set);
  }
  function close() {
    if (!S.open) return;
    closeDetail();
    S.open = false;
    root.classList.remove("on");
    document.body.classList.remove("lib-open");
    setTimeout(() => { if (!S.open) root.hidden = true; }, 260);
    // looking at the library for a few seconds counts as seeing what is new in it
    if (performance.now() - S.openedAt > 3000) for (const s of sets) if (s.view.fresh.size) seen(s, [...s.view.fresh]);
    for (const fn of toggles) fn(false);
    renderButton();
    btn.focus({ preventScroll: true });
  }
  const toggle = () => (S.open ? close() : open());

  // ------------------------------------------------------------------ events
  btn.addEventListener("click", toggle);

  root.addEventListener("click", (e) => {
    const t = e.target;
    const act = t.closest("[data-act]")?.dataset.act;
    if (act === "close") return close();
    if (act === "close-detail") return closeDetail();
    if (act === "prev") return step(-1);
    if (act === "next") return step(1);
    if (act === "retry") return load(cur(), { deep: true, force: true });
    if (act === "open-pack") { close(); document.getElementById("open-pack")?.focus?.(); return; }
    if (act === "connect") {
      // the wallet button owns the whole connect flow (no wallet installed, phones, refused requests)
      const pill = document.querySelector("#wallet .w-pill");
      if (pill) pill.click();
      else wallet.connect().catch((err) => toast(err?.message ?? String(err)));
      return;
    }
    const kind = t.closest("[data-kind]"), elc = t.closest("[data-el]"), st = t.closest("[data-status]"), tok = t.closest("[data-token]"), setB = t.closest("[data-set]");
    if (kind) { S.filters.kind = kind.dataset.kind === S.filters.kind ? "all" : kind.dataset.kind; renderChips(); applyView(); return; }
    if (elc) { S.filters.element = elc.dataset.el === S.filters.element ? "all" : elc.dataset.el; renderChips(); applyView(); return; }
    if (st) { S.filters.status = st.dataset.status; renderChips(); applyView(); return; }
    if (setB) { S.setIdx = Number(setB.dataset.set); S.gridKey = ""; closeDetail(); render(); if (!cur().view.rows.length || cur().view.status === "idle") load(cur()); return; }
    if (tok && S.detail) { openDetail(S.detail.row, tok.dataset.token); return; }
    const tile = t.closest(".lb-tile");
    if (tile && tile.dataset.i != null) {
      const row = cur().view.rows[Number(tile.dataset.i)];
      if (row?.owned) openDetail(row);
      else toast(`${row.card.kind} · ${row.card.path}: not in your collection yet. Open packs to find it.`);
    }
  });

  let qTimer = 0;
  el.q.addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.filters.q = el.q.value; applyView(); }, 90); });
  el.sort.addEventListener("change", () => { S.filters.sort = el.sort.value; applyView(); });

  // keep wheel / touch scrolling inside the library from reaching the canvas orbit controls
  for (const ev of ["pointerdown", "wheel", "touchstart"]) root.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });

  // a little tilt on the full-size card
  el.stage.addEventListener("pointermove", (e) => {
    if (reduced || e.pointerType === "touch") return;
    const b = el.stage.getBoundingClientRect();
    const x = (e.clientX - b.left) / b.width - 0.5, y = (e.clientY - b.top) / b.height - 0.5;
    el.card.style.setProperty("--ry", `${(x * 12).toFixed(2)}deg`);
    el.card.style.setProperty("--rx", `${(-y * 12).toFixed(2)}deg`);
  });
  el.stage.addEventListener("pointerleave", () => { el.card.style.setProperty("--rx", "0deg"); el.card.style.setProperty("--ry", "0deg"); });

  // closing the inspect panel with its own X leaves the library detail too (capture: before the panel's own handler)
  panelEl?.addEventListener("click", (e) => { if (S.detail && e.target.closest("[data-close]")) closeDetail(); }, true);

  addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName ?? "") || e.target?.isContentEditable;
    if (e.key === "Escape") {
      if (S.detail) { closeDetail(); e.preventDefault(); } else if (S.open) { if (typing && el.q.value) { el.q.value = ""; S.filters.q = ""; applyView(); } else close(); e.preventDefault(); }
      return;
    }
    if (typing) return;
    if ((e.key === "l" || e.key === "L") && !e.repeat) { toggle(); return; }
    if (S.detail && e.key === "ArrowLeft") { step(-1); e.preventDefault(); }
    if (S.detail && e.key === "ArrowRight") { step(1); e.preventDefault(); }
  });

  // ------------------------------------------------------------------ wiring to the wallet and the pack
  let lastAddr = who();
  wallet.subscribe(() => {
    const now = who();
    if (now === lastAddr) return;
    lastAddr = now;
    for (const s of sets) { s.view.tokens = []; s.view.fresh = new Set(); s.view.status = "idle"; s.view.read = null; s.deepAt = 0; s.doneAt = 0; rebuild(s); }
    S.gridKey = "";
    render();
    loadAll();
  });

  // a live pack just minted cards to this wallet: remember them at once (the explorer takes a while) and flag them NEW
  pack?.events?.addEventListener("done", (e) => {
    const addr = who();
    const minted = (e.detail?.cards ?? []).filter((c) => c.owned && c.tokenId);
    if (!addr || DEMO || !minted.length) return;
    for (const s of sets) {
      const ids = [];
      for (const c of minted) {
        const src = s.collection.cards.find((k) => k.slug === c.slug);
        if (!src) continue;
        s.holdings.learn(c.tokenId, src.tokenId);
        ids.push(String(c.tokenId));
      }
      if (ids.length) s.holdings.remember(addr, ids);
    }
    loadAll({ deep: false });
    setTimeout(() => loadAll({ deep: false }), 8000);     // and once more after the explorer has indexed the mint
  });

  setInterval(syncButton, 400);
  setInterval(() => { if (S.open && !document.hidden && !S.detail && !cur().busy) load(cur()); }, POLL_MS);
  syncButton();
  renderButton();
  loadAll();

  return {
    open, close, toggle,
    refresh: (o) => loadAll(o),
    /** fn(open: boolean) whenever the library opens or closes (main.js pauses the 3D render while it covers the hall). */
    onToggle(fn) { toggles.add(fn); return () => toggles.delete(fn); },
    isOpen: () => S.open,
    sets,
  };
}

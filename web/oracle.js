// FORGE — the Oracle: the covenant (terms of use) and the Trial of the Heavens, a short astrolabe puzzle a new player
// passes once, after the prologue, before entering the forge. title.js opens it inside the title root (everything else
// in <body> is inert while the title shows) and holds "Enter the forge" until it resolves.
// It is a themed gate and a clear moment to accept the terms, not a security measure: a determined bot can solve it.
// Passing stores COVENANT (oraclecore.js) in localStorage; a new covenant shows it again. ?oracle=1 always shows it.
import { COVENANT, SLOTS, makeTrial, aligned, solved, atGate, turnToGate, glyphText, mod } from "./oraclecore.js";

const KEY = "forge.covenant";
const Q = new URLSearchParams(location.search);
import { store, REDUCED_MOTION as REDUCED } from "./util.js";

/** Whether this browser still has to swear to the current covenant. */
export function oracleNeeded() {
  return Q.get("oracle") === "1" || store.get(KEY) !== COVENANT;
}

/**
 * Show the Oracle in `host` (the title root). Resolves once the player has accepted the terms and passed the trial.
 * @param {HTMLElement} host
 * @param {{ chime?: () => void, boom?: () => void }} [sound]  the title's sound, if it has one
 */
export function openOracle(host, sound = {}) {
  styles();
  return new Promise((resolve) => new Oracle(host, sound, resolve));
}

function styles() {
  if (document.getElementById("oracle-css")) return;
  const fonts = document.createElement("link");
  fonts.rel = "stylesheet";
  fonts.href = "https://fonts.googleapis.com/css2?family=Noto+Sans+Symbols&display=swap"; // planets + zodiac as text, everywhere
  const css = document.createElement("link");
  css.id = "oracle-css";
  css.rel = "stylesheet";
  css.href = new URL("./oracle.css", import.meta.url).href; // beside this module, whatever page loads it
  document.head.append(fonts, css);
}

const C = 200;                                        // astrolabe centre (viewBox 400 x 400)
const RINGS = [{ r0: 140, r1: 178 }, { r0: 98, r1: 136 }, { r0: 58, r1: 94 }]; // band radii, outer to inner
const STEP = 360 / SLOTS;
const SVGNS = "http://www.w3.org/2000/svg";

class Oracle {
  constructor(host, sound, resolve) {
    this.sound = sound;
    this.resolve = resolve;
    this.trial = makeTrial();
    const g = this.trial.god;
    const el = this.el = document.createElement("div");
    el.className = "oracle";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-labelledby", "or-h1");
    el.innerHTML = `
      <canvas class="or-sky" aria-hidden="true"></canvas>
      <section class="or-card" data-step="covenant">
        <div class="or-meander" aria-hidden="true"></div>
        <div class="or-step or-covenant">
          <p class="or-kicker">Before the forge opens</p>
          <h1 id="or-h1">The Oracle's Covenant</h1>
          <ol class="or-terms">
            <li><b>A testnet product.</b> zkLTC and the cards minted here are test tokens with no monetary value; the network may be reset at any time.</li>
            <li><b>Use at your own risk.</b> It is experimental and without warranty. You answer for your wallet and every transaction you sign.</li>
            <li><b>Open and decentralized.</b> An open-source "NFT Agent" minting platform for ERC-6699 agent characters and games. <a href="https://litvm.games/whitepaper" target="_blank" rel="noopener">Whitepaper</a></li>
            <li><b>For learning.</b> Built for education and research: to stretch the boundaries of cryptography and decentralized networks, for the betterment of humanity.</li>
          </ol>
          <p class="or-full"><a href="./terms.html" target="_blank" rel="noopener">Read the full terms</a></p>
          <button class="or-btn or-accept" type="button">I accept the covenant</button>
        </div>
        <div class="or-step or-trial" hidden>
          <p class="or-kicker">Trial of the Heavens</p>
          <h1 class="or-h">Align the sigils of <span class="or-god">${g.name}</span></h1>
          <p class="or-ask">Turn the rings until each sigil rests beneath the golden star.</p>
          <ul class="or-want" aria-label="The sigils of ${g.name}">
            <li data-ring="0"><i>${glyphText(g.planet)}</i><span>${g.planetName}</span></li>
            <li data-ring="1"><i>${glyphText(g.sign)}</i><span>${g.signName}</span></li>
            <li data-ring="2"><i class="greek">${g.letter}</i><span>${g.greek}</span></li>
          </ul>
          <div class="or-astro"></div>
          <p class="or-help">${matchMedia("(pointer: coarse)").matches ? "Drag a ring, or tap a sigil to turn it to the star." : "Drag a ring, or click a sigil to turn it to the star. Keyboard: Tab to a ring, arrows to turn."}</p>
          <p class="or-verdict" aria-live="polite"></p>
          <button class="or-btn or-enter" type="button" disabled>Enter the Forge</button>
        </div>
      </section>`;
    host.append(el);
    this.$ = (s) => el.querySelector(s);
    this.sky = new Sky(this.$(".or-sky"));
    this.buildAstrolabe();
    this.$(".or-accept").addEventListener("click", () => this.toTrial());
    this.$(".or-enter").addEventListener("click", () => this.close());
    // keep every key inside the dialog: the title listens on window for Space / Enter strikes
    el.addEventListener("keydown", (e) => e.stopPropagation());
    requestAnimationFrame(() => { el.classList.add("on"); this.$(".or-accept").focus({ preventScroll: true }); });
  }

  toTrial() {
    const card = this.$(".or-card");
    card.dataset.step = "trial";
    this.$(".or-covenant").hidden = true;
    this.$(".or-trial").hidden = false;
    this.sound.chime?.();
    this.sky.burst(innerWidth / 2, innerHeight * 0.3, 40, "gold");
    this.render(true);
    requestAnimationFrame(() => this.ringEls[0].focus({ preventScroll: true }));
  }

  // -------------------------------------------------------------- astrolabe
  buildAstrolabe() {
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", "0 0 400 400");
    svg.setAttribute("class", "or-svg");
    const defs = `
      <defs>
        <linearGradient id="or-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#fff1c4"/><stop offset=".35" stop-color="#e8b25a"/><stop offset=".7" stop-color="#9a5f1c"/><stop offset="1" stop-color="#ffd98a"/>
        </linearGradient>
        <radialGradient id="or-band" cx="200" cy="200" r="190" gradientUnits="userSpaceOnUse">
          <stop offset=".25" stop-color="#1d1730"/><stop offset=".7" stop-color="#120f1f"/><stop offset="1" stop-color="#241a14"/>
        </radialGradient>
        <radialGradient id="or-core" cx="50%" cy="45%" r="60%">
          <stop offset="0" stop-color="#fff6d8"/><stop offset=".35" stop-color="#ffc35a"/><stop offset=".75" stop-color="#b8561a"/><stop offset="1" stop-color="#3a1608"/>
        </radialGradient>
        <linearGradient id="or-beam" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#fff1c4" stop-opacity=".55"/><stop offset="1" stop-color="#ffb347" stop-opacity="0"/>
        </linearGradient>
        <filter id="or-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>`;
    let ticks = "";
    for (let a = 0; a < 360; a += 5) {
      const long = a % 45 === 0, r0 = long ? 181 : 184;
      const [x0, y0] = polar(r0, a), [x1, y1] = polar(189, a);
      ticks += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" class="${long ? "tk long" : "tk"}"/>`;
    }
    let rays = "";
    for (let a = 0; a < 360; a += 22.5) {
      const [x0, y0] = polar(30, a), [x1, y1] = polar(a % 45 ? 46 : 52, a);
      rays += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"/>`;
    }
    svg.innerHTML = `${defs}
      <circle cx="200" cy="200" r="197" class="bezel-out"/>
      <circle cx="200" cy="200" r="190" class="bezel"/>
      <g class="ticks">${ticks}</g>
      <path class="gate-window" d="${wedge(54, 180, -STEP / 2 + 2, STEP / 2 - 2)}"/>
      <g class="rings"></g>
      <path class="gate-beam" d="${wedge(54, 180, -STEP / 2 + 6, STEP / 2 - 6)}"/>
      <g class="core">
        <g class="core-rays">${rays}</g>
        <circle cx="200" cy="200" r="27" class="core-disc"/>
        <circle cx="200" cy="200" r="27" class="core-ring"/>
        <circle cx="200" cy="200" r="70" class="shock"/>
      </g>
      <g class="gate-star" filter="url(#or-glow)"><path d="${star(200, 13, 15, 6.2)}"/></g>`;
    const ringsG = svg.querySelector(".rings");
    this.ringEls = this.trial.rings.map((ring, i) => {
      const { r0, r1 } = RINGS[i];
      const g = document.createElementNS(SVGNS, "g");
      g.setAttribute("class", `ring ring-${ring.kind}`);
      g.setAttribute("tabindex", "0");
      g.setAttribute("role", "slider");
      g.setAttribute("aria-label", ring.label);
      g.setAttribute("aria-valuemin", "0");
      g.setAttribute("aria-valuemax", String(SLOTS - 1));
      let inner = `<path class="band" d="${annulus(r0, r1)}"/>`;
      for (let j = 0; j < SLOTS; j++) {
        const [x0, y0] = polar(r0 + 2, j * STEP + STEP / 2), [x1, y1] = polar(r1 - 2, j * STEP + STEP / 2);
        inner += `<line class="div" x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"/>`;
      }
      const rg = (r0 + r1) / 2;
      ring.glyphs.forEach((gl, j) => {
        inner += `<g class="slot" data-j="${j}" transform="rotate(${j * STEP} 200 200)">
          <text x="200" y="${C - rg}" class="glyph ${ring.kind === "letters" ? "greek" : "astro"}" text-anchor="middle" dominant-baseline="central">${glyphText(gl)}</text>
        </g>`;
      });
      g.innerHTML = inner;
      ringsG.append(g);
      return g;
    });
    this.$(".or-astro").append(svg);
    this.svg = svg;
    this.bindDrag();
  }

  bindDrag() {
    const svg = this.svg;
    const toSvg = (e) => {
      const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
      return { x: p.x - C, y: p.y - C };
    };
    const angle = (p) => (Math.atan2(p.x, -p.y) * 180) / Math.PI; // clockwise from the top
    svg.addEventListener("pointerdown", (e) => {
      if (this.done) return;
      const p = toSvg(e), r = Math.hypot(p.x, p.y);
      const i = RINGS.findIndex((b) => r >= b.r0 - 3 && r <= b.r1 + 3);
      if (i < 0) return;
      e.preventDefault();
      try { svg.setPointerCapture(e.pointerId); } catch { /* a synthetic or already-lifted pointer: drag without capture */ }
      this.drag = { i, id: e.pointerId, a0: angle(p), t0: this.trial.rings[i].turn, moved: false,
                    slot: e.target.closest(".slot")?.dataset.j };
      this.ringEls[i].classList.add("grab");
    });
    svg.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      let delta = angle(toSvg(e)) - d.a0;
      delta = mod(delta + 180, 360) - 180;
      if (!d.moved && Math.abs(delta) > 4) d.moved = true;
      if (!d.moved) return;
      d.a0 += delta; // accumulate so laps past +-180 keep turning
      const ring = this.trial.rings[d.i];
      ring.turn += delta / STEP;
      this.ringEls[d.i].classList.add("dragging");
      this.render();
    });
    const end = (e) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      this.drag = null;
      const ring = this.trial.rings[d.i], el = this.ringEls[d.i];
      el.classList.remove("dragging", "grab");
      if (!d.moved && d.slot !== undefined) ring.turn = turnToGate(ring, +d.slot); // a click on a sigil brings it to the star
      else ring.turn = Math.round(ring.turn);
      this.render(true);
    };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", end);
    this.ringEls.forEach((el, i) => el.addEventListener("keydown", (e) => {
      const k = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
      if (!k || this.done) return;
      e.preventDefault();
      this.trial.rings[i].turn = Math.round(this.trial.rings[i].turn) + k;
      this.render(true);
    }));
  }

  /** Draw the rings at their turns; on a snapped render, react to rings locking in and the trial being solved. */
  render(snapped = false) {
    this.trial.rings.forEach((ring, i) => {
      const el = this.ringEls[i];
      el.style.transform = `rotate(${ring.turn * STEP}deg)`;
      el.setAttribute("aria-valuenow", String(atGate(ring)));
      el.setAttribute("aria-valuetext", `${ring.glyphs[atGate(ring)]} at the star`);
      if (!snapped) return;
      const ok = aligned(ring);
      const was = el.classList.contains("locked");
      el.classList.toggle("locked", ok);
      el.querySelectorAll(".slot").forEach((s) => {
        s.classList.toggle("lit", ok && +s.dataset.j === ring.target);
        if (!ok) s.classList.remove("pulse"); // so it pulses again the next time this ring locks in
      });
      this.$(`.or-want li[data-ring="${i}"]`).classList.toggle("ok", ok);
      if (ok && !was) this.lockIn(i);
    });
    if (snapped && !this.done && solved(this.trial)) this.win();
  }

  lockIn(i) {
    this.sound.chime?.();
    const lit = this.ringEls[i].querySelector(".slot.lit text");
    // the rotation transition is still running: spark where the sigil will rest, at the gate
    const box = this.svg.getBoundingClientRect(), k = box.width / 400, rg = (RINGS[i].r0 + RINGS[i].r1) / 2;
    this.sky.burst(box.left + C * k, box.top + (C - rg) * k, 22, "gold");
    lit?.closest(".slot")?.classList.add("pulse");
  }

  win() {
    this.done = true;
    const el = this.el, g = this.trial.god;
    setTimeout(() => {
      el.classList.add("solved");
      this.sound.boom?.();
      const box = this.svg.getBoundingClientRect();
      this.sky.burst(box.left + box.width / 2, box.top + box.height / 2, REDUCED ? 30 : 140, "mixed");
      this.sky.meteors(REDUCED ? 0 : 7);
      this.$(".or-verdict").textContent = `The heavens align. ${g.name} grants you passage.`;
      const btn = this.$(".or-enter");
      btn.disabled = false;
      btn.focus({ preventScroll: true });
    }, 420);
  }

  close() {
    store.set(KEY, COVENANT);
    this.el.classList.add("leaving");
    setTimeout(() => { this.sky.stop(); this.el.remove(); this.resolve(); }, REDUCED ? 50 : 650);
  }
}

// -------------------------------------------------------------- geometry
function polar(r, deg) {
  const a = (deg * Math.PI) / 180;
  return [+(C + r * Math.sin(a)).toFixed(2), +(C - r * Math.cos(a)).toFixed(2)];
}
function annulus(r0, r1) {
  return `M${C} ${C - r1}A${r1} ${r1} 0 1 1 ${C} ${C + r1}A${r1} ${r1} 0 1 1 ${C} ${C - r1}Z` +
         `M${C} ${C - r0}A${r0} ${r0} 0 1 0 ${C} ${C + r0}A${r0} ${r0} 0 1 0 ${C} ${C - r0}Z`;
}
function star(cx, cy, ro, ri) {
  let d = "";
  for (let k = 0; k < 10; k++) {
    const r = k % 2 ? ri : ro, a = (k * Math.PI) / 5;
    d += `${k ? "L" : "M"}${(cx + r * Math.sin(a)).toFixed(2)} ${(cy - r * Math.cos(a)).toFixed(2)}`;
  }
  return d + "Z";
}
function wedge(r0, r1, a0, a1) {
  const [x0, y0] = polar(r1, a0), [x1, y1] = polar(r1, a1), [x2, y2] = polar(r0, a1), [x3, y3] = polar(r0, a0);
  return `M${x0} ${y0}A${r1} ${r1} 0 0 1 ${x1} ${y1}L${x2} ${y2}A${r0} ${r0} 0 0 0 ${x3} ${y3}Z`;
}

// -------------------------------------------------------------- the night sky behind the card
class Sky {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext("2d");
    this.sparks = [];
    this.trails = [];
    this.resize();
    this.onResize = () => this.resize();
    addEventListener("resize", this.onResize);
    this.last = performance.now();
    const loop = (now) => { if (this.dead) return; this.frame(Math.min(0.05, (now - this.last) / 1000), now / 1000); this.last = now; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = innerWidth; this.h = innerHeight;
    this.c.width = Math.round(this.w * dpr); this.c.height = Math.round(this.h * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round(Math.min(260, (this.w * this.h) / 5200));
    this.stars = Array.from({ length: n }, () => ({
      x: Math.random() * this.w, y: Math.random() * this.h, r: Math.random() ** 3 * 1.6 + 0.35,
      tw: Math.random() * 6.3, sp: 0.6 + Math.random() * 1.8, warm: Math.random() < 0.3,
    }));
  }

  burst(x, y, n, tone = "gold") {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 60 + Math.random() * (tone === "mixed" ? 420 : 220);
      const hue = tone === "mixed" ? [42, 48, 200, 270, 30][i % 5] : 38 + Math.random() * 14;
      this.sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40, life: 0, max: 0.6 + Math.random() * 0.9,
                         r: 0.8 + Math.random() * 2.2, hue });
    }
  }

  meteors(n) {
    for (let i = 0; i < n; i++) {
      const x = Math.random() * this.w * 0.9, y = Math.random() * this.h * 0.35;
      this.trails.push({ x, y, vx: 520 + Math.random() * 380, vy: 160 + Math.random() * 160, life: -i * 0.18, max: 0.9 });
    }
  }

  frame(dt, t) {
    const g = this.g;
    g.clearRect(0, 0, this.w, this.h);
    for (const s of this.stars) {
      const a = REDUCED ? 0.7 : 0.45 + 0.55 * Math.sin(t * s.sp + s.tw) ** 2;
      g.globalAlpha = a;
      g.fillStyle = s.warm ? "#ffe3b0" : "#dfe8ff";
      g.beginPath(); g.arc(s.x, s.y, s.r, 0, Math.PI * 2); g.fill();
      if (s.r > 1.4) { // the bright ones get a soft cross
        g.globalAlpha = a * 0.35;
        g.fillRect(s.x - s.r * 4, s.y - 0.4, s.r * 8, 0.8);
        g.fillRect(s.x - 0.4, s.y - s.r * 4, 0.8, s.r * 8);
      }
    }
    g.globalCompositeOperation = "lighter";
    this.sparks = this.sparks.filter((p) => (p.life += dt) < p.max);
    for (const p of this.sparks) {
      p.vx *= 1 - 1.6 * dt; p.vy = p.vy * (1 - 1.6 * dt) + 60 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      const k = 1 - p.life / p.max;
      g.globalAlpha = k;
      g.fillStyle = `hsl(${p.hue} 100% ${62 + 25 * k}%)`;
      g.beginPath(); g.arc(p.x, p.y, p.r * (0.6 + k), 0, Math.PI * 2); g.fill();
    }
    this.trails = this.trails.filter((m) => (m.life += dt) < m.max);
    for (const m of this.trails) {
      if (m.life < 0) continue;
      m.x += m.vx * dt; m.y += m.vy * dt;
      const k = 1 - m.life / m.max, len = 0.09;
      const grad = g.createLinearGradient(m.x, m.y, m.x - m.vx * len, m.y - m.vy * len);
      grad.addColorStop(0, `rgba(255, 240, 210, ${k})`); grad.addColorStop(1, "rgba(255, 190, 90, 0)");
      g.globalAlpha = 1; g.strokeStyle = grad; g.lineWidth = 2;
      g.beginPath(); g.moveTo(m.x, m.y); g.lineTo(m.x - m.vx * len, m.y - m.vy * len); g.stroke();
    }
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;
  }

  stop() { this.dead = true; removeEventListener("resize", this.onResize); }
}

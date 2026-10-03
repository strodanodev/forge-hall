// FORGE — AERIS, the forge's NPC host.
// A 2D portrait (four keyed pose sheets + a closed-mouth frame for lip-flap) with a typewriter dialogue box. It hosts
// the hall (click-through intro) and narrates the pack sequence from its story beats (auto-advancing "comms" mode).
// Pure DOM/CSS, transform/opacity only, so it costs the WebGL frame nothing. Lines live in npc_script.js.
import { NPC, SCRIPT } from "./npc_script.js";

const POSES = ["idle", "talking", "talking_closed", "happy", "thinking"];
const CPS = 44;                                   // typing speed, characters per second
const PAUSE = { ",": 0.1, ";": 0.12, ":": 0.12, ".": 0.26, "!": 0.26, "?": 0.26, "…": 0.34, "—": 0.16 };
const ACCENT = { legendary: "#ffbf3f", epic: "#c68bff", rare: "#5bb2ff", common: "#dfe6ee" };
const RANK = { common: 0, rare: 1, epic: 2, legendary: 3 };
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

export class ForgeNPC {
  /** @param {HTMLElement} root  empty #npc container   @param {import("./pack.js").PackOpening} pack */
  constructor(root, pack) {
    this.root = root;
    this.pack = pack;
    root.dataset.mode = "off";
    root.innerHTML = `
      <div class="npc-stage">
        <div class="npc-glow"></div>
        <div class="npc-breathe"><div class="npc-figure" title="Talk to ${NPC.name}">
          ${POSES.map((p) => `<img class="npc-pose" data-pose="${p}" src="./assets/npc/aeris_${p}.webp" alt="" draggable="false">`).join("")}
        </div></div>
      </div>
      <div class="npc-box hide" role="status" aria-live="polite">
        <div class="npc-plate"><b>${NPC.name}</b><span>${NPC.title}</span></div>
        <p class="npc-text"></p>
        <i class="npc-next" aria-hidden="true"></i>
      </div>`;
    const $ = (s) => root.querySelector(s);
    this.stage = $(".npc-stage"); this.figure = $(".npc-figure"); this.box = $(".npc-box"); this.textEl = $(".npc-text");
    this.imgs = Object.fromEntries([...root.querySelectorAll(".npc-pose")].map((i) => [i.dataset.pose, i]));
    // decode every pose up front: a first-time decode of a 1k image mid-pack would hitch the WebGL frame
    this.ready = Promise.all(Object.values(this.imgs).map((i) => i.decode().catch(() => {})));

    this.pose = null; this.emotion = null;
    this.queue = []; this.line = null;
    this.setPose("idle");

    this.box.addEventListener("click", () => this.advance());
    this.figure.addEventListener("click", () => this.poke());
    addEventListener("keydown", (e) => {
      if ((e.key === " " || e.key === "Enter") && this.line?.waiting && !/^(BUTTON|INPUT|TEXTAREA|A)$/.test(e.target.tagName)) {
        e.preventDefault(); this.advance();
      }
    });
    this.bindPack();
  }

  // -------------------------------------------------------------- public
  async enter() {
    await this.ready;
    this.root.dataset.mode = this.wanted ?? "host";
    await new Promise((r) => setTimeout(r, 650));      // let her slide in before she speaks
    if (this.pack.state === "idle" && !this.line) this.say(this.pack.shop?.live ? SCRIPT.hall.introLive : SCRIPT.hall.intro, { auto: false });
  }

  /** Queue lines. interrupt: drop whatever is playing. auto: advance on a timer instead of waiting for a click. */
  say(lines, { auto = true, interrupt = true, card = null } = {}) {
    const items = lines.map(([emotion, text]) => ({ emotion, text: fill(text, card), auto, accent: card ? ACCENT[card.rarity] : null }));
    if (interrupt) { this.queue = items; this.next(); }
    else { this.queue.push(...items); if (!this.line) this.next(); }
  }

  // -------------------------------------------------------------- pack beats
  bindPack() {
    const P = SCRIPT.pack, on = (type, fn) => this.pack.events.addEventListener(type, (e) => fn(e.detail));
    on("open", ({ again }) => { this.skipped = false; this.mode("comms"); this.say(pick(again ? P.again : P.open)); });
    // live shop: wallet steps happen in the hall, the wait for the chain with the sealed pack on screen
    on("wallet", () => { this.mode("comms"); this.say(pick(P.wallet)); });
    on("sealing", () => this.say(pick(P.sealing), { interrupt: false }));
    on("signing", () => this.say(pick(P.signing)));
    on("chainError", () => { if (this.pack.state === "idle") this.mode("host"); this.say(pick(P.error)); });
    on("tear", () => { if (!this.skipped) this.say(pick(P.tear)); });
    on("burst", () => { if (!this.skipped) this.say(pick(P.burst)); });
    on("skip", () => { this.skipped = true; this.say(pick(P.skip)); });
    on("reveal", () => this.say(pick(P.reveal), { interrupt: !this.skipped }));
    on("flip", ({ card }) => { if (RANK[card.rarity] >= 2) this.say(pick(card.rarity === "legendary" ? P.legendary : P.epic), { card }); });
    // the best card's own line (from flip) finishes first, then the wrap-up
    on("done", ({ best }) => this.say(pick(P.done[best.rarity]), { card: best, interrupt: false }));
    on("inspect", ({ card }) => { if (card) this.say(pick(P.inspect[card.kind] ?? P.inspect.God), { card }); });
    on("leave", () => this.say(pick(SCRIPT.hall.welcomeBack)));
    on("idle", () => this.mode("host"));
  }

  // before enter() finishes (still "off") remember the mode, so a pack opened early still gets comms
  mode(m) { this.wanted = m; if (this.root.dataset.mode !== "off") this.root.dataset.mode = m; }

  poke() {
    if (this.root.dataset.mode !== "host") return;
    if (this.line?.waiting || this.line?.typing) return this.advance();
    this.say(pick(SCRIPT.hall.chatter));
  }

  // -------------------------------------------------------------- dialogue
  next() {
    const item = this.queue.shift();
    if (!item) { this.close(); return; }
    this.line = { ...item, i: 0, acc: 0, delay: 0, flap: 0, hold: 0, typing: true, waiting: false };
    this.box.style.setProperty("--em", item.accent ?? "#ffd37a");
    this.chars = renderLine(this.textEl, item.text);
    this.box.classList.remove("hide", "wait");
    this.setEmotion(item.emotion);
    this.run();
  }

  advance() {
    const L = this.line;
    if (!L) return;
    if (L.typing) { this.finishTyping(); return; }   // first click completes the line, the next one moves on
    this.next();
  }

  close() {
    this.line = null;
    this.box.classList.add("hide");
    this.box.classList.remove("wait");
    this.setEmotion("idle");
  }

  finishTyping() {
    const L = this.line;
    for (const c of this.chars) c.classList.add("on");
    L.i = this.chars.length; L.typing = false;
    if (this.emotion === "talking") this.setPose("talking_closed"); // rest with the mouth shut, finger still up
    if (L.auto) L.hold = Math.max(1.7, 0.9 + this.chars.length / 30);
    else { L.waiting = true; this.box.classList.add("wait"); }
  }

  run() {
    if (this.raf) return;
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      this.raf = this.tick(dt) ? requestAnimationFrame(step) : 0;
    };
    this.raf = requestAnimationFrame(step);
  }

  // returns whether the loop still has work
  tick(dt) {
    const L = this.line;
    if (!L) return false;
    if (L.typing) {
      if (L.delay > 0) L.delay -= dt;
      else {
        L.acc += dt * CPS;
        while (L.acc >= 1 && L.i < this.chars.length) {
          L.acc -= 1;
          const el = this.chars[L.i++], ch = el.textContent;
          el.classList.add("on");
          if (PAUSE[ch] && L.i < this.chars.length) { L.delay = PAUSE[ch]; L.acc = 0; break; }
          if (ch === " " && this.emotion !== "talking") this.bob(); // non-talking poses nod a beat per word
        }
        if (L.i >= this.chars.length) this.finishTyping();
      }
      // lip-flap: talking pose alternates open/closed mouth while letters land, shuts during punctuation pauses
      if (L.typing && this.emotion === "talking") {
        L.flap -= dt;
        if (L.delay > 0) this.setPose("talking_closed");
        else if (L.flap <= 0) { L.flap = 0.075 + Math.random() * 0.06; this.setPose(this.pose === "talking" ? "talking_closed" : "talking"); }
      }
      return true;
    }
    if (L.waiting) return false;                     // click-gated: nothing to animate until the player advances
    L.hold -= dt;
    if (L.hold <= 0) { this.next(); return !!this.line; }
    return true;
  }

  // -------------------------------------------------------------- poses
  setEmotion(e) {
    if (e === this.emotion) return;
    const prev = this.emotion;
    this.emotion = e;
    this.setPose(e, true);
    if (prev && !reduceMotion) this.react(e);
  }

  // Cross-dissolve by fading the new pose in over the old one (both would go half-transparent in a plain crossfade,
  // and the silhouettes mostly overlap). Lip-flap swaps are instant.
  setPose(p, fade = false) {
    if (p === this.pose) return;
    const old = this.imgs[this.pose], img = this.imgs[p];
    this.pose = p;
    for (const i of Object.values(this.imgs)) if (i !== img && i !== old) i.className = "npc-pose";
    if (old) old.className = fade ? "npc-pose was" : "npc-pose";
    img.className = fade ? "npc-pose on fade" : "npc-pose on";
    if (fade && old) setTimeout(() => { if (this.imgs[this.pose] !== old) old.className = "npc-pose"; }, 220);
  }

  // a small body reaction per emotion change (Web Animations: compositor-only, no style recalcs per frame)
  react(e) {
    const k = {
      happy: [{ transform: "none" }, { transform: "translateY(-2.2%) scale(1.025)" }, { transform: "translateY(.4%) scale(.995)" }, { transform: "none" }],
      thinking: [{ transform: "none" }, { transform: "translateY(1%) rotate(-.6deg)" }, { transform: "none" }],
      talking: [{ transform: "none" }, { transform: "translateY(-1%)" }, { transform: "none" }],
      idle: [{ transform: "none" }, { transform: "translateY(.5%)" }, { transform: "none" }],
    }[e];
    if (k) this.figure.animate(k, { duration: e === "happy" ? 520 : 420, easing: "cubic-bezier(.3,.7,.3,1)" });
  }

  bob() {
    if (reduceMotion) return;
    this.figure.animate([{ transform: "none" }, { transform: "translateY(-.5%)" }, { transform: "none" }], { duration: 220, easing: "ease-out" });
  }
}

// ---------------------------------------------------------------- text
function fill(text, card) {
  if (!card) return text;
  return text.replace(/\{(\w+)\}/g, (m, k) => {
    const v = card[k] ?? card[k.toLowerCase()];
    return v == null ? m : k === k.toUpperCase() ? String(v).toUpperCase() : String(v);
  });
}

// Lay the whole line out up front (one span per character, invisible) and reveal in place: words never jump to the
// next row mid-type. *word* renders in the accent colour.
function renderLine(el, text) {
  el.textContent = "";
  const chars = [];
  let em = false;
  for (const ch of text) {
    if (ch === "*") { em = !em; continue; }
    const s = document.createElement("span");
    s.className = em ? "c em" : "c";
    s.textContent = ch;
    el.appendChild(s);
    chars.push(s);
  }
  return chars;
}

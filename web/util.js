// FORGE — small helpers the DOM modules share. No three.js here, so Node tests can import it too.

/** HTML-escape a value for an innerHTML template. */
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** 0x1234…abcd */
export const shortAddress = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** localStorage that never throws (private mode, blocked storage): a read gives null, a write is dropped. */
export const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* remember nothing */ } },
};

/** The player asked for less motion. */
export const REDUCED_MOTION = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

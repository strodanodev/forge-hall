// FORGE — pack tiers, kept free of three.js so plain modules (and their Node tests) can use them.
// Rapture has no rarity: Kind is the only tier. The pack's ladder (odds, frame colour, flip FX) follows it.
export const RANK = { common: 0, rare: 1, epic: 2, legendary: 3 };
export const RARITY = {
  common: { label: "COMMON", css: "#c9d2dc", glow: 0xbcd0ff, fx: 0.5 },
  rare: { label: "RARE", css: "#46a6ff", glow: 0x3f9dff, fx: 0.8 },
  epic: { label: "EPIC", css: "#b76bff", glow: 0xa455ff, fx: 1.1 },
  legendary: { label: "LEGENDARY", css: "#ffbf3f", glow: 0xffae2a, fx: 1.7 },
};

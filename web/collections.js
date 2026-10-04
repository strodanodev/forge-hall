// FORGE — the sets the Card Library knows about.
//
// A "set" is one collection snapshot (scripts/rapture_snapshot.mjs writes assets/rapture/cards.json for the current
// deployment). To show a future ARC in the library, add an entry here with its own snapshot; nothing else changes.
// The in-game 22 GODS cards are not a separate set: they are these same ARC 1 tokens (the game reads them with ownerOf
// on Liteforge), so a wallet's ARC 1 cards are also its 22 GODS cards.
//
// No imports: main.js hands in the loader, so this module also loads in Node.

export const LIBRARY_SETS = Object.freeze([
  { id: "rapture-arc1", title: "Rapture · ARC 1", subtitle: "Studio Test set · LitVM Liteforge", snapshot: "./assets/rapture/cards.json", primary: true },
]);

/**
 * -> [{ id, title, subtitle, collection }]
 *   primary  the collection main.js already loaded (and adapted for a local dev chain); it stands in for the primary entry
 *   load     (url) => Promise<collection>, i.e. rapture.js loadCollection
 * A set whose snapshot cannot be loaded is left out (and logged), never blocking the others.
 */
export async function loadSets({ primary, load, sets = LIBRARY_SETS }) {
  const out = [];
  for (const s of sets) {
    try {
      const collection = s.primary ? primary : await load(s.snapshot);
      if (collection?.cards?.length) out.push({ id: s.id, title: s.title, subtitle: s.subtitle, collection });
    } catch (e) {
      console.warn(`[library] the set "${s.id}" could not be loaded and is skipped`, e);
    }
  }
  return out;
}

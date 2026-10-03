// FORGE — the Card Library's view model: which cards are owned, how far the set is complete, and what the filters show.
// Pure functions, no DOM and no three.js, so the filters and progress maths have Node tests (web/test/library.test.mjs).

/** The Kind ladder, lowest to highest. Kind is Rapture's only tier. */
export const KINDS = ["Mortal", "King", "Demigod", "God", "Titan"];
export const ELEMENTS = ["Water", "Lava", "Earth", "Metal"];
const TIER = { Mortal: 0, King: 1, Demigod: 2, God: 3, Titan: 3 };   // matches KIND_TIER in rapture.js (God and Titan share the top)
const kindRank = (k) => KINDS.indexOf(k);

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const big = (id) => BigInt(id);

/**
 * One row per snapshot card, whether or not the wallet owns it, plus the tokens no snapshot card explains.
 *   cards   the collection's snapshot cards
 *   owned   [{ tokenId, card }]  card = the snapshot card the token is an edition of (null when unknown)
 *   fresh   Set of token ids not yet looked at (NEW)
 * -> { rows: [{ card, index, tokens (newest first), count, owned, isNew, newest }], unknown: [tokenId], tokens: number }
 */
export function buildRows(cards, owned, fresh = new Set()) {
  const byCard = new Map();
  const unknown = [];
  for (const t of owned) {
    if (!t.card) { unknown.push(String(t.tokenId)); continue; }
    const list = byCard.get(t.card.tokenId) ?? [];
    list.push(String(t.tokenId));
    byCard.set(t.card.tokenId, list);
  }
  const rows = cards.map((card, index) => {
    const tokens = (byCard.get(card.tokenId) ?? []).sort((a, b) => cmp(big(b), big(a)));   // newest first
    return {
      card, index, tokens, count: tokens.length, owned: tokens.length > 0,
      isNew: tokens.some((id) => fresh.has(id)),
      newest: tokens.length ? big(tokens[0]) : -1n,
    };
  });
  return { rows, unknown: unknown.sort((a, b) => cmp(big(a), big(b))), tokens: owned.length };
}

/** { owned, total, tokens, byKind: { Mortal: { owned, total }, ... } } — owned counts DISTINCT cards, tokens counts editions. */
export function progress(rows, tokens = rows.reduce((n, r) => n + r.count, 0)) {
  const byKind = Object.fromEntries(KINDS.map((k) => [k, { owned: 0, total: 0 }]));
  let owned = 0;
  for (const r of rows) {
    const k = byKind[r.card.kind] ?? (byKind[r.card.kind] = { owned: 0, total: 0 });
    k.total++;
    if (r.owned) { k.owned++; owned++; }
  }
  return { owned, total: rows.length, tokens, byKind };
}

const norm = (s) => String(s ?? "").toLowerCase();
/** What the search box can match. A card the wallet does not own only reveals its kind, path, element and faction: its silhouette stays one. */
function haystack(r) {
  const c = r.card;
  const open = [c.kind, c.path, c.element, c.faction];
  if (r.owned) open.push(c.name, c.epithet, c.alignment, c.kit, c.frame, c.slug);
  return norm(open.filter(Boolean).join(" "));
}

/** filters: { kind, element, status: "all" | "owned" | "missing" | "new", q }. Returns the matching rows. */
export function filterRows(rows, { kind = "all", element = "all", status = "all", q = "" } = {}) {
  const words = norm(q).split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    if (kind !== "all" && r.card.kind !== kind) return false;
    if (element !== "all" && r.card.element !== element) return false;
    if (status === "owned" && !r.owned) return false;
    if (status === "missing" && r.owned) return false;
    if (status === "new" && !r.isNew) return false;
    if (words.length) {
      const h = haystack(r);
      if (!words.every((w) => h.includes(w))) return false;
    }
    return true;
  });
}

export const SORTS = { set: "Set order", rarity: "Rarity", name: "Name", newest: "Newest" };

/** A new array in display order. Owned cards come first for every mode except "set", which keeps the set's own order. */
export function sortRows(rows, mode = "set") {
  const out = [...rows];
  const setOrder = (a, b) => a.index - b.index;
  const ownedFirst = (a, b) => (a.owned === b.owned ? 0 : a.owned ? -1 : 1);
  switch (mode) {
    case "rarity":
      return out.sort((a, b) => ownedFirst(a, b) || TIER[b.card.kind] - TIER[a.card.kind] || kindRank(b.card.kind) - kindRank(a.card.kind) || setOrder(a, b));
    case "name":
      return out.sort((a, b) => ownedFirst(a, b) || (a.owned ? cmp(norm(a.card.name), norm(b.card.name)) : setOrder(a, b)));
    case "newest":
      return out.sort((a, b) => ownedFirst(a, b) || (a.newest === b.newest ? setOrder(a, b) : a.newest > b.newest ? -1 : 1));
    default:
      return out.sort(setOrder);
  }
}

/** "#051" style label for an edition's position in its set. */
export const serialLabel = (serial) => `#${String(Number(serial) + 1).padStart(3, "0")}`;

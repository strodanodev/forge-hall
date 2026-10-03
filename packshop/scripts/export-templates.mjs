// Read the finished ARC 1 cards from chain (read-only) and write the PackShop template pool.
//
//   node scripts/export-templates.mjs            -> data/templates.liteforge.json
//
// A template is a card's Kind, traits, stats, style source and design record: exactly what StudioMinter.mintBatch
// takes, minus the recipient. Cards are read in token order and de-duplicated by designHash, so re-running after
// PackShop has minted editions still yields one template per design.
import { ethers, readJson, writeJson, provider, pool, CARDS_ABI, DESIGN_ABI, KIND_NAMES } from "./lib/chain.mjs";

const dep = readJson("deployments/liteforge.json");
const p = provider(dep);
const cards = new ethers.Contract(dep.collection.RaptureCards, CARDS_ABI, p);
const design = new ethers.Contract(dep.collection.CardDesign, DESIGN_ABI, p);
const base = BigInt(dep.collection.setId) << 32n;
const LIMIT = 1024;

// find the end of the set: the first index whose design record is empty
const total = Number(await cards.totalSupply());
console.log(`RaptureCards ${dep.collection.RaptureCards}: totalSupply ${total}`);
const ids = [];
for (let n = 0; n < Math.min(total, LIMIT); n++) ids.push(base + BigInt(n));

const rows = await pool(ids, 6, async (id) => {
  const [card, stats, origin, d] = await Promise.all([cards.cardOf(id), cards.coreStats(id), cards.originOf(id), design.designOf(id)]);
  process.stdout.write(".");
  return { id, card, stats, origin, d };
});
console.log();

const seen = new Set();
const templates = [];
for (const { id, card, stats, origin, d } of rows) {
  if (d.designHash === ethers.ZeroHash) continue;           // not a Studio card
  if (!card.revealed) throw new Error(`token ${id} is not revealed`);
  if (seen.has(d.designHash)) continue;                     // an edition of a design already exported
  seen.add(d.designHash);
  templates.push({
    id: templates.length,
    sourceTokenId: id.toString(),
    kindName: KIND_NAMES[Number(card.kind)],
    template: {
      kind: Number(card.kind),
      traits: {
        faction: Number(card.faction), alignment: Number(card.alignment), element: Number(card.element), frame: Number(card.frame),
        bodyparts: Number(card.bodyparts),
        strength: Number(stats.strength), agility: Number(stats.agility), resilience: Number(stats.resilience), intelligence: Number(stats.intelligence),
      },
      styleSource: { chainId: origin.chainId.toString(), collection: origin.collection, tokenId: origin.tokenId.toString() },
      design: {
        designHash: d.designHash, art: d.art, turntable: d.turntable, overridesHash: d.overridesHash,
        avatar: d.avatar, avatarPlain: d.avatarPlain, soul: d.soul, kit: Number(d.kit), name: d.name, epithet: d.epithet,
      },
    },
  });
}

const byKind = KIND_NAMES.map((k, i) => `${k} ${templates.filter((t) => t.template.kind === i).length}`).join("  ");
console.log(`${templates.length} templates: ${byKind}`);
writeJson("data/templates.liteforge.json", {
  chainId: dep.chainId,
  source: { RaptureCards: dep.collection.RaptureCards, CardDesign: dep.collection.CardDesign, setId: dep.collection.setId },
  exportedAt: new Date().toISOString(),
  templates,
});
console.log("wrote data/templates.liteforge.json");

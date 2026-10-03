// Read-only helpers shared by the PackShop scripts (plain ethers, no Hardhat).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const { ethers } = { ethers: require("ethers") };

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
export const writeJson = (rel, data) => {
  fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, rel), JSON.stringify(data, null, 2) + "\n");
};

export const KIND_NAMES = ["Mortal", "King", "Demigod", "Titan", "God"];

// Human-readable ABIs for the reads and the one simulated write.
export const CARD_TUPLE = "tuple(address drop, uint64 profileId, uint32 index, uint16 setId, uint8 kind, uint8 faction, uint8 alignment, uint8 element, uint8 frame, uint32 bodyparts, bool revealed, bool custodial, bytes32 entropyCommit, bytes32 sealedCommit)";
export const STATS_TUPLE = "tuple(uint16 strength, uint16 agility, uint16 resilience, uint16 intelligence, uint32 level, uint64 experience)";
export const ORIGIN_TUPLE = "tuple(uint64 chainId, address collection, uint256 tokenId)";
export const DESIGN_TUPLE = "tuple(bytes32 designHash, bytes32 art, bytes32 turntable, bytes32 overridesHash, bytes32 avatar, bytes32 avatarPlain, bytes32 soul, uint8 kit, string name, string epithet)";
export const TRAITS_TUPLE = "tuple(uint8 faction, uint8 alignment, uint8 element, uint8 frame, uint32 bodyparts, uint16 strength, uint16 agility, uint16 resilience, uint16 intelligence)";
export const STUDIO_CARD = `tuple(address to, uint8 kind, ${TRAITS_TUPLE} traits, ${ORIGIN_TUPLE} styleSource, ${DESIGN_TUPLE} design)`;

export const CARDS_ABI = [
  `function cardOf(uint256) view returns (${CARD_TUPLE})`,
  `function coreStats(uint256) view returns (${STATS_TUPLE})`,
  `function originOf(uint256) view returns (${ORIGIN_TUPLE})`,
  "function ownerOf(uint256) view returns (address)",
  "function totalSupply() view returns (uint256)",
];
export const DESIGN_ABI = [`function designOf(uint256) view returns (${DESIGN_TUPLE})`];
export const MINTER_ABI = [
  "function admin() view returns (address)",
  "function minters(address) view returns (bool)",
  "function nextIndex() view returns (uint32)",
  `function mintBatch(${STUDIO_CARD}[] cs) returns (uint256[] ids)`,
  "function setMinter(address who, bool on)",
];

export function provider(dep) {
  return new ethers.JsonRpcProvider(dep.rpc, dep.chainId, { staticNetwork: true, batchMaxCount: 1 });
}
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

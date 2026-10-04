// After a Liteforge launch: write the file the FORGE page reads to find the shop (public data only).
//
//   node scripts/write-web-config.mjs        -> ../web/assets/rapture/packshop.json
//
// Reads the shop's address from deployments/liteforge.json (launch.js records it) and CHECKS it against the chain
// (config() and the template count) before writing, so the page never points at an unstocked or wrong contract.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ethers, readJson, provider, ROOT } from "./lib/chain.mjs";

const require = createRequire(import.meta.url);
const { webConfig } = require("./lib/launch.js");

const dep = readJson("deployments/liteforge.json");
if (!dep.packShop?.address) throw new Error("deployments/liteforge.json has no packShop: run the launch first");
const templates = readJson("data/templates.liteforge.json").templates;
const p = provider(dep);
const shop = new ethers.Contract(dep.packShop.address, [
  "function config() view returns (uint256 price, uint8 packSize, uint16 dailyLimit, bool paused, bool ready, uint16[5] weights, uint256 templateCount)",
  "function activeTemplates(uint8 kind) view returns (uint16[])",
], p);
const c = await shop.config();
// templateCount() counts retired templates too: compare the ACTIVE pool with the file, so a retire + re-add does not break this
const active = (await Promise.all([0, 1, 2, 3, 4].map((k) => shop.activeTemplates(k)))).reduce((n, ids) => n + ids.length, 0);
if (active !== templates.length) throw new Error(`the shop has ${active} active templates (${c.templateCount} ever loaded), the file has ${templates.length}`);
if (!c.ready) throw new Error("the shop is not ready");
console.log(`PackShop ${dep.packShop.address}: price ${ethers.formatEther(c.price)} zkLTC, ${c.packSize} cards, ${c.dailyLimit} packs/day, paused ${c.paused}`);

const cfg = webConfig({
  network: "liteforge", chainId: dep.chainId, rpc: dep.rpc, explorer: dep.explorer, faucet: "https://liteforge.hub.caldera.xyz",
  packShop: dep.packShop.address, cards: dep.collection.RaptureCards, templates,
});
const out = path.join(ROOT, "..", "web", "assets", "rapture", "packshop.json");
fs.writeFileSync(out, JSON.stringify(cfg, null, 2) + "\n");
console.log("wrote", path.relative(process.cwd(), out));

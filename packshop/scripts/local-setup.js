// A complete local PackShop for developing the FORGE client: the Rapture Studio contracts (vendored copy), PackShop
// stocked with the same 50 templates the Liteforge collection has, sales open, and a client config written for the
// page. Nothing here touches Liteforge.
//
//   terminal 1:  npm run node            (Hardhat node with a block every 3 s, like a Nitro block.number tick)
//   terminal 2:  npm run local-setup     (this script)
//
// Writes web/assets/rapture/packshop.local.json; the FORGE page reads it with ?shop=local on a localhost host.
const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");
const { deployStudio } = require("../test/helpers/deployStudio.js");
const L = require("./lib/launch.js");

async function main() {
  if (network.name !== "local") throw new Error(`local-setup.js only runs on the local dev node (--network local) (got ${network.name})`);
  const templates = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "templates.liteforge.json"), "utf8")).templates;
  const [deployer, owner] = await ethers.getSigners();
  const studio = await deployStudio(ethers, { minters: [deployer.address] });
  const minterAddr = await studio.minter.getAddress();
  const record = {};
  const shop = await L.deployShop(ethers, { minter: minterAddr, owner: owner.address, record });
  await (await studio.minter.setMinter(await shop.getAddress(), true)).wait();     // deployer is the StudioMinter admin here
  console.log("granted MINTER to PackShop");
  await L.stock(ethers, { shop: shop.connect(owner), templates: templates.map((t) => t.template) });
  await L.openSales(ethers, { shop: shop.connect(owner) });

  const cfg = L.webConfig({
    network: "local", chainId: 31338, rpc: "http://127.0.0.1:8547", explorer: null, faucet: null,
    packShop: await shop.getAddress(), cards: await studio.cards.getAddress(), templates,
  });
  const out = path.join(__dirname, "..", "..", "web", "assets", "rapture", "packshop.local.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(cfg, null, 2) + "\n");
  console.log("wrote", path.relative(process.cwd(), out));
  console.log("PackShop state:", await L.describe(shop));
  console.log(`\nowner ${owner.address}; test buyers are the other Hardhat accounts (each has 10000 ETH)`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });

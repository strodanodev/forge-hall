// Launch PackShop on Liteforge: deploy, grant it the MINTER role, load the 50 templates, open sales.
//
//   PACKSHOP_CONFIRM=liteforge DEPLOYER_KEY=<StudioMinter admin key> \
//     npx hardhat run scripts/launch.js --network liteforge
//
// The signer must be the StudioMinter admin (0x8697...87b5 today): it deploys, becomes PackShop's owner, grants the
// role and loads the pool. Without PACKSHOP_CONFIRM=liteforge the script only prints what it WOULD do.
// Re-run it after any failure: each stage checks the chain first. The key is read from the environment and never
// printed. Set STAGE=deploy|grant|stock|open to run a single stage.
const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");
const L = require("./lib/launch.js");

async function main() {
  if (network.name !== "liteforge") throw new Error(`launch.js is for the liteforge network (got ${network.name}); local runs use local-setup.js`);
  const file = path.join(__dirname, "..", "deployments", "liteforge.json");
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  const templates = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "templates.liteforge.json"), "utf8")).templates.map((t) => t.template);
  const [signer] = await ethers.getSigners();
  const stage = process.env.STAGE || "all";
  const live = process.env.PACKSHOP_CONFIRM === "liteforge";
  if (!signer && live) throw new Error("no signer: set DEPLOYER_KEY (the StudioMinter admin key)");

  // a dry run needs no key: it reports the collection admin (who must sign a live launch) and its balance
  const who = signer ? signer.address : dep.collection.admin;
  const bal = await ethers.provider.getBalance(who);
  console.log(`${signer ? "signer" : "no DEPLOYER_KEY set; the launch must be signed by the StudioMinter admin"} ${who}  balance ${ethers.formatEther(bal)} zkLTC`);
  if (signer && signer.address.toLowerCase() !== dep.collection.admin.toLowerCase()) console.log(`WARNING: the StudioMinter admin is ${dep.collection.admin}; only it can grant PackShop the minter role`);
  console.log(`StudioMinter ${dep.collection.StudioMinter}   templates in file: ${templates.length}`);
  if (!live) {
    console.log("\nDRY RUN (set PACKSHOP_CONFIRM=liteforge to send transactions). Stages that would run:");
    console.log("  deploy  PackShop(minter, owner=signer, price 0.001 zkLTC, 5 cards, weights 30/25/20/15/10, 3 packs/day)   ~ 2.9M gas");
    console.log("  grant   StudioMinter.setMinter(PackShop, true)");
    console.log(`  stock   addTemplates x${Math.ceil(templates.length / 10)} batches of 10   ~ 3.2M gas each`);
    console.log("  open    unpause()");
    return;
  }
  if (bal < ethers.parseEther("0.02")) throw new Error("fund the signer with at least 0.02 zkLTC first (https://liteforge.hub.caldera.xyz)");

  const record = dep.packShop ? { packShop: dep.packShop.address } : dep.packShopPending ? { packShopPending: dep.packShopPending } : {};
  const run = (s) => stage === "all" || stage === s;
  const persist = () => fs.writeFileSync(file, JSON.stringify(dep, null, 2) + "\n");
  if (!run("deploy") && !record.packShop) throw new Error(`STAGE=${stage} needs a deployed shop: run the deploy stage first`);
  const shop = run("deploy")
    ? await L.deployShop(ethers, { minter: dep.collection.StudioMinter, owner: signer.address, record,
        save: (r) => { dep.packShopPending = r.packShopPending; persist(); } })   // before the deploy is sent
    : await ethers.getContractAt("PackShop", record.packShop);
  if (record.packShop && !dep.packShop) {
    dep.packShop = { address: record.packShop, ...(record.packShopTx ? { tx: record.packShopTx } : {}), deployedAt: new Date().toISOString(), owner: signer.address };
    delete dep.packShopPending;
    persist();
  }
  if (run("grant")) await L.grantMinter(ethers, { minter: dep.collection.StudioMinter, shop });
  if (run("stock")) await L.stock(ethers, { shop, templates });
  if (run("open")) await L.openSales(ethers, { shop });
  console.log("\nPackShop state:", await L.describe(shop));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });

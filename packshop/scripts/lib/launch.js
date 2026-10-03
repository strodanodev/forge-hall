// PackShop launch stages, shared by the local dev chain and the Liteforge launch. Every stage is idempotent: it reads
// the chain first and only sends a transaction when something is missing, so a half-finished launch can be re-run.
const PRICE = 10n ** 15n;                   // 0.001 zkLTC
const WEIGHTS = [30, 25, 20, 15, 10];       // testnet Kind odds: Mortal, King, Demigod, Titan, God
const MINTER_ABI = [
  "function admin() view returns (address)",
  "function minters(address) view returns (bool)",
  "function setMinter(address who, bool on)",
];

/** Deploy PackShop unless `record.packShop` already has code. Returns the contract. */
async function deployShop(ethers, { minter, owner, record, price = PRICE, packSize = 5, weights = WEIGHTS, dailyLimit = 3, log = console.log }) {
  if (record.packShop && (await ethers.provider.getCode(record.packShop)) !== "0x") {
    log(`PackShop already deployed at ${record.packShop}`);
    return ethers.getContractAt("PackShop", record.packShop);
  }
  const f = await ethers.getContractFactory("PackShop");
  const shop = await f.deploy(minter, owner, price, packSize, weights, dailyLimit);
  await shop.waitForDeployment();
  record.packShop = await shop.getAddress();
  record.packShopTx = shop.deploymentTransaction().hash;
  log(`PackShop deployed ${record.packShop} (tx ${record.packShopTx})`);
  return shop;
}

/** Give PackShop the MINTER role on StudioMinter. Must be sent by the StudioMinter admin. */
async function grantMinter(ethers, { minter, shop, log = console.log }) {
  const m = new ethers.Contract(minter, MINTER_ABI, (await ethers.getSigners())[0]);
  const addr = await shop.getAddress();
  if (await m.minters(addr)) return log("PackShop is already a StudioMinter minter");
  const admin = await m.admin();
  const [signer] = await ethers.getSigners();
  if (admin.toLowerCase() !== signer.address.toLowerCase()) throw new Error(`StudioMinter admin is ${admin}; sign with that key to grant the role (signer is ${signer.address})`);
  const rc = await (await m.setMinter(addr, true)).wait();
  log(`granted MINTER to PackShop (tx ${rc.hash})`);
}

/** Load templates the shop does not have yet, `batch` at a time; check each against what was sent. */
async function stock(ethers, { shop, templates, batch = 10, log = console.log }) {
  const have = Number(await shop.templateCount());
  if (have > templates.length) throw new Error(`the shop holds ${have} templates but only ${templates.length} were given`);
  for (let i = 0; i < have; i++) {
    const t = await shop.templateOf(i);
    if (t.design.designHash !== templates[i].design.designHash) throw new Error(`template ${i} on chain is not the one in the file`);
  }
  for (let i = have; i < templates.length; i += batch) {
    const part = templates.slice(i, i + batch);
    const rc = await (await shop.addTemplates(part)).wait();
    log(`templates ${i}..${i + part.length - 1} loaded (gas ${rc.gasUsed.toLocaleString()})`);
  }
  const n = Number(await shop.templateCount());
  for (let i = 0; i < templates.length; i++) {
    if ((await shop.templateOf(i)).design.designHash !== templates[i].design.designHash) throw new Error(`template ${i} did not load`);
  }
  log(`${n} templates in the shop`);
}

/** Unpause once the shop can sell. */
async function openSales(ethers, { shop, log = console.log }) {
  if (!(await shop.ready())) throw new Error("the shop is not ready: a Kind with odds has no template");
  if (await shop.paused()) {
    const rc = await (await shop.unpause()).wait();
    log(`sales opened (tx ${rc.hash})`);
  } else log("sales already open");
}

async function describe(shop) {
  const c = await shop.config();
  return {
    price: c.price_.toString(), packSize: Number(c.packSize_), dailyLimit: Number(c.dailyLimit_), paused: c.paused_, ready: c.ready_,
    weights: [...c.weights_].map(Number), templates: Number(c.templateCount_), owner: await shop.owner(),
  };
}

module.exports = { PRICE, WEIGHTS, deployShop, grantMinter, stock, openSales, describe };

/** The file the browser client reads (web/assets/rapture/packshop*.json). Public data only. */
function webConfig({ network, chainId, rpc, explorer, faucet, packShop, cards, templates }) {
  return {
    network, chainId, rpc, explorer: explorer ?? null, faucet: faucet ?? null,
    currency: { name: "zkLTC", symbol: "zkLTC", decimals: 18 },
    packShop, cards,
    templates: templates.map((t) => ({ id: t.id, sourceTokenId: t.sourceTokenId, designHash: t.template.design.designHash, kind: t.template.kind })),
    writtenAt: new Date().toISOString(),
  };
}
module.exports.webConfig = webConfig;

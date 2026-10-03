// Read-only: would PackShop deploy on Liteforge (Nitro), and what would launch cost? eth_estimateGas only, no key.
//
//   node scripts/estimate-deploy.mjs
import fs from "node:fs";
import path from "node:path";
import { ethers, readJson, provider, ROOT } from "./lib/chain.mjs";

const dep = readJson("deployments/liteforge.json");
const art = JSON.parse(fs.readFileSync(path.join(ROOT, "artifacts/contracts/PackShop.sol/PackShop.json"), "utf8"));
const p = provider(dep);
const admin = dep.collection.admin;
const args = [dep.collection.StudioMinter, admin, 10n ** 15n, 5, [30, 25, 20, 15, 10], 3];
const data = new ethers.Interface(art.abi).encodeDeploy(args);
const bytes = art.bytecode + data.slice(2);
const runtime = (art.deployedBytecode.length - 2) / 2;
console.log(`PackShop runtime ${runtime} bytes (limit 24576)`);
const [gas, fee] = await Promise.all([p.estimateGas({ from: admin, data: bytes }), p.getFeeData()]);
const price = fee.gasPrice ?? 0n;
const cost = (g) => ethers.formatEther(g * price);
console.log(`deploy: ${gas.toLocaleString()} gas ~ ${cost(gas)} zkLTC at ${ethers.formatUnits(price, "gwei")} gwei`);
// pool: 5 batches of 10 templates ~ what the local run measured
const pool = 16_000_000n;
console.log(`pool of 50 templates ~ ${pool.toLocaleString()} gas ~ ${cost(pool)} zkLTC (measured on the local chain)`);
console.log(`launch total ~ ${cost(gas + pool + 300_000n)} zkLTC`);

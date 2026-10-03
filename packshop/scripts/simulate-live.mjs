// Read-only rehearsal against the LIVE collection: would StudioMinter.mintBatch accept every template PackShop will
// hold, and what does a 5-card pack cost in gas on Liteforge? Uses eth_call / eth_estimateGas only (no key, no writes).
//
//   node scripts/simulate-live.mjs [--to <address>]
//
// The simulated caller is the collection's admin, who is a minter today. PackShop will be a minter too, so the
// minted result is the same; only the role check differs (PackShop's grant is a one-line setMinter at launch).
import { ethers, readJson, provider, MINTER_ABI, KIND_NAMES } from "./lib/chain.mjs";

const dep = readJson("deployments/liteforge.json");
const tpl = readJson("data/templates.liteforge.json").templates;
const p = provider(dep);
const admin = dep.collection.admin;
const minter = new ethers.Contract(dep.collection.StudioMinter, MINTER_ABI, p);
const argTo = process.argv.indexOf("--to");
const to = argTo > 0 ? process.argv[argTo + 1] : admin;

const [minterAdmin, isMinter, nextIndex, fee] = await Promise.all([minter.admin(), minter.minters(admin), minter.nextIndex(), p.getFeeData()]);
console.log(`StudioMinter ${dep.collection.StudioMinter}\n  admin ${minterAdmin}\n  simulated caller ${admin} is minter: ${isMinter}\n  nextIndex ${nextIndex}`);
if (!isMinter) throw new Error("the simulated caller is not a minter; pick another --from");
const gwei = Number(ethers.formatUnits(fee.gasPrice ?? 0n, "gwei"));
console.log(`  gas price ${gwei.toFixed(3)} gwei\n`);

const card = (t) => ({ to, ...t.template });
const rows = [];
let worst = 0n;
for (let i = 0; i < tpl.length; i += 5) {
  const batch = tpl.slice(i, i + 5);
  const data = minter.interface.encodeFunctionData("mintBatch", [batch.map(card)]);
  const label = batch.map((t) => t.kindName[0] + t.id).join(" ");
  try {
    const ret = await p.call({ from: admin, to: dep.collection.StudioMinter, data });
    const ids = minter.interface.decodeFunctionResult("mintBatch", ret)[0];
    const gas = await p.estimateGas({ from: admin, to: dep.collection.StudioMinter, data });
    worst = gas > worst ? gas : worst;
    rows.push({ label, ok: true, gas });
    console.log(`  ok   [${label}]  ids ${ids[0]}..${ids.at(-1)}  gas ${gas.toLocaleString()}`);
  } catch (e) {
    rows.push({ label, ok: false });
    console.log(`  FAIL [${label}]  ${e.shortMessage ?? e.message}`);
  }
}
const bad = rows.filter((r) => !r.ok).length;
console.log(`\n${rows.length - bad}/${rows.length} five-card batches would mint`);
if (worst) {
  const est = (worst * 125n) / 100n; // PackShop adds the draw and copies templates out of storage; +25% is generous
  const cost = Number(ethers.formatEther(est * (fee.gasPrice ?? 0n)));
  console.log(`worst mintBatch of 5: ${worst.toLocaleString()} gas; with PackShop overhead ~${est.toLocaleString()} gas`);
  console.log(`open cost at ${gwei.toFixed(3)} gwei ~ ${cost.toFixed(5)} zkLTC (pack price 0.001)`);
}
process.exitCode = bad ? 1 : 0;

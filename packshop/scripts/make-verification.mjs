// Build and CHECK a reproducible verification package for the deployed PackShop (read-only: only eth_getCode).
//
//   node scripts/make-verification.mjs
//
// 1. finds the Hardhat build whose runtime bytecode equals the code on chain (immutables masked, metadata hash included, so
//    a match means the published sources compile to exactly what is deployed),
// 2. writes verification/PackShop.standard-input.json with ONLY the sources PackShop depends on (what an explorer needs; the
//    rest of the project, including the vendored Rapture contracts, is not included),
// 3. writes the constructor arguments and the solc metadata next to it.
//
// The package is what Blockscout / Etherscan-style explorers take ("standard JSON input"), and anyone can re-run step 1
// themselves: compile with these settings and compare against eth_getCode.
import fs from "node:fs";
import path from "node:path";
import { ethers, readJson, writeJson, ROOT } from "./lib/chain.mjs";

const dep = readJson("deployments/liteforge.json");
const shopAddr = dep.packShop?.address;
if (!shopAddr) throw new Error("deployments/liteforge.json has no packShop");
const OUT = path.join(ROOT, "verification");
fs.mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------ the code that is live
const rpc = async (method, params) => {
  const r = await fetch(dep.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};
const onChain = (await rpc("eth_getCode", [shopAddr, "latest"])).toLowerCase();
console.log(`on chain at ${shopAddr}: ${(onChain.length - 2) / 2} bytes`);

// ------------------------------------------------------------------ find the matching build
const dir = path.join(ROOT, "artifacts", "build-info");
const builds = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
const mask = (hex, refs) => {
  const bytes = Buffer.from(hex.slice(2), "hex");
  for (const list of Object.values(refs ?? {})) for (const { start, length } of list) bytes.fill(0, start, start + length);
  return bytes.toString("hex");
};
let found = null;
for (const f of builds) {
  const b = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const c = b.output?.contracts?.["contracts/PackShop.sol"]?.PackShop;
  if (!c) continue;
  const compiled = "0x" + c.evm.deployedBytecode.object;
  const refs = c.evm.deployedBytecode.immutableReferences;
  const same = compiled.length === onChain.length && mask(compiled, refs) === mask(onChain, refs);
  console.log(`  build ${f.slice(0, 10)}…  solc ${b.solcLongVersion}  ${same ? "MATCHES the deployed code" : "differs"}`);
  if (same && !found) found = { file: f, build: b, contract: c, refs };
}
if (!found) throw new Error("no local build reproduces the deployed bytecode: do not publish anything until that is understood");

// ------------------------------------------------------------------ what the immutables hold (a second, independent check)
const { contract, build } = found;
const slot = (range) => "0x" + onChain.slice(2 + range.start * 2, 2 + (range.start + range.length) * 2);
const immutables = Object.fromEntries(Object.entries(found.refs).map(([astId, ranges]) => [astId, slot(ranges[0])]));

// ------------------------------------------------------------------ minimal standard JSON input
const metadata = JSON.parse(contract.metadata);
const used = Object.keys(metadata.sources);                       // exactly the files PackShop was compiled from
const sources = Object.fromEntries(used.map((p) => [p, { content: build.input.sources[p].content }]));
const settings = { ...build.input.settings, outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"] } } };
const standardInput = { language: "Solidity", sources, settings };
fs.writeFileSync(path.join(OUT, "PackShop.standard-input.json"), JSON.stringify(standardInput, null, 2) + "\n");
fs.writeFileSync(path.join(OUT, "PackShop.metadata.json"), JSON.stringify(metadata, null, 2) + "\n");

// ------------------------------------------------------------------ constructor arguments, from what the launch recorded
const args = [dep.collection.StudioMinter, dep.packShop.owner, 10n ** 15n, 5, [30, 25, 20, 15, 10], 3];
const encoded = new ethers.Interface(JSON.parse(fs.readFileSync(path.join(ROOT, "artifacts/contracts/PackShop.sol/PackShop.json"), "utf8")).abi).encodeDeploy(args).slice(2);
fs.writeFileSync(path.join(OUT, "PackShop.constructor-args.txt"), encoded + "\n");

// the creation transaction's own input ends with these arguments: a third check, against what was really sent
const tx = await rpc("eth_getTransactionByHash", [dep.packShop.tx]);
const creationMatches = !!tx && tx.input.toLowerCase().endsWith(encoded.toLowerCase());

const summary = {
  contract: "contracts/PackShop.sol:PackShop",
  address: shopAddr,
  chainId: dep.chainId,
  compiler: `v${build.solcLongVersion}`,
  settings: { optimizer: settings.optimizer, viaIR: settings.viaIR, evmVersion: settings.evmVersion, metadata: settings.metadata ?? null },
  license: "Apache-2.0",
  files: used.map((p) => ({ path: p, bytes: Buffer.byteLength(sources[p].content) })),
  bytecode: { runtimeBytes: (onChain.length - 2) / 2, matchesCompiled: "exact (immutables masked, metadata hash included)", immutables },
  constructorArgs: { hex: encoded, matchesCreationTransactionInput: creationMatches },
  checkedAt: new Date().toISOString(),
};
writeJson("verification/result.json", summary);
console.log(`\nsources included (${used.length}):`);
for (const f of summary.files) console.log(`  ${f.path}  (${f.bytes} bytes)`);
console.log(`\ncompiler ${summary.compiler}; optimizer ${JSON.stringify(settings.optimizer)}; viaIR ${settings.viaIR}; evm ${settings.evmVersion}`);
console.log(`constructor args match the creation transaction input: ${creationMatches}`);
console.log("wrote verification/PackShop.standard-input.json, PackShop.metadata.json, PackShop.constructor-args.txt, result.json");

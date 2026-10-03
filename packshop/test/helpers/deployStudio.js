// The Studio Mode test deployment (RaptureCards + CardDesign + StudioMinter + metadata + registry), as the Rapture
// project's scripts/studio/deploy-lib.js builds it. Kept as a copy so these tests run without that project.
const STAT_MIN = [12000, 16000, 22000, 28000, 36000];
const STAT_MAX = [22000, 26000, 32000, 40000, 52000];

async function deployStudio(ethers, opts = {}) {
  const [deployer] = await ethers.getSigners();
  const { minters = [deployer.address], imageBase = "https://cards.test/assets/", statMin = STAT_MIN, statMax = STAT_MAX } = opts;
  const wait = async (txp) => (await txp).wait();
  const deploy = async (name, ...args) => {
    const c = await (await ethers.getContractFactory(name)).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const identity = await deploy("NullIdentity");
  const sets = await deploy("SetRegistry", 0);
  const metadata = await deploy("RaptureMetadata", sets, deployer.address, imageBase, "");
  const registry = await deploy("contracts/vendor/rapture/litnode/ERC6699Registry.sol:ERC6699Registry", deployer.address);
  const cards = await deploy("RaptureCards", sets, identity, metadata, registry);
  const design = await deploy("CardDesign");
  const minter = await deploy("StudioMinter", sets, cards, design, deployer.address, statMin, statMax);

  await wait(metadata.bindCards(cards));
  await wait(metadata.bindDesign(design));
  await wait(design.bindWriter(minter));
  await wait(registry.setMinter(await cards.getAddress(), true));

  const setId = await sets.nextSetId();
  await wait(sets.register("Studio Test", ethers.ZeroHash, ethers.ZeroHash));
  await wait(sets.addDrop(setId, minter));
  await wait(sets.sealSet(setId));
  for (const m of minters) await wait(minter.setMinter(m, true));
  return { identity, sets, metadata, registry, cards, design, minter, setId: Number(setId) };
}

module.exports = { deployStudio, STAT_MIN, STAT_MAX };

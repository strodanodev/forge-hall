require("@nomicfoundation/hardhat-ethers");

/**
 * Liteforge (LitVM testnet, chain 4441) is an Arbitrum Nitro chain with EVM Shanghai: no Cancun opcodes, so the
 * OpenZeppelin release is pinned to 5.0.2 (5.6 uses mcopy). Same compiler settings as the Rapture project, whose
 * contracts are vendored under contracts/vendor/rapture for the integration tests.
 */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: { evmVersion: "shanghai", optimizer: { enabled: true, runs: 200 }, viaIR: true },
  },
  networks: {
    // `npm run node` sets HARDHAT_TICK_MS: blocks also arrive on a timer, the way Nitro's block.number keeps moving,
    // so a sealed pack becomes openable without another transaction. Tests leave it unset (instant blocks only).
    // 31338 (not Hardhat's default 31337) and port 8547, so this dev chain never collides with another local chain
    // in the wallet or on the machine.
    hardhat: { chainId: 31338, ...(process.env.HARDHAT_TICK_MS ? { mining: { auto: true, interval: Number(process.env.HARDHAT_TICK_MS) } } : {}) },
    local: { url: "http://127.0.0.1:8547", chainId: 31338 },
    liteforge: {
      url: process.env.LITVM_RPC_URL || "https://liteforge.rpc.caldera.xyz/http",
      chainId: 4441,
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [],
    },
  },
};

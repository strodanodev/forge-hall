// `npm run node`: a Hardhat node that also mines a block every HARDHAT_TICK_MS (default 3 s), the way Liteforge's
// block.number keeps ticking, so a sealed pack becomes openable without another transaction.
const { spawn } = require("node:child_process");
const env = { ...process.env, HARDHAT_TICK_MS: process.env.HARDHAT_TICK_MS || "3000" };
const child = spawn("npx", ["hardhat", "node", "--port", "8547"], { env, stdio: "inherit", shell: true });
child.on("exit", (code) => process.exit(code ?? 0));

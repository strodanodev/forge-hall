// Lets `node --test web/test/` run every suite. Node 21+ treats a directory argument as a glob that matches the directory
// itself and runs it as a file, which resolves to this index; importing the suites here makes that one command work.
// `node --test "web/test/*.test.mjs"` runs each suite in its own process instead and never loads this file.
import "./abi.test.mjs";
import "./chain.test.mjs";
import "./wallet.test.mjs";
import "./packshop.test.mjs";
import "./auth.test.mjs";
import "./shopflow.test.mjs";
import "./holdings.test.mjs";
import "./library.test.mjs";
import "./title.test.mjs";

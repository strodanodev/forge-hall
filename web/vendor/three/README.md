Vendored from `three@0.170.0` (npm), MIT: `build/three.module.min.js` and the `examples/jsm` addons the hall
imports plus their relative imports (17 files). The page's import map (`web/index.html`) maps `three` and
`three/addons/` here, so no script is loaded from a CDN: a wallet dapp should not trust a third-party host with its
renderer. To upgrade, re-run the vendoring step with the new version and update the import-map hash in `vercel.json`.

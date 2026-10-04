# FORGE production audit (2026-10-05)

Scope: the hall (`web/`), the sign-in API (`api/`, `db/`), the PackShop contract and its tooling (`packshop/`), the
Blender/asset pipeline (`scripts/`), and the two live deployments. Every suite was run; every claim below was checked
against the code or the live site. Line numbers refer to the tree as it was before this session's cleanup.

## Verdict

FORGE is in good shape for a **testnet** launch and better engineered than most projects of its size: no leftover TODOs
or debug logging, every chain-facing module tested against ethers as an oracle, a verified contract, an honest README
on randomness. It is **not** ready for anything that carries real value, and the README already says so. The red flags
below are mostly operational and product-truth issues, plus one real bug (sign-out never worked in production, fixed here).

## Red flags, ranked

1. **Sign-out was broken in production (fixed).** `web/auth.js` sent the logout POST without `content-type`, the API
   answers 415 to that, so "Sign out" showed a raw error and "Disconnect" silently left the server session and the 7-day
   cookie alive. Neither test suite caught it: each faked the other side. Fixed in `web/auth.js` (every POST now carries the
   header) with a test. Harmless today (a session grants nothing beyond `/api/auth/me`), fatal the day any endpoint trusts it.
2. **Supply chain: three.js and its addons load from jsDelivr with no integrity hash and the site has no Content-Security-Policy.**
   This is a wallet dapp; a CDN compromise or an XSS is a drainer. `three-fire` is vendored, three is not. Vendor
   `three@0.170.0` (build + the nine addons used) next to it, or at least add `integrity` to the import map, and add a CSP
   via `vercel.json` (`script-src 'self'`, `connect-src` the RPC/explorer/IPFS gateway/Google Fonts). The live site also
   sends no `X-Frame-Options`, `Referrer-Policy` or `Permissions-Policy` (checked with curl).
3. **Two production copies of the site.** `forge-hall.vercel.app` (first project, no database, the one Blockaid flagged) and
   `forge.litvm.games` (the real one). Two origins doubles the phishing-lookalike surface and the deploy procedure. Retire
   the first project (redirect to `forge.litvm.games`) and drop it from `DEPLOY.md`. `og:image` pointed at the old host (fixed).
4. **One hot EOA runs everything on chain.** The PackShop owner, the StudioMinter admin and the key that can grant or
   revoke MINTER on the whole collection are the same address, read from the command line (`DEPLOYER_KEY=0x…`, which
   lands in shell history). Before mainnet: Ownable2Step to a Safe, a keystore or prompt for the key, and a timelock.
5. **The preview environment accepts any host and writes to the production database.** `ALLOWED_HOSTS` is set for
   Production only while `DATABASE_URL` is set for Preview too, so a preview deployment is a sign-in endpoint with no host
   pinning on the production tables. Set `ALLOWED_HOSTS` for Preview (or refuse to sign in on Vercel when it is unset) and
   give Preview its own Neon branch.
6. **No rate limiting.** Every anonymous `POST /api/auth/nonce` is a DB write and every `/verify` an ECDSA recovery.
   `DEPLOY.md` recommends a Vercel Firewall rule for `/api/auth/*` but neither deployment record says it was applied.
7. **The server accepted SIWE messages it never wrote (fixed).** `statement`, `Request ID` and `Resources` were not
   checked, so a validly signed message with another statement or extra `Resources:` lines was accepted. Added the three
   checks in `api/_lib/siwe.js` with a re-signed-variant test. Not a domain bypass, but it widened what a phishing page could
   put in front of a user with this server's blessing.
8. **AERIS told paying players nothing is minted (fixed).** The hall chatter line "This is a testnet preview. Nothing you
   pull here is minted" played regardless of whether the live shop was configured. Split into preview / live chatter like
   the intro already was.
9. **Free Preview misrepresents the paid product.** Its odds (50/28/15/7 per tier) are not the shop's (30/25/20/15/10 per
   Kind), and it rolls a 3 % "Gilded" cosmetic (`rapture.js`, marked "mockup, not on chain yet") that a bought pack can
   never produce and the Library never shows. Either align the preview to `shop.info` and remove Gilded, or label it clearly.
10. **Three correctness bugs in the wallet layer** (not fixed; each is a few lines, flagged for a focused change):
    - `wallet.js` `onProviderConnect`: after `await eth_accounts` it re-populates `account` without re-checking
      `wantConnected`, so a disconnect during that request is undone.
    - `shopflow.js` `refresh()` is fired unawaited from five places and is not serialised; a stale `findMyPacks` answer can
      re-populate `shop.expired` after a refund and re-offer a refund that then throws `pack_refunded`.
    - `holdings.js` persists a reduced `ids` list after a *transient* `ownerOf` failure, forgetting a pack-minted token
      until the explorer rediscovers it; and a read can return `complete: true, partial: true`.
11. **Owner re-roll levers are wider than documented.** `README.md` names `retireTemplate` and `setWeights`; `addTemplates`
    also re-rolls every sealed pack of that Kind (`pool.length` changes the modulo). And `openPack` has no pause: once a bad
    template is live, the only stop is `StudioMinter.setMinter(PackShop, false)` from the collection admin.
12. **Launch script is not as idempotent as claimed.** The PackShop address is recorded only after the deploy receipt; an
    RPC drop between send and receipt makes a re-run deploy a second shop. Precompute the CREATE address from the nonce.
13. **Terms say "open-source"; the repo is private.** `terms.html` and the Oracle covenant promise an open-source platform.
    Publish the repo or soften the wording. `about.html` also hard-codes the price ("currently 0.001 zkLTC"), which is
    owner-adjustable on chain and will go stale silently.
14. **The rebuild path in `web/README.md` is not runnable from a clone.** `forge_hall.blend` and `bake/` are gitignored,
    `optimize_web.sh` reads `bake/*.png`, the re-grade path needs a Blender-5.2 OCIO file at an absolute path and a
    `grade_cinematic.json` that does not exist. Say so in the README, and decide whether the re-grade subsystem
    (`grade_cinematic.py`, `reexport_web.py`, the second 75 MB blend, 140 MB of `.npz` per bake) earns its keep for a
    grade that is currently at defaults.

## Cleanup applied in this session (uncommitted; `git diff --stat` shows 33 files, +142 / −292)

- **Dead code removed, with its tests:** `chain.getLogs`, `abi.addressTopic/uintTopic`, the `packOf`/`packCountOf`
  selectors, `packshop.readPack/packCountOf/txUrl/addressUrl`, `auth.apiAvailable`, `wallet.request/destroy`,
  `shop.txUrl`, `titlecore.selfIntersects` (test-only, moved into the test), a commented-out ARC 2 entry, a no-op
  assertion and two history-narrating tests. Web suite: 235 → 231 tests, all passing. API suite: all passing.
- **claude.ai-artifact compatibility code removed from production:** the base64 GLB path and the `imageTextures` plugin
  in `fx.js` (the plugin replaced three's off-thread `ImageBitmapLoader` with `TextureLoader` for every user), plus the
  "Hosted preview" README section with its private artifact link. Verified in the browser: hall, preview pack and avatar
  inspect render as before.
- **Redundancy:** `RANK` is imported from `tiers.js` in `npc.js` instead of a hand copy; the double re-export in
  `rapture.js` collapsed; `drawFace` no longer gets an argument it ignores.
- **Pipeline:** `rapture_snapshot.mjs` uses `@noble/hashes` (a root dependency `api/_lib/address.js` already uses; equality
  with the vendored BigInt Keccak proven on 7 inputs) instead of `scripts/.tools/keccak.mjs`; the dead migration shim in
  `reexport_web.py` removed.
- **Config and docs:** `.claude/launch.json` is one `npm run dev` entry (it had three identical static servers and one for a
  gitignored folder); `.gitignore` deduplicated and given a rule for `*_raw.glb`; `web/test/README.md` counts and
  prerequisites corrected (it claimed 146 tests and a warning that never appears); `packshop/README.md` test count corrected
  (28, not 27); the wrong Vercel body-parsing comment in `http.js` fixed; unused `now` injection params in `siwe.js` removed.
- Four scratch files at the repo root (`b.txt`, `b2.txt`, `b3.txt`, `resp.txt`, explorer JSON dumps) deleted.

## Round 2: recommendations applied (same day, on request)

- **Supply chain / headers.** `three@0.170.0` (min build + the 17 addon files the hall needs, MIT) is vendored under
  `web/vendor/three`; the import map points there, so no script loads from a CDN. `vercel.json` now sends a
  Content-Security-Policy (`script-src 'self'` plus the import map's hash and `'wasm-unsafe-eval'` for the meshopt
  decoder; `connect-src` limited to the Liteforge RPC and explorer), `X-Frame-Options: DENY`, `Referrer-Policy`,
  `Permissions-Policy` and `nosniff` on every route. The dev server reads the same rules from `vercel.json`, with a test,
  so a CSP break shows up on localhost. `<link rel="canonical">` points at `forge.litvm.games`.
- **Sign-in host pinning.** On Vercel (every environment) the API now answers 503 to sign-in until `ALLOWED_HOSTS` is set,
  instead of accepting any host; locally nothing changes. Documented in `DEPLOY.md` and `.env.example`.
- **The three wallet-layer bugs** are fixed with regression tests: a disconnect during the reconnect refresh stays a
  disconnect (`wallet.js`); `shop.refresh()` runs one read at a time and queues one more, and a refunded pack is never
  re-offered by a lagging node (`shopflow.js`); a remembered token whose `ownerOf` failed transiently is kept for the
  next read, and `complete`/`partial` no longer contradict (`holdings.js`).
- **Preview tells the truth.** Free Preview draws exactly like the shop (a Kind by weight, uniform within it,
  duplicates allowed; a live shop's own weights when it has them) and the "one Demigod guaranteed" rule is gone. The
  Gilded finish is look-dev only (`?gilded=all`), never rolled in a pull. AERIS's odds lines and the README match.
- **Redundancy.** `web/util.js` holds the one copy of `esc`, `shortAddress`, the safe `localStorage` wrapper and the
  reduced-motion flag (was five copies); `RARITY` lives in `tiers.js` and the NPC uses it instead of its own drifted palette.
- **Repo hygiene (the deletions, with your go-ahead).** `forge_hall_raw.glb` untracked, `scripts/.tools/keccak.mjs` and the
  two duplicate PNGs removed, `p1`–`p16` + `lib.py` + `ph_on.py` moved to `archive/forge_hall_session/` (gitignored, with a
  README; `bmcp.py`, p17, p18, `logo_trace.py`, `render_stills.py` stay).
- **Pipeline and PackShop tooling.** `grade_cinematic.py` takes the OCIO config from `$OCIO` and fails clearly;
  `optimize_web.sh` finds `uv` on PATH and refuses to run without `bake/`; `rapture_snapshot.mjs` no longer defaults to a
  path in another project; `write-web-config.mjs` compares the *active* pool (so a retire + re-add does not break it);
  the launch records the deploy address before sending (a lost receipt no longer means a second shop) and a stage run
  without a deployed shop says so; the `addTemplates` re-roll lever is documented. `web/README.md` says what the rebuild
  assumes. `package.json` pins Node 22.x.
- Not changed, on purpose: the terms' "open-source" wording and the covenant (legal copy, and bumping `COVENANT` makes
  everyone re-swear) and the `__Host-` cookie prefix (marginal, with a localhost risk). Both stay listed above.

### Still yours to do (accounts, not code)

1. `ALLOWED_HOSTS` for Preview on the NPC project; with the new guard, preview sign-in is off until then.
2. Firewall rate-limit rules for `/api/auth/*` and `/api/rapture/*`.
3. Retire `forge-hall.vercel.app` (redirect or delete).
4. A Neon branch for Preview; the mainnet items in `packshop/README.md` before real value.
5. Commit and deploy: nothing here is committed. The deploy of the holder endpoint shipped HEAD without any of this.

## Recommendations by area

**Deployment.** Pin `"engines": { "node": "22.x" }` in `package.json` (the tests need ≥ 21 and the two Vercel projects pick
their own version). Add the Firewall rate-limit rule and record it. Set `ALLOWED_HOSTS` for Preview. Use `__Host-` on the
session cookie. Run `git add --renormalize .` once: `core.autocrlf=true` globally plus `eol=lf` in `.gitattributes` has left
some working-tree files CRLF (index is LF, so the repo is fine).

**Web client.** Vendor three (or import-map `integrity`) and add a CSP. Merge the three copies of `esc()`/`short()`, the
four `localStorage` wrappers, the two text-truncating `short()`s and the three `prefers-reduced-motion` reads into one small
`util.js`. Two tier palettes have drifted (`npc.js` `ACCENT` vs `rapture.js` `RARITY`). Fix the three wallet-layer bugs
above. The title screen (1,000 lines, its own WebGL context, three GPU bake passes, a second bloom chain, torn down after
~10 s) and the Oracle's three-ring puzzle ("not real bot protection" by its own comment) are the two places where effort
most exceeds product value; both work and are tested, so this is a cost note, not a defect.

**Tests.** Several assertions are wall-clock based (`chain.test.mjs`, `packshop.test.mjs`) where the injected `sleep` hook
already exists; the fee_too_low story is tested four times; `library.test.mjs` tests `holdings.learn()`. The packshop
contract has two suites with ~10 overlapping cases and verbatim `template()`/`POOL` fixtures; the adversarial suite is the
better one.

**Contract (before mainnet, all already known in spirit).** VRF or drand seed; a separate `openingPaused` flag that still
allows refunds; a dead-liability sweep (a non-receiving buyer contract freezes owner revenue forever, not just its own
funds); a multisig owner; proof that the vendored Rapture contracts equal the live bytecode (`eth_getCode` compare);
`write-web-config.mjs` breaks after the first retire + re-add because `templateCount()` counts retired templates.

**Pipeline.** Hard-coded machine paths in `grade_cinematic.py`, `optimize_web.sh` (`$HOME/.local/bin/uv`),
`rapture_snapshot.mjs` (a default pointing into another project) and the font paths; `export_web.py` and
`render_stills.py` duplicate the CUDA setup block; `export_web.py` and `reexport_web.py` duplicate the glTF export block.

## What is good and should stay

Explicit, strict SIWE verification with canonical re-serialisation; atomic nonce consumption; hashed session tokens with
rotation; JSON-only + Origin CSRF stance; parameterised SQL with DB-level checks. The hand-rolled ABI codec proven
byte-for-byte against ethers; the fake PackShop chain that runs buy → wait → open → refund → resume end to end; real
wallets signing real messages in tests. `liability`-bounded `withdraw`, exact-price buys, deploy-paused, two-step ownership,
the verification package that proves the live bytecode. `export_web.py` as a single headless entry point that never writes
the source blend; `optimize_web.sh`; the one caduceus trace feeding both the furnace badge and the title emblem. Every
module header explains *why*. No TODOs, no stray logging, degradation paths everywhere (title bails to the hall, live metals
keep the baked look, the library failing does not kill the hall).

## Verification done

- After round 2: `node --test "web/test/*.test.mjs"` 234 / 234 pass; `node --test "api/test/*.test.js"` 111 / 111 pass
  (10 of them are the `/api/rapture/holder` endpoint's, committed by the other session as `7355794`; that endpoint was
  not part of this audit). `npx hardhat test` in `packshop/`: 61 passing (contracts untouched; the launch and config
  scripts were syntax-checked, not run against a chain).
- Live: `https://forge.litvm.games/api/health` → `{"ok":true,"db":true}`; `/test/`, `*_raw.glb` and
  `packshop.local.json` are not served; PackShop on chain reads price 0.001, 5 cards, 3/day, odds 30/25/20/15/10,
  50 templates, sales open, liability 0.001 (one sealed pack outstanding).
- Browser, local dev server with the CSP and the vendored three: hall textured and lit, Library overlay, Free Preview
  run to `done` with five revealed cards drawn by Kind (no Gilded), card inspect with its avatar, title screen building
  its emblem (168 ms), playing the story and opening the Oracle covenant. No CSP violation in the console (only the
  expected 401 from `/api/auth/me` while signed out).
- Line endings: `core.autocrlf=true` is set globally while `.gitattributes` says `eol=lf`, so some working-tree files
  are CRLF; the index is LF and Git normalises on commit. A one-time `git add --renormalize .` after committing tidies
  the working tree.

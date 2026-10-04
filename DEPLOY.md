# Deploying the FORGE to Vercel (with Neon Postgres)

The site in `web/` is static. The sign-in API in `api/` runs as Vercel functions and keeps
players and sessions in Neon. Players sign in with MetaMask (Sign-In with Ethereum, LitVM
Liteforge testnet, chain 4441); the server only ever learns their wallet address. Buying
packs is on-chain and needs no server.

You need: Node 22 or newer, a Vercel account, a Neon account, and the Vercel CLI (`npm i -g vercel`).

## Current deployment (2026-09-30)

| | |
|---|---|
| Vercel team / project | `notsedanos-projects` / `forge-hall` (project id `prj_m1VLay6GTVYPdynwH961vCdJWPCs`) |
| Public URL | https://forge-hall.vercel.app (the `forge-hall-notsedanos-projects.vercel.app` alias sits behind Vercel Authentication) |
| Live shop | PackShop `0x3E39be64A4dE8752E45067d6Bbe4787b4D272B0c` on Liteforge (launched 2026-10-01, config in `web/assets/rapture/packshop.json`) |
| Env vars set | `ALLOWED_HOSTS=forge-hall.vercel.app` (Production). `DATABASE_URL` comes from the Neon integration (see below) |
| CLI login | this machine's default `vercel` login is another account (`contactstrodano-8632`), so every command here uses an isolated login: `--scope notsedanos-projects --global-config "C:/Users/strodano/.vercel-notsedano"` |

Redeploy after any change (env-var changes only apply to the next deployment):

```
vercel deploy --prod --yes --scope notsedanos-projects --global-config "C:/Users/strodano/.vercel-notsedano"
```

Database: in the Vercel dashboard open the project's **Storage** tab, **Create Database**, **Neon**, free plan, region
Washington D.C. (`iad1`, where the functions run), connect it to `forge-hall` for all environments, and keep the default
env-var names so it creates `DATABASE_URL`. (The CLI cannot do this step: `vercel integration add neon` only offers to open the
dashboard.) Then create the tables once with `vercel env pull` + `npm run migrate` (section 2), or run the statements of
`db/schema.sql` in Neon's SQL editor, and redeploy. Until then `/api/health` reports `"db":false` and the wallet menu hides the
sign-in button. (This first project has no database; the NPC deployment below does.)

## Wallet warnings and network fees (found live 2026-10-02)

- **"Continue at your own risk / signs of phishing or wallet-draining"** on connect. Not a bug in the app: a wallet security
  scanner (Blockaid for MetaMask, other vendors elsewhere) scores a brand-new `*.vercel.app` subdomain that asks for a wallet
  connection as high risk, because that is what drainer kits look like (MetaMask's own blocklist lists ~2,100 `vercel.app`
  subdomains; `forge-hall.vercel.app` is not on it). The code asks for nothing sensitive (no `approve`, `setApprovalForAll`,
  `permit`, `eth_sign` or typed data). Fixes, in order of effect: a custom domain on an older, reputable domain; report the
  false positive (Blockaid: https://report.blockaid.io/); verify the contracts on the explorer (done for the PackShop on
  2026-10-02, see "Source code on the explorer" in `packshop/README.md`). `web/about.html` lists every request the app can
  make, linked from the page, with the contract addresses and the verified-source link.
- **"max fee per gas less than block base fee"**. Liteforge's base fee idles at its 0.01 gwei floor (10,000,000 wei) and drifts
  about 1% per block. Some wallets bid exactly the floor, which works only while the base fee equals it. The client now sends
  explicit `maxFeePerGas` (2x the gas price) and `maxPriorityFeePerGas` (the node's tip, 0 on Nitro) with every transaction, and
  reports a refusal as `fee_too_low`. A bought pack stays sealed and can be opened on the next try or refunded.
- `litvm.games` uses Vercel DNS, but in a zone that neither the `notsedano` nor the `contactstrodano-8632` login can manage
  (`vercel dns ls litvm.games` is refused). Adding `forge.litvm.games` needs whoever owns that zone to add
  `forge CNAME cname.vercel-dns.com`, or to give one of these accounts access. **Resolved 2026-10-02:** the zone belongs to the NPC
  team, which added `forge.litvm.games` to its own `forge-hall` project (next section); it serves the site over HTTPS (DNS and TLS
  checked).

**Last deployed 2026-10-04** to both projects (forge.litvm.games / forge-hall-theta.vercel.app and forge-hall.vercel.app): the p18
hall (THE FORGE plaque, caduceus badge, live metals, night lighting, torches; painted mode removed), the title screen, and the
folder's uncommitted card/shop edits at the time. `/archive/` is in `.vercelignore` (its blends/bakes broke the 100 MB file cap).

## Second deployment: NPC team (2026-10-02)

The same site is also deployed to the **NPC** team, where the production domain will be linked.

| | |
|---|---|
| Vercel team / project | `npc-31bbd654` (NPC) / `forge-hall` (project id `prj_OY62mbJg5w34HN1e7FFG243fC6m3`, team id `team_LHXkgP0HcJa3J3Mg2Z2diX9l`). A NEW project: the team's other projects (cabinet, picklebrawl, litgaming-website, ...) are unrelated, never deploy into them |
| Public URL | **https://forge.litvm.games** (production domain, added by the NPC team in the Vercel dashboard 2026-10-02; DNS, TLS and the site checked) and https://forge-hall-theta.vercel.app (the short alias Vercel assigned: `forge-hall.vercel.app` belongs to the first project). `forge-hall-npc-31bbd654.vercel.app` and the per-deployment URLs sit behind Vercel Authentication |
| Env vars set | `ALLOWED_HOSTS=forge.litvm.games,forge-hall-theta.vercel.app` (Production; **add any new production domain here and redeploy**, or sign-in refuses that host). `DATABASE_URL` and the other `POSTGRES_*`/`PG*` names (Preview + Production) come from the Neon integration, see "Database" below |
| Database | Neon project `neon-cyan-desert` (id `broad-breeze-18257698`, `aws-us-east-1`, free plan, branch `main`, database `neondb`, role `neondb_owner`), created 2026-10-02 from the dashboard Storage tab and linked to `forge-hall`. Schema (`db/schema.sql`) applied 2026-10-02. `/api/health` reports `db:true` on both hosts; a full sign-in round trip (throwaway wallet) passed on https://forge.litvm.games and its rows were deleted afterwards |
| Live shop | the same PackShop on Liteforge as the first deployment (`web/assets/rapture/packshop.json`) |
| CLI login | an isolated login for the user `newprontera` (it sees `agent-aeris-projects` and `npc-31bbd654`); log out after use. The device page signs in whichever Vercel account the browser is using: one approval on 2026-10-02 landed on `notsedano`, which cannot see the NPC team ("scope does not exist"). Run `vercel whoami` first, it must say `newprontera`; otherwise `vercel logout` and approve again from a window signed in as `newprontera`. A pending device code expires after about 10 minutes |

This folder's own `.vercel` still links the FIRST project, so redeploy by passing the NPC ids as environment variables instead of re-linking:

```
vercel login --global-config "C:/Users/strodano/.vercel-npc"        # approve the printed URL as newprontera
VERCEL_ORG_ID=team_LHXkgP0HcJa3J3Mg2Z2diX9l VERCEL_PROJECT_ID=prj_OY62mbJg5w34HN1e7FFG243fC6m3 vercel deploy --prod --yes --scope npc-31bbd654 --global-config "C:/Users/strodano/.vercel-npc"
vercel logout --global-config "C:/Users/strodano/.vercel-npc"
```

The same two environment variables make `vercel env ls|add|rm` and `vercel integration list` act on the NPC project (they read the repo's `.vercel` link otherwise), for example `printf '%s' 'a,b' | vercel env add ALLOWED_HOSTS production --scope npc-31bbd654 --global-config ...`. Env-var changes only apply to the next deployment.

### Database on the NPC project (Neon, 2026-10-02)

The Neon organisation behind this team ("Vercel: NPC") is **managed by Vercel**, so a new database can only be created from the
Vercel dashboard (project **Storage** tab, **Create Database**, **Neon**, Free plan, Washington D.C. `iad1`, all environments, no env-var
prefix). Neither shortcut works: the Neon API / MCP answers `action restricted; reason: "organization is managed by Vercel"` for
`create_project`, and `vercel integration add neon` only offers to open the dashboard ("must be provisioned through the Web UI").
Once the database exists, the Neon MCP or console can run SQL on it normally: the tables were created by running the six
statements of `db/schema.sql` in one transaction (the same thing `npm run migrate` does; it needs no `DATABASE_URL` copy on this machine).
The team's other Neon project, `litvmgames` (Singapore), holds Neon Auth tables for another app and is not used here. The
dashboard flow also switched on Neon Auth for the new project (`NEON_AUTH_BASE_URL`, `VITE_NEON_AUTH_URL`): this app does not use it.

## 0. Launch the PackShop contract (once, before the first deploy)

The hall sells packs through the **PackShop** contract in `packshop/` (5 cards for 0.001 zkLTC, minted to the buyer).
Until `web/assets/rapture/packshop.json` exists the site runs in **preview mode**: free client-side pulls, nothing minted;
the wallet button and sign-in still work. To go live, follow "Launch on Liteforge" in `packshop/README.md`. In short:

```
cd packshop
npm install
# dry run first (prints the plan, sends nothing):
DEPLOYER_KEY=0x... npx hardhat run scripts/launch.js --network liteforge
# for real (StudioMinter admin key, ~0.004 zkLTC):
PACKSHOP_CONFIRM=liteforge DEPLOYER_KEY=0x... npx hardhat run scripts/launch.js --network liteforge
node scripts/write-web-config.mjs        # checks the shop on chain, writes ../web/assets/rapture/packshop.json
```

Then continue with the site deploy below. The launch is idempotent (safe to re-run) and never leaves the key on disk.

## 1. Create the database (Neon)

1. In Neon, create a project. Pick the region closest to where your Vercel functions run
   (default: Washington, D.C. = `iad1`, so "AWS US East 1 (N. Virginia)").
2. Open **Connect**, switch **Connection pooling** on, and copy the connection string
   (the host contains `-pooler`). It looks like
   `postgresql://USER:PASSWORD@ep-xxxx-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require`.

## 2. Create the tables (once)

From the repo root:

```
npm install
copy .env.example .env        (bash: cp .env.example .env)
```

Open `.env`, paste the connection string after `DATABASE_URL=`, then:

```
npm run migrate
```

It prints the database host (never the password) and is safe to re-run. `.env` holds a
secret: keep `.env*`, `node_modules/` and `.vercel/` out of git.
(Alternative without a file: set `DATABASE_URL` in the shell, then `npm run migrate`.
PowerShell: `$env:DATABASE_URL = "postgresql://..."`; bash: `export DATABASE_URL='postgresql://...'`.)

## 3. Link the project and set environment variables

```
vercel link
vercel env add DATABASE_URL production
```

`vercel link`: choose your scope, create a new project, and keep the code directory as `./`.
Paste the pooled connection string when `vercel env add` asks. If you also want preview
deployments to work, repeat with `preview` instead of `production`.

Optional variables (add them the same way):

| Variable | Meaning |
| --- | --- |
| `SIWE_CHAIN_ID` | Chain the sign-in message is bound to. Default `4441` (Liteforge testnet). |
| `ALLOWED_HOSTS` | Comma-separated hosts allowed to sign in, exactly as in the browser address bar, for example `forge.example.com,my-forge.vercel.app`. Unset = any host. Set it in production: it pins the sign-in domain to hosts you chose. |

There is no `SESSION_SECRET`: sessions are random tokens stored hashed in the database.

`vercel.json` already sets Framework "Other", no build command, and output directory `web`.

## 4. Deploy

```
vercel --prod
```

Environment variable changes only apply to the next deployment, so redeploy after
changing any. Then check the site and the database connection:

```
curl https://YOUR-DOMAIN/api/health
```

Expected: `{"ok":true,"db":true}`. `"db":false` means the function cannot reach Neon: check
`DATABASE_URL` for the environment you deployed to, and that step 2 ran against the same database.

## 5. Run it locally

```
npm run dev
```

Opens `http://localhost:3000`: the same `web/` files plus the same `/api/*` handlers. With no
`DATABASE_URL` set it uses a throwaway in-memory database (sessions vanish on restart), so it
works with zero setup. MetaMask signs in fine on `http://localhost:3000`; session cookies
drop the `Secure` flag only on `localhost` / `127.0.0.1`.

- Other port: `PORT=4000 npm run dev` (PowerShell: `$env:PORT=4000; npm run dev`).
- Use Neon instead: export `DATABASE_URL` in the shell before `npm run dev`
  (run `npm run migrate` against it first).
- API code changes need a restart of the dev server.
- Tests: `npm test` (real ethers wallets sign real messages against in-memory Postgres).

## What is deployed

`.vercelignore` uploads only `web/`, `api/`, `db/`, `package.json`, `package-lock.json` and
`vercel.json`, about 51 MB instead of gigabytes: the Blender files, `bake/`, `aeris/`,
`packshop/`, `scripts/`, the tests, and a few unneeded files inside `web/` (raw model exports,
the 24 fps pack video originals, `web/test/`) stay home. Keep `/api/test/` in that file: Vercel
turns every `.js` file it sees under `api/` (except names starting with `_`) into a public endpoint.

## Endpoints (same origin, JSON, session by cookie)

| Endpoint | Purpose |
| --- | --- |
| `POST /api/auth/nonce` `{"address"}` | Returns `{"nonce","message"}`: the message to sign. |
| `POST /api/auth/verify` `{"message","signature"}` | Checks the signature, sets the `forge_session` cookie, returns `{"address","createdAt"}`. |
| `GET /api/auth/me` | `{"address","createdAt","displayName"}`, or 401 when signed out. |
| `POST /api/auth/logout` | 204; ends the session. |
| `GET /api/health` | `{"ok":true,"db":true\|false}`. |

Notes for the browser client: every POST needs the header `content-type: application/json`
(logout too; the body may be empty or `{}`), and `/verify` must receive the exact `message`
string that `/nonce` returned. Cross-origin requests are refused on purpose.

Hardening worth doing in the Vercel dashboard: a Firewall rate-limit rule for `/api/auth/*`
(nonces are cheap to request, and expired ones are purged automatically).
Smart-contract wallets (EIP-1271) are not supported; ordinary wallets such as MetaMask are.

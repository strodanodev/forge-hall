// Snapshot the Rapture ARC 1 collection for the FORGE pack opening (preview: nothing is written on chain).
//
//   node scripts/rapture_snapshot.mjs [--paintings <dir>] [--no-avatars]
//   node scripts/rapture_snapshot.mjs --local <studio>/out/deployment.localhost.json [--no-avatars]
//   node scripts/rapture_snapshot.mjs --deployment <studio>/out/deployment.liteforge.json   (after a Liteforge redeploy;
//     without it the snapshot reads the Liteforge deployment whose address is fixed below). Add
//     --plates <studio>/out/assets to crop fresh paintings from the design's plate (hash-checked); otherwise paintings
//     come from the 22 GODS pack art in --paintings, which may be older than the deployment
//
// --local reads the Studio's local test chain instead of Liteforge: the art session's latest bodies (fixed feet, King
// wireframe crown) live only there until Liteforge is updated. Same checks; files come from the Studio asset host
// (http, content-addressed) instead of IPFS, and each painting is cropped from the plate the design doc names, the way
// the Studio's pack export crops it. Run without --local to go back to the Liteforge snapshot.
//
// 1. enumerates the collection's tokens on chain (setId << 32 | n until tokenURI reverts) and decodes each token's
//    inline character.json: name, traits, stats, soul/avatar commitments
// 2. downloads each token's web avatar (animation_url) and SOUL.md from IPFS and checks them against the hashes the
//    token commits to (sha256 / keccak256), so the preview never shows bytes the chain does not vouch for
// 3. copies each card's painting (the Studio pack's square plate crop; the on-chain `image` is the fully framed
//    card, which the FORGE frame replaces) and writes web/assets/rapture/cards.json
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const LIVE = {
  name: "Rapture — ARC 1",
  network: "liteforge",
  chainId: 4441,
  rpc: "https://liteforge.rpc.caldera.xyz/http",
  address: "0x138F1A2E48111aFD0Af865F421F05Fd1B0A72721",   // 2026-09-30 redeploy (the first, 0xe519…0018, is retired)
  explorer: "https://liteforge.explorer.caldera.xyz",
  setId: 1,
};
const GATEWAY = "https://ipfs.filebase.io/ipfs/"; // this machine can't resolve ipfs.io / dweb.link
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "web", "assets", "rapture");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const LOCAL = opt("--local", null);
const DEPLOYMENT = opt("--deployment", null);   // any Studio deployment.<network>.json (e.g. a fresh Liteforge deploy)
const COLLECTION = LOCAL ? fromDeployment(LOCAL, true) : DEPLOYMENT ? fromDeployment(DEPLOYMENT, false) : LIVE;
function fromDeployment(file, local) {
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  const live = dep.chainId === LIVE.chainId;       // Liteforge: keep its explorer and IPFS reads
  return { name: LIVE.name, network: dep.network, chainId: dep.chainId, rpc: dep.rpc ?? LIVE.rpc, address: dep.addresses.RaptureCards,
    explorer: live ? LIVE.explorer : null, setId: dep.setId, ...(local || !live ? { local: true } : {}) };
}
const PLATES = opt("--plates", null);           // a folder of the Studio's plate PNGs (<sha256>.png), e.g. <studio>/out/assets
const PAINTINGS = opt("--paintings", null);     // a folder of rapture-<slug>.webp (the Studio's pack art) when --plates is not given
const AVATARS = !args.includes("--no-avatars");

// ---------------------------------------------------------------- chain (read-only eth_call)
async function ethCall(data) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(COLLECTION.rpc, {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(30000),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: COLLECTION.address, data }, "latest"] }),
      });
      const j = await r.json();
      if (j.error) return { error: j.error.message ?? "eth_call failed" };
      return { result: j.result };
    } catch (e) { if (attempt >= 3) throw e; await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); }
  }
}
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
function decodeString(hex) {
  const b = Buffer.from(hex.slice(2), "hex");
  const off = Number(BigInt("0x" + b.subarray(0, 32).toString("hex")));
  const len = Number(BigInt("0x" + b.subarray(off, off + 32).toString("hex")));
  return b.subarray(off + 32, off + 32 + len).toString("utf8");
}
async function tokenJson(id) {
  const { result, error } = await ethCall("0xc87b56dd" + word(id)); // tokenURI(uint256)
  if (error || !result || result === "0x") return null;
  const uri = decodeString(result);
  if (!uri.startsWith("data:application/json;base64,")) throw new Error(`token ${id}: tokenURI is not inline JSON`);
  return JSON.parse(Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64").toString("utf8"));
}

// ---------------------------------------------------------------- ipfs
async function ipfs(uri) {
  const url = uri.replace(/^ipfs:\/\//, GATEWAY);
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(90000) });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { if (attempt >= 3) throw e; await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); }
  }
}
const sha256 = (b) => "0x" + crypto.createHash("sha256").update(b).digest("hex");
const cid = (uri) => uri.slice("ipfs://".length).split("/")[0];
// a file the token names by hash lives beside its image: ipfs://<cid>/<file>, or the asset host's folder
const sibling = (image, file) => image.startsWith("ipfs://") ? `ipfs://${cid(image)}/${file}` : image.slice(0, image.lastIndexOf("/") + 1) + file;

// the painting the game prints (and the FORGE frames): the plate's top square at 768, as the Studio's pack export bakes it
function cropPainting(plate, out) {
  const py = `import sys,io
from PIL import Image
im=Image.open(io.BytesIO(sys.stdin.buffer.read())).convert('RGB')
` +
    `s=min(im.size);l=(im.size[0]-s)//2
im.crop((l,0,l+s,s)).resize((768,768),Image.LANCZOS).save(sys.argv[1],'WEBP',quality=84)`;
  const r = spawnSync("python", ["-c", py, out], { input: plate });
  if (r.status !== 0) throw new Error(`painting crop failed: ${r.stderr}`);
}

// SOUL.md is free LLM prose in several markdown shapes (title line + "- Voice: .." bullets, "## Voice" headings,
// "**Voice:**" bold labels, plain paragraphs with "In a fight:"). Normalise to plain text, then split on the labels
// the Studio prompts for. Everything unlabelled is the intro. Result: { intro, voice, values, fight }, each capped
// at a sentence boundary so the lore panel stays readable.
const LABELS = { voice: /^voice$/i, values: /^values?$/i, fight: /^(in a fight|in battle|in combat|fighting style|combat|tactics)$/i };
function parseSoul(md) {
  let t = md.replace(/\r/g, "")
    .replace(/#{1,3}\s*(Voice|Values?|In a fight|In battle|Fighting style|Combat|Tactics)\b\s*:?/gi, "$1:")  // "## Voice"
    .replace(/\*\*([^*]+?):\*\*|\*\*([^*]+?)\*\*:/g, (m, a, b) => `${a ?? b}:`)                            // "**Voice:**"
    .replace(/\[(Voice|Values?|In a fight|Combat|Tactics)\]\s*/gi, "$1: ")                                  // "[Voice]"
    .replace(/[*_`]+/g, "").replace(/^\s*[-•]\s+/gm, "").replace(/\s+/g, " ").trim();
  t = t.replace(/^[—-]\s*SOUL\.MD\.?\s*/i, "");
  if (t.startsWith("#")) t = t.slice(titleEnd(t));                      // "# Name, Epithet (Kind, ... (x))." title

  t = t.replace(/(Stats:\s*)?STR \d+\s*[/,]\s*AGI \d+\s*[/,]\s*RES \d+\s*[/,]\s*INT \d+\.?/gi, "").replace(/^[\s.,;:-]+/, "");
  const out = { intro: "", voice: "", values: "", fight: "" };
  const re = /(?:^|[\s.;—-])(Voice|Values?|In a fight|In battle|In combat|Fighting style|Combat|Tactics):\s*/gi;
  let key = "intro", last = 0, m;
  while ((m = re.exec(t))) {
    out[key] += " " + t.slice(last, m.index + (m[0].match(/^[.;]/) ? 1 : 0));
    key = Object.keys(LABELS).find((k) => LABELS[k].test(m[1])) ?? "intro";
    last = m.index + m[0].length;
  }
  out[key] += " " + t.slice(last);
  for (const k in out) out[k] = out[k].replace(/\s+/g, " ").replace(/^[\s\-—.:;]+/, "").replace(/[\s\-—:;]+$/, "").trim();
  out.intro = out.intro.split(/(?<=[.!?])\s+/).filter(storySentence).join(" ").replace(/^You are /, "");
  for (const k in out) out[k] = capSentences(out[k].replace(/^[(\[]/, "").replace(/^./, (c) => c.toUpperCase()), 520);
  return out;
}
// Drop what the card face already says or what is prompt residue: stat lines, trait lists, "test-deck" notes.
const TRAIT = /^(god|gods|titan|king|demigod|mortal|ascended|rising|fallen|path|alliance|horde|good|feral|corrupted|sealed|water|lava|earth|metal|glass|obsidian|pearl|smoke|frame|kit|halo|eyes?|flicker|cracked|dark|intact|arc|1|of|the|and|a|an|with|fights|riki|ares|hephaestus|hermes|athena|zeus|poseidon)$/i;
function storySentence(s) {
  if (/\d{4,}|^stats?:|test-deck|test deck|SOUL\.MD|every sentence below|AI agent|character sheet/i.test(s)) return false;
  const words = s.replace(/[^A-Za-z' ]+/g, " ").split(/\s+/).filter(Boolean);
  return words.filter((w) => !TRAIT.test(w)).length >= 5;
}
// a soul whose prose all filtered away still shows something: the token's own on-chain bio
const withFallback = (soul, bio) => (Object.values(soul).some(Boolean) ? soul : { ...soul, intro: bio });
// end of a "# ..." title: the first ". " or " - " outside parentheses (titles nest them: "(Feral (halo flicker))")
function titleEnd(t) {
  let depth = 0;
  for (let i = 1; i < Math.min(t.length, 400); i++) {
    const ch = t[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && ((ch === "." && t[i + 1] === " ") || (ch === " " && t[i + 1] === "-" && t[i + 2] === " "))) return i + 1;
  }
  return 1;
}
function capSentences(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max), end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > max * 0.4 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "") + "…";
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// ---------------------------------------------------------------- main
const base = BigInt(COLLECTION.setId) << 32n;
const tokens = [];
// PackShop mints NEW tokens (editions) from the same designs, so the set can hold many tokens per design. Keep the FIRST
// token of each design (the original card) and skip its editions, or the pack pool would fill with duplicates.
const seenDesigns = new Set();
let editions = 0;
for (let n = 0n; ; n++) {
  const j = await tokenJson(base + n);
  if (!j) break;
  const design = j.rapture?.design?.hash;
  if (design && seenDesigns.has(design)) { editions++; continue; }
  if (design) seenDesigns.add(design);
  tokens.push({ id: (base + n).toString(), j });
  process.stdout.write(`\rtokens ${tokens.length}`);
}
console.log(`\n${tokens.length} cards (${editions} editions skipped) on ${COLLECTION.network} ${COLLECTION.address}`);
if (!tokens.length) throw new Error("no tokens found");

fs.mkdirSync(path.join(OUT, "art"), { recursive: true });
if (AVATARS) fs.mkdirSync(path.join(OUT, "avatars"), { recursive: true });
const { keccak_256 } = await import("@noble/hashes/sha3");   // a root dependency (api/_lib/address.js uses it too)
const { bytesToHex } = await import("@noble/hashes/utils");

const cards = await pool(tokens, 6, async ({ id, j }) => {
  const r = j.rapture, attr = Object.fromEntries(j.attributes.map((a) => [a.trait_type, a.value]));
  const slug = j.name.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  if (LOCAL || PLATES) {
    // painting: the plate the design doc names. The doc must be the design the token commits to (rapture.design.hash,
    // the Studio's structural design hash, not a byte hash); the plate is checked against its own sha256.
    const doc = JSON.parse((await ipfs(j.external_url)).toString("utf8"));
    if (!r.design?.hash || doc.designHash !== r.design.hash) throw new Error(`${j.name}: design doc is not the token's design`);
    const plateHash = doc.art?.plate;
    if (!plateHash) throw new Error(`${j.name}: design doc names no plate`);
    const plate = PLATES ? fs.readFileSync(path.join(PLATES, `${plateHash.slice(2)}.png`))
      : await ipfs(sibling(j.image, `${plateHash.slice(2)}.png`));
    if (sha256(plate) !== plateHash) throw new Error(`${j.name}: plate does not match its hash`);
    cropPainting(plate, path.join(OUT, "art", `${slug}.webp`));
  } else {
    // painting (Studio pack art, same slug the game importer uses)
    if (!PAINTINGS) throw new Error("pass --plates <studio>/out/assets (the plate crops) or --paintings <folder of rapture-<slug>.webp>");
    const src = path.join(PAINTINGS, `rapture-${slug}.webp`);
    if (!fs.existsSync(src)) throw new Error(`${j.name}: no painting at ${src}`);
    fs.copyFileSync(src, path.join(OUT, "art", `${slug}.webp`));
  }

  // soul: bytes must hash to the committed keccak256
  const soulBytes = await ipfs(sibling(j.image, j.soul.file));
  if ("0x" + bytesToHex(keccak_256(soulBytes)) !== j.soul.keccak256) throw new Error(`${j.name}: SOUL.md does not match its keccak256`);

  let avatar = null;
  if (AVATARS) {
    const file = path.join(OUT, "avatars", `${slug}.glb`);
    let bytes = fs.existsSync(file) ? fs.readFileSync(file) : null;
    if (!bytes || sha256(bytes) !== j.avatar.sha256) {
      bytes = await ipfs(j.animation_url);
      if (sha256(bytes) !== j.avatar.sha256) throw new Error(`${j.name}: avatar bytes do not match the token's sha256`);
      fs.writeFileSync(file, bytes);
    }
    avatar = { url: `./assets/rapture/avatars/${slug}.glb`, sha256: j.avatar.sha256, bytes: bytes.length };
  }
  process.stdout.write(".");
  return {
    tokenId: id, slug, name: j.name, epithet: attr.Epithet, bio: j.description,
    kind: r.kind, path: r.path, faction: r.faction, alignment: r.alignment, element: r.element, frame: r.frame,
    kit: attr.Kit, set: attr.Set, bodyType: r.bodyparts?.bodyType,
    stats: { str: attr.Strength, agi: attr.Agility, res: attr.Resilience, int: attr.Intelligence },
    soul: withFallback(parseSoul(soulBytes.toString("utf8")), j.description),
    art: `./assets/rapture/art/${slug}.webp`,
    image: j.image, metadata: j.external_url, avatar,
  };
});

const snapshot = { collection: { ...COLLECTION, snapshotAt: new Date().toISOString(), count: cards.length }, cards };
fs.writeFileSync(path.join(OUT, "cards.json"), JSON.stringify(snapshot, null, 1));
const kinds = cards.reduce((m, c) => ((m[c.kind] = (m[c.kind] ?? 0) + 1), m), {});
console.log(`\nwrote ${path.join(OUT, "cards.json")}: ${cards.length} cards`, kinds);

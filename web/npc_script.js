// FORGE — AERIS's lines. PLACEHOLDER COPY: rewrite freely; the code only reads this shape.
//
// A line is [emotion, text]. Emotions map to the pose sheets in assets/npc/:
//   idle      arms down, soft smile        (resting, listening)
//   talking   finger raised, mouth open    (explaining; lip-flaps against a closed-mouth frame while typing)
//   happy     thumbs up, big grin          (celebrating a pull, greeting)
//   thinking  hand on chin, serious        (hints, suspense, reading a card)
// Text may use the card the beat is about: {name} {epithet} {kind} {path} {element} {faction} {alignment} {frame}
// ({KIND} etc. in capitals prints the value in capitals), and *word* for emphasis (gold, or the card's tier colour).
//
// hall.*  plays in the hall, click/Space to advance (host mode: full portrait + dialogue box).
// pack.*  plays during the pack sequence, auto-advancing (comms mode: small portrait, never blocks the view).
// A beat with several variants picks one at random.

export const NPC = { name: "AERIS", title: "Keeper of the Forge" };

export const SCRIPT = {
  hall: {
    intro: [
      ["happy", "Welcome to the Forge, traveler!"],
      ["talking", "I'm AERIS. This anvil strikes the *Rapture*, the first fifty souls of ARC 1, fresh off the chain."],
      ["thinking", "Every pack holds *five cards*: Mortals, Kings, Demigods, Gods and Titans. At least one is a *Demigod* or better… and the rarest always turns last."],
      ["talking", "Press *Open Pack* whenever you're ready. Tap any card afterwards and I'll show you its soul, and its body."],
      ["happy", "Go on. The forge is waiting."],
    ],
    // the same welcome when a live shop is configured: real packs, real wallet
    introLive: [
      ["happy", "Welcome to the Forge, traveler!"],
      ["talking", "I'm AERIS. This anvil strikes the *Rapture*: connect your wallet, pay a little *zkLTC*, and five cards are minted straight into it."],
      ["thinking", "Kings, Demigods, Titans, Gods and Mortals, all fresh on the testnet. Two signatures per pack: one to buy, one to break the seal."],
      ["talking", "Not ready to spend? *Free Preview* lets you pull for fun. Nothing is minted there."],
      ["happy", "Whenever you are. The forge is waiting."],
    ],
    // clicking AERIS while she's idle in the hall
    chatter: [
      [["thinking", "Gods and Titans are the rarest strikes. Seven packs in a hundred, give or take."]],
      [["talking", "Kind is everything here. A Mortal is glass waiting for light; a God wears the whole halo."]],
      [["happy", "Another pack? I never say no to that."]],
      [["thinking", "This is a *testnet preview*. Nothing you pull here is minted, so pull freely."]],
      [["talking", "Water, Lava, Earth, Metal. The neon tells you the element; the gold is only ever for divinity."]],
    ],
    welcomeBack: [
      [["happy", "Good pulls! Come back when the anvil's hot again."]],
      [["talking", "Those souls will keep. Ready for another?"]],
    ],
  },
  pack: {
    // live shop: the wallet steps and the wait for the chain
    wallet: [[["thinking", "Sign the purchase in your wallet… I'll wait."]], [["talking", "Your wallet is asking. The forge only takes what the price says."]]],
    sealing: [[["talking", "The seal is setting on the chain. Two heartbeats of the forge, no more."]], [["thinking", "Every block is a hammer strike… nearly there."]]],
    signing: [[["happy", "Now break it! Confirm in your wallet and these cards are *yours*."]]],
    error: [[["thinking", "Something snagged. Your pack is safe on the chain; read the note below."]], [["talking", "That didn't go through. Nothing is lost: try again when you're ready."]]],
    open: [[["talking", "Hold it steady… every seal is struck by a god."]], [["thinking", "Let's see who answers the Rapture."]]],
    again: [[["happy", "Another one? The forge never sleeps!"]], [["talking", "Fresh seal, fresh souls. Here we go."]]],
    tear: [[["thinking", "Feel that? The seal's giving way…"]]],
    burst: [[["happy", "*There* it goes!"]]],
    skip: [[["happy", "Impatient? I like that."]]],
    reveal: [[["talking", "Five souls. The *rarest* turns last."]]],
    // a big card flipping (Demigod = epic, God / Titan = legendary)
    epic: [[["happy", "A *Demigod!* {name}, {epithet}."]]],
    legendary: [[["happy", "*A {KIND}!* {name}, {epithet}!"]]],
    done: {
      legendary: [[["happy", "A *{kind}* leads this pack! Tap {name} and meet them properly."]]],
      epic: [[["happy", "{name}, a {element} Demigod. Tap any card to see its soul."]]],
      rare: [[["talking", "A King leads this pack: {name}. Tap a card to inspect it, or open another."]]],
      common: [[["thinking", "Mortals only… still glass, still waiting. Tap one, or try your luck again."]]],
    },
    inspect: {
      God: [[["thinking", "{name}, {epithet}. A {element} God of the {faction}, on the {path} path."]]],
      Titan: [[["thinking", "{name}. A {path} Titan of {element}, chrome cracked by the old war."]]],
      Demigod: [[["thinking", "{name}, {epithet}. A Demigod, sternum open, halfway to the light."]]],
      King: [[["talking", "{name}, a King of {element}. Faceted chrome and a ring of power."]]],
      Mortal: [[["thinking", "{name}. A glass Mortal of the {path} path, waiting for the Rapture to fill them."]]],
    },
  },
};

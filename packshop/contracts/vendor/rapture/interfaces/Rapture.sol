// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// Shared types and the narrow interfaces the Rapture contracts call on each
/// other and on litnode's deployed contracts (PlayerProfile, NodeStake v3).

/// What a reveal writes. `alignment` 255 = sealed (Section 7 of the spec).
/// Frame is an unranked card-frame style and bodyparts are variety slots; the
/// only tier is Kind (Art Direction tab, 2026-09-28).
struct Traits {
    uint8 faction;     // 0 Alliance, 1 Horde (shown as a sigil on the frame)
    uint8 alignment;   // 0 Good, 1 Corrupted, 2 Feral, 255 sealed
    uint8 element;     // 0 Earth, 1 Lava, 2 Metal, 3 Water
    uint8 frame;       // 0 Glass, 1 Obsidian, 2 Pearl, 3 Smoke
    uint32 bodyparts;  // head | facet << 8 | circuit << 16 | bodyType << 24
    uint16 strength;
    uint16 agility;
    uint16 resilience;
    uint16 intelligence;
}

struct Card {
    address drop;          // the drop that minted it
    uint64 profileId;      // PlayerProfile it was minted for
    uint32 index;          // position in its drop, 0-based
    uint16 setId;
    uint8 kind;            // 0 Mortal, 1 King, 2 Demigod, 3 Titan, 4 God
    uint8 faction;
    uint8 alignment;
    uint8 element;
    uint8 frame;
    uint32 bodyparts;
    bool revealed;
    bool custodial;        // minted to the profile's proxy: may only move to its linked signer
    bytes32 entropyCommit; // keccak256(entropy) (open mode) or Poseidon2(entropy) (sealed mode)
    bytes32 sealedCommit;  // Poseidon2(alignment, sealed traits, salt); 0 when nothing is sealed
}

/// Where a forged card came from: the NFT consumed into a ForgeVault.
struct Origin {
    uint64 chainId;
    address collection;
    uint256 tokenId;
}

/// A Studio Mode card's design record (CardDesign). Hashes, not locations:
/// the art host can move without anything on chain changing.
struct Design {
    bytes32 designHash;    // keccak256 of the canonical design JSON (rapture-studio/2)
    bytes32 art;           // sha256 of the published card image (WebP; its PNG master is in the design doc)
    bytes32 turntable;     // sha256 of the turntable WebM, 0 when none
    bytes32 overridesHash; // keccak256 of the canonical per-game overrides JSON
    bytes32 avatar;        // sha256 of the avatar GLB, web encoding (meshopt; erc6699-avatar/1)
    bytes32 avatarPlain;   // sha256 of the same avatar in core glTF (no extension required)
    bytes32 soul;          // keccak256 of SOUL.MD: the card's ERC-6699 soulManifestHash from mint
    uint8 kit;             // 0 none, 1 Hermes, 2 Ares, 3 Hecate, 4 Riki, 5 Hephaestus
    string name;
    string epithet;
}

interface ICardDesign {
    function has(uint256 tokenId) external view returns (bool);
    function designOf(uint256 tokenId) external view returns (Design memory);
}

interface IPlayerProfile {
    function profileOf(address wallet) external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function ownerOfKey(bytes32 key) external view returns (address owner, uint256 tokenId, bool active);
}

interface INodeStake {
    function standingOf(bytes32 nodeKey) external view returns (address operator, uint256 amount, bool active);
}

/// Matches the verifier Noir/Barretenberg generates: verify(proof, publicInputs).
interface IVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}

interface ISeedBeacon {
    function randomness(uint64 round) external view returns (bytes32);
}

interface IIdentityLink {
    function proxyOf(uint256 profileId) external view returns (address);
    function signerOf(uint256 profileId) external view returns (address);
    function profileOfSigner(address signer) external view returns (uint256);
    function profileOf(address who) external view returns (uint256);
}

interface ISetRegistry {
    function setOfDrop(address drop) external view returns (uint16);
    function nameOf(uint16 setId) external view returns (string memory);
}

interface IRaptureDropView {
    function seed() external view returns (bytes32);
    function kindOf(uint32 index) external view returns (uint8);
    function derive(uint256 tokenId, uint32 index, bytes32 entropy) external view returns (Traits memory);
    function sealedMode() external view returns (bool);
    function revealVerifier() external view returns (IVerifier);
    function ruleTableRoot() external view returns (bytes32);
    function revealDeadline() external view returns (uint64);
    function bandOf(uint8 kind) external view returns (uint16 min, uint16 max);
}

interface IRaptureMetadata {
    function tokenURI(uint256 tokenId) external view returns (string memory);
    /// ERC-6699 characterConfigURI (a CAIP-19 pointer to the card) and
    /// characterConfigHash (keccak256 of the image-free character.json).
    function agentConfig(uint256 tokenId) external view returns (string memory uri, bytes32 hash);
    /// The SOUL.MD hash a card is minted with (Studio cards: their design's), 0 when none.
    function soulOf(uint256 tokenId) external view returns (bytes32);
}

interface IRaptureCards {
    function mint(address to, uint256 profileId, uint32 index, bytes32 entropyCommit) external returns (uint256);
    function mintRevealed(address to, uint256 profileId, uint32 index, uint8 kind, Traits calldata t, bytes32 sealedCommit, Origin calldata o) external returns (uint256);
    function originOf(uint256 tokenId) external view returns (Origin memory);
    function burn(uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
    function cardOf(uint256 tokenId) external view returns (Card memory);
    function revealedOf(address owner, uint16 setId) external view returns (uint256);
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// ERC-6699 (PROPOSED, litVM Games whitepaper Article VI), as litnode's
/// ERC6699Registry v2 declares it. No ERC number is assigned; "ERC-6699" is
/// the project's proposed interface. Any contract implementing this is an
/// ERC-6699 character source; compatibility is the interface, not an address.
interface IERC6699 {
    struct CoreStats {
        uint16 strength;
        uint16 agility;
        uint16 resilience;
        uint16 intelligence;
        uint32 level;
        uint64 experience;
    }

    struct AgentManifest {
        string  characterConfigURI;   // character.json
        bytes32 soulManifestHash;     // keccak256(SOUL.MD)
        address agentController;      // who may act for the agent
        bytes32 characterConfigHash;  // keccak256(character.json)
        uint64  statsNonce;           // bumped on every stat write (never, here)
        uint64  manifestNonce;        // bumped on every manifest change
    }

    function coreStats(uint256 tokenId) external view returns (CoreStats memory);
    function manifestOf(uint256 tokenId) external view returns (AgentManifest memory);
    function equipped(uint256 tokenId, bytes32 slot) external view returns (address collection, uint256 assetId);

    function equip(uint256 tokenId, bytes32 slot, address collection, uint256 assetId) external;
    function unequip(uint256 tokenId, bytes32 slot) external;

    event Equipped(uint256 indexed tokenId, bytes32 indexed slot, address collection, uint256 assetId);
    event ManifestUpdated(uint256 indexed tokenId, bytes32 soulManifestHash);
    event Attested(uint256 indexed tokenId, bytes32 indexed registryEntry);
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ERC-6699 (PROPOSED interface, v2 registry) — universal character rules and stats.
/// @notice Deploy target: litVM Liteforge testnet, chain 4441, EVM Shanghai.
///
/// "ERC-6699" is this project's proposed interface (whitepaper Article VI);
/// no such number is assigned in the official ERC index at the time of
/// writing, and nothing here should be read as an adopted standard.
///
/// v2 closes what the build audit found in v1:
///   - `forge` is no longer open: only a MINTER may create a character, so
///     nobody can mint an unused id with arbitrary competitive stats;
///   - stats change only through `progress`, by a PROGRESSOR, against an
///     expected nonce — a settlement pipeline is the intended caller, a
///     player never is; `statsNonce` lets a witness compare nonces instead
///     of needing an archive read;
///   - the manifest carries `characterConfigHash` (§6.3 promised it, the v1
///     struct lacked it) and a `manifestNonce`, updated only by the
///     controller, so a hydration can be verified after the URI's content
///     moves;
///   - `equip` checks that the OWNER of the character owns the referenced
///     item (ERC-721 ownerOf on the collection), not just that the caller
///     controls the character;
///   - ownership is explicit: `ownerOf`, `balanceOf`, `transferFrom` with
///     `Transfer` events. Still not a full ERC-721 (no approvals, no
///     safeTransfer hooks) — stated here rather than pretended.
///
/// Stats are fixed width so no title can quietly overflow another's balance,
/// and the soul is committed by hash so the document can live anywhere and
/// still be checked by anyone.
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
        bytes32 characterConfigHash;  // keccak256(character.json) — v2
        uint64  statsNonce;           // bumped on every progress() — v2
        uint64  manifestNonce;        // bumped on every setManifest() — v2
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

interface IERC721OwnerOf {
    function ownerOf(uint256 tokenId) external view returns (address);
}

contract ERC6699Registry is IERC6699 {
    mapping(uint256 => CoreStats) private _stats;
    mapping(uint256 => AgentManifest) private _manifest;
    mapping(uint256 => mapping(bytes32 => address)) private _slotCollection;
    mapping(uint256 => mapping(bytes32 => uint256)) private _slotAsset;
    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;

    /// Roles. `admin` names minters and progressors and hands itself over;
    /// it never touches a character directly.
    address public admin;
    mapping(address => bool) public minters;
    mapping(address => bool) public progressors;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Forged(uint256 indexed tokenId, address indexed owner, address indexed minter);
    event Progressed(uint256 indexed tokenId, uint64 statsNonce, address indexed by);
    event ControllerSet(uint256 indexed tokenId, address controller);
    event RoleSet(bytes32 indexed role, address indexed who, bool on);
    event AdminTransferred(address indexed from, address indexed to);

    error NotController();
    error NotOwner();
    error NotMinter();
    error NotProgressor();
    error NotAdmin();
    error Exists();
    error Unknown();
    error NonceMismatch(uint64 expected, uint64 actual);
    error ItemNotOwned();
    error ZeroAddress();

    constructor(address admin_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
    }

    modifier onlyAdmin() { if (msg.sender != admin) revert NotAdmin(); _; }
    modifier onlyController(uint256 tokenId) {
        if (msg.sender != _manifest[tokenId].agentController && msg.sender != ownerOf[tokenId]) revert NotController();
        _;
    }

    // ------------------------------------------------------------ roles
    function setMinter(address who, bool on) external onlyAdmin { minters[who] = on; emit RoleSet("minter", who, on); }
    function setProgressor(address who, bool on) external onlyAdmin { progressors[who] = on; emit RoleSet("progressor", who, on); }
    function transferAdmin(address to) external onlyAdmin { if (to == address(0)) revert ZeroAddress(); emit AdminTransferred(admin, to); admin = to; }

    // ------------------------------------------------------------ minting
    /// Only a minter forges. Nonces start at 0; the manifest's hashes are
    /// whatever the minter commits to — the minter is the authority.
    function forge(uint256 tokenId, address owner, CoreStats calldata s, AgentManifest calldata m) external {
        if (!minters[msg.sender]) revert NotMinter();
        if (owner == address(0)) revert ZeroAddress();
        if (ownerOf[tokenId] != address(0)) revert Exists();
        ownerOf[tokenId] = owner;
        balanceOf[owner] += 1;
        totalSupply += 1;
        _stats[tokenId] = s;
        _manifest[tokenId] = AgentManifest(m.characterConfigURI, m.soulManifestHash, m.agentController, m.characterConfigHash, 0, 0);
        emit Transfer(address(0), owner, tokenId);
        emit Forged(tokenId, owner, msg.sender);
        emit ManifestUpdated(tokenId, m.soulManifestHash);
    }

    // ------------------------------------------------------------ progression
    /// The authorized progression path. `expectedNonce` must equal the
    /// current statsNonce so two settlements cannot race each other.
    function progress(uint256 tokenId, CoreStats calldata s, uint64 expectedNonce) external {
        if (!progressors[msg.sender]) revert NotProgressor();
        if (ownerOf[tokenId] == address(0)) revert Unknown();
        AgentManifest storage m = _manifest[tokenId];
        if (m.statsNonce != expectedNonce) revert NonceMismatch(expectedNonce, m.statsNonce);
        _stats[tokenId] = s;
        m.statsNonce += 1;
        emit Progressed(tokenId, m.statsNonce, msg.sender);
    }

    // ------------------------------------------------------------ manifest
    function setManifest(uint256 tokenId, string calldata uri, bytes32 soulManifestHash, bytes32 characterConfigHash)
        external onlyController(tokenId)
    {
        AgentManifest storage m = _manifest[tokenId];
        m.characterConfigURI = uri;
        m.soulManifestHash = soulManifestHash;
        m.characterConfigHash = characterConfigHash;
        m.manifestNonce += 1;
        emit ManifestUpdated(tokenId, soulManifestHash);
    }

    function setController(uint256 tokenId, address controller) external {
        if (msg.sender != ownerOf[tokenId]) revert NotOwner();
        _manifest[tokenId].agentController = controller;
        emit ControllerSet(tokenId, controller);
    }

    // ------------------------------------------------------------ ownership
    function transferFrom(address from, address to, uint256 tokenId) external {
        if (ownerOf[tokenId] != from || msg.sender != from) revert NotOwner();
        if (to == address(0)) revert ZeroAddress();
        ownerOf[tokenId] = to;
        balanceOf[from] -= 1;
        balanceOf[to] += 1;
        emit Transfer(from, to, tokenId);
    }

    // ------------------------------------------------------------ reads
    function coreStats(uint256 tokenId) external view returns (CoreStats memory) { return _stats[tokenId]; }
    function manifestOf(uint256 tokenId) external view returns (AgentManifest memory) { return _manifest[tokenId]; }
    function statsNonce(uint256 tokenId) external view returns (uint64) { return _manifest[tokenId].statsNonce; }

    function equipped(uint256 tokenId, bytes32 slot) external view returns (address, uint256) {
        return (_slotCollection[tokenId][slot], _slotAsset[tokenId][slot]);
    }

    // ------------------------------------------------------------ equipment
    /// The character's OWNER must own the item on its collection.
    function equip(uint256 tokenId, bytes32 slot, address collection, uint256 assetId)
        external onlyController(tokenId)
    {
        (bool ok, bytes memory ret) = collection.staticcall(abi.encodeWithSelector(IERC721OwnerOf.ownerOf.selector, assetId));
        if (!ok || ret.length < 32 || abi.decode(ret, (address)) != ownerOf[tokenId]) revert ItemNotOwned();
        _slotCollection[tokenId][slot] = collection;
        _slotAsset[tokenId][slot] = assetId;
        emit Equipped(tokenId, slot, collection, assetId);
    }

    function unequip(uint256 tokenId, bytes32 slot) external onlyController(tokenId) {
        delete _slotCollection[tokenId][slot];
        delete _slotAsset[tokenId][slot];
        emit Equipped(tokenId, slot, address(0), 0);
    }
}

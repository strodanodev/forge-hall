// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC6699} from "./interfaces/IERC6699.sol";
import {Traits, Card, Origin, IIdentityLink, IVerifier, ISetRegistry, IRaptureDropView, IRaptureMetadata} from "./interfaces/Rapture.sol";

/// The write side of litnode's ERC6699Registry v2 that the mirror uses. This
/// contract must be named a MINTER by the registry's admin.
interface IERC6699Registry {
    function forge(uint256 tokenId, address owner, IERC6699.CoreStats calldata s, IERC6699.AgentManifest calldata m) external;
    function setController(uint256 tokenId, address controller) external;
    function setManifest(uint256 tokenId, string calldata uri, bytes32 soulManifestHash, bytes32 characterConfigHash) external;
}

/// @title RaptureCards — every Rapture card, every set: a full ERC-721 that
/// implements the proposed ERC-6699 character interface.
///
/// Fair-launch invariants this contract holds (spec Section 6):
///   - only a drop registered in SetRegistry can mint;
///   - no stat or trait can change after reveal: there is no progressor, no
///     admin write path, and the contract is not upgradeable;
///   - a card minted to a profile's proxy wallet (a node-held key) can leave
///     it only for that profile's linked signer (IdentityLink), so the node
///     operator holding the proxy key cannot take it;
///   - reveal is by proof (sealed mode), by the holder's entropy (open mode),
///     or, after the reveal window, by anyone on the public default path.
///
/// Plug and play with litnode: at reveal every card is MIRRORED into litnode's
/// ERC6699Registry (registry id = registryIdOf(tokenId)), owned by this
/// contract as custodian, with agentController = the holder's play wallet.
/// litnode nodes hydrate ranked matches from that registry and accept a player
/// whose profile wallet owns OR controls the character (protocol/registry.js
/// mayPlay), so a card plays on the mesh with no node change. Every transfer
/// re-points the registry controller to the new holder.
contract RaptureCards is ERC721, IERC6699 {
    uint8 public constant SEALED = 255;
    uint256 public constant MAX_SLOTS = 8;
    uint256 internal constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    ISetRegistry public immutable sets;
    IIdentityLink public immutable identity;
    IRaptureMetadata public immutable metadata;
    /// litnode's ERC6699Registry on this chain; zero disables the mirror.
    IERC6699Registry public immutable registry;

    /// Predicate verifier (spec Section 7). Set once by the deployer when the
    /// audited circuit ships; zero until then, which disables predicates.
    IVerifier public predicateVerifier;
    address private _deployer;

    uint256 public totalSupply;
    mapping(uint256 => Card) private _cards;
    mapping(uint256 => CoreStats) private _stats;
    mapping(uint256 => address) private _controller;
    mapping(uint256 => bytes32) private _soul;
    mapping(uint256 => uint64) private _manifestNonce;
    mapping(uint256 => bytes32[]) private _slots;
    mapping(uint256 => mapping(bytes32 => address)) private _slotCollection;
    mapping(uint256 => mapping(bytes32 => uint256)) private _slotAsset;
    /// Revealed cards held, per owner and set: what RaptureAccess and NodeLicense read.
    mapping(address => mapping(uint16 => uint256)) public revealedOf;
    /// Forged cards: the NFT consumed into a ForgeVault to make this card.
    mapping(uint256 => Origin) private _origin;

    event Mirrored(uint256 indexed tokenId, uint256 indexed registryId);
    event Revealed(uint256 indexed tokenId, uint8 kind, uint8 alignment, bytes32 sealedCommit, uint8 path);
    event PredicateProven(uint256 indexed tokenId, uint8 indexed predicateId, bytes32 arg, bool result);
    event ControllerSet(uint256 indexed tokenId, address controller);

    error NotDrop();
    error NotYourDrop();
    error AlreadyRevealed();
    error NoSeed();
    error WrongMode();
    error BadEntropy();
    error BadProof();
    error OutOfBand();
    error TooEarly();
    error CustodialCard();
    error NotClaimable();
    error NotController();
    error NotOwner();
    error ItemNotOwned();
    error TooManySlots();
    error NoPredicates();
    error NothingSealed();
    error AlreadySet();

    constructor(ISetRegistry sets_, IIdentityLink identity_, IRaptureMetadata metadata_, IERC6699Registry registry_) ERC721("Rapture Cards", "RAPTURE") {
        sets = sets_;
        identity = identity_;
        metadata = metadata_;
        registry = registry_;
        _deployer = msg.sender;
    }

    /// The card's id in litnode's registry. Hashing in this contract's
    /// address keeps it clear of every other minter's ids.
    function registryIdOf(uint256 tokenId) public view returns (uint256) {
        return uint256(keccak256(abi.encode(address(this), tokenId)));
    }

    function setPredicateVerifier(IVerifier v) external {
        if (msg.sender != _deployer || address(predicateVerifier) != address(0)) revert AlreadySet();
        predicateVerifier = v;
        _deployer = address(0);
    }

    // ------------------------------------------------------------------ mint / burn

    /// tokenId = setId << 32 | index: unique across sets, readable, never 0.
    function mint(address to, uint256 profileId, uint32 index, bytes32 entropyCommit) external returns (uint256 tokenId) {
        uint16 setId = sets.setOfDrop(msg.sender);
        if (setId == 0) revert NotDrop();
        tokenId = (uint256(setId) << 32) | index;
        address proxy = identity.proxyOf(profileId);
        Card storage c = _cards[tokenId];
        c.drop = msg.sender;
        c.profileId = uint64(profileId);
        c.index = index;
        c.setId = setId;
        c.alignment = SEALED;
        c.custodial = (to == proxy);
        c.entropyCommit = entropyCommit;
        totalSupply += 1;
        _mint(to, tokenId);
    }

    /// Forged cards (RaptureForge): minted already revealed, with the traits the
    /// forger chose inside the tier's budget and the Kind's band, and the
    /// consumed NFT recorded as the card's origin.
    function mintRevealed(address to, uint256 profileId, uint32 index, uint8 kind, Traits calldata t, bytes32 sealedCommit, Origin calldata o)
        external
        returns (uint256 tokenId)
    {
        uint16 setId = sets.setOfDrop(msg.sender);
        if (setId == 0) revert NotDrop();
        tokenId = (uint256(setId) << 32) | index;
        Card storage c = _cards[tokenId];
        c.drop = msg.sender;
        c.profileId = uint64(profileId);
        c.index = index;
        c.setId = setId;
        c.custodial = (to == identity.proxyOf(profileId));
        _origin[tokenId] = o;
        // a card minted with its SOUL.MD (Studio designs) starts with that soul committed,
        // so its ERC-6699 manifest and registry twin carry it from the first block
        bytes32 soul = metadata.soulOf(tokenId);
        if (soul != bytes32(0)) _soul[tokenId] = soul;
        totalSupply += 1;
        _mint(to, tokenId);
        _write(tokenId, c, IRaptureDropView(msg.sender), kind, t, sealedCommit == bytes32(0) ? t.alignment : SEALED, sealedCommit, 3);
    }

    /// Refund path only: the minting drop burns an unrevealed card it refunds.
    function burn(uint256 tokenId) external {
        Card storage c = _cards[tokenId];
        if (msg.sender != c.drop) revert NotYourDrop();
        if (c.revealed) revert AlreadyRevealed();
        totalSupply -= 1;
        _burn(tokenId);
        delete _cards[tokenId];
    }

    // ------------------------------------------------------------------ reveal

    /// Sealed mode: public traits and stats become state, Alignment and sealed
    /// traits stay a commitment. Public inputs, in order, match circuits/reveal.
    function reveal(uint256 tokenId, Traits calldata t, bytes32 sealedCommit, bytes calldata proof) external {
        Card storage c = _revealable(tokenId);
        IRaptureDropView d = IRaptureDropView(c.drop);
        if (!d.sealedMode()) revert WrongMode();
        uint8 kind = d.kindOf(c.index);
        bytes32[] memory pub = new bytes32[](14);
        pub[0] = bytes32(tokenId);
        pub[1] = bytes32(uint256(d.seed()) % FIELD);
        pub[2] = c.entropyCommit;
        pub[3] = d.ruleTableRoot();
        pub[4] = bytes32(uint256(kind));
        pub[5] = bytes32(uint256(t.faction));
        pub[6] = bytes32(uint256(t.element));
        pub[7] = bytes32(uint256(t.frame));
        pub[8] = bytes32(uint256(t.bodyparts));
        pub[9] = bytes32(uint256(t.strength));
        pub[10] = bytes32(uint256(t.agility));
        pub[11] = bytes32(uint256(t.resilience));
        pub[12] = bytes32(uint256(t.intelligence));
        pub[13] = sealedCommit;
        if (!d.revealVerifier().verify(proof, pub)) revert BadProof();
        _write(tokenId, c, d, kind, t, SEALED, sealedCommit, 0);
    }

    /// Open mode: the holder publishes the entropy; traits are derived on chain.
    function revealOpen(uint256 tokenId, bytes32 entropy) external {
        Card storage c = _revealable(tokenId);
        IRaptureDropView d = IRaptureDropView(c.drop);
        if (d.sealedMode()) revert WrongMode();
        if (keccak256(abi.encode(entropy)) != c.entropyCommit) revert BadEntropy();
        Traits memory t = d.derive(tokenId, c.index, entropy);
        _write(tokenId, c, d, d.kindOf(c.index), t, t.alignment, 0, 1);
    }

    /// After the reveal window anyone may reveal with entropy = 0: traits from
    /// the seed alone, Alignment public. No card stays unplayable forever.
    function revealDefault(uint256 tokenId) external {
        Card storage c = _revealable(tokenId);
        IRaptureDropView d = IRaptureDropView(c.drop);
        if (block.timestamp <= d.revealDeadline()) revert TooEarly();
        Traits memory t = d.derive(tokenId, c.index, bytes32(0));
        _write(tokenId, c, d, d.kindOf(c.index), t, t.alignment, 0, 2);
    }

    function _revealable(uint256 tokenId) internal view returns (Card storage c) {
        _requireOwned(tokenId);
        c = _cards[tokenId];
        if (c.revealed) revert AlreadyRevealed();
        if (IRaptureDropView(c.drop).seed() == bytes32(0)) revert NoSeed();
    }

    function _write(uint256 tokenId, Card storage c, IRaptureDropView d, uint8 kind, Traits memory t, uint8 alignment, bytes32 sealedCommit, uint8 path) internal {
        (uint16 lo, uint16 hi) = d.bandOf(kind);
        if (t.strength < lo || t.strength > hi || t.agility < lo || t.agility > hi) revert OutOfBand();
        if (t.resilience < lo || t.resilience > hi || t.intelligence < lo || t.intelligence > hi) revert OutOfBand();
        c.kind = kind;
        c.faction = t.faction;
        c.alignment = alignment;
        c.element = t.element;
        c.frame = t.frame;
        c.bodyparts = t.bodyparts;
        c.sealedCommit = sealedCommit;
        c.revealed = true;
        _stats[tokenId] = CoreStats(t.strength, t.agility, t.resilience, t.intelligence, 1, 0);
        revealedOf[_ownerOf(tokenId)][c.setId] += 1;
        emit Revealed(tokenId, kind, alignment, sealedCommit, path);
        _mirror(tokenId);
    }

    /// Forge the card's twin in litnode's registry: same stats, this contract
    /// as owner (so the card, not the registry entry, is what trades), the
    /// holder's play wallet as controller, the image-free character.json hash.
    function _mirror(uint256 tokenId) internal {
        if (address(registry) == address(0)) return;
        (string memory uri, bytes32 hash) = metadata.agentConfig(tokenId);
        uint256 regId = registryIdOf(tokenId);
        registry.forge(regId, address(this), _stats[tokenId], AgentManifest(uri, _soul[tokenId], _controller[tokenId], hash, 0, 0));
        emit Mirrored(tokenId, regId);
    }

    /// One fact about the sealed traits, and nothing else (spec Section 7).
    function provePredicate(uint256 tokenId, uint8 predicateId, bytes32 arg, bool result, bytes calldata proof) external {
        if (address(predicateVerifier) == address(0)) revert NoPredicates();
        Card storage c = _cards[tokenId];
        if (!c.revealed || c.sealedCommit == bytes32(0)) revert NothingSealed();
        bytes32[] memory pub = new bytes32[](5);
        pub[0] = bytes32(tokenId);
        pub[1] = c.sealedCommit;
        pub[2] = bytes32(uint256(predicateId));
        pub[3] = arg;
        pub[4] = bytes32(uint256(result ? 1 : 0));
        if (!predicateVerifier.verify(proof, pub)) revert BadProof();
        emit PredicateProven(tokenId, predicateId, arg, result);
    }

    // ------------------------------------------------------------------ custody

    /// The linked signer pulls a proxy-held card into their own wallet.
    function claim(uint256 tokenId) external {
        Card storage c = _cards[tokenId];
        address signer = identity.signerOf(c.profileId);
        if (!c.custodial || signer == address(0) || msg.sender != signer) revert NotClaimable();
        _transfer(_ownerOf(tokenId), signer, tokenId);
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        Card storage c = _cards[tokenId];
        address prev = _ownerOf(tokenId);
        if (prev != address(0) && to != address(0)) {
            if (c.custodial) {
                if (to != identity.signerOf(c.profileId)) revert CustodialCard();
                c.custodial = false;
            }
            _clearSlots(tokenId);
        }
        from = super._update(to, tokenId, auth);
        if (c.revealed) {
            if (from != address(0)) revealedOf[from][c.setId] -= 1;
            if (to != address(0)) revealedOf[to][c.setId] += 1;
        }
        if (to != address(0)) {
            address ctl = _defaultController(to);
            _controller[tokenId] = ctl;
            emit ControllerSet(tokenId, ctl);
            if (c.revealed && address(registry) != address(0)) registry.setController(registryIdOf(tokenId), ctl);
        } else {
            delete _controller[tokenId];
        }
    }

    /// A linked signer's cards are played by their proxy by default, so the
    /// node can queue and equip for the player without holding the asset.
    function _defaultController(address owner) internal view returns (address) {
        uint256 p = identity.profileOfSigner(owner);
        return p != 0 ? identity.proxyOf(p) : owner;
    }

    // ------------------------------------------------------------------ ERC-6699

    function coreStats(uint256 tokenId) external view returns (CoreStats memory) {
        return _stats[tokenId];
    }

    function manifestOf(uint256 tokenId) external view returns (AgentManifest memory m) {
        _requireOwned(tokenId);
        (string memory uri, bytes32 hash) = metadata.agentConfig(tokenId);
        m = AgentManifest(uri, _soul[tokenId], _controller[tokenId], hash, 0, _manifestNonce[tokenId]);
    }

    function equipped(uint256 tokenId, bytes32 slot) external view returns (address, uint256) {
        return (_slotCollection[tokenId][slot], _slotAsset[tokenId][slot]);
    }

    /// The card's OWNER must own the item on its collection (litnode v2 rule).
    function equip(uint256 tokenId, bytes32 slot, address collection, uint256 assetId) external {
        address owner = _onlyOwnerOrController(tokenId);
        (bool ok, bytes memory ret) = collection.staticcall(abi.encodeWithSignature("ownerOf(uint256)", assetId));
        if (!ok || ret.length < 32 || abi.decode(ret, (address)) != owner) revert ItemNotOwned();
        if (_slotCollection[tokenId][slot] == address(0)) {
            if (_slots[tokenId].length >= MAX_SLOTS) revert TooManySlots();
            _slots[tokenId].push(slot);
        }
        _slotCollection[tokenId][slot] = collection;
        _slotAsset[tokenId][slot] = assetId;
        emit Equipped(tokenId, slot, collection, assetId);
    }

    function unequip(uint256 tokenId, bytes32 slot) external {
        _onlyOwnerOrController(tokenId);
        delete _slotCollection[tokenId][slot];
        delete _slotAsset[tokenId][slot];
        emit Equipped(tokenId, slot, address(0), 0);
    }

    function _clearSlots(uint256 tokenId) internal {
        bytes32[] storage s = _slots[tokenId];
        for (uint256 i = 0; i < s.length; i++) {
            delete _slotCollection[tokenId][s[i]];
            delete _slotAsset[tokenId][s[i]];
            emit Equipped(tokenId, s[i], address(0), 0);
        }
        delete _slots[tokenId];
    }

    /// keccak256(SOUL.MD), committed by the owner or controller.
    function setSoul(uint256 tokenId, bytes32 soulManifestHash) external {
        _onlyOwnerOrController(tokenId);
        _soul[tokenId] = soulManifestHash;
        _manifestNonce[tokenId] += 1;
        emit ManifestUpdated(tokenId, soulManifestHash);
        if (_cards[tokenId].revealed && address(registry) != address(0)) {
            (string memory uri, bytes32 hash) = metadata.agentConfig(tokenId);
            registry.setManifest(registryIdOf(tokenId), uri, soulManifestHash, hash);
        }
    }

    function setController(uint256 tokenId, address controller) external {
        if (msg.sender != _requireOwned(tokenId)) revert NotOwner();
        _controller[tokenId] = controller;
        emit ControllerSet(tokenId, controller);
        if (_cards[tokenId].revealed && address(registry) != address(0)) registry.setController(registryIdOf(tokenId), controller);
    }

    function _onlyOwnerOrController(uint256 tokenId) internal view returns (address owner) {
        owner = _requireOwned(tokenId);
        if (msg.sender != owner && msg.sender != _controller[tokenId]) revert NotController();
    }

    // ------------------------------------------------------------------ reads

    function cardOf(uint256 tokenId) external view returns (Card memory) {
        return _cards[tokenId];
    }

    function originOf(uint256 tokenId) external view returns (Origin memory) {
        return _origin[tokenId];
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return metadata.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IERC6699).interfaceId || super.supportsInterface(interfaceId);
    }
}

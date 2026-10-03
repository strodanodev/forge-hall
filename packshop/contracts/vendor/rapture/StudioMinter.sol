// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Traits, Origin, Design, ISetRegistry, IRaptureCards} from "./interfaces/Rapture.sol";

interface ICardDesignWriter {
    function write(uint256 tokenId, Design calldata d) external;
}

/// @title StudioMinter — Studio Mode's only way to mint: team minter keys
/// mint finished (revealed) cards to test wallets.
///
/// It is the single drop of the sealed "Studio Test" set, so nothing else can
/// mint into that set. For each card it writes the design record first (the
/// metadata reads it while RaptureCards mirrors the card into the registry),
/// then calls RaptureCards.mintRevealed with explicit Kind, traits and stats.
/// RaptureCards checks the stats against bandOf(kind); this contract checks
/// the rest of the Studio rules (Art Direction tab, 2026-09-28):
///   - enums in range; alignment Good, Corrupted, Feral or Sealed (255);
///   - bodyparts = head(0-3) | facet(0-1) << 8 | circuit(0-2) << 16 | bodyType(0-1) << 24;
///     Mortals have no chrome shell (facet 0); Titans wear their element's
///     titan body (head 0, bodyType 0);
///   - God and Demigod cards name one of the five God kits; others name none.
/// An OpenSea NFT used as a style input rides along as the card's Origin and
/// shows as "Style Source" in the metadata. Nothing is burned or checked for
/// ownership: Studio Mode is a team tool on a separate test deployment.
contract StudioMinter {
    struct StudioCard {
        address to;
        uint8 kind;       // 0 Mortal, 1 King, 2 Demigod, 3 Titan, 4 God
        Traits traits;
        Origin styleSource;
        Design design;
    }

    uint8 internal constant SEALED = 255;

    ISetRegistry public immutable sets;
    IRaptureCards public immutable cards;
    ICardDesignWriter public immutable design;

    address public admin;
    mapping(address => bool) public minters;
    uint32 public nextIndex;
    uint16[5] private _min;
    uint16[5] private _max;

    event MinterSet(address indexed who, bool on);
    event AdminTransferred(address indexed from, address indexed to);
    event StudioMinted(uint256 indexed tokenId, address indexed to, address indexed minter, bytes32 designHash);

    error NotAdmin();
    error NotMinter();
    error ZeroAddress();
    error NotRegistered();
    error BadBand();
    error BadTraits();
    error BadParts();
    error BadKit();
    error EmptyBatch();

    constructor(ISetRegistry sets_, IRaptureCards cards_, ICardDesignWriter design_, address admin_, uint16[5] memory statMin, uint16[5] memory statMax) {
        if (admin_ == address(0)) revert ZeroAddress();
        for (uint256 k = 0; k < 5; k++) {
            if (statMin[k] == 0 || statMin[k] > statMax[k]) revert BadBand();
        }
        sets = sets_;
        cards = cards_;
        design = design_;
        admin = admin_;
        _min = statMin;
        _max = statMax;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyMinter() {
        if (!minters[msg.sender]) revert NotMinter();
        _;
    }

    // ------------------------------------------------------------------ roles

    function setMinter(address who, bool on) external onlyAdmin {
        if (who == address(0)) revert ZeroAddress();
        minters[who] = on;
        emit MinterSet(who, on);
    }

    function transferAdmin(address to) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, to);
        admin = to;
    }

    // ------------------------------------------------------------------ mint

    function mintStudio(StudioCard calldata c) external onlyMinter returns (uint256) {
        return _mintOne(c);
    }

    function mintBatch(StudioCard[] calldata cs) external onlyMinter returns (uint256[] memory ids) {
        if (cs.length == 0) revert EmptyBatch();
        ids = new uint256[](cs.length);
        for (uint256 i = 0; i < cs.length; i++) ids[i] = _mintOne(cs[i]);
    }

    function _mintOne(StudioCard calldata c) internal returns (uint256 tokenId) {
        _check(c);
        uint16 setId = sets.setOfDrop(address(this));
        if (setId == 0) revert NotRegistered();
        uint32 index = nextIndex++;
        tokenId = (uint256(setId) << 32) | index;
        design.write(tokenId, c.design);
        cards.mintRevealed(c.to, 0, index, c.kind, c.traits, bytes32(0), c.styleSource);
        emit StudioMinted(tokenId, c.to, msg.sender, c.design.designHash);
    }

    function _check(StudioCard calldata c) internal pure {
        Traits calldata t = c.traits;
        if (c.to == address(0)) revert ZeroAddress();
        if (c.kind > 4 || t.faction > 1 || t.element > 3 || t.frame > 3) revert BadTraits();
        if (t.alignment > 2 && t.alignment != SEALED) revert BadTraits();

        uint32 p = t.bodyparts;
        uint32 head = p & 0xff;
        uint32 facet = (p >> 8) & 0xff;
        uint32 circuit = (p >> 16) & 0xff;
        uint32 bodyType = (p >> 24) & 0xff;
        if (head > 3 || facet > 1 || circuit > 2 || bodyType > 1) revert BadParts();
        if (c.kind == 0 && facet != 0) revert BadParts();
        if (c.kind == 3 && (head != 0 || bodyType != 0)) revert BadParts();

        bool divine = c.kind == 2 || c.kind == 4;
        if (divine ? (c.design.kit == 0 || c.design.kit > 5) : c.design.kit != 0) revert BadKit();
    }

    // ------------------------------------------------------------------ drop view

    /// Read by RaptureCards when it writes the card: every stat must sit inside
    /// its Kind's band.
    function bandOf(uint8 kind) external view returns (uint16, uint16) {
        return (_min[kind], _max[kind]);
    }
}

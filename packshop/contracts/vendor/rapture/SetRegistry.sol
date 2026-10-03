// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title SetRegistry — one ERC-721 per card set; its holder is the creator.
/// A set registers its layer pack hash and rule-table root, posts a bond,
/// names its drops, and then SEALS itself: after sealSet no further drop can
/// ever mint into the set, which is what makes a set's supply final.
contract SetRegistry is ERC721 {
    uint64 public constant BOND_LOCK = 30 days;

    struct SetInfo {
        string name;
        bytes32 packHash;
        bytes32 ruleTableRoot;
        uint256 bond;
        uint64 sealedAt;
    }

    uint256 public immutable minBond;
    uint16 public nextSetId = 1;
    mapping(uint16 => SetInfo) private _sets;
    mapping(address => uint16) public setOfDrop;
    mapping(uint16 => address[]) private _drops;

    event SetRegistered(uint16 indexed setId, address indexed creator, string name, bytes32 packHash, bytes32 ruleTableRoot);
    event DropAdded(uint16 indexed setId, address drop);
    event SetSealed(uint16 indexed setId);

    error BadName();
    error LowBond();
    error NotCreator();
    error SetIsSealed();
    error NotSealed();
    error BadDrop();
    error Locked();

    constructor(uint256 minBond_) ERC721("Rapture Sets", "RSET") {
        minBond = minBond_;
    }

    function register(string calldata name_, bytes32 packHash, bytes32 ruleTableRoot) external payable returns (uint16 setId) {
        if (msg.value < minBond) revert LowBond();
        _checkName(name_);
        setId = nextSetId++;
        _sets[setId] = SetInfo(name_, packHash, ruleTableRoot, msg.value, 0);
        _mint(msg.sender, setId);
        emit SetRegistered(setId, msg.sender, name_, packHash, ruleTableRoot);
    }

    function addDrop(uint16 setId, address drop) external {
        if (msg.sender != ownerOf(setId)) revert NotCreator();
        if (_sets[setId].sealedAt != 0) revert SetIsSealed();
        if (drop.code.length == 0 || setOfDrop[drop] != 0) revert BadDrop();
        setOfDrop[drop] = setId;
        _drops[setId].push(drop);
        emit DropAdded(setId, drop);
    }

    function sealSet(uint16 setId) external {
        if (msg.sender != ownerOf(setId)) revert NotCreator();
        if (_sets[setId].sealedAt != 0) revert SetIsSealed();
        _sets[setId].sealedAt = uint64(block.timestamp);
        emit SetSealed(setId);
    }

    function withdrawBond(uint16 setId) external {
        if (msg.sender != ownerOf(setId)) revert NotCreator();
        SetInfo storage s = _sets[setId];
        if (s.sealedAt == 0) revert NotSealed();
        if (block.timestamp < s.sealedAt + BOND_LOCK) revert Locked();
        uint256 b = s.bond;
        s.bond = 0;
        (bool ok, ) = msg.sender.call{value: b}("");
        require(ok);
    }

    function nameOf(uint16 setId) external view returns (string memory) {
        return _sets[setId].name;
    }

    function setInfo(uint16 setId) external view returns (SetInfo memory) {
        return _sets[setId];
    }

    function dropsOf(uint16 setId) external view returns (address[] memory) {
        return _drops[setId];
    }

    /// Names go into on-chain JSON unescaped, so the charset is closed.
    function _checkName(string calldata s) internal pure {
        bytes calldata b = bytes(s);
        if (b.length == 0 || b.length > 48) revert BadName();
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            bool ok = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
                || c == 0x20 || c == 0x3a || c == 0x2d || c == 0x2e || c == 0x5f;
            if (!ok) revert BadName();
        }
    }
}

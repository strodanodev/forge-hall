// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Design, ICardDesign} from "./interfaces/Rapture.sol";

/// @title CardDesign — the design record of each Studio Mode card.
///
/// Kept out of RaptureCards (20 KB of its 24 KB) so the cards contract stays
/// unchanged. One writer (StudioMinter), bound once by the deployer; each
/// card's record is written once, before the card is minted, and never
/// changes: a retune is a new card. RaptureMetadata reads it to name the card
/// and point at its art.
contract CardDesign is ICardDesign {
    uint8 public constant KITS = 5;

    address private _deployer;
    address public writer;
    mapping(uint256 => Design) private _designs;

    event WriterBound(address writer);
    event DesignWritten(uint256 indexed tokenId, bytes32 designHash, bytes32 art, bytes32 overridesHash);

    error NotDeployer();
    error NotWriter();
    error AlreadyBound();
    error AlreadyWritten();
    error BadDesign();
    error BadName();

    constructor() {
        _deployer = msg.sender;
    }

    function bindWriter(address writer_) external {
        if (msg.sender != _deployer) revert NotDeployer();
        if (writer != address(0) || writer_ == address(0)) revert AlreadyBound();
        writer = writer_;
        _deployer = address(0);
        emit WriterBound(writer_);
    }

    function write(uint256 tokenId, Design calldata d) external {
        if (msg.sender != writer) revert NotWriter();
        if (_designs[tokenId].designHash != bytes32(0)) revert AlreadyWritten();
        // every Studio card ships a loadable avatar (both encodings): any ERC-6699 game can field it
        if (d.designHash == bytes32(0) || d.art == bytes32(0) || d.avatar == bytes32(0) || d.avatarPlain == bytes32(0) || d.kit > KITS) revert BadDesign();
        _checkText(d.name, 1, 40);
        _checkText(d.epithet, 0, 48);
        _designs[tokenId] = d;
        emit DesignWritten(tokenId, d.designHash, d.art, d.overridesHash);
    }

    function has(uint256 tokenId) external view returns (bool) {
        return _designs[tokenId].designHash != bytes32(0);
    }

    function designOf(uint256 tokenId) external view returns (Design memory) {
        return _designs[tokenId];
    }

    /// Names go into on-chain JSON unescaped, so the charset is closed:
    /// letters, digits, space and  ' , - . : _
    function _checkText(string calldata s, uint256 minLen, uint256 maxLen) internal pure {
        bytes calldata b = bytes(s);
        if (b.length < minLen || b.length > maxLen) revert BadName();
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            bool ok = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
                || c == 0x20 || c == 0x27 || c == 0x2c || c == 0x2d || c == 0x2e || c == 0x3a || c == 0x5f;
            if (!ok) revert BadName();
        }
    }
}

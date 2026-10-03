// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IERC6699} from "./interfaces/IERC6699.sol";
import {Card, Origin, Design, ISetRegistry, IRaptureCards, ICardDesign} from "./interfaces/Rapture.sol";

/// @title RaptureMetadata — each card's character.json, built on chain from
/// its on-chain traits. No metadata server, no pinning service.
///   tokenURI            data: URI of the full JSON, image included (wallets, marketplaces)
///   agentConfig().uri   CAIP-19 pointer to the card, eip155:<chain>/erc721:<cards>/<id>
///   agentConfig().hash  keccak256 of the IMAGE-FREE JSON: fixed at reveal, so the
///                       hash litnode's registry holds never drifts when the image
///                       base moves from a gateway to the final IPFS directory.
///
/// The one mutable pointer is the IMAGE base (rendered art lives on IPFS,
/// pinned by litnodes). The admin may set it until freezeImages(); after
/// that nothing here can change. Art is deterministic from traits + the
/// layer pack hash pinned in the drop, so anyone can re-render and compare.
///
/// Studio Mode cards also have a CardDesign record: its name and epithet name
/// the card, and its art is addressed by content hash under the image base
/// (<imageBase><sha256 hex>.webp; the PNG master is in the design document), as is the full design document
/// (<imageBase><designHash hex>.json) that carries the per-game overrides.
///
/// Trait vocabulary follows the ARC 1 Art Direction (2026-09-28): Kind is the
/// only tier; Path says which way it points (Rising, Ascended, Fallen); Frame
/// is an unranked style; bodyparts are head, facet, circuit and body type.
contract RaptureMetadata {
    using Strings for uint256;

    ISetRegistry public immutable sets;
    IRaptureCards public cards;
    ICardDesign public design;
    address public admin;
    string public imageBase;    // e.g. ipfs://<rendersCID>/  → <imageBase><tokenId>.png
    string public sealedImage;  // card back shown before reveal
    bool public frozen;

    error NotAdmin();
    error Frozen();
    error AlreadyBound();

    constructor(ISetRegistry sets_, address admin_, string memory imageBase_, string memory sealedImage_) {
        sets = sets_;
        admin = admin_;
        imageBase = imageBase_;
        sealedImage = sealedImage_;
    }

    function bindCards(IRaptureCards cards_) external {
        if (msg.sender != admin) revert NotAdmin();
        if (address(cards) != address(0)) revert AlreadyBound();
        cards = cards_;
    }

    /// Studio Mode deployments only; the public drop never binds one.
    function bindDesign(ICardDesign design_) external {
        if (msg.sender != admin) revert NotAdmin();
        if (address(design) != address(0)) revert AlreadyBound();
        design = design_;
    }

    function setImageBase(string calldata base) external {
        if (msg.sender != admin) revert NotAdmin();
        if (frozen) revert Frozen();
        imageBase = base;
    }

    function freezeImages() external {
        if (msg.sender != admin) revert NotAdmin();
        frozen = true;
    }

    // ------------------------------------------------------------------ reads

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        return string.concat("data:application/json;base64,", Base64.encode(bytes(characterJson(tokenId, true))));
    }

    function agentConfig(uint256 tokenId) external view returns (string memory uri, bytes32 hash) {
        uri = string.concat("eip155:", block.chainid.toString(), "/erc721:", Strings.toHexString(address(cards)), "/", tokenId.toString());
        hash = keccak256(bytes(characterJson(tokenId, false)));
    }

    /// The image-free form is the full form minus its location fields (`"image":…,`
    /// and, for Studio cards, `"animation_url":…,` and `"external_url":…,`), so a
    /// reader can recompute characterConfigHash from tokenURI alone, and the hash
    /// survives any move of the image base.
    function characterJson(uint256 tokenId, bool withImage) public view returns (string memory) {
        Card memory c = cards.cardOf(tokenId);
        if (!c.revealed) {
            string memory sealedName = string.concat(sets.nameOf(c.setId), " #", uint256(c.index).toString());
            return string.concat(
                '{"name":"', sealedName, '","description":"A sealed Rapture card. Revealed after the drop closes.","image":"', sealedImage,
                '","attributes":[{"trait_type":"Status","value":"Sealed"}],"rapture":{"schema":"rapture/1","setId":',
                uint256(c.setId).toString(), ',"tokenId":"', tokenId.toString(), '","revealed":false}}'
            );
        }
        Design memory d;
        bool studio = address(design) != address(0) && design.has(tokenId);
        if (studio) d = design.designOf(tokenId);
        IERC6699.CoreStats memory s = IERC6699(address(cards)).coreStats(tokenId);
        string memory bio = _bio(c, d, studio);
        return string.concat(
            '{"name":"', _name(c, d, studio), '","bio":"', bio, '","description":"', bio, '",',
            withImage ? _image(tokenId, d, studio) : "",
            _style(s), ',"boundaries":{"equipmentSlots":["head","body","mainhand","offhand","trinket"]},',
            studio ? _avatarJson(d) : "",
            _attributes(c, s, cards.originOf(tokenId), d, studio), ',', _rapture(c, tokenId, d, studio), '}'
        );
    }

    function soulOf(uint256 tokenId) external view returns (bytes32) {
        if (address(design) == address(0) || !design.has(tokenId)) return bytes32(0);
        return design.designOf(tokenId).soul;
    }

    /// The character, loadable by any ERC-6699 game without Rapture conventions (hashes and
    /// file names only; the location is animation_url, outside the hashed form). One GLB:
    /// this card's variant, every part on one skeleton, colours baked, clips named by role.
    /// The file describes itself in its root extras (`erc6699Avatar`: rig, VRM humanoid bone
    /// map, clip roles, axes, height). `plain` is the same avatar in core glTF for a loader
    /// without a meshopt decoder; files named by hash sit beside each other. SOUL.MD likewise.
    function _avatarJson(Design memory d) internal pure returns (string memory) {
        string memory a = string.concat(
            '"avatar":{"schema":"erc6699-avatar/1","format":"model/gltf-binary","file":"', _hex(d.avatar),
            '.glb","sha256":"', uint256(d.avatar).toHexString(32),
            '","requires":["EXT_meshopt_compression","KHR_mesh_quantization"],"plain":{"file":"', _hex(d.avatarPlain),
            '.glb","sha256":"', uint256(d.avatarPlain).toHexString(32), '"}},'
        );
        if (d.soul == bytes32(0)) return a;
        return string.concat(a, '"soul":{"format":"text/markdown","file":"', _hex(d.soul), '.md","keccak256":"', uint256(d.soul).toHexString(32), '"},');
    }

    // ------------------------------------------------------------------ pieces

    function _name(Card memory c, Design memory d, bool studio) internal view returns (string memory) {
        if (studio) return d.name;
        return string.concat(sets.nameOf(c.setId), " #", uint256(c.index).toString());
    }

    function _bio(Card memory c, Design memory d, bool studio) internal pure returns (string memory) {
        string memory base = string.concat("A ", _kind(c.kind), " of the ", _faction(c.faction), ", ", _element(c.element), "-bound. The Rapture has begun.");
        if (studio && bytes(d.epithet).length != 0) return string.concat(d.epithet, ". ", base);
        return base;
    }

    /// Every LOCATION lives here, in the part left out of the hashed (image-free) form:
    /// the art, the avatar GLB (animation_url: marketplaces show it in 3D, games load it)
    /// and the design document (external_url). Moving the image base (gateway -> IPFS)
    /// must never change the hash the registry twin holds. The turntable stays in the
    /// design document.
    function _image(uint256 tokenId, Design memory d, bool studio) internal view returns (string memory) {
        if (!studio) return string.concat('"image":"', imageBase, tokenId.toString(), '.png",');
        return string.concat(
            '"image":"', imageBase, _hex(d.art), '.webp","animation_url":"', imageBase, _hex(d.avatar),
            '.glb","external_url":"', imageBase, _hex(d.designHash), '.json",'
        );
    }

    function _style(IERC6699.CoreStats memory s) internal pure returns (string memory) {
        uint256 total = uint256(s.strength) + s.agility + s.resilience + s.intelligence;
        if (total == 0) total = 1;
        return string.concat(
            '"style":{"combatWeights":{"aggression":', _milli(uint256(s.strength) * 1000 / total),
            ',"tempo":', _milli(uint256(s.agility) * 1000 / total),
            ',"defense":', _milli(uint256(s.resilience) * 1000 / total),
            ',"economy":', _milli(uint256(s.intelligence) * 1000 / total),
            '},"frameReactions":{"retreatBelowHealth":0.25,"engageAbove":0.6},"skillPriorities":["smite","rally","summon"]}'
        );
    }

    function _attributes(Card memory c, IERC6699.CoreStats memory s, Origin memory o, Design memory d, bool studio) internal view returns (string memory) {
        string memory head = string.concat(
            '"attributes":[{"trait_type":"Kind","value":"', _kind(c.kind),
            '"},{"trait_type":"Path","value":"', _path(c.kind),
            '"},{"trait_type":"Faction","value":"', _faction(c.faction),
            '"},{"trait_type":"Alignment","value":"', _alignment(c.alignment),
            '"},{"trait_type":"Element","value":"', _element(c.element),
            '"},{"trait_type":"Frame","value":"', _frame(c.frame)
        );
        string memory studioTraits = "";
        if (studio) {
            if (bytes(d.epithet).length != 0) studioTraits = string.concat('"},{"trait_type":"Epithet","value":"', d.epithet);
            if (d.kit != 0) studioTraits = string.concat(studioTraits, '"},{"trait_type":"Kit","value":"', _kitName(d.kit));
        }
        return string.concat(
            head, studioTraits,
            '"},{"trait_type":"Set","value":"', sets.nameOf(c.setId),
            '"},{"trait_type":"Strength","value":', uint256(s.strength).toString(),
            ',"display_type":"number"},{"trait_type":"Agility","value":', uint256(s.agility).toString(),
            ',"display_type":"number"},{"trait_type":"Resilience","value":', uint256(s.resilience).toString(),
            ',"display_type":"number"},{"trait_type":"Intelligence","value":', uint256(s.intelligence).toString(),
            ',"display_type":"number"}', _origin(o, studio), ']'
        );
    }

    /// The NFT a card came from (CAIP-19 of the source token): consumed by a
    /// forge ("Burn Origin"), or only used as a Studio style input ("Style Source").
    function _origin(Origin memory o, bool studio) internal pure returns (string memory) {
        if (o.collection == address(0)) return "";
        return string.concat(
            ',{"trait_type":"', studio ? "Style Source" : "Burn Origin", '","value":"eip155:', uint256(o.chainId).toString(),
            '/erc721:', Strings.toHexString(o.collection), '/', o.tokenId.toString(), '"}'
        );
    }

    function _rapture(Card memory c, uint256 tokenId, Design memory d, bool studio) internal view returns (string memory) {
        string memory head = string.concat(
            '"rapture":{"schema":"rapture/1","setId":', uint256(c.setId).toString(),
            ',"tokenId":"', tokenId.toString(),
            '","revealed":true,"kind":"', _kind(c.kind),
            '","path":"', _path(c.kind),
            '","faction":"', _faction(c.faction),
            '","alignment":"', _alignment(c.alignment)
        );
        string memory body = string.concat(
            '","sealedCommit":"', uint256(c.sealedCommit).toHexString(32),
            '","element":"', _element(c.element),
            '","frame":"', _frame(c.frame),
            '","bodyparts":{"head":', uint256(c.bodyparts & 0xff).toString(),
            ',"facet":', uint256((c.bodyparts >> 8) & 0xff).toString(),
            ',"circuit":', uint256((c.bodyparts >> 16) & 0xff).toString(),
            ',"bodyType":"', ((c.bodyparts >> 24) & 0xff) == 0 ? "male" : "female", '"}'
        );
        return string.concat(head, body, studio ? _designJson(d) : ',"overrides":{}', '}');
    }

    /// What a Studio card's full design document must hash to, and its file name beside the
    /// art (hashes only: the location is external_url, outside the hashed form). Games read
    /// their block of "overrides" from that document.
    function _designJson(Design memory d) internal pure returns (string memory) {
        string memory file = string.concat(_hex(d.designHash), ".json");
        return string.concat(
            ',"design":{"schema":"rapture-studio/2","hash":"', uint256(d.designHash).toHexString(32),
            '","file":"', file,
            '","art":"', uint256(d.art).toHexString(32),
            '","kit":"', _kitId(d.kit),
            '"},"overrides":{"file":"', file, '","pointer":"/overrides","hash":"', uint256(d.overridesHash).toHexString(32), '"}'
        );
    }

    function _hex(bytes32 v) internal pure returns (string memory) {
        bytes memory out = new bytes(64);
        bytes16 digits = "0123456789abcdef";
        for (uint256 i = 0; i < 32; i++) {
            uint8 b = uint8(v[i]);
            out[2 * i] = digits[b >> 4];
            out[2 * i + 1] = digits[b & 0x0f];
        }
        return string(out);
    }

    function _milli(uint256 m) internal pure returns (string memory) {
        if (m >= 1000) return "1.000";
        string memory frac = m.toString();
        if (m < 10) frac = string.concat("00", frac);
        else if (m < 100) frac = string.concat("0", frac);
        return string.concat("0.", frac);
    }

    function _kind(uint8 k) internal pure returns (string memory) {
        if (k == 0) return "Mortal";
        if (k == 1) return "King";
        if (k == 2) return "Demigod";
        if (k == 3) return "Titan";
        return "God";
    }

    /// Gods and Titans are equal and opposite apexes: Gods ascended, Titans fell.
    function _path(uint8 k) internal pure returns (string memory) {
        if (k == 4) return "Ascended";
        if (k == 3) return "Fallen";
        return "Rising";
    }

    function _faction(uint8 f) internal pure returns (string memory) {
        return f == 0 ? "Alliance" : "Horde";
    }

    function _alignment(uint8 a) internal pure returns (string memory) {
        if (a == 0) return "Good";
        if (a == 1) return "Corrupted";
        if (a == 2) return "Feral";
        return "Sealed";
    }

    function _element(uint8 e) internal pure returns (string memory) {
        if (e == 0) return "Earth";
        if (e == 1) return "Lava";
        if (e == 2) return "Metal";
        return "Water";
    }

    /// An unranked card-frame style, equal odds (gold is reserved for divine light).
    function _frame(uint8 f) internal pure returns (string memory) {
        if (f == 0) return "Glass";
        if (f == 1) return "Obsidian";
        if (f == 2) return "Pearl";
        return "Smoke";
    }

    function _kitId(uint8 k) internal pure returns (string memory) {
        if (k == 1) return "hermes";
        if (k == 2) return "ares";
        if (k == 3) return "hecate";
        if (k == 4) return "riki";
        if (k == 5) return "heph";
        return "";
    }

    function _kitName(uint8 k) internal pure returns (string memory) {
        if (k == 1) return "Hermes";
        if (k == 2) return "Ares";
        if (k == 3) return "Hecate";
        if (k == 4) return "Riki";
        return "Hephaestus";
    }
}

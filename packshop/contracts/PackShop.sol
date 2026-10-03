// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Traits, Origin, Design} from "./vendor/rapture/interfaces/Rapture.sol";

/// Same ABI as StudioMinter.StudioCard (only the tuple layout matters to the selector).
struct StudioCard {
    address to;
    uint8 kind;       // 0 Mortal, 1 King, 2 Demigod, 3 Titan, 4 God
    Traits traits;
    Origin styleSource;
    Design design;
}

interface IStudioMinter {
    function mintBatch(StudioCard[] calldata cs) external returns (uint256[] memory ids);
    /// Whether `who` holds the MINTER role: PackShop must, or a paid pack could never be opened.
    function minters(address who) external view returns (bool);
    /// The stat band RaptureCards enforces for a Kind; a template outside it would revert at every open.
    function bandOf(uint8 kind) external view returns (uint16 min, uint16 max);
}

/// @title PackShop — sell sealed Rapture card packs for native zkLTC and mint the cards to the buyer.
///
/// PackShop is a separate contract from the card collection. It holds one role: MINTER on the
/// Studio Test set's StudioMinter (the owner of that contract grants it with setMinter). It holds a pool of card
/// TEMPLATES (a card's traits, stats and design record, copied from a finished card) and, on every pack,
/// mints fresh tokens from those templates straight to the buyer. Templates are editions: a hundred wallets can
/// hold a copy of the same design, each its own token with its own id.
///
/// Flow (two transactions, so a buyer can never simulate and revert a bad pull):
///   1. buyPack()      pay the exact price; a sealed pack is recorded with the current block number
///   2. openPack(id)   once block.number >= commit + 2, the pack's cards are drawn from blockhash(commit + 1)
///                     and minted to the buyer. Anyone may send this transaction; the cards always go to the buyer.
/// A pack nobody opens inside the blockhash window (255 block numbers, ~50 min on Liteforge) is refunded
/// with refundExpired(id).
///
/// TESTNET-GRADE RANDOMNESS. Liteforge is an Arbitrum Nitro chain: block.number follows the parent chain
/// (one number every ~12 s), block.prevrandao is the constant 1, and Arbitrum documents blockhash as
/// "cryptographically insecure". A commit-reveal on it stops the buyer from grinding, but the sequencer can still
/// see or influence the seed. Before real value rides on a pull, replace _seed() with a VRF or drand beacon.
contract PackShop is Ownable2Step, Pausable, ReentrancyGuard {
    /// A card the shop can mint: StudioCard minus the recipient.
    struct Template {
        uint8 kind;
        Traits traits;
        Origin styleSource;
        Design design;
    }

    enum PackState { None, Sealed, Opened, Refunded }
    /// What a client shows: Waiting = sealed but blockhash not ready yet; Openable = ready.
    enum Phase { None, Waiting, Openable, Expired, Opened, Refunded }

    struct Pack {
        address buyer;
        uint64 commitBlock;
        PackState state;
        uint256 paid;
    }

    struct Daily {
        uint32 day;
        uint16 count;
    }

    /// The blockhash window, less one number so a pack is never opened on the edge of it.
    uint256 public constant REVEAL_WINDOW = 255;
    uint256 public constant KINDS = 5;
    uint256 public constant MAX_PACK_SIZE = 8;
    uint256 public constant MAX_TEMPLATES = 4096;

    IStudioMinter public immutable minter;
    /// Cards per pack, fixed for this deployment (a different size is a new PackShop).
    uint8 public immutable packSize;

    /// Exact price of one pack, in wei of the native token (zkLTC).
    uint256 public price;
    /// Packs one wallet may buy per UTC day; 0 = no limit.
    uint16 public dailyLimit;
    /// Odds per slot of a pack, Mortal, King, Demigod, Titan, God. Only the ratio matters.
    uint16[5] public weights;

    uint256 public nextPackId = 1;
    /// Wei paid for packs that are still sealed. The owner can only withdraw the balance above it.
    uint256 public liability;

    mapping(uint256 => Pack) private _packs;
    mapping(address => Daily) private _daily;
    /// Each buyer's pack ids, oldest first: a client can resume a bought-but-unopened pack, or find an expired one to
    /// refund, with one eth_call (recentPacks) instead of scanning logs, which the public RPC serves slowly.
    mapping(address => uint256[]) private _packsOf;
    Template[] internal _templates;
    /// Active template ids by Kind.
    uint16[][5] internal _byKind;
    mapping(bytes32 => bool) public hasDesign;
    mapping(uint256 => bool) public retired;

    event PackBought(uint256 indexed packId, address indexed buyer, uint256 paid, uint256 commitBlock);
    event PackOpened(uint256 indexed packId, address indexed buyer, uint256[] tokenIds, uint16[] templateIds);
    event PackRefunded(uint256 indexed packId, address indexed buyer, uint256 amount);
    event TemplateAdded(uint256 indexed templateId, uint8 indexed kind, bytes32 designHash);
    event TemplateRetired(uint256 indexed templateId);
    event PriceSet(uint256 price);
    event DailyLimitSet(uint16 limit);
    event WeightsSet(uint16[5] weights);
    event Withdrawn(address indexed to, uint256 amount);

    error ZeroAddress();
    error BadPackSize();
    error BadWeights();
    error NotStocked();
    error NotMinter();
    error BadMinter();
    error WrongPayment();
    error DailyLimitReached();
    error NotSealed();
    error TooEarly();
    error Expired();
    error NotExpired();
    error BadTemplate();
    error DuplicateDesign();
    error UnknownTemplate();
    error LastOfKind();
    error TooManyTemplates();
    error Insufficient();
    error TransferFailed();
    error RenounceDisabled();

    /// Deploys PAUSED: load the templates, then unpause.
    constructor(IStudioMinter minter_, address owner_, uint256 price_, uint8 packSize_, uint16[5] memory weights_, uint16 dailyLimit_)
        Ownable(owner_)
    {
        if (address(minter_) == address(0)) revert ZeroAddress();
        if (address(minter_).code.length == 0) revert BadMinter();   // a typo'd address would sell packs that can never open
        if (packSize_ == 0 || packSize_ > MAX_PACK_SIZE) revert BadPackSize();
        minter = minter_;
        packSize = packSize_;
        price = price_;
        dailyLimit = dailyLimit_;
        _setWeights(weights_, false);
        _pause();
    }

    // ------------------------------------------------------------------ buy / open / refund

    function buyPack() external payable whenNotPaused nonReentrant returns (uint256 packId) {
        if (!_stocked()) revert NotStocked();
        if (!minter.minters(address(this))) revert NotMinter();   // never take money for a pack that cannot open
        if (msg.value != price) revert WrongPayment();
        _spendDaily(msg.sender);
        packId = nextPackId++;
        _packs[packId] = Pack(msg.sender, uint64(block.number), PackState.Sealed, msg.value);
        _packsOf[msg.sender].push(packId);
        liability += msg.value;
        emit PackBought(packId, msg.sender, msg.value, block.number);
    }

    /// Draw and mint a sealed pack. Anyone may call; the buyer always receives the cards.
    function openPack(uint256 packId) external nonReentrant returns (uint256[] memory tokenIds) {
        Pack storage p = _packs[packId];
        if (p.state != PackState.Sealed) revert NotSealed();
        uint256 reveal = uint256(p.commitBlock) + 1;
        if (block.number <= reveal) revert TooEarly();
        if (block.number - reveal > REVEAL_WINDOW) revert Expired();
        bytes32 h = blockhash(reveal);
        if (h == bytes32(0)) revert Expired();

        address buyer = p.buyer;
        p.state = PackState.Opened;
        liability -= p.paid;

        uint16[] memory ids = _draw(_seed(h, packId, buyer));
        StudioCard[] memory cs = new StudioCard[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            Template storage t = _templates[ids[i]];
            cs[i] = StudioCard(buyer, t.kind, t.traits, t.styleSource, t.design);
        }
        tokenIds = minter.mintBatch(cs);
        emit PackOpened(packId, buyer, tokenIds, ids);
    }

    /// Give the price back for a pack that was not opened inside the blockhash window. Anyone may call;
    /// the refund goes to the buyer. The pack still counts against the buyer's daily limit.
    function refundExpired(uint256 packId) external nonReentrant {
        Pack storage p = _packs[packId];
        if (p.state != PackState.Sealed) revert NotSealed();
        uint256 reveal = uint256(p.commitBlock) + 1;
        if (block.number <= reveal || block.number - reveal <= REVEAL_WINDOW) revert NotExpired();
        address buyer = p.buyer;
        uint256 amount = p.paid;
        p.state = PackState.Refunded;
        liability -= amount;
        emit PackRefunded(packId, buyer, amount);
        _send(buyer, amount);
    }

    // ------------------------------------------------------------------ draw

    /// The seed is public once the reveal block exists: a buyer can compute the pull before opening, but cannot
    /// change it (the only way to skip a pull is to let the pack expire and take the refund).
    function _seed(bytes32 h, uint256 packId, address buyer) internal view returns (uint256) {
        return uint256(keccak256(abi.encode(h, packId, buyer, address(this))));
    }

    function _draw(uint256 seed) internal view returns (uint16[] memory ids) {
        uint16[5] memory w = weights;
        uint256 total = uint256(w[0]) + w[1] + w[2] + w[3] + w[4];
        ids = new uint16[](packSize);
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 roll = r % total;
            uint256 kind = 0;
            while (roll >= w[kind]) {
                roll -= w[kind];
                kind++;
            }
            uint16[] storage pool = _byKind[kind];
            ids[i] = pool[(r >> 128) % pool.length];
        }
    }

    // ------------------------------------------------------------------ views

    function phaseOf(uint256 packId) public view returns (Phase) {
        Pack storage p = _packs[packId];
        if (p.state == PackState.None) return Phase.None;
        if (p.state == PackState.Opened) return Phase.Opened;
        if (p.state == PackState.Refunded) return Phase.Refunded;
        uint256 reveal = uint256(p.commitBlock) + 1;
        if (block.number <= reveal) return Phase.Waiting;
        return block.number - reveal > REVEAL_WINDOW ? Phase.Expired : Phase.Openable;
    }

    function packOf(uint256 packId) external view returns (address buyer, uint256 commitBlock, Phase phase, uint256 paid) {
        Pack storage p = _packs[packId];
        return (p.buyer, p.commitBlock, phaseOf(packId), p.paid);
    }

    /// How many packs `who` has ever bought.
    function packCountOf(address who) external view returns (uint256) {
        return _packsOf[who].length;
    }

    /// `who`'s most recent `n` packs (at most 16), oldest first: id, phase and commit block of each. One call is all a
    /// page needs to resume a sealed pack (Waiting / Openable) or offer a refund (Expired).
    function recentPacks(address who, uint256 n)
        external
        view
        returns (uint256[] memory ids, Phase[] memory phases, uint256[] memory commitBlocks)
    {
        uint256[] storage all = _packsOf[who];
        uint256 len = all.length;
        if (n > 16) n = 16;
        if (n > len) n = len;
        ids = new uint256[](n);
        phases = new Phase[](n);
        commitBlocks = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 id = all[len - n + i];
            ids[i] = id;
            phases[i] = phaseOf(id);
            commitBlocks[i] = _packs[id].commitBlock;
        }
    }

    /// Can the shop sell? Every Kind that has odds needs an active template (or a paid pack could not be drawn), and
    /// PackShop must hold the MINTER role on StudioMinter (or it could not be opened).
    function ready() public view returns (bool) {
        return _stocked() && minter.minters(address(this));
    }

    function _stocked() internal view returns (bool) {
        uint256 total;
        for (uint256 k = 0; k < KINDS; k++) {
            if (weights[k] == 0) continue;
            if (_byKind[k].length == 0) return false;
            total += weights[k];
        }
        return total > 0;
    }

    function packsLeftToday(address who) external view returns (uint256) {
        if (dailyLimit == 0) return type(uint256).max;
        Daily storage d = _daily[who];
        if (d.day != uint32(block.timestamp / 1 days)) return dailyLimit;
        return d.count >= dailyLimit ? 0 : dailyLimit - d.count;
    }

    /// One call for a client: everything it needs to draw the buy button.
    function config()
        external
        view
        returns (uint256 price_, uint8 packSize_, uint16 dailyLimit_, bool paused_, bool ready_, uint16[5] memory weights_, uint256 templateCount_)
    {
        return (price, packSize, dailyLimit, paused(), ready(), weights, _templates.length);
    }

    function templateCount() external view returns (uint256) {
        return _templates.length;
    }

    function templateOf(uint256 templateId) external view returns (Template memory) {
        if (templateId >= _templates.length) revert UnknownTemplate();
        return _templates[templateId];
    }

    function activeTemplates(uint8 kind) external view returns (uint16[] memory) {
        return _byKind[kind];
    }

    // ------------------------------------------------------------------ owner: pool

    /// Load cards the shop may mint. Each is checked against the same rules StudioMinter and CardDesign apply at
    /// mint time, so a paid pack cannot draw a template that would revert.
    function addTemplates(Template[] calldata ts) external onlyOwner {
        if (_templates.length + ts.length > MAX_TEMPLATES) revert TooManyTemplates();
        for (uint256 i = 0; i < ts.length; i++) {
            Template calldata t = ts[i];
            _validate(t);
            if (hasDesign[t.design.designHash]) revert DuplicateDesign();
            hasDesign[t.design.designHash] = true;
            uint256 id = _templates.length;
            _templates.push(t);
            _byKind[t.kind].push(uint16(id));
            emit TemplateAdded(id, t.kind, t.design.designHash);
        }
    }

    /// Stop minting a template. Cards already minted from it are untouched. The last template of a Kind that has
    /// odds cannot be retired (add its replacement first, or set that Kind's odds to 0).
    function retireTemplate(uint256 templateId) external onlyOwner {
        if (templateId >= _templates.length || retired[templateId]) revert UnknownTemplate();
        uint16[] storage pool = _byKind[_templates[templateId].kind];
        // a sealed pack must always be drawable: never empty a Kind that has odds
        if (pool.length == 1 && weights[_templates[templateId].kind] > 0) revert LastOfKind();
        retired[templateId] = true;
        hasDesign[_templates[templateId].design.designHash] = false;   // a corrected version of this design may be added
        for (uint256 i = 0; i < pool.length; i++) {
            if (pool[i] == templateId) {
                pool[i] = pool[pool.length - 1];
                pool.pop();
                break;
            }
        }
        emit TemplateRetired(templateId);
    }

    // ------------------------------------------------------------------ owner: settings and money

    function setPrice(uint256 price_) external onlyOwner {
        price = price_;
        emit PriceSet(price_);
    }

    function setDailyLimit(uint16 limit) external onlyOwner {
        dailyLimit = limit;
        emit DailyLimitSet(limit);
    }

    function setWeights(uint16[5] calldata weights_) external onlyOwner {
        _setWeights(weights_, true);
    }

    /// Revenue is only reachable through the owner: renouncing would strand it.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// Revenue only: the balance above what sealed packs could still be refunded.
    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount > address(this).balance - liability) revert Insufficient();
        emit Withdrawn(to, amount);
        _send(to, amount);
    }

    // ------------------------------------------------------------------ internals

    /// `covered`: every Kind given odds must already have an active template, so sealed packs stay drawable.
    /// The constructor skips it (the pool is empty then; ready() gates selling until it is stocked).
    function _setWeights(uint16[5] memory w, bool covered) internal {
        if (uint256(w[0]) + w[1] + w[2] + w[3] + w[4] == 0) revert BadWeights();
        if (covered) {
            for (uint256 k = 0; k < KINDS; k++) {
                if (w[k] != 0 && _byKind[k].length == 0) revert NotStocked();
            }
        }
        weights = w;
        emit WeightsSet(w);
    }

    function _spendDaily(address who) internal {
        uint16 limit = dailyLimit;
        if (limit == 0) return;
        Daily storage d = _daily[who];
        uint32 day = uint32(block.timestamp / 1 days);
        if (d.day != day) {
            d.day = day;
            d.count = 0;
        }
        if (d.count >= limit) revert DailyLimitReached();
        d.count += 1;
    }

    function _send(address to, uint256 amount) internal {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// The StudioMinter._check, CardDesign.write and stat-band rules, so a bad template fails here, not inside a
    /// buyer's pack. (The loading script also simulates every template against the live StudioMinter.)
    function _validate(Template calldata t) internal view {
        Traits calldata tr = t.traits;
        Design calldata d = t.design;
        if (t.kind > 4 || tr.faction > 1 || tr.element > 3 || tr.frame > 3) revert BadTemplate();
        if (tr.alignment > 2 && tr.alignment != 255) revert BadTemplate();
        // RaptureCards checks the stats against the Kind's band at mint: outside it, every pack drawing this template reverts
        (uint16 lo, uint16 hi) = minter.bandOf(t.kind);
        if (tr.strength < lo || tr.strength > hi || tr.agility < lo || tr.agility > hi) revert BadTemplate();
        if (tr.resilience < lo || tr.resilience > hi || tr.intelligence < lo || tr.intelligence > hi) revert BadTemplate();

        uint32 p = tr.bodyparts;
        uint32 head = p & 0xff;
        uint32 facet = (p >> 8) & 0xff;
        uint32 circuit = (p >> 16) & 0xff;
        uint32 bodyType = (p >> 24) & 0xff;
        if (head > 3 || facet > 1 || circuit > 2 || bodyType > 1) revert BadTemplate();
        if (t.kind == 0 && facet != 0) revert BadTemplate();
        if (t.kind == 3 && (head != 0 || bodyType != 0)) revert BadTemplate();

        bool divine = t.kind == 2 || t.kind == 4;
        if (divine ? (d.kit == 0 || d.kit > 5) : d.kit != 0) revert BadTemplate();

        if (d.designHash == bytes32(0) || d.art == bytes32(0) || d.avatar == bytes32(0) || d.avatarPlain == bytes32(0)) {
            revert BadTemplate();
        }
        if (!_text(d.name, 1, 40) || !_text(d.epithet, 0, 48)) revert BadTemplate();
    }

    /// CardDesign's closed charset: letters, digits, space and  ' , - . : _
    function _text(string calldata s, uint256 minLen, uint256 maxLen) internal pure returns (bool) {
        bytes calldata b = bytes(s);
        if (b.length < minLen || b.length > maxLen) return false;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            bool ok = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
                || c == 0x20 || c == 0x27 || c == 0x2c || c == 0x2d || c == 0x2e || c == 0x3a || c == 0x5f;
            if (!ok) return false;
        }
        return true;
    }
}

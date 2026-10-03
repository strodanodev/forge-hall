// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {PackShop} from "../../PackShop.sol";

/// Test-only actors for test/review/adversarial.test.js (the PackShop adversarial review). Never deployed anywhere.

interface ITransferFrom {
    function transferFrom(address from, address to, uint256 tokenId) external;
}

/// A buyer contract whose receive() is scripted: accept, revert, burn every unit of gas, or re-enter PackShop once.
contract Adversary {
    PackShop public immutable shop;
    uint256 public lastPackId;
    uint8 public mode;            // 0 accept, 1 revert, 2 burn all gas, 3 re-enter once with `reenterData`
    bytes public reenterData;
    uint256 public reenterValue;
    uint256 public reenterCount;
    bool public reenterOk;
    bytes4 public reenterError;

    constructor(PackShop shop_) {
        shop = shop_;
    }

    function buy() external payable returns (uint256) {
        lastPackId = shop.buyPack{value: msg.value}();
        return lastPackId;
    }

    function setMode(uint8 mode_, bytes calldata data, uint256 value) external {
        mode = mode_;
        reenterData = data;
        reenterValue = value;
    }

    function open(uint256 id) external returns (uint256[] memory) {
        return shop.openPack(id);
    }

    function refund(uint256 id) external {
        shop.refundExpired(id);
    }

    receive() external payable {
        uint8 m = mode;
        if (m == 0) return;
        if (m == 1) revert("no thanks");
        if (m == 2) {
            assembly {
                for {} 1 {} {}
            }
        }
        mode = 0; // re-enter exactly once
        reenterCount += 1;
        (bool ok, bytes memory ret) = address(shop).call{value: reenterValue}(reenterData);
        reenterOk = ok;
        if (!ok && ret.length >= 4) reenterError = bytes4(ret);
    }
}

/// A contract that can buy but can never be paid: no receive(), no fallback().
contract NoReceiveBuyer {
    function buy(PackShop shop) external payable returns (uint256) {
        return shop.buyPack{value: msg.value}();
    }
}

/// One Sybil wallet: buys a pack in its constructor, forwards every refund to its master, hands cards over on request.
contract SybilChild {
    address public immutable master;
    uint256 public packId;

    constructor(PackShop shop) payable {
        master = msg.sender;
        packId = shop.buyPack{value: msg.value}();
    }

    receive() external payable {
        (bool ok, ) = master.call{value: msg.value}("");
        require(ok, "forward");
    }

    function sweep(ITransferFrom cards, uint256[] calldata ids, address to) external {
        require(msg.sender == master, "master only");
        for (uint256 i = 0; i < ids.length; i++) cards.transferFrom(address(this), to, ids[i]);
    }
}

/// Creates any number of distinct buyers in ONE transaction: the per-address daily limit never binds.
contract SybilFactory {
    address public immutable attacker;
    PackShop public immutable shop;
    SybilChild[] public children;

    constructor(PackShop shop_) {
        attacker = msg.sender;
        shop = shop_;
    }

    function spawn(uint256 n) external payable {
        require(msg.sender == attacker && n != 0 && msg.value % n == 0, "bad spawn");
        uint256 each = msg.value / n;
        for (uint256 i = 0; i < n; i++) children.push(new SybilChild{value: each}(shop));
    }

    function childCount() external view returns (uint256) {
        return children.length;
    }

    function packIdOf(uint256 i) external view returns (uint256) {
        return children[i].packId();
    }

    function sweepChild(uint256 i, ITransferFrom cards, uint256[] calldata ids, address to) external {
        require(msg.sender == attacker, "attacker only");
        children[i].sweep(cards, ids, to);
    }

    function cashOut() external {
        require(msg.sender == attacker, "attacker only");
        (bool ok, ) = attacker.call{value: address(this).balance}("");
        require(ok, "cash out");
    }

    receive() external payable {}
}

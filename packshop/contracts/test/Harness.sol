// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {PackShop, IStudioMinter} from "../PackShop.sol";

/// Test-only: exposes the draw so its odds can be measured without minting thousands of cards.
contract PackShopHarness is PackShop {
    constructor(IStudioMinter minter_, address owner_, uint256 price_, uint8 packSize_, uint16[5] memory weights_, uint16 dailyLimit_)
        PackShop(minter_, owner_, price_, packSize_, weights_, dailyLimit_)
    {}

    /// Kind counts and per-template counts over `n` consecutive seeds starting at `start`.
    function drawStats(uint256 start, uint256 n) external view returns (uint256[5] memory kinds, uint256[] memory perTemplate) {
        perTemplate = new uint256[](_templates.length);
        for (uint256 s = start; s < start + n; s++) {
            uint16[] memory ids = _draw(uint256(keccak256(abi.encode("seed", s))));
            for (uint256 i = 0; i < ids.length; i++) {
                kinds[_templates[ids[i]].kind]++;
                perTemplate[ids[i]]++;
            }
        }
    }
}

/// Test-only buyer that tries to re-enter PackShop while it is being paid.
contract ReentrantBuyer {
    PackShop public immutable shop;
    uint256 public packId;
    bool public armed;
    bytes4 public lastReenterError;
    bool public reenterSucceeded;

    constructor(PackShop shop_) {
        shop = shop_;
    }

    function buy() external payable {
        packId = shop.buyPack{value: msg.value}();
    }

    function arm() external {
        armed = true;
    }

    function refund() external {
        shop.refundExpired(packId);
    }

    receive() external payable {
        if (!armed) return;
        armed = false;
        try shop.refundExpired(packId) {
            reenterSucceeded = true;
        } catch (bytes memory err) {
            if (err.length >= 4) lastReenterError = bytes4(err);
        }
    }
}

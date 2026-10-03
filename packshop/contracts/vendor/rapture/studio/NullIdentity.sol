// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IIdentityLink} from "../interfaces/Rapture.sol";

/// @title NullIdentity — the identity link of the Studio Mode test deployment.
///
/// Studio cards are minted straight to team test wallets, with no PlayerProfile
/// and no AIR proxy, so no card is ever custodial and each holder controls its
/// own cards. RaptureCards needs an IIdentityLink that answers without
/// reverting (IdentityLink.proxyOf(0) reverts on a real PlayerProfile); this
/// one links nobody. The public release deploys the real IdentityLink.
contract NullIdentity is IIdentityLink {
    function proxyOf(uint256) external pure returns (address) {
        return address(0);
    }

    function signerOf(uint256) external pure returns (address) {
        return address(0);
    }

    function profileOfSigner(address) external pure returns (uint256) {
        return 0;
    }

    function profileOf(address) external pure returns (uint256) {
        return 0;
    }
}

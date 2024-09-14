// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {FeistelShuffleOptimised} from "solshuffle/contracts/FeistelShuffleOptimised.sol";
import {Sort} from "./Sort.sol";

library Pick {
    using Sort for uint8[];

    /// @notice Compute the identity of an ordered set of numbers.
    /// @dev NB: DOES NOT check ordering of `picks`!
    /// @param pick *Set* of numbers
    /// @return id Identity (hash) of the set
    function id(uint8[] memory pick) internal pure returns (uint256) {
        uint256 id_;
        for (uint256 i; i < pick.length; ++i) {
            id_ |= uint256(1) << pick[i];
        }
        return id_;
    }

    /// @notice Pick bitvector => pick array
    /// @param pickLength Number of elements in the pick array
    /// @param pickId Bitvector representing the pick
    function parse(
        uint8 pickLength,
        uint256 pickId
    ) internal pure returns (uint8[] memory pick) {
        pick = new uint8[](pickLength);
        uint256 p;
        for (uint256 i; i < 256; ++i) {
            bool isSet = (pickId >> i) & 1 == 1;
            if (isSet) {
                pick[p++] = uint8(i);
            }
            if (p == pickLength) {
                break;
            }
        }
    }

    /// @notice Compute the winning numbers/balls given a random seed.
    /// @param randomSeed Seed that determines the permutation of BALLS
    /// @return balls Ordered set of winning numbers
    function draw(
        uint8 pickLength,
        uint8 maxBallValue,
        uint256 randomSeed
    ) internal pure returns (uint8[] memory balls) {
        balls = new uint8[](pickLength);
        for (uint256 i; i < pickLength; ++i) {
            balls[i] = uint8(
                1 +
                    FeistelShuffleOptimised.shuffle(
                        i,
                        maxBallValue,
                        randomSeed,
                        12
                    )
            );
        }
        balls = balls.sort();
    }
}

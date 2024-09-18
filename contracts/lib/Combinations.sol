// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {LibBit} from "solady/src/utils/LibBit.sol";

library Combinations {
    /// @notice Compute number of combinations of size k from a set of n
    /// @param n Size of set to choose from
    /// @param k Size of subsets to choose
    function choose(
        uint256 n,
        uint256 k
    ) internal pure returns (uint256 result) {
        assert(n >= k);
        assert(n <= 128); // Artificial limit to avoid overflow
        // "How to calculate binomial coefficients"
        // From: https://blog.plover.com/math/choose.html
        // This algorithm computes multiplication and division in alternation
        // to avoid overflow as much as possible.
        unchecked {
            uint256 out = 1;
            for (uint256 d = 1; d <= k; ++d) {
                out *= n--;
                out /= d;
            }
            return out;
        }
    }

    /// @notice Generate all possible subsets of size k from a bit vector.
    /// @param set Bit vector to generate subsets from
    /// @param k Size of subsets to generate
    function generateSubsets(
        uint256 set,
        uint256 k
    ) internal pure returns (uint256[] memory) {
        unchecked {
            // Count the number of set bits in the original bitSet
            uint256 n = LibBit.popCount(set);

            // If k is greater than the total number of set bits, return an empty array
            if (k > n) {
                return new uint256[](0);
            }

            // Calculate the binomial coefficient (n choose k) to get the number of subsets
            uint256 nCombs = choose(n, k);

            // Create an array to store subsets with popcount k
            uint256[] memory subsets = new uint256[](nCombs);
            uint256 s;

            // Generate subsets using Gosper's hack
            uint256 bound = 1 << n;
            uint256 comb = (1 << k) - 1;
            while (comb < bound) {
                // Map the subset back to the original set
                uint256 mapped;
                uint256 _set = set;
                uint256 _comb = comb;
                for (uint256 i = 0; i < 256 && _set != 0; i++) {
                    if (_set & 1 == 1) {
                        if (_comb & 1 == 1) {
                            mapped |= (1 << i);
                        }
                        _comb >>= 1;
                    }
                    _set >>= 1;
                }

                subsets[s] = mapped;
                ++s;

                // Gosper's hack to generate the next subset
                uint256 c = comb & uint256(-int256(comb));
                uint256 r = comb + c;
                comb = (((r ^ comb) >> 2) / c) | r;
            }

            return subsets;
        }
    }
}

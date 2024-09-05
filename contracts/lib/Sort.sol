// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

library Sort {
    /// @notice Sort a small array (insertion sort -> O(n^2))
    /// @param unsorted Potentially unsorted array to be sorted inplace
    function sort(
        uint8[] memory unsorted
    ) internal pure returns (uint8[] memory) {
        uint256 len = unsorted.length;
        for (uint256 i = 1; i < len; ++i) {
            uint8 curr = unsorted[i];
            int256 j;
            for (
                j = int256(i) - 1;
                j >= 0 && curr < unsorted[uint256(j)];
                --j
            ) {
                unsorted[uint256(j + 1)] = unsorted[uint256(j)];
            }
            unsorted[uint256(j + 1)] = curr;
        }
        return unsorted;
    }
}

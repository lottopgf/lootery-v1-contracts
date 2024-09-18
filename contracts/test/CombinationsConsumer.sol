// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {Combinations} from "../lib/Combinations.sol";

contract CombinationsConsumer {
    function choose(
        uint256 n,
        uint256 k
    ) public view returns (uint256 out, uint256 gasUsed) {
        gasUsed = gasleft();
        out = Combinations.choose(n, k);
        gasUsed -= gasleft();
    }

    function generateSubsets(
        uint256 set,
        uint256 k
    ) public view returns (uint256[] memory out, uint256 gasUsed) {
        gasUsed = gasleft();
        out = Combinations.generateSubsets(set, k);
        gasUsed -= gasleft();
    }
}

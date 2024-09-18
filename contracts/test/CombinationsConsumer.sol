// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {Combinations} from "../lib/Combinations.sol";

contract CombinationsConsumer {
    mapping(uint256 gameId => mapping(uint256 pickId => uint256 count))
        public pickIdCountsPerGame;

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
    ) public returns (uint256 gasUsed) {
        gasUsed = gasleft();
        Combinations.generateSubsets(set, k, pickIdCountsPerGame[0]);
        gasUsed -= gasleft();
    }
}

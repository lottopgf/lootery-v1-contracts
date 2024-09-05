// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {Sort} from "../lib/Sort.sol";

contract SortConsumer {
    using Sort for uint8[];

    function sort(
        uint8[] calldata unsorted
    ) external pure returns (uint8[] memory) {
        return unsorted.sort();
    }
}

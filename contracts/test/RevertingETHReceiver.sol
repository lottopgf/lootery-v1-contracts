// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

contract RevertingETHReceiver {
    receive() external payable {
        revert("nope");
    }
}

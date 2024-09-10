// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    constructor(address initialOwner) ERC20("Test", "TEST") {}

    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }

    function setApproval(
        address owner,
        address spender,
        uint256 amount
    ) public {
        _approve(owner, spender, amount);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract TestERC721 is ERC721 {
    constructor(address initialOwner) ERC721("Test", "TEST") {}

    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }
}

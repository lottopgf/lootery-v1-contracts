// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {Lootery} from "../Lootery.sol";

contract LooteryHarness is Lootery {
    constructor() {
        require(block.chainid == 31337, "Test only");
    }

    function pickTickets(
        Ticket[] calldata tickets,
        uint256 jackpotShare
    ) external {
        return _pickTickets(tickets, jackpotShare);
    }

    function setupNextGame() external {
        _setupNextGame();
    }

    function setGameState(GameState state) external {
        currentGame.state = state;
    }
}

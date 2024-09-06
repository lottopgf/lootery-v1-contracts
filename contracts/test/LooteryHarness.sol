// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {Lootery} from "../Lootery.sol";

contract LooteryHarness is Lootery {
    function pickTickets(Ticket[] calldata tickets) external {
        return _pickTickets(tickets);
    }

    function setupNextGame() external {
        _setupNextGame();
    }

    function setGameState(GameState state) external {
        currentGame.state = state;
    }

    function setGameData(uint248 gameId, Game calldata data) external {
        gameData[gameId] = data;
    }

    function setRandomnessRequest(RandomnessRequest calldata req) external {
        randomnessRequest = req;
    }

    function setJackpot(uint256 amount) external {
        jackpot = amount;
    }

    function setUnclaimedPayouts(uint256 amount) external {
        unclaimedPayouts = amount;
    }
}

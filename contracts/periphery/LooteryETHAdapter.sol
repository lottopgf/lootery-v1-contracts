// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Lootery} from "../Lootery.sol";
import {IWETH9} from "../interfaces/IWETH9.sol";

/// @custom:version 1.5.0
contract LooteryETHAdapter {
    IWETH9 public immutable wrappedToken;

    event JackpotSeeded(address indexed whomst, uint256 amount);

    constructor(address payable _wrappedTokenAddress) {
        wrappedToken = IWETH9(_wrappedTokenAddress);
    }

    function purchase(
        address payable looteryAddress,
        Lootery.Ticket[] calldata tickets,
        address beneficiary
    ) public payable {
        Lootery lootery = Lootery(looteryAddress);
        uint256 ticketsCount = tickets.length;
        uint256 totalPrice = lootery.ticketPrice() * ticketsCount;

        require(msg.value == totalPrice, "Need to provide exact funds");

        wrappedToken.deposit{value: totalPrice}();
        wrappedToken.approve(looteryAddress, totalPrice);

        lootery.purchase(tickets, beneficiary);
    }

    function seedJackpot(address payable looteryAddress) public payable {
        Lootery lootery = Lootery(looteryAddress);

        wrappedToken.deposit{value: msg.value}();
        wrappedToken.approve(looteryAddress, msg.value);

        lootery.seedJackpot(msg.value);

        emit JackpotSeeded(msg.sender, msg.value);
    }
}

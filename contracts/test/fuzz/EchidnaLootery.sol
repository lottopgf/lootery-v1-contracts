// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {hevm} from "../IHevm.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ILootery, Lootery} from "../../../contracts/Lootery.sol";
import {MockRandomiser} from "../MockRandomiser.sol";
import {MockERC20} from "../MockERC20.sol";
import {TicketSVGRenderer} from "../../periphery/TicketSVGRenderer.sol";
import {WETH9} from "../WETH9.sol";
import {LooteryETHAdapter} from "../../periphery/LooteryETHAdapter.sol";

contract EchidnaLootery {
    Lootery internal lootery;
    MockRandomiser internal randomiser = new MockRandomiser();
    MockERC20 internal prizeToken = new MockERC20(address(this));
    TicketSVGRenderer internal ticketSVGRenderer = new TicketSVGRenderer();

    constructor() {
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(new Lootery()),
            abi.encodeWithSelector(
                Lootery.init.selector,
                ILootery.InitConfig({
                    owner: address(this),
                    name: "Lootery Test",
                    symbol: "TEST",
                    numPicks: 5,
                    maxBallValue: 36,
                    gamePeriod: 10 minutes,
                    ticketPrice: 0.01 ether,
                    communityFeeBps: 0.5e4,
                    randomiser: address(randomiser),
                    prizeToken: address(prizeToken),
                    seedJackpotDelay: 10 minutes,
                    seedJackpotMinValue: 0.1 ether,
                    ticketSVGRenderer: address(ticketSVGRenderer)
                })
            )
        );
        lootery = Lootery(payable(proxy));
        // Operational funds
        hevm.deal(address(lootery), 1 ether);
        // Echidna senders should have enough tokens to buy tickets
        prizeToken.mint(address(0x10000), 2 ** 128);
        prizeToken.setApproval(
            address(0x10000),
            address(lootery),
            type(uint256).max
        );
        prizeToken.mint(address(0x20000), 2 ** 128);
        prizeToken.setApproval(
            address(0x20000),
            address(lootery),
            type(uint256).max
        );
        prizeToken.mint(address(0x30000), 2 ** 128);
        prizeToken.setApproval(
            address(0x30000),
            address(lootery),
            type(uint256).max
        );
    }

    function seedJackpot(uint256 value) public {
        lootery.seedJackpot(value);
    }

    /// @notice Buy tickets
    function purchase(uint256 numTickets, uint256 seed) external {
        numTickets = 1 + (numTickets % 19); // [1, 20] tickets

        ILootery.Ticket[] memory tickets = new ILootery.Ticket[](numTickets);
        for (uint256 i = 0; i < numTickets; i++) {
            tickets[i] = ILootery.Ticket({
                whomst: msg.sender,
                picks: lootery.computePicks(seed)
            });
            seed = uint256(keccak256(abi.encodePacked(seed)));
        }
        // TODO: fuzz beneficiaries
        lootery.purchase(tickets, address(0));
    }

    function draw() external {
        lootery.draw();
    }

    function echidna_alwaysBacked() external view returns (bool) {
        return
            prizeToken.balanceOf(address(lootery)) >=
            (lootery.unclaimedPayouts() +
                lootery.jackpot() +
                lootery.accruedCommunityFees());
    }
}

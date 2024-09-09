// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {hevm} from "../IHevm.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ILootery, Lootery} from "../../../contracts/Lootery.sol";
import {MockRandomiser} from "../MockRandomiser.sol";
import {MockERC20} from "../MockERC20.sol";
import {TicketSVGRenderer} from "../../periphery/TicketSVGRenderer.sol";

contract EchidnaLootery {
    MockERC20 internal prizeToken;
    MockRandomiser internal randomiser;
    Lootery internal impl;
    ILootery.InitConfig internal config;

    constructor() {
        impl = new Lootery();
        randomiser = new MockRandomiser();
        prizeToken = new MockERC20(address(this));
        TicketSVGRenderer ticketSVGRenderer = new TicketSVGRenderer();
        config = ILootery.InitConfig({
            owner: address(this),
            name: "Lootery Test",
            symbol: "TEST",
            numPicks: 5,
            maxBallValue: 36,
            gamePeriod: 10 minutes,
            ticketPrice: 0.1 ether,
            communityFeeBps: 0.5e4,
            randomiser: address(randomiser),
            prizeToken: address(prizeToken),
            seedJackpotDelay: 10 minutes,
            seedJackpotMinValue: 0.1 ether,
            ticketSVGRenderer: address(ticketSVGRenderer)
        });
    }

    function createLootery(
        uint8 numPicks,
        uint8 maxBallValue
    ) internal returns (Lootery lootery) {
        config.numPicks = numPicks;
        config.maxBallValue = maxBallValue;
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeWithSelector(Lootery.init.selector, config)
        );
        lootery = Lootery(payable(proxy));
        hevm.deal(address(lootery), 1 ether); // operational funds
    }

    /// @notice Generate random picks
    /// @param whomst Address to buy tickets for
    /// @param seed Random seed
    function slikpik(
        Lootery lootery,
        address whomst,
        uint256 seed
    ) internal view returns (ILootery.Ticket memory ticket) {
        ticket.whomst = whomst;
        ticket.picks = lootery.computePicks(seed);
    }

    /// @notice Buy tickets
    /// @param seed Random seed
    /// @param numTickets Number of tickets to buy
    /// @param addresses Addresses to buy tickets for
    function buyTickets(
        Lootery lootery,
        uint256 seed,
        uint256 numTickets,
        address[] memory addresses
    ) internal {
        assert(numTickets > 0);
        uint256 totalSupply = lootery.totalSupply();

        prizeToken.mint(address(this), numTickets * lootery.ticketPrice());
        prizeToken.approve(
            address(lootery),
            numTickets * lootery.ticketPrice()
        );
        ILootery.Ticket[] memory tickets = new ILootery.Ticket[](numTickets);
        for (uint256 i = 0; i < numTickets; i++) {
            tickets[i] = ILootery.Ticket({
                whomst: addresses[i],
                picks: lootery.computePicks(seed)
            });
            seed = uint256(keccak256(abi.encodePacked(seed)));
        }
        lootery.purchase(tickets, address(0));
        assert(lootery.totalSupply() == totalSupply + numTickets);
    }

    /// @notice Runthrough from game 0 until game n
    /// @param seed Random seed
    /// @param numTickets Number of tickets to buy
    /// @param addresses Addresses to buy tickets for
    function test_gameProgression(
        uint8 numPicks,
        uint8 maxBallValue,
        uint256 seed,
        uint256 numTickets,
        address[] calldata addresses,
        uint256 runs
    ) public {
        numPicks = 1 + (numPicks % (type(uint8).max - 1));
        maxBallValue = numPicks + (maxBallValue % (type(uint8).max - numPicks));
        numTickets = numTickets % 32; // Max echidna array len=32
        runs = 1 + (runs % 19);

        Lootery lootery = createLootery(numPicks, maxBallValue);

        for (uint256 i = 0; i < runs; i++) {
            (ILootery.GameState state0, uint256 gameId0) = lootery
                .currentGame();
            if (numTickets > 0)
                buyTickets(lootery, seed, numTickets, addresses);

            hevm.warp(block.timestamp + 10 minutes);
            (bool success, ) = address(lootery).call(
                abi.encodeWithSelector(Lootery.draw.selector)
            );
            assert(success);

            (ILootery.GameState state1, uint256 gameId1) = lootery
                .currentGame();
            (uint256 requestId, ) = lootery.randomnessRequest();
            if (numTickets == 0) {
                // No tickets -> skip draw
                assert(gameId1 > gameId0);
                assert(state0 == state1);
                assert(state1 == ILootery.GameState.Purchase);
                assert(requestId == 0);
            } else {
                // Tickets -> VRF request
                assert(gameId0 == gameId1);
                assert(state1 == ILootery.GameState.DrawPending);
                assert(requestId != 0);
                uint256[] memory randomWords = new uint256[](1);
                randomWords[0] = uint256(
                    keccak256(abi.encodePacked("vrf", seed))
                );
                randomiser.fulfillRandomWords(requestId, randomWords);
            }
            seed = uint256(keccak256(abi.encodePacked(seed)));
        }
        (, uint256 gameIdZ) = lootery.currentGame();
        assert(gameIdZ == runs);
    }

    /// @notice It must always be the case that the internal accounting of
    ///     jackpot+fees is always greater than or equal to the balance of
    ///     the prize token balance in the contract
    function test_jackpotAndFeesGtBalance() public {
        Lootery lootery = createLootery(5, 36);
        assert(
            lootery.jackpot() + lootery.accruedCommunityFees() >=
                prizeToken.balanceOf(address(lootery))
        );
    }

    /// @notice #computeWinningBalls produces strictly ordered numbers
    function test_sortedWinningNumbers(
        uint8 numPicks,
        uint8 maxBallValue,
        uint256 seed
    ) public {
        numPicks = 1 + (numPicks % (type(uint8).max - 1));
        maxBallValue = numPicks + (maxBallValue % (type(uint8).max - numPicks));
        Lootery lootery = createLootery(numPicks, maxBallValue);
        uint8[] memory balls = lootery.computeWinningBalls(seed);
        uint8 lastPick = 0;
        for (uint256 i = 0; i < balls.length; i++) {
            assert(balls[i] > lastPick);
        }
    }
}

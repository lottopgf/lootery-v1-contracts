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
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

contract EchidnaLootery {
    using Strings for uint256;
    using Strings for address;

    address internal immutable owner = address(this);
    Lootery internal lootery;
    MockRandomiser internal randomiser = new MockRandomiser();
    MockERC20 internal prizeToken = new MockERC20(address(this));
    TicketSVGRenderer internal ticketSVGRenderer = new TicketSVGRenderer();
    uint256 internal lastTicketSeed;
    uint256 internal lastGameId;

    mapping(uint256 gameId => uint256 unclaimedPayouts)
        internal recUnclaimedPayouts;
    mapping(uint256 gameId => uint256 jackpot) internal recJackpots;

    event DebugLog(string msg);
    event AssertionFailed(string reason);

    constructor() {
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(new Lootery()),
            abi.encodeWithSelector(
                Lootery.init.selector,
                ILootery.InitConfig({
                    owner: owner,
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
        hevm.label(address(0x10000), "alice");
        prizeToken.mint(address(0x10000), 2 ** 128);
        prizeToken.setApproval(
            address(0x10000),
            address(lootery),
            type(uint256).max
        );
        hevm.label(address(0x20000), "bob");
        prizeToken.mint(address(0x20000), 2 ** 128);
        prizeToken.setApproval(
            address(0x20000),
            address(lootery),
            type(uint256).max
        );
        hevm.label(address(0x30000), "deployer");
        prizeToken.mint(address(0x30000), 2 ** 128);
        prizeToken.setApproval(
            address(0x30000),
            address(lootery),
            type(uint256).max
        );
    }

    function assertWithMsg(bool condition, string memory reason) internal {
        if (!condition) {
            emit AssertionFailed(reason);
        }
    }

    function seedJackpot(uint256 value) public {
        hevm.prank(msg.sender);
        lootery.seedJackpot(value);
    }

    function purchase(uint256 numTickets, uint256 seed) external {
        numTickets = numTickets % 20; // max 20 tix
        lastTicketSeed = seed;

        ///////////////////////////////////////////////////////////////////////
        /// Initial state /////////////////////////////////////////////////////
        uint256 totalSupply0 = lootery.totalSupply();
        uint256 jackpot0 = lootery.jackpot();
        uint256 accruedCommunityFees0 = lootery.accruedCommunityFees();
        ///////////////////////////////////////////////////////////////////////

        ILootery.Ticket[] memory tickets = new ILootery.Ticket[](numTickets);
        for (uint256 i = 0; i < numTickets; i++) {
            lastTicketSeed = uint256(
                keccak256(abi.encodePacked(lastTicketSeed))
            );
            tickets[i] = ILootery.Ticket({
                whomst: msg.sender,
                picks: lootery.computeWinningBalls(lastTicketSeed)
            });
        }
        // TODO: fuzz beneficiaries
        hevm.prank(msg.sender);
        lootery.purchase(tickets, address(0));

        ///////////////////////////////////////////////////////////////////////
        /// Postconditions ////////////////////////////////////////////////////
        assert(lootery.totalSupply() == totalSupply0 + numTickets);
        assert(lootery.jackpot() > jackpot0);
        // *If no beneficiary was passed in*
        assert(lootery.accruedCommunityFees() > accruedCommunityFees0);
        ///////////////////////////////////////////////////////////////////////
    }

    /// @notice Helper function to fast forward the game and draw
    function _fastForwardAndDraw() internal {
        ///////////////////////////////////////////////////////////////////////
        /// Initial state /////////////////////////////////////////////////////
        (ILootery.GameState state0, uint256 gameId0) = lootery.currentGame();
        require(state0 == ILootery.GameState.Purchase, "Ignore path");
        (uint64 ticketsSold0, uint64 startedAt0, ) = lootery.gameData(gameId0);
        bool isApocalypseMode = lootery.isApocalypseMode();
        uint256 total0 = lootery.jackpot() + lootery.unclaimedPayouts();
        ///////////////////////////////////////////////////////////////////////

        uint256 period = lootery.gamePeriod();
        if (block.timestamp < startedAt0 + period) {
            hevm.warp(startedAt0 + period);
        }
        hevm.prank(msg.sender);
        lootery.draw();

        ///////////////////////////////////////////////////////////////////////
        /// Postconditions ////////////////////////////////////////////////////
        (ILootery.GameState state1, uint256 gameId1) = lootery.currentGame();
        uint256 jackpot1 = lootery.jackpot();
        uint256 unclaimedPayouts1 = lootery.unclaimedPayouts();
        assertWithMsg(
            total0 == jackpot1 + unclaimedPayouts1,
            "total paid/unpaid jackpot amounts not conserved"
        );
        recJackpots[gameId1] = jackpot1;
        recUnclaimedPayouts[gameId1] = unclaimedPayouts1;
        if (ticketsSold0 == 0) {
            // No tickets -> skip draw
            assertWithMsg(
                gameId1 > gameId0,
                "numTickets == 0: gameId did not increase"
            );
            assertWithMsg(
                (state0 == state1) ||
                    (isApocalypseMode && state1 == ILootery.GameState.Dead),
                "numTickets == 0: unexpected state"
            );
        } else {
            // Tickets -> VRF request
            assertWithMsg(
                gameId0 == gameId1,
                "numTickets > 0: unexpected gameId increase"
            );
            assertWithMsg(
                state1 == ILootery.GameState.DrawPending,
                "numTickets > 0: unexpected state"
            );
        }
    }

    /// @notice Helper to fulfill randomness request
    function _fulfill(uint256 seed) internal {
        ///////////////////////////////////////////////////////////////////////
        /// Initial state /////////////////////////////////////////////////////
        (ILootery.GameState state0, ) = lootery.currentGame();
        (uint256 requestId0, ) = lootery.randomnessRequest();
        require(
            state0 == ILootery.GameState.DrawPending && requestId0 != 0,
            "No pending draw"
        );
        uint256 total0 = lootery.jackpot() + lootery.unclaimedPayouts();
        ///////////////////////////////////////////////////////////////////////

        uint256[] memory randomWords = new uint256[](1);
        if (seed % 2 == 0) {
            randomWords[0] = seed;
        } else {
            randomWords[0] = lastTicketSeed;
            lastTicketSeed = 0;
        }
        randomiser.fulfillRandomWords(requestId0, randomWords);

        ///////////////////////////////////////////////////////////////////////
        /// Postconditions ////////////////////////////////////////////////////
        (ILootery.GameState state1, uint256 gameId1) = lootery.currentGame();
        uint256 jackpot1 = lootery.jackpot();
        uint256 unclaimedPayouts1 = lootery.unclaimedPayouts();
        recJackpots[gameId1] = jackpot1;
        recUnclaimedPayouts[gameId1] = unclaimedPayouts1;
        assertWithMsg(
            total0 == jackpot1 + unclaimedPayouts1,
            "total paid/unpaid jackpot amounts not conserved"
        );
        (uint256 requestId1, ) = lootery.randomnessRequest();
        assertWithMsg(requestId1 == 0, "requestId should be 0");
        bool isApocalypseMode = lootery.isApocalypseMode();
        assertWithMsg(
            state1 == ILootery.GameState.Purchase ||
                (isApocalypseMode && state1 == ILootery.GameState.Dead),
            "unexpected state"
        );
    }

    function draw() external {
        _fastForwardAndDraw();
    }

    function fulfill(uint256 seed) external {
        _fulfill(seed);
    }

    function drawAndFulfill(uint256 seed) external {
        _fastForwardAndDraw();
        _fulfill(seed);
    }

    function claimWinnings(uint256 tokenId) external {
        tokenId = 1 + (tokenId % lootery.totalSupply());
        (ILootery.GameState state, uint256 currGameId) = lootery.currentGame();
        require(currGameId > 0, "No games played yet");

        uint256 totalSupply0 = lootery.totalSupply();
        require(totalSupply0 > 0, "No tickets bought yet");
        tokenId = 1 + (tokenId % (totalSupply0 - 1));
        address tokenOwner = lootery.ownerOf(tokenId);
        uint256 tokenOwnerBalance0 = prizeToken.balanceOf(tokenOwner);
        (uint256 gameId, uint256 pickId) = lootery.purchasedTickets(tokenId);
        (uint64 ticketsSold, , uint256 winningPickId) = lootery.gameData(
            gameId
        );

        lootery.claimWinnings(tokenId);

        ///////////////////////////////////////////////////////////////////////
        /// Postconditions ////////////////////////////////////////////////////
        bool isBurnt;
        try lootery.ownerOf(tokenId) {} catch {
            isBurnt = true;
        }
        assertWithMsg(isBurnt, "tokenId not burnt");
        // Total supply should not change; we don't decrease it during burn
        // We use `totalSupply()` to increment token IDs
        assert(lootery.totalSupply() == totalSupply0);

        uint256 numWinners = lootery.numWinnersInGame(gameId, winningPickId);
        uint256 tokenOwnerBalance1 = prizeToken.balanceOf(tokenOwner);
        if (winningPickId == pickId) {
            // Winner takes jackpot regardless of state
            assert(numWinners > 0);
            uint256 minPrizeShare = recUnclaimedPayouts[gameId] / numWinners;
            assertWithMsg(
                tokenOwnerBalance1 - tokenOwnerBalance0 >= minPrizeShare,
                "winner did not receive jackpot"
            );
        } else {
            if (numWinners == 0 && state == ILootery.GameState.Dead) {
                // Apocalypse mode, no winner -> claim even share
                uint256 minPrizeShare = recUnclaimedPayouts[gameId] /
                    ticketsSold;
                assertWithMsg(
                    tokenOwnerBalance1 - tokenOwnerBalance0 >= minPrizeShare,
                    "consolation prize not received"
                );
            } else {
                // Receive nothing
                assertWithMsg(
                    tokenOwnerBalance1 == tokenOwnerBalance0,
                    "no prize"
                );
            }
        }
    }

    function withdrawAccruedFees() external {
        lootery.withdrawAccruedFees();
    }

    function kill() external {
        lootery.kill();
    }

    function rescueRandomTokens(address tokenAddress) external {
        lootery.rescueTokens(tokenAddress);
    }

    function rescuePrizeTokens() external {
        ///////////////////////////////////////////////////////////////////////
        /// Initial state /////////////////////////////////////////////////////
        uint256 locked = lootery.accruedCommunityFees() +
            lootery.unclaimedPayouts() +
            lootery.jackpot();
        ///////////////////////////////////////////////////////////////////////

        lootery.rescueTokens(address(prizeToken));

        ///////////////////////////////////////////////////////////////////////
        /// Postconditions ////////////////////////////////////////////////////
        (ILootery.GameState state, uint256 gameId) = lootery.currentGame();
        require(gameId > 0, "No games played yet");

        // The following checks are to ensure that we never have funds that are
        // stuck in the contract, even in the rare case that the game is dead
        // with no tickets sold.
        (uint64 ticketsSold, , ) = lootery.gameData(gameId - 1);
        bool isDeadWithNoTickets = state == ILootery.GameState.Dead &&
            ticketsSold == 0;
        uint256 balance1 = prizeToken.balanceOf(address(lootery));
        if (isDeadWithNoTickets) {
            // If the game is dead, then we should have been able to rescue
            // the entire balance of prize tokens.
            assertWithMsg(balance1 == 0, "stuck funds");
            assertWithMsg(
                lootery.accruedCommunityFees() == 0 &&
                    lootery.unclaimedPayouts() == 0 &&
                    lootery.jackpot() == 0,
                "all accrued fee values should be 0"
            );
        } else {
            assertWithMsg(balance1 == locked, "unbacked");
        }
    }

    function sendAccidentalPrizeTokens(uint256 amount) external {
        prizeToken.mint(address(lootery), amount);
    }

    ///////////////////////////////////////////////////////////////////////////
    /// PROPERTIES ////////////////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////

    function test_gameIdIncreases() external {
        (, uint256 gameId) = lootery.currentGame();
        assert(gameId >= lastGameId);
        lastGameId = gameId;
    }

    function test_numWinnersLteTicketsSold() external {
        (, uint256 gameId) = lootery.currentGame();
        require(gameId > 0, "No games played yet");
        (uint64 ticketsSold, , uint256 winningPickId) = lootery.gameData(
            gameId - 1
        );
        assertWithMsg(
            lootery.numWinnersInGame(gameId - 1, winningPickId) <= ticketsSold,
            "numWinners > ticketsSold"
        );
    }

    function test_alwaysBacked() external view {
        assert(
            prizeToken.balanceOf(address(lootery)) >=
                (lootery.unclaimedPayouts() +
                    lootery.jackpot() +
                    lootery.accruedCommunityFees())
        );
    }

    function test_requestOnlyDefinedWhenDrawPending() external view {
        (ILootery.GameState state, ) = lootery.currentGame();
        (uint256 requestId, ) = lootery.randomnessRequest();
        bool isDrawPending = state == ILootery.GameState.DrawPending &&
            requestId != 0;
        bool isOtherState = state != ILootery.GameState.DrawPending &&
            requestId == 0;
        assert(isDrawPending || isOtherState);
    }
}

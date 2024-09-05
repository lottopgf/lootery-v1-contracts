// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {ILootery} from "./interfaces/ILootery.sol";
import {Pick} from "./lib/Pick.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IRandomiserCallback} from "./interfaces/IRandomiserCallback.sol";
import {IAnyrand} from "./interfaces/IAnyrand.sol";
import {ITicketSVGRenderer} from "./interfaces/ITicketSVGRenderer.sol";

/// @title Lootery
/// @custom:version 1.3.0
/// @notice Lootery is a number lottery contract where players can pick a
///     configurable set of numbers/balls per ticket, similar to IRL lottos
///     such as Powerball or EuroMillions. At the end of every round, a keeper
///     may call the `draw` function to determine the winning set of numbers
///     for that round. Then a new round is immediately started.
///
///     Any player with a winning ticket (i.e. their ticket's set of numbers is
///     set-equal to the winning set of numbers) has one round to claim their
///     winnings. Otherwise, the winnings are rolled back into the jackpot.
///
///     The lottery will run forever until the owner invokes *apocalypse mode*,
///     which invokes a special rule for the current round: if no player wins
///     the jackpot, then every ticket buyer from the current round may claim
///     an equal share of the jackpot.
///
///     Players may permissionlessly buy tickets through the `purchase`
///     function, paying a ticket price (in the form of `prizeToken`), where
///     the proceeds are split into the jackpot and the community fee (this is
///     configurable only at initialisation). Alternatively, the owner of the
///     lottery contract may also distribute free tickets via the `ownerPick`
///     function.
///
///     While the jackpot builds up over time, it is possible (and desirable)
///     to seed the jackpot at any time using the `seedJackpot` function.
contract Lootery is
    Initializable,
    ILootery,
    OwnableUpgradeable,
    ERC721Upgradeable
{
    using SafeERC20 for IERC20;
    using Strings for uint256;

    /// @notice How many numbers must be picked per draw (and per ticket)
    ///     The range of this number should be something like 3-7
    uint8 public numPicks;
    /// @notice Maximum value of a ball (pick) s.t. value \in [1, maxBallValue]
    uint8 public maxBallValue;
    /// @notice How long a game lasts in seconds (before numbers are drawn)
    uint256 public gamePeriod;
    /// @notice Trusted randomiser
    address public randomiser;
    /// @notice Token used for prizes
    address public prizeToken;
    /// @notice Ticket price
    uint256 public ticketPrice;
    /// @notice Percentage of ticket price directed to the community
    uint256 public communityFeeBps;
    /// @notice Minimum seconds to wait between seeding jackpot
    uint256 public seedJackpotDelay;
    /// @notice Minimum value required when seeding jackpot
    uint256 public seedJackpotMinValue;
    /// @notice Ticket SVG renderer
    address public ticketSVGRenderer;

    /// @dev Current token id
    uint256 private currentTokenId;
    /// @notice Current state of the game
    CurrentGame public currentGame;
    /// @notice Running jackpot
    uint256 public jackpot;
    /// @notice Unclaimed jackpot payouts from previous game; will be rolled
    ///     over if not claimed in current game
    uint256 public unclaimedPayouts;
    /// @notice Current random request details
    RandomnessRequest public randomnessRequest;
    /// @notice token id => purchased ticked details (gameId, pickId)
    mapping(uint256 tokenId => PurchasedTicket) public purchasedTickets;
    /// @notice Game data
    mapping(uint256 gameId => Game) public gameData;
    /// @notice Game id => pick identity => tokenIds
    mapping(uint256 gameId => mapping(uint256 id => uint256[]))
        public tokenByPickIdentity;
    /// @notice Game id => claimed winning tickets
    mapping(uint256 gameId => uint256[]) public claimedWinningTickets;
    /// @notice Accrued community fee share (wei)
    uint256 public accruedCommunityFees;
    /// @notice When nonzero, this gameId will be the last
    uint256 public apocalypseGameId;
    /// @notice Timestamp of when jackpot was last seeded
    uint256 public jackpotLastSeededAt;

    constructor() {
        _disableInitializers();
    }

    /// @notice Initialisoooooooor
    function init(InitConfig memory initConfig) public override initializer {
        __Ownable_init(initConfig.owner);
        __ERC721_init(initConfig.name, initConfig.symbol);

        if (initConfig.numPicks == 0) {
            revert InvalidNumPicks(initConfig.numPicks);
        }
        numPicks = initConfig.numPicks;
        maxBallValue = initConfig.maxBallValue;

        if (initConfig.gamePeriod < 10 minutes) {
            revert InvalidGamePeriod(initConfig.gamePeriod);
        }
        gamePeriod = initConfig.gamePeriod;

        if (initConfig.ticketPrice == 0) {
            revert InvalidTicketPrice(initConfig.ticketPrice);
        }
        ticketPrice = initConfig.ticketPrice;
        communityFeeBps = initConfig.communityFeeBps;

        if (initConfig.randomiser == address(0)) {
            revert InvalidRandomiser(initConfig.randomiser);
        }
        randomiser = initConfig.randomiser;

        if (initConfig.prizeToken == address(0)) {
            revert InvalidPrizeToken(initConfig.prizeToken);
        }
        prizeToken = initConfig.prizeToken;

        seedJackpotDelay = initConfig.seedJackpotDelay;
        seedJackpotMinValue = initConfig.seedJackpotMinValue;
        if (seedJackpotDelay == 0 || seedJackpotMinValue == 0) {
            revert InvalidSeedJackpotConfig(
                seedJackpotDelay,
                seedJackpotMinValue
            );
        }

        _setTicketSVGRenderer(initConfig.ticketSVGRenderer);

        gameData[0] = Game({
            ticketsSold: 0,
            // The first game starts straight away
            startedAt: uint64(block.timestamp),
            winningPickId: 0
        });
    }

    /// @notice Determine if game is active (in any playable state). If this
    ///     returns `false`, it means that the lottery is no longer playable.
    function isGameActive() public view returns (bool) {
        uint256 apocalypseGameId_ = apocalypseGameId;
        return !(apocalypseGameId_ != 0 && currentGame.id >= apocalypseGameId_);
    }

    /// @notice See {Lootery-isGameActive}
    function _assertGameIsActive() internal view {
        if (!isGameActive()) {
            revert GameInactive();
        }
    }

    /// @notice Seed the jackpot.
    /// @notice NB: This function is rate-limited by `jackpotLastSeededAt`!
    /// @param value Amount of `prizeToken` to be taken from the caller and
    ///     added to the jackpot.
    function seedJackpot(uint256 value) external {
        _assertGameIsActive();
        // We allow seeding jackpot during purchase phase only, so we don't
        // have to fuck around with accounting
        if (currentGame.state != GameState.Purchase) {
            revert UnexpectedState(currentGame.state, GameState.Purchase);
        }

        // Disallow seeding the jackpot with zero value
        if (value < seedJackpotMinValue) {
            revert InsufficientJackpotSeed(value);
        }

        // Rate limit seeding the jackpot
        if (block.timestamp < jackpotLastSeededAt + seedJackpotDelay) {
            revert RateLimited(
                jackpotLastSeededAt + seedJackpotDelay - block.timestamp
            );
        }
        jackpotLastSeededAt = block.timestamp;

        jackpot += value;
        IERC20(prizeToken).safeTransferFrom(msg.sender, address(this), value);
        emit JackpotSeeded(msg.sender, value);
    }

    /// @notice Helper to parse a pick id into a pick array
    /// @param pickId Pick id
    function computePicks(
        uint256 pickId
    ) public view returns (uint8[] memory picks) {
        return Pick.parse(numPicks, pickId);
    }

    /// @notice Helper to compute the winning numbers/balls given a random seed.
    /// @param randomSeed Seed that determines the permutation of BALLS
    /// @return balls Ordered set of winning numbers
    function computeWinningBalls(
        uint256 randomSeed
    ) public view returns (uint8[] memory balls) {
        return Pick.draw(numPicks, maxBallValue, randomSeed);
    }

    /// @notice Purchase a ticket
    /// @param tickets Tickets! Tickets!
    function purchase(Ticket[] calldata tickets, address beneficiary) external {
        uint256 ticketsCount = tickets.length;
        uint256 totalPrice = ticketPrice * ticketsCount;

        IERC20(prizeToken).safeTransferFrom(
            msg.sender,
            address(this),
            totalPrice
        );

        // Handle fee splits
        uint256 communityFeeShare = (totalPrice * communityFeeBps) / 10000;
        uint256 jackpotShare = totalPrice - communityFeeShare;
        uint256 currentGameId = currentGame.id;
        if (beneficiary == address(0)) {
            accruedCommunityFees += communityFeeShare;
        } else {
            IERC20(prizeToken).safeTransfer(beneficiary, communityFeeShare);
        }
        emit BeneficiaryPaid(
            currentGameId,
            beneficiary == address(0) ? address(this) : beneficiary,
            communityFeeShare
        );

        _pickTickets(tickets, jackpotShare);
    }

    /// @notice Draw numbers, picking potential jackpot winners and ending the
    ///     current game. This should be automated by a keeper.
    function draw() external {
        uint256 gasUsed = gasleft();
        _assertGameIsActive();
        // Assert game is still playable
        // Assert we're in the correct state
        CurrentGame memory currentGame_ = currentGame;
        if (currentGame_.state != GameState.Purchase) {
            revert UnexpectedState(currentGame_.state, GameState.Purchase);
        }
        Game memory game = gameData[currentGame_.id];
        // Assert that the game is actually over
        uint256 gameDeadline = (game.startedAt + gamePeriod);
        if (block.timestamp < gameDeadline) {
            revert WaitLonger(gameDeadline);
        }

        // Assert that there are actually tickets sold in this game
        // slither-disable-next-line incorrect-equality
        if (game.ticketsSold == 0) {
            // Case #1: No tickets were sold, just skip the game
            emit DrawSkipped(currentGame_.id);
            _setupNextGame();
        } else {
            // Case #2: Tickets were sold
            currentGame.state = GameState.DrawPending;
            // Assert there's not already a request inflight, unless some
            // reasonable amount of time has already passed
            RandomnessRequest memory randReq = randomnessRequest;
            if (
                randReq.requestId != 0 &&
                (block.timestamp <= (randReq.timestamp + 1 hours))
            ) {
                revert RequestAlreadyInFlight(
                    randReq.requestId,
                    randReq.timestamp
                );
            }

            // Assert that we have enough in operational funds so as to not eat
            // into jackpots or whatever else.
            uint256 requestPrice = IAnyrand(randomiser).getRequestPrice(
                500_000
            );
            if (address(this).balance < requestPrice) {
                revert InsufficientOperationalFunds(
                    address(this).balance,
                    requestPrice
                );
            }
            // VRF call to trusted coordinator
            // slither-disable-next-line reentrancy-eth,arbitrary-send-eth
            uint256 requestId = IAnyrand(randomiser).requestRandomness{
                value: requestPrice
            }(block.timestamp + 30, 500_000);
            if (requestId > type(uint208).max) {
                revert RequestIdOverflow(requestId);
            }
            randomnessRequest = RandomnessRequest({
                requestId: uint208(requestId),
                timestamp: uint48(block.timestamp)
            });
        }

        // Refund gas to caller (+10% bounty)
        gasUsed -= gasleft();
        gasUsed += 21_000 + 9000; // total gas <100k
        // Cap gas refund
        gasUsed = gasUsed > 150_000 ? 150_000 : gasUsed;
        // Everything below this line costs an additional ~9000 gas
        uint256 gasRefund = ((gasUsed * tx.gasprice) * 1.1e4) / 1e4;
        if (address(this).balance < gasRefund) {
            revert InsufficientOperationalFunds(
                address(this).balance,
                gasRefund
            );
        }
        (bool success, ) = msg.sender.call{value: gasRefund}("");
        emit GasRefundAttempted(
            msg.sender,
            gasRefund,
            gasUsed,
            tx.gasprice,
            success
        );
    }

    /// @notice Callback for VRF fulfiller.
    ///     See {IRandomiserCallback-receiveRandomWords}
    function receiveRandomWords(
        uint256 requestId,
        uint256[] calldata randomWords
    ) external {
        if (msg.sender != randomiser) {
            revert CallerNotRandomiser(msg.sender);
        }
        if (currentGame.state != GameState.DrawPending) {
            revert UnexpectedState(currentGame.state, GameState.DrawPending);
        }
        if (randomnessRequest.requestId != requestId) {
            revert RequestIdMismatch(requestId, randomnessRequest.requestId);
        }
        randomnessRequest = RandomnessRequest({requestId: 0, timestamp: 0});

        if (randomWords.length == 0) {
            revert InsufficientRandomWords();
        }

        // Pick winning numbers
        uint8[] memory balls = computeWinningBalls(randomWords[0]);
        uint248 gameId = currentGame.id;
        emit GameFinalised(gameId, balls);

        // Record winning pick bitset
        uint256 winningPickId = Pick.id(balls);
        gameData[gameId].winningPickId = winningPickId;

        _setupNextGame();
    }

    /// @dev Transition to next game, locking and/or rolling over any jackpots
    ///     as necessary.
    function _setupNextGame() internal {
        uint248 gameId = currentGame.id;

        // Ready for next game
        currentGame = CurrentGame({state: GameState.Purchase, id: gameId + 1});

        // Set up next game
        gameData[gameId + 1] = Game({
            ticketsSold: 0,
            startedAt: uint64(block.timestamp),
            winningPickId: 0
        });

        // Roll over jackpot if no winner
        uint256 winningPickId = gameData[gameId].winningPickId;
        uint256 numWinners = tokenByPickIdentity[gameId][winningPickId].length;
        uint256 currentUnclaimedPayouts = unclaimedPayouts;
        uint256 currentJackpot = jackpot;
        if (numWinners == 0 && !isGameActive()) {
            // No winners, but apocalypse mode
            uint256 nextJackpot = 0;
            uint256 nextUnclaimedPayouts = currentUnclaimedPayouts +
                currentJackpot;
            jackpot = 0;
            unclaimedPayouts = nextUnclaimedPayouts;
            emit JackpotRollover(
                gameId,
                currentUnclaimedPayouts,
                currentJackpot,
                nextUnclaimedPayouts,
                nextJackpot
            );
        } else if (numWinners == 0) {
            // No winners, current jackpot and unclaimed payouts are rolled
            // over to the next game
            uint256 nextJackpot = currentUnclaimedPayouts + currentJackpot;
            uint256 nextUnclaimedPayouts = 0;
            jackpot = nextJackpot;
            unclaimedPayouts = 0;
            emit JackpotRollover(
                gameId,
                currentUnclaimedPayouts,
                currentJackpot,
                nextUnclaimedPayouts,
                nextJackpot
            );
        } else {
            // Winners! Jackpot resets to zero for next game, and current
            // jackpot goes into unclaimed payouts
            uint256 nextUnclaimedPayouts = currentJackpot;
            unclaimedPayouts = nextUnclaimedPayouts;
            jackpot = 0;
            emit JackpotRollover(
                gameId,
                currentUnclaimedPayouts,
                currentJackpot,
                nextUnclaimedPayouts,
                0
            );
        }
    }

    /// @notice Claim a share of the jackpot with a winning ticket.
    /// @param tokenId Token id of the ticket (will be burnt)
    function claimWinnings(uint256 tokenId) external {
        // Only allow claims during purchase phase so we don't have to deal
        // with intermediate states between gameIds
        if (currentGame.state != GameState.Purchase) {
            revert UnexpectedState(currentGame.state, GameState.Purchase);
        }

        address whomst = _ownerOf(tokenId);
        if (whomst == address(0)) {
            revert ERC721NonexistentToken(tokenId);
        }
        // Burning the token is our "claim nullifier"
        _burn(tokenId);

        PurchasedTicket memory ticket = purchasedTickets[tokenId];
        uint256 currentGameId = currentGame.id;
        // Can only claim winnings from the last game
        if (ticket.gameId != currentGameId - 1) {
            revert ClaimWindowMissed(tokenId);
        }

        // Determine if the jackpot was won
        Game memory game = gameData[ticket.gameId];
        uint256 winningPickId = game.winningPickId;
        uint256 numWinners = tokenByPickIdentity[ticket.gameId][winningPickId]
            .length;
        uint256 numClaimedWinningTickets = claimedWinningTickets[ticket.gameId]
            .length;

        if (numWinners == 0 && !isGameActive()) {
            // No jackpot winners, and game is no longer active!
            // Jackpot is shared between all tickets
            // Invariant: `ticketsSold[gameId] > 0`
            uint256 prizeShare = unclaimedPayouts / game.ticketsSold;
            _transferOrBust(whomst, prizeShare);
            emit ConsolationClaimed(tokenId, ticket.gameId, whomst, prizeShare);
            return;
        }

        if (winningPickId == ticket.pickId) {
            // NB: `numWinners` != 0 in this path
            // This ticket did have the winning numbers
            uint256 prizeShare = unclaimedPayouts /
                (numWinners - numClaimedWinningTickets);
            // Decrease unclaimed payouts by the amount just claimed
            unclaimedPayouts -= prizeShare;
            // Record that this ticket has claimed its winnings
            claimedWinningTickets[ticket.gameId].push(tokenId);
            // Transfer share of jackpot to ticket holder
            _transferOrBust(whomst, prizeShare);

            emit WinningsClaimed(tokenId, ticket.gameId, whomst, prizeShare);
            return;
        }

        revert NoWin(ticket.pickId, winningPickId);
    }

    /// @notice Withdraw accrued community fees.
    function withdrawAccruedFees() external onlyOwner {
        uint256 totalAccrued = accruedCommunityFees;
        accruedCommunityFees = 0;
        _transferOrBust(msg.sender, totalAccrued);
    }

    /// @notice Allow owner to pick tickets for free.
    /// @param tickets Tickets!
    function ownerPick(Ticket[] calldata tickets) external onlyOwner {
        _pickTickets(tickets, 0);
    }

    /// @notice Set this game as the last game of the lottery.
    ///     aka invoke apocalypse mode.
    function kill() external onlyOwner {
        if (apocalypseGameId != 0) {
            // Already set
            revert GameInactive();
        }

        CurrentGame memory currentGame_ = currentGame;
        if (currentGame_.state != GameState.Purchase) {
            revert UnexpectedState(currentGame_.state, GameState.Purchase);
        }
        apocalypseGameId = currentGame_.id + 1;
    }

    /// @notice Withdraw any ETH (used for VRF requests).
    function rescueETH() external onlyOwner {
        (bool success, bytes memory data) = msg.sender.call{
            value: address(this).balance
        }("");
        if (!success) {
            revert TransferFailure(msg.sender, address(this).balance, data);
        }
    }

    /// @notice Allow owner to rescue any tokens sent to the contract;
    ///     excluding jackpot and accrued fees.
    /// @param tokenAddress Address of token to withdraw
    function rescueTokens(address tokenAddress) external onlyOwner {
        uint256 amount = IERC20(tokenAddress).balanceOf(address(this));
        if (tokenAddress == prizeToken) {
            // TODO: This no longer works if we don't limit claiming jackpot
            // to last game only
            // 1. Limit claiming jackpot to last game only and rollover
            //  jackpot from 2 games ago if unclaimed (during finalisation)
            // 2. Count total locked as jackpot (+20k gas every ticket)
            amount = amount - accruedCommunityFees - unclaimedPayouts - jackpot;
        }

        IERC20(tokenAddress).safeTransfer(msg.sender, amount);
    }

    /// @notice Helper to transfer the `prizeToken`.
    /// @param to Address to transfer to
    /// @param value Value (in wei) to transfer
    function _transferOrBust(address to, uint256 value) internal {
        IERC20(prizeToken).safeTransfer(to, value);
    }

    /// @notice Pick tickets and increase jackpot
    /// @param tickets Tickets!
    /// @param jackpotShare Amount of jackpot fees generated from purchase.
    function _pickTickets(
        Ticket[] calldata tickets,
        uint256 jackpotShare
    ) internal {
        CurrentGame memory currentGame_ = currentGame;
        uint256 currentGameId = currentGame_.id;
        // Assert game is still playable
        _assertGameIsActive();

        uint256 ticketsCount = tickets.length;
        Game memory game = gameData[currentGameId];
        jackpot += jackpotShare;
        gameData[currentGameId] = Game({
            ticketsSold: game.ticketsSold + uint64(ticketsCount),
            startedAt: game.startedAt,
            winningPickId: game.winningPickId
        });

        uint256 numPicks_ = numPicks;
        uint256 maxBallValue_ = maxBallValue;
        uint256 startingTokenId = currentTokenId + 1;
        currentTokenId += ticketsCount;
        for (uint256 t; t < ticketsCount; ++t) {
            address whomst = tickets[t].whomst;
            uint8[] memory picks = tickets[t].picks;

            if (picks.length != numPicks_) {
                revert InvalidNumPicks(picks.length);
            }

            // Assert picks are ascendingly sorted, with no possibility of duplicates
            uint8 lastPick;
            for (uint256 i; i < numPicks_; ++i) {
                uint8 pick = picks[i];
                if (pick <= lastPick) revert UnsortedPicks(picks);
                if (pick > maxBallValue_) revert InvalidBallValue(pick);
                lastPick = pick;
            }

            // Record picked numbers
            uint256 tokenId = startingTokenId + t;
            uint256 pickId = Pick.id(picks);
            purchasedTickets[tokenId] = PurchasedTicket({
                gameId: currentGameId,
                pickId: pickId
            });

            // Account for this pick set
            tokenByPickIdentity[currentGameId][pickId].push(tokenId);
            emit TicketPurchased(currentGameId, whomst, tokenId, picks);
        }
        // Effects
        for (uint256 t; t < ticketsCount; ++t) {
            address whomst = tickets[t].whomst;
            _safeMint(whomst, startingTokenId + t);
        }
    }

    /// @dev The contract should be able to receive Ether to pay for VRF.
    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    /// @notice Set the SVG renderer for tickets (privileged)
    /// @param renderer Address of renderer contract
    function _setTicketSVGRenderer(address renderer) internal {
        if (
            renderer == address(0) ||
            !ITicketSVGRenderer(renderer).supportsInterface(
                type(ITicketSVGRenderer).interfaceId
            )
        ) {
            revert InvalidTicketSVGRenderer(renderer);
        }
        ticketSVGRenderer = renderer;
    }

    /// @notice Set the SVG renderer for tickets
    /// @param renderer Address of renderer contract
    function setTicketSVGRenderer(address renderer) external onlyOwner {
        _setTicketSVGRenderer(renderer);
    }

    /// @notice See {ERC721-tokenURI}
    function tokenURI(
        uint256 tokenId
    ) public view override returns (string memory) {
        _requireOwned(tokenId);
        return
            ITicketSVGRenderer(ticketSVGRenderer).renderTokenURI(
                name(),
                tokenId,
                maxBallValue,
                Pick.parse(numPicks, purchasedTickets[tokenId].pickId)
            );
    }
}

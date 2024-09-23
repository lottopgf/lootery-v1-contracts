# Lootery

A protocol for launching number lotteries to fund public goods. Part of the [LottoPGF](https://lottopgf.org) project.

## Overview

Lootery is a number lottery contract where players can pick a configurable set of numbers/balls per ticket, similar to IRL lottos such as Powerball or EuroMillions. At the end of every round, a keeper may call the `draw` function to determine the winning set of numbers for that round. Then a new round is immediately started.

Any player with a winning ticket (i.e. their ticket's set of numbers is set-equal to the winning set of numbers) has the next round to claim their winnings. Otherwise, the winnings are rolled back into the jackpot.

The lottery will run forever until the owner invokes _apocalypse mode_, which invokes a special rule for the current round: if no player wins the jackpot, then every ticket buyer from the current round may claim an equal share of the jackpot.

Players may permissionlessly buy tickets through the `purchase` function, paying a ticket price (in the form of `prizeToken`), where the proceeds are split into the jackpot and the community fee (this is configurable only at initialisation). Alternatively, the owner of the lottery contract may also distribute free tickets via the `ownerPick` function.

While the jackpot builds up over time, it is possible (and desirable)to seed the jackpot at any time using the `seedJackpot` function.

## Testing

To run hardhat tests:

1. Install deps with `yarn`.
1. Run tests with `yarn test`.

Additionally, there is a fuzzing suite written for Echidna. To run:

1. Ensure [Echidna](https://github.com/crytic/echidna) is installed.
1. Start a fuzzing run with `yarn fuzz`. You may have to run this multiple times to get complete coverage. The coverage report can be found under `corpus/covered.*.html`.

If in doubt about the versions of tooling used, please refer to the CI configs under `.github/workflows`.

## Deploying

1. Export the desired deployer private key to environment variable `MAINNET_PK`
1. To deploy to a new network, ensure there exists a separate hardhat config file `hardhat.config.${network}.ts`.
    1. Ensure that the `network` and `etherscan` configurations are populated as needed.
    1. For existing configurations, ensure that you have the necessary environment variables set (RPC URLs, Etherscan API keys, etc)
1. Deploy with `yarn hardhat --config hardhat.config.${network}.ts --network ${network} run scripts/deploy.ts`

## Operation

### Launch a new lottery

To launch a new lottery, use the [`LotteryFactory#create`](./contracts/LooteryFactory.sol#150) function. This function will emit a `LooteryLaunched` event, which contains the _proxy address_ (which is the one you should use; not the implementation address) of the newly-deployed lottery contract.

### Seed the jackpot

To seed the jackpot, use the [`Lottery#seedJackpot`](./contracts/Lootery.sol#263) function. Note that this function is rate-limited by the `seedJackpotDelay` parameter to prevent potential denial-of-service attacks.

### Purchase tickets

To purchase tickets, call the [`Lottery#purchase`](./contracts/Lootery.sol#353) function. This function will attempt to transfer the required ticket fee of `prizeToken` from the caller into the contract, so the caller must have approved the required token allowance amount to the contract before calling.

If the `prizeToken` is WETH, then it's also possible to use the `LooteryETHAdapter` contract to purchase tickets without needing prior allowance.

### Lottery draw!

To draw the winning numbers, call the [`Lottery#draw`](./contracts/Lootery.sol#415) function. This function will request randomness from the VRF coordinator. The game will stay in the `DrawPending` state until the VRF callback (`#receiveRandomWords`) is triggered, which finally ends the round and picks the winning numbers.

To pick the winning numbers efficiently, the contract uses an optimised Feistel shuffle with the delivered VRF output as the seed.

In practice, this process should be automated by a keeper. The `draw` function is payable and requires a payment. Query `Lootery#getRequestPrice` to get the instantaneous price of a VRF request (making sure to set the gas price in the call if calling from offchain). There will be gas fluctuation in reality, so use 2x the returned request price when calling `draw`. Any excess payment will be refunded to the caller so don't worry about overpaying.

#### Troubleshooting: VRF request not fulfilled

If the VRF request fails to be fulfilled for any reason after 1 hour, it's possible to force a re-request by calling the [`Lottery#forceRedraw`](./contracts/Lootery.sol#431) function. This function will request new randomness from the VRF coordinator.

### Query the winning numbers

The winning numbers can be retrieved by querying the `gameData[gameId].winningPickId` mapping (see below to understand what a pick identity is). To find the current `gameId`, query the `currentGame.id` variable. To find which `gameId` a ticket belongs to, query the `purchasedTickets[tokenId].gameId` mapping.

### Pick identities

Each ticket has a set of numbers called a pick. A pick must be an ordered array of numbers with no duplicates. The maximum value any number in the array can have is determined by the `maxBallValue` parameter.

For efficiency, each pick is stored internally as a `uint256` where each number in the pick is represented by a bit in the integer. This is called a pick identity. The [`Pick`](./contracts/lib/Pick.sol) library contains the code to convert between a pick identity and a pick array.

### Claim winnings

To claim winnings, the player must call the [`Lottery#claimWinnings`](./contracts/Lootery.sol#609) function. This function will burn the ticket and transfer the winnings from the contact to the player, if the ticket pick matches the winning pick. If in _apocalypse mode_, and no ticket has the winning pick, then every ticket may claim an equal share of the jackpot.

While anyone can call the `claimWinnings` function on behalf of anyone's ticket, the winnings will always be sent to the current owner of the ticket.

⚠️ It is only possible to claim winnings from the last round. Once the claim window is missed, the winnings are rolled back into the jackpot for the next round.

### Privileged operations

While the lottery is designed to be maximally unruggable by the operator, there are some privileged operations reserved for the owner (by default, this is the account that deployed the lottery). It is recommended that the owner be a timelock, governor, or at least a multisig.

List of privileged operations:

-   `#setCallbackGasLimit` - Set the gas limit that the VRF should use when calling the `Lootery#receiveRandomWords` function. This should not need to be increased unless configured with a very large `pickLength`.
-   `#setBeneficiary` - Set/unset beneficiary addresses that players may optionally direct the community fee share to when purchasing tickets.
-   `#ownerPick` - Give out tickets for free!
-   `#withdrawAccruedFees` - Withdraw accrued fees (to the owner).
-   `#kill` - Trigger apocalypse mode, so that the current round becomes the last round, after which the game becomes no longer playable.
-   `#rescueETH` - Rescue ETH accidentally sent to the contract.
-   `#rescueTokens` - Rescue any ERC20 tokens accidentally sent to the contract.
-   `#setTicketSVGRenderer` - Set the contract that renders ticket SVGs.

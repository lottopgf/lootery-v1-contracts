import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import {
    Lootery,
    Lootery__factory,
    LooteryHarness__factory,
    MockRandomiser__factory,
    TestERC20,
    TicketSVGRenderer__factory,
} from '../../typechain-types'
import { deployProxy } from './deployProxy'
import { encrypt } from '@kevincharm/gfc-fpe'
import { time, setBalance } from '@nomicfoundation/hardhat-network-helpers'
import {
    parseEther,
    hexlify,
    ethers,
    ZeroAddress,
    LogDescription,
    BigNumberish,
    TransactionResponse,
} from 'ethers'
import crypto from 'node:crypto'

export function computePick(pickId: bigint): bigint[] {
    if (pickId & 1n) throw new Error('0 is not a valid ball value')
    const pick: bigint[] = []
    for (let i = 1n; i < 256n; i++) {
        if ((pickId >> i) & 1n) {
            pick.push(i)
        }
    }
    return pick
}

export function computePickId(picks: bigint[]) {
    return picks.reduce((id, pick) => id | (1n << pick), 0n)
}

export async function deployLotto({
    deployer,
    gamePeriod,
    prizeToken,
    numPicks,
    maxBallValue,
    seedJackpotDelay,
    shouldSkipSeedJackpot,
    seedJackpotMinValue,
}: {
    deployer: SignerWithAddress
    /** seconds */
    gamePeriod: bigint
    prizeToken: TestERC20
    numPicks?: bigint
    maxBallValue?: bigint
    /** seconds */
    seedJackpotDelay?: bigint
    shouldSkipSeedJackpot?: boolean
    seedJackpotMinValue?: bigint
}) {
    const mockRandomiser = await new MockRandomiser__factory(deployer).deploy()
    const ticketSVGRenderer = await new TicketSVGRenderer__factory(deployer).deploy()
    const lotto = await deployProxy({
        deployer,
        implementation: LooteryHarness__factory,
        initData: LooteryHarness__factory.createInterface().encodeFunctionData('init', [
            {
                owner: deployer.address,
                name: 'Lotto',
                symbol: 'LOTTO',
                numPicks: numPicks || 5,
                maxBallValue: maxBallValue || 69,
                gamePeriod,
                ticketPrice: parseEther('0.1'),
                communityFeeBps: 5000, // 50%
                randomiser: await mockRandomiser.getAddress(),
                prizeToken: await prizeToken.getAddress(),
                seedJackpotDelay:
                    typeof seedJackpotDelay === 'undefined'
                        ? 3600
                        : seedJackpotDelay /** default to 1h */,
                seedJackpotMinValue:
                    typeof seedJackpotMinValue === 'undefined'
                        ? parseEther('1')
                        : seedJackpotMinValue,
                ticketSVGRenderer: await ticketSVGRenderer.getAddress(),
            },
        ]),
    })

    if (!shouldSkipSeedJackpot) {
        // Seed initial jackpot with 10 ETH
        await prizeToken.mint(deployer, parseEther('10'))
        await prizeToken.approve(lotto, parseEther('10'))
        await lotto.seedJackpot(parseEther('10'))
    }

    const fastForwardAndDraw = async (randomness: bigint) => {
        // Draw
        await time.increase(gamePeriod)
        await setBalance(await lotto.getAddress(), parseEther('0.1'))
        await lotto.draw()
        const { requestId } = await lotto.randomnessRequest()

        // Fulfill w/ mock randomiser
        const fulfilmentTx = await mockRandomiser
            .fulfillRandomWords(requestId, [randomness])
            .then((tx) => tx.wait(1))
        const [, emittedBalls] = lotto.interface.decodeEventLog(
            'GameFinalised',
            fulfilmentTx?.logs?.[0].data!,
            fulfilmentTx?.logs?.[0].topics,
        ) as unknown as [bigint, bigint[]]
        return emittedBalls
    }

    return {
        lotto,
        mockRandomiser,
        fastForwardAndDraw,
        prizeToken,
    }
}

const roundFn = (R: bigint, i: bigint, seed: bigint, domain: bigint) => {
    return BigInt(
        ethers.solidityPackedKeccak256(
            ['uint256', 'uint256', 'uint256', 'uint256'],
            [R, i, seed, domain],
        ),
    )
}

export function shuffle(i: bigint, domain: bigint, seed: bigint, rounds: bigint) {
    return encrypt(i, domain, seed, rounds, roundFn)
}

export function slikpik(numPicks: bigint, domain: bigint) {
    const seed = BigInt(hexlify(crypto.getRandomValues(new Uint8Array(32))))

    const picks: bigint[] = []
    for (let i = 0; i < numPicks; i++) {
        const pick = 1n + shuffle(BigInt(i), domain, seed, 12n)
        picks.push(pick)
    }
    picks.sort((a, b) => Number(a - b))
    return picks
}

/**
 * Purchase a slikpik ticket. Lotto must be connected to an account
 * with enough funds to buy a ticket.
 * @param connectedLotto Lottery contract
 * @param whomst Who to mint the ticket to
 */
export async function buySlikpik(connectedLotto: Lootery, whomst: string, beneficiary?: string) {
    const numPicks = await connectedLotto.numPicks()
    const domain = await connectedLotto.maxBallValue()
    // Generate shuffled pick
    const picks = slikpik(numPicks, domain)
    const tx = await connectedLotto
        .purchase(
            [
                {
                    whomst,
                    picks,
                },
            ],
            beneficiary || ZeroAddress,
        )
        .then((tx) => tx.wait())
    const parsedLogs = tx!.logs
        .map((log) =>
            connectedLotto.interface.parseLog({ topics: log.topics as string[], data: log.data }),
        )
        .filter((value): value is LogDescription => !!value)
    const ticketPurchasedEvent = parsedLogs.find((log) => log.name === 'TicketPurchased')
    const [, , tokenId] = ticketPurchasedEvent!.args
    return {
        tokenId,
    }
}

/**
 * Purchase a ticket. Lotto must be connected to an account
 * with enough funds to buy a ticket.
 * @param connectedLotto Lottery contract
 * @param whomst Who to mint the ticket to
 * @param picks Picks
 */
export async function purchaseTicket(
    connectedLotto: Lootery,
    whomst: string,
    picks: BigNumberish[],
    beneficiary?: string,
) {
    const numPicks = await connectedLotto.numPicks()
    if (picks.length !== Number(numPicks)) {
        throw new Error(`Invalid number of picks (expected ${numPicks}, got picks.length)`)
    }
    // const ticketPrice = await connectedLotto.ticketPrice()
    const tx = await connectedLotto
        .purchase(
            [
                {
                    whomst,
                    picks,
                },
            ],
            beneficiary || ZeroAddress,
        )
        .then((tx) => tx.wait())
    const lottoAddress = await connectedLotto.getAddress()
    const parsedLogs = tx!.logs
        .filter((log) => log.address === lottoAddress)
        .map((log) =>
            connectedLotto.interface.parseLog({ topics: log.topics as string[], data: log.data }),
        )
        .filter((value): value is LogDescription => !!value)
    const ticketPurchasedEvent = parsedLogs.find((log) => log.name === 'TicketPurchased')
    const [, , tokenId] = ticketPurchasedEvent!.args as unknown as [any, any, bigint]
    return {
        tokenId,
    }
}

export async function getLottoEvent<TArgs>({
    eventName,
    tx,
}: {
    eventName: string
    tx?: TransactionResponse
}) {
    const receipt = await tx?.wait()
    if (!receipt) throw new Error('Nonexistent tx/receipt')

    const iface = Lootery__factory.createInterface()
    return receipt.logs
        .map((log) => iface.parseLog(log))
        .filter((log): log is LogDescription => Boolean(log))
        .find((log) => log.name === eventName) as
        | (LogDescription & {
              args: TArgs
          })
        | undefined
}

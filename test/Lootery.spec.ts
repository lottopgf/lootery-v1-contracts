import { ethers } from 'hardhat'
import {
    loadFixture,
    time,
    setBalance,
    impersonateAccount,
} from '@nomicfoundation/hardhat-network-helpers'
import {
    Lootery,
    LooteryFactory,
    LooteryFactory__factory,
    Lootery__factory,
    MockRandomiser,
    MockRandomiser__factory,
    TestERC20__factory,
    type TestERC20,
    WETH9__factory,
    LooteryETHAdapter__factory,
    TicketSVGRenderer__factory,
    TicketSVGRenderer,
} from '../typechain-types'
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import {
    BigNumberish,
    LogDescription,
    Wallet,
    ZeroAddress,
    formatEther,
    hexlify,
    parseEther,
} from 'ethers'
import { expect } from 'chai'
import { deployProxy } from './helpers/deployProxy'
import { encrypt } from '@kevincharm/gfc-fpe'
import crypto from 'node:crypto'
import { GameState } from './helpers/GameState'

describe('Lootery', () => {
    let mockRandomiser: MockRandomiser
    let testERC20: TestERC20
    let factory: LooteryFactory
    let deployer: SignerWithAddress
    let bob: SignerWithAddress
    let alice: SignerWithAddress
    let beneficiary: SignerWithAddress
    let ticketSVGRenderer: TicketSVGRenderer
    beforeEach(async () => {
        ;[deployer, bob, alice, beneficiary] = await ethers.getSigners()
        mockRandomiser = await new MockRandomiser__factory(deployer).deploy()
        testERC20 = await new TestERC20__factory(deployer).deploy(deployer)
        const looteryImpl = await new Lootery__factory(deployer).deploy()
        ticketSVGRenderer = await new TicketSVGRenderer__factory(deployer).deploy()
        factory = await deployProxy({
            deployer,
            implementation: LooteryFactory__factory,
            initData: LooteryFactory__factory.createInterface().encodeFunctionData('init', [
                await looteryImpl.getAddress(),
                await mockRandomiser.getAddress(),
                await ticketSVGRenderer.getAddress(),
            ]),
        })
    })

    /**
     * Helper to create lotteries using the factory
     * @param args Lootery init args
     * @returns Lootery instance
     */
    async function createLotto(...args: Parameters<LooteryFactory['create']>) {
        const lottoAddress = await factory.computeNextAddress()
        await factory.create(...args)
        return Lootery__factory.connect(lottoAddress, deployer)
    }

    it('runs happy path', async () => {
        // Launch a lottery
        const gamePeriod = BigInt(1 * 60 * 60) // 1h
        const lotto = await createLotto(
            'Lotto',
            'LOTTO',
            5,
            69,
            gamePeriod,
            parseEther('0.1'),
            5000, // 50%,
            testERC20,
            3600, // 1 hour
            parseEther('1'),
        )

        // Allow seeding jackpot
        await testERC20.mint(deployer, parseEther('10'))
        await testERC20.approve(lotto, parseEther('10'))
        await lotto.seedJackpot(parseEther('10'))
        expect(await testERC20.balanceOf(lotto)).to.eq(parseEther('10'))

        // Bob purchases a losing ticket for 0.1
        await testERC20.mint(bob, parseEther('0.1'))
        await testERC20.connect(bob).approve(lotto, parseEther('0.1'))

        const losingTicket = [3n, 11n, 22n, 29n, 42n]
        await lotto.connect(bob).purchase(
            [
                {
                    whomst: bob.address,
                    picks: losingTicket,
                },
            ],
            ZeroAddress,
        )
        // Bob receives NFT ticket
        expect(await lotto.balanceOf(bob.address)).to.eq(1)
        expect(await lotto.ownerOf(1)).to.eq(bob.address)

        // Draw
        await time.increase(gamePeriod)
        await setBalance(await lotto.getAddress(), parseEther('0.1'))
        await lotto.draw()
        let { requestId } = await lotto.randomnessRequest()
        expect(requestId).to.not.eq(0n)

        // Fulfill w/ mock randomiser (no winners)
        let fulfilmentTx = await mockRandomiser
            .fulfillRandomWords(requestId, [6942069421])
            .then((tx) => tx.wait(1))
        let [emittedGameId, emittedBalls] = lotto.interface.decodeEventLog(
            'GameFinalised',
            fulfilmentTx?.logs?.[0].data!,
            fulfilmentTx?.logs?.[0].topics,
        ) as unknown as [bigint, bigint[]]
        expect(emittedGameId).to.eq(0)
        expect(emittedBalls).to.deep.eq([12n, 13n, 25n, 51n, 65n])
        expect(await lotto.gameData(emittedGameId).then((game) => game.winningPickId)).to.eq(
            computePickId(emittedBalls),
        )

        // Check that jackpot rolled over to next game
        expect(await lotto.currentGame().then((game) => game.id)).to.eq(1)
        expect(await lotto.jackpot()).to.eq(parseEther('10.05'))

        // Bob purchases a winning ticket for 0.1
        await testERC20.mint(bob, parseEther('0.1'))
        await testERC20.connect(bob).approve(lotto, parseEther('0.1'))

        const winningTicket = [31n, 35n, 37n, 56n, 61n]
        await lotto.connect(bob).purchase(
            [
                {
                    whomst: bob.address,
                    picks: winningTicket,
                },
            ],
            ZeroAddress,
        )
        // Bob receives NFT ticket
        expect(await lotto.balanceOf(bob.address)).to.eq(2)
        expect(await lotto.ownerOf(2)).to.eq(bob.address)

        // Draw again
        await time.increase(gamePeriod)
        await setBalance(await lotto.getAddress(), parseEther('0.1'))
        await lotto.draw()
        ;({ requestId } = await lotto.randomnessRequest())
        expect(requestId).to.not.eq(0n)

        // Fulfill w/ mock randomiser (Bob wins)
        fulfilmentTx = await mockRandomiser
            .fulfillRandomWords(requestId, [6942069420])
            .then((tx) => tx.wait(1))
        ;[emittedGameId, emittedBalls] = lotto.interface.decodeEventLog(
            'GameFinalised',
            fulfilmentTx?.logs?.[0].data!,
            fulfilmentTx?.logs?.[0].topics,
        ) as unknown as [bigint, bigint[]]
        expect(emittedGameId).to.eq(1)
        expect(emittedBalls).to.deep.eq(winningTicket)
        expect(await lotto.gameData(emittedGameId).then((game) => game.winningPickId)).to.eq(
            computePickId(emittedBalls),
        )

        // Bob claims entire pot
        const jackpot = await lotto.unclaimedPayouts()
        expect(jackpot).to.eq(parseEther('10.1'))
        const balanceBefore = await testERC20.balanceOf(bob.address)
        await expect(lotto.claimWinnings(2))
            .to.emit(lotto, 'WinningsClaimed')
            .withArgs(2, 1, bob.address, jackpot)
        expect(await testERC20.balanceOf(bob.address)).to.eq(balanceBefore + jackpot)
        await expect(lotto.ownerOf(2)).to.be.revertedWithCustomError(
            lotto,
            'ERC721NonexistentToken',
        )

        // Withdraw accrued fees
        const accruedFees = await lotto.accruedCommunityFees()
        expect(accruedFees).to.eq(parseEther('0.1'))
        await expect(lotto.withdrawAccruedFees()).to.emit(testERC20, 'Transfer')
        expect(await lotto.accruedCommunityFees()).to.eq(0)
    })

    it('distributes winnings evenly', async () => {
        // Launch a lottery
        const gamePeriod = BigInt(1 * 60 * 60) // 1h
        const lotto = await createLotto(
            'Lotto',
            'LOTTO',
            5,
            69,
            gamePeriod,
            parseEther('0.1'),
            5000, // 50%,
            testERC20,
            3600, // 1 hour
            parseEther('1'),
        )

        // Allow seeding jackpot
        await testERC20.mint(deployer, parseEther('10'))
        await testERC20.approve(lotto, parseEther('10'))
        await lotto.seedJackpot(parseEther('10'))
        expect(await testERC20.balanceOf(lotto)).to.eq(parseEther('10'))

        // Bob and Alice purchase a winning ticket for 0.1
        await testERC20.mint(bob, parseEther('0.1'))
        await testERC20.connect(bob).approve(lotto, parseEther('0.1'))
        await testERC20.mint(alice, parseEther('0.1'))
        await testERC20.connect(alice).approve(lotto, parseEther('0.1'))

        const winningTicket = [31n, 35n, 37n, 56n, 61n]
        await lotto.connect(bob).purchase(
            [
                {
                    whomst: bob.address,
                    picks: winningTicket,
                },
            ],
            ZeroAddress,
        )
        await lotto.connect(alice).purchase(
            [
                {
                    whomst: alice.address,
                    picks: winningTicket,
                },
            ],
            ZeroAddress,
        )
        // Bob receives NFT ticket
        expect(await lotto.balanceOf(bob.address)).to.eq(1)
        expect(await lotto.ownerOf(1)).to.eq(bob.address)

        // Draw
        await time.increase(gamePeriod)
        await setBalance(await lotto.getAddress(), parseEther('0.1'))
        await lotto.draw()
        let { requestId } = await lotto.randomnessRequest()
        expect(requestId).to.not.eq(0n)

        // Fulfill w/ mock randomiser (Bob wins)
        const fulfilmentTx = await mockRandomiser
            .fulfillRandomWords(requestId, [6942069420])
            .then((tx) => tx.wait(1))
        const [emittedGameId, emittedBalls] = lotto.interface.decodeEventLog(
            'GameFinalised',
            fulfilmentTx?.logs?.[0].data!,
            fulfilmentTx?.logs?.[0].topics,
        ) as unknown as [bigint, bigint[]]
        expect(emittedGameId).to.eq(0n)
        expect(emittedBalls).to.deep.eq(winningTicket)
        expect(await lotto.gameData(emittedGameId).then((game) => game.winningPickId)).to.eq(
            computePickId(emittedBalls),
        )

        // Bob & Alice each claim half of the pot
        const jackpot = await lotto.unclaimedPayouts()
        expect(jackpot).to.eq(parseEther('10.1'))
        const jackpotShare = jackpot / 2n
        {
            // Bob
            const balanceBefore = await testERC20.balanceOf(bob.address)
            await expect(lotto.claimWinnings(1))
                .to.emit(lotto, 'WinningsClaimed')
                .withArgs(1, 0, bob.address, jackpotShare)
            expect(await testERC20.balanceOf(bob.address)).to.eq(balanceBefore + jackpotShare)
            await expect(lotto.ownerOf(1)).to.be.revertedWithCustomError(
                lotto,
                'ERC721NonexistentToken',
            )
        }
        {
            // Alice
            const balanceBefore = await testERC20.balanceOf(alice.address)
            await expect(lotto.claimWinnings(2))
                .to.emit(lotto, 'WinningsClaimed')
                .withArgs(2, 0, alice.address, jackpotShare)
            expect(await testERC20.balanceOf(alice.address)).to.eq(balanceBefore + jackpotShare)
            await expect(lotto.ownerOf(2)).to.be.revertedWithCustomError(
                lotto,
                'ERC721NonexistentToken',
            )
        }
    })

    it('should transfer community fee to beneficiary', async () => {
        const gamePeriod = BigInt(1 * 60 * 60) // 1h
        const ticketPrice = parseEther('0.1')
        const lotto = await createLotto(
            'Lotto',
            'LOTTO',
            5,
            69,
            gamePeriod,
            ticketPrice,
            5000, // 50%,
            testERC20,
            3600, // 1 hour
            parseEther('1'),
        )
        const beneficiaryBalanceBefore = await testERC20.balanceOf(beneficiary.address)
        await testERC20.mint(deployer.address, parseEther('10'))
        await testERC20.approve(await lotto.getAddress(), parseEther('10'))
        await purchaseTicket(lotto, deployer.address, [1, 2, 3, 4, 5], beneficiary.address)
        expect(await testERC20.balanceOf(beneficiary.address)).to.eq(
            beneficiaryBalanceBefore + ticketPrice / 2n,
        )

        // Don't transfer to beneficiary if no beneficiary is set
        await purchaseTicket(lotto, deployer.address, [1, 2, 3, 4, 5])
        expect(await testERC20.balanceOf(beneficiary.address)).to.eq(
            beneficiaryBalanceBefore + ticketPrice / 2n,
        )
    })

    it('should rollover jackpot to next round if noone has won', async () => {
        const gamePeriod = 1n * 60n * 60n
        async function deploy() {
            return deployLotto({
                deployer,
                gamePeriod,
                prizeToken: testERC20,
            })
        }
        const { lotto, fastForwardAndDraw } = await loadFixture(deploy)

        await testERC20.mint(deployer, parseEther('10'))
        await testERC20.approve(lotto, parseEther('10'))

        const winningTicket = [31n, 35n, 37n, 56n, 61n]

        const { tokenId: bobTokenId } = await purchaseTicket(lotto, bob.address, winningTicket)
        const { tokenId: aliceTokenId } = await purchaseTicket(lotto, alice.address, winningTicket)
        expect(await lotto.jackpot()).to.eq(parseEther('10.1'))

        const seed = 6942069420n
        await fastForwardAndDraw(seed)
        expect(await lotto.computeWinningBalls(seed)).to.deep.eq(winningTicket)

        // Current jackpot + 2 tickets
        expect(await lotto.unclaimedPayouts()).to.be.eq(parseEther('10.1'))
        expect(await lotto.jackpot()).to.eq(0)

        // Alice claims prize
        await lotto.claimWinnings(aliceTokenId)

        // Unclaimed payouts is reduced
        expect(await lotto.unclaimedPayouts()).to.be.eq(parseEther('5.05'))
        expect(await lotto.jackpot()).to.eq(0)

        // Balance is half of jackpot + 2 tickets
        expect(await testERC20.balanceOf(lotto)).to.be.eq(parseEther('5.15'))

        // Advance 1 round (skip draw)
        await time.increase(gamePeriod)
        await lotto.draw()

        // Unclaimed payouts rolled over to jackpot
        expect(await lotto.unclaimedPayouts()).to.be.eq(0)
        expect(await lotto.jackpot()).to.eq(parseEther('5.05'))

        // Bob can't claim anymore
        await expect(lotto.claimWinnings(bobTokenId)).to.be.revertedWithCustomError(
            lotto,
            'ClaimWindowMissed',
        )
    })

    it('should run games continuously, as long as gamePeriod has elapsed', async () => {
        const gamePeriod = 1n * 60n * 60n
        async function deploy() {
            return deployLotto({
                deployer,
                gamePeriod,
                prizeToken: testERC20,
            })
        }
        const { lotto, fastForwardAndDraw } = await loadFixture(deploy)

        // Buy some tickets
        await testERC20.mint(deployer, parseEther('10'))
        await testERC20.approve(lotto, parseEther('10'))

        await purchaseTicket(lotto, bob.address, [1, 2, 3, 4, 5])

        const initialGameId = await lotto.currentGame().then((game) => game.id)
        await fastForwardAndDraw(6942069320n)
        await expect(lotto.draw()).to.be.revertedWithCustomError(lotto, 'WaitLonger')
        for (let i = 0; i < 10; i++) {
            const gameId = await lotto.currentGame().then((game) => game.id)
            expect(gameId).to.eq(initialGameId + BigInt(i) + 1n)
            await time.increase(gamePeriod)
            await expect(lotto.draw()).to.emit(lotto, 'DrawSkipped').withArgs(gameId)
        }
    })

    it('should let owner pick tickets for free', async () => {
        const gamePeriod = 1n * 60n * 60n
        async function deploy() {
            return deployLotto({
                deployer,
                gamePeriod,
                prizeToken: testERC20,
            })
        }
        const { lotto } = await loadFixture(deploy)

        const whomst = bob.address
        const picks = [1, 2, 3, 4, 5]

        await expect(
            lotto.ownerPick([
                {
                    whomst,
                    picks,
                },
            ]),
        )
            .to.emit(lotto, 'TicketPurchased')
            .withArgs(0, whomst, 1, picks)
    })

    it('should let owner rescue tokens', async () => {
        const gamePeriod = 1n * 60n * 60n
        async function deploy() {
            return deployLotto({
                deployer,
                gamePeriod,
                prizeToken: testERC20,
            })
        }
        const { lotto } = await loadFixture(deploy)

        const lottoAddress = await lotto.getAddress()

        await testERC20.mint(deployer, parseEther('10'))
        await testERC20.approve(lotto, parseEther('10'))

        await purchaseTicket(lotto, bob.address, [1, 2, 3, 4, 5])

        await testERC20.mint(lotto, parseEther('10'))

        // Jackpot + 1 ticket + 10 extra tokens
        expect(await testERC20.balanceOf(lotto)).to.eq(parseEther('20.1'))

        expect(await lotto.rescueTokens(await testERC20.getAddress()))
            .to.emit(testERC20, 'Transfer')
            .withArgs(lottoAddress, deployer.address, parseEther('10'))
    })

    it('should let owner rescue eth', async () => {
        const gamePeriod = 1n * 60n * 60n
        async function deploy() {
            return deployLotto({
                deployer,
                gamePeriod,
                prizeToken: testERC20,
            })
        }
        const { lotto } = await loadFixture(deploy)

        await deployer.sendTransaction({
            to: lotto,
            value: parseEther('10'),
        })

        await expect(lotto.rescueETH()).to.changeEtherBalances(
            [lotto, deployer],
            [parseEther('-10'), parseEther('10')],
        )
    })

    it('should skip VRF request if nobody bought tickets', async () => {
        const gamePeriod = 1n * 60n * 60n
        async function deploy() {
            return deployLotto({
                deployer,
                gamePeriod,
                prizeToken: testERC20,
            })
        }
        const { lotto, mockRandomiser } = await loadFixture(deploy)

        // Draw
        await time.increase(gamePeriod)
        await setBalance(await lotto.getAddress(), parseEther('0.1'))
        await expect(lotto.draw()).to.emit(lotto, 'DrawSkipped')
        const { requestId } = await lotto.randomnessRequest()
        expect(requestId).to.eq(0)

        const mockRandomiserAddress = await mockRandomiser.getAddress()
        await impersonateAccount(mockRandomiserAddress)
        await setBalance(mockRandomiserAddress, parseEther('10'))
        const impersonatedRandomiser = await ethers.getSigner(mockRandomiserAddress)
        await expect(
            lotto.connect(impersonatedRandomiser).receiveRandomWords(requestId, [6942069421]),
        ).to.be.revertedWithCustomError(lotto, 'UnexpectedState')
    })

    it('should rate-limit seeding jackpots', async () => {
        async function deploy() {
            return deployLotto({
                deployer,
                gamePeriod: 86400n,
                prizeToken: testERC20,
                seedJackpotDelay: 3600n /** 1h */,
                shouldSkipSeedJackpot: true,
            })
        }
        const { lotto } = await loadFixture(deploy)

        await testERC20.mint(deployer.address, parseEther('10000'))
        await testERC20.approve(await lotto.getAddress(), (1n << 256n) - 1n)
        await lotto.seedJackpot(parseEther('100'))
        expect(await testERC20.balanceOf(await lotto.getAddress())).to.eq(parseEther('100'))
        await expect(lotto.seedJackpot(parseEther('100'))).to.be.revertedWithCustomError(
            lotto,
            'RateLimited',
        )
        // Wait 1h
        await time.increase(3600)
        await lotto.seedJackpot(parseEther('100'))
        expect(await testERC20.balanceOf(await lotto.getAddress())).to.eq(parseEther('200'))
    })

    it('should enforce minimum seed jackpot value', async () => {
        async function deploy() {
            return deployLotto({
                deployer,
                gamePeriod: 86400n,
                prizeToken: testERC20,
                seedJackpotDelay: 3600n /** 1h */,
                shouldSkipSeedJackpot: true,
                seedJackpotMinValue: parseEther('10'),
            })
        }
        const { lotto } = await loadFixture(deploy)

        await testERC20.mint(deployer.address, parseEther('10000'))
        await testERC20.approve(await lotto.getAddress(), (1n << 256n) - 1n)
        await expect(lotto.seedJackpot(parseEther('0'))).to.be.revertedWithCustomError(
            lotto,
            'InsufficientJackpotSeed',
        )
        await expect(lotto.seedJackpot(parseEther('1'))).to.be.revertedWithCustomError(
            lotto,
            'InsufficientJackpotSeed',
        )
        await expect(lotto.seedJackpot(parseEther('9.999'))).to.be.revertedWithCustomError(
            lotto,
            'InsufficientJackpotSeed',
        )
        await lotto.seedJackpot(parseEther('10'))

        // Wait 1h
        await time.increase(3600)
        await expect(lotto.seedJackpot(parseEther('0'))).to.be.revertedWithCustomError(
            lotto,
            'InsufficientJackpotSeed',
        )
        await expect(lotto.seedJackpot(parseEther('1'))).to.be.revertedWithCustomError(
            lotto,
            'InsufficientJackpotSeed',
        )
        await expect(lotto.seedJackpot(parseEther('9.999'))).to.be.revertedWithCustomError(
            lotto,
            'InsufficientJackpotSeed',
        )
        await lotto.seedJackpot(parseEther('11'))
    })

    it('should refund gas to draw() keeper', async () => {
        async function deploy() {
            return deployLotto({
                deployer,
                gamePeriod: 86400n,
                prizeToken: testERC20,
                seedJackpotDelay: 3600n /** 1h */,
                shouldSkipSeedJackpot: true,
                seedJackpotMinValue: parseEther('10'),
            })
        }
        const { lotto } = await loadFixture(deploy)
        await deployer.sendTransaction({
            to: await lotto.getAddress(),
            value: parseEther('100.0'),
        })
        await lotto.ownerPick([
            {
                whomst: bob.address,
                picks: [1, 2, 3, 4, 5],
            },
        ])

        const balanceBefore = await ethers.provider.getBalance(deployer.address)
        await time.increase(await lotto.gamePeriod())
        const drawTx = await lotto.draw()
        await drawTx.wait()
        const balanceAfter = await ethers.provider.getBalance(deployer.address)
        expect(balanceAfter).to.be.gt(balanceBefore)
        await expect(drawTx).to.emit(lotto, 'GasRefundAttempted')
    })

    it('should return correct metadata', async () => {
        async function deploy() {
            return deployLotto({
                deployer,
                gamePeriod: 86400n,
                prizeToken: testERC20,
                seedJackpotDelay: 3600n /** 1h */,
                shouldSkipSeedJackpot: true,
                seedJackpotMinValue: parseEther('10'),
            })
        }
        const { lotto } = await loadFixture(deploy)
        await lotto.ownerPick([
            {
                whomst: bob.address,
                picks: [1, 2, 3, 4, 5],
            },
        ])

        expect(await lotto.tokenURI(1)).to.include('data:application/json;base64')
    })

    describe('Apocalypse', () => {
        it('distributes to winner only when there is a winner', async () => {
            const gamePeriod = 1n * 60n * 60n
            async function deploy() {
                return deployLotto({
                    deployer,
                    gamePeriod,
                    prizeToken: testERC20,
                })
            }
            const { lotto, fastForwardAndDraw } = await loadFixture(deploy)

            // Buy some tickets
            await testERC20.mint(deployer, parseEther('1000'))
            await testERC20.approve(lotto, parseEther('1000'))

            await purchaseTicket(lotto, bob.address, [1, 2, 3, 4, 5])

            const initialGameId = await lotto.currentGame().then((game) => game.id)
            await fastForwardAndDraw(6942069320n)
            await expect(lotto.draw()).to.be.revertedWithCustomError(lotto, 'WaitLonger')
            for (let i = 0; i < 10; i++) {
                const gameId = await lotto.currentGame().then((game) => game.id)
                expect(gameId).to.eq(initialGameId + BigInt(i) + 1n)
                await time.increase(gamePeriod)
                await expect(lotto.draw()).to.emit(lotto, 'DrawSkipped').withArgs(gameId)
            }

            // Herald the end of days
            const { id: gameId } = await lotto.currentGame()
            await lotto.kill()
            expect(await lotto.apocalypseGameId()).to.eq(gameId + 1n)

            // Buy tickets
            const picks: [string, number[]][] = [
                [bob.address, [12, 13, 25, 51, 65]],
                [bob.address, [2, 3, 4, 5, 6]],
                [alice.address, [3, 4, 5, 6, 7]],
                [alice.address, [4, 5, 6, 7, 8]],
            ]
            const tickets: { owner: string; tokenId: bigint }[] = await Promise.all(
                picks.map(async ([owner, pick]) => {
                    const { tokenId } = await purchaseTicket(lotto, owner, pick)
                    return {
                        owner,
                        tokenId,
                    }
                }),
            )

            const seed = 6942069421n
            await fastForwardAndDraw(seed)
            expect(await lotto.isGameActive()).to.eq(false)
            expect(await lotto.computeWinningBalls(seed)).to.deep.eq(picks[0][1] /** bob's */)

            // Game no longer active -> no longer possible to do the following actions
            await expect(lotto.kill())
                .to.be.revertedWithCustomError(lotto, 'UnexpectedState')
                .withArgs(GameState.Dead)
            await expect(lotto.seedJackpot(parseEther('10')))
                .to.be.revertedWithCustomError(lotto, 'UnexpectedState')
                .withArgs(GameState.Dead)
            await expect(lotto.draw()).to.be.revertedWithCustomError(lotto, 'UnexpectedState')
            await expect(
                purchaseTicket(lotto, bob.address, [1, 2, 3, 4, 5]),
            ).to.be.revertedWithCustomError(lotto, 'UnexpectedState')

            // Bob has the winning ticket
            const unclaimedPayouts = await lotto.unclaimedPayouts()
            const balanceBefore = await testERC20.balanceOf(bob.address)
            await lotto.claimWinnings(tickets[0].tokenId)
            expect(await testERC20.balanceOf(bob.address)).to.eq(balanceBefore + unclaimedPayouts)
        })

        it('distributes to everyone when there are no winners', async () => {
            const gamePeriod = 1n * 60n * 60n
            async function deploy() {
                return deployLotto({
                    deployer,
                    gamePeriod,
                    prizeToken: testERC20,
                })
            }
            const { lotto, fastForwardAndDraw } = await loadFixture(deploy)

            // Buy some tickets
            await testERC20.mint(deployer, parseEther('1000'))
            await testERC20.approve(lotto, parseEther('1000'))

            await purchaseTicket(lotto, bob.address, [1, 2, 3, 4, 5])

            const initialGameId = await lotto.currentGame().then((game) => game.id)
            await fastForwardAndDraw(6942069320n)
            await expect(lotto.draw()).to.be.revertedWithCustomError(lotto, 'WaitLonger')
            for (let i = 0; i < 10; i++) {
                const gameId = await lotto.currentGame().then((game) => game.id)
                expect(gameId).to.eq(initialGameId + BigInt(i) + 1n)
                await time.increase(gamePeriod)
                await expect(lotto.draw()).to.emit(lotto, 'DrawSkipped').withArgs(gameId)
            }

            // Herald the end of days
            const { id: gameId } = await lotto.currentGame()
            await lotto.kill()
            expect(await lotto.apocalypseGameId()).to.eq(gameId + 1n)

            // Buy tickets
            const picks: [string, number[]][] = [
                [bob.address, [1, 2, 3, 4, 5]],
                [bob.address, [2, 3, 4, 5, 6]],
                [alice.address, [3, 4, 5, 6, 7]],
                [alice.address, [4, 5, 6, 7, 8]],
            ]
            const tickets: { owner: string; tokenId: bigint }[] = await Promise.all(
                picks.map(async ([owner, pick]) => {
                    const { tokenId } = await purchaseTicket(lotto, owner, pick)
                    return {
                        owner,
                        tokenId,
                    }
                }),
            )

            await fastForwardAndDraw(6942069320n)
            expect(await lotto.isGameActive()).to.eq(false)

            // Game no longer active -> no longer possible to do the following actions
            await expect(lotto.kill())
                .to.be.revertedWithCustomError(lotto, 'UnexpectedState')
                .withArgs(GameState.Dead)
            await expect(lotto.seedJackpot(parseEther('10')))
                .to.be.revertedWithCustomError(lotto, 'UnexpectedState')
                .withArgs(GameState.Dead)
            await expect(lotto.draw()).to.be.revertedWithCustomError(lotto, 'UnexpectedState')
            await expect(
                purchaseTicket(lotto, bob.address, [1, 2, 3, 4, 5]),
            ).to.be.revertedWithCustomError(lotto, 'UnexpectedState')

            // No winners -> each ticket claims share of jackpot
            const unclaimedPayouts = await lotto.unclaimedPayouts()
            expect(unclaimedPayouts).to.be.gt(0n)
            const expectedShare = unclaimedPayouts / BigInt(tickets.length)
            for (const ticket of tickets) {
                const balanceBefore = await testERC20.balanceOf(ticket.owner)
                await lotto.claimWinnings(ticket.tokenId)
                expect(await testERC20.balanceOf(ticket.owner)).to.eq(balanceBefore + expectedShare)
            }
        })
    })

    describe('LooteryETHAdapter', () => {
        it('should allow users to purchase tickets with ETH', async () => {
            const weth9 = await new WETH9__factory(deployer).deploy()
            const lotto = await createLotto(
                'Lotto',
                'LOTTO',
                5,
                69,
                69420,
                parseEther('0.1'),
                5000, // 50%,
                weth9,
                3600, // 1 hour
                parseEther('1'),
            )
            const looteryETHAdapter = await new LooteryETHAdapter__factory(deployer).deploy(weth9)

            expect(
                looteryETHAdapter.connect(bob).purchase(
                    lotto,
                    [
                        {
                            whomst: bob.address,
                            picks: [1n, 2n, 3n, 4n, 5n],
                        },
                    ],
                    ZeroAddress,
                    { value: parseEther('1') },
                ),
            ).to.be.revertedWith('Need to provide exact funds')

            looteryETHAdapter.connect(bob).purchase(
                lotto,
                [
                    {
                        whomst: bob.address,
                        picks: [1n, 2n, 3n, 4n, 5n],
                    },
                ],
                ZeroAddress,
                { value: parseEther('0.1') },
            )
        })

        it('should allow users to seed jackpot with ETH', async () => {
            const weth9 = await new WETH9__factory(deployer).deploy()
            const lotto = await createLotto(
                'Lotto',
                'LOTTO',
                5,
                69,
                69420,
                parseEther('0.1'),
                5000, // 50%,
                weth9,
                3600, // 1 hour
                parseEther('1'),
            )
            const looteryETHAdapter = await new LooteryETHAdapter__factory(deployer).deploy(weth9)

            await expect(
                looteryETHAdapter.connect(bob).seedJackpot(lotto, { value: parseEther('10') }),
            )
                .to.emit(looteryETHAdapter, 'JackpotSeeded')
                .withArgs(bob.address, parseEther('10'))
        })
    })

    describe('Regression', () => {
        it('mint tickets to correct purchasers', async () => {
            async function deploy() {
                return deployLotto({
                    deployer,
                    gamePeriod: 1n * 60n * 60n,
                    prizeToken: testERC20,
                })
            }

            const { lotto } = await loadFixture(deploy)
            const numPicks = await lotto.numPicks()
            const domain = await lotto.maxBallValue()

            await testERC20.mint(deployer, parseEther('1000'))
            await testERC20.approve(lotto, parseEther('1000'))

            const randomAddresses = Array(10)
                .fill(0)
                .map((_) => Wallet.createRandom().address)
            const purchaseTx = lotto.purchase(
                randomAddresses.map((whomst) => ({
                    picks: slikpik(numPicks, domain),
                    whomst,
                })),
                ZeroAddress,
            )
            for (let i = 0; i < randomAddresses.length; i++) {
                const whomst = randomAddresses[i]
                // Fixed bug that minted the NFT to only the last address in the list
                expect(purchaseTx)
                    .to.emit(lotto, 'Transfer')
                    .withArgs(ZeroAddress, whomst, i + 1)
            }
        })

        it('should prevent skipping draws if gamePeriod has not elapsed', async () => {
            const gamePeriod = 1n * 60n * 60n
            async function deploy() {
                return deployLotto({
                    deployer,
                    gamePeriod,
                    prizeToken: testERC20,
                })
            }
            const { lotto } = await loadFixture(deploy)

            // Fund the contract so it can draw
            await deployer.sendTransaction({
                to: await lotto.getAddress(),
                value: parseEther('100.0'),
            })

            const initialGameId = await lotto.currentGame().then((game) => game.id)
            await expect(lotto.draw()).to.be.revertedWithCustomError(lotto, 'WaitLonger')
            for (let i = 0; i < 10; i++) {
                const gameId = await lotto.currentGame().then((game) => game.id)
                expect(gameId).to.eq(initialGameId + BigInt(i))
                await expect(lotto.draw()).to.be.revertedWithCustomError(lotto, 'WaitLonger')
                await time.increase(gamePeriod)
                await expect(lotto.draw()).to.emit(lotto, 'DrawSkipped').withArgs(gameId)
            }
        })
    })
})

function computePickId(picks: bigint[]) {
    return picks.reduce((id, pick) => id | (1n << pick), 0n)
}

async function deployLotto({
    deployer,
    gamePeriod,
    prizeToken,
    seedJackpotDelay,
    shouldSkipSeedJackpot,
    seedJackpotMinValue,
}: {
    deployer: SignerWithAddress
    /** seconds */
    gamePeriod: bigint
    prizeToken: TestERC20
    /** seconds */
    seedJackpotDelay?: bigint
    shouldSkipSeedJackpot?: boolean
    seedJackpotMinValue?: bigint
}) {
    const mockRandomiser = await new MockRandomiser__factory(deployer).deploy()
    const ticketSVGRenderer = await new TicketSVGRenderer__factory(deployer).deploy()
    const lotto = await deployProxy({
        deployer,
        implementation: Lootery__factory,
        initData: await Lootery__factory.createInterface().encodeFunctionData('init', [
            {
                owner: deployer.address,
                name: 'Lotto',
                symbol: 'LOTTO',
                numPicks: 5,
                maxBallValue: 69,
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
    }
}

function slikpik(numPicks: bigint, domain: bigint) {
    const seed = BigInt(hexlify(crypto.getRandomValues(new Uint8Array(32))))
    const roundFn = (R: bigint, i: bigint, seed: bigint, domain: bigint) => {
        return BigInt(
            ethers.solidityPackedKeccak256(
                ['uint256', 'uint256', 'uint256', 'uint256'],
                [R, i, seed, domain],
            ),
        )
    }
    const picks: bigint[] = []
    for (let i = 0; i < numPicks; i++) {
        const pick = 1n + encrypt(BigInt(i), domain, seed, 4n, roundFn)
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
async function buySlikpik(connectedLotto: Lootery, whomst: string, beneficiary?: string) {
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
async function purchaseTicket(
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

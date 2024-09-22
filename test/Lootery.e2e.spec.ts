import { ethers } from 'hardhat'
import { loadFixture, time, setBalance } from '@nomicfoundation/hardhat-network-helpers'
import {
    LooteryFactory,
    LooteryFactory__factory,
    Lootery__factory,
    MockRandomiser,
    MockRandomiser__factory,
    MockERC20__factory,
    type MockERC20,
    TicketSVGRenderer__factory,
    TicketSVGRenderer,
} from '../typechain-types'
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import { Wallet, ZeroAddress, parseEther } from 'ethers'
import { expect } from 'chai'
import { deployProxy } from './helpers/deployProxy'
import { computePickId, deployLotto, purchaseTicket, slikpik } from './helpers/lotto'

describe('Lootery e2e', () => {
    let mockRandomiser: MockRandomiser
    let testERC20: MockERC20
    let factory: LooteryFactory
    let deployer: SignerWithAddress
    let bob: SignerWithAddress
    let alice: SignerWithAddress
    let beneficiary: SignerWithAddress
    let ticketSVGRenderer: TicketSVGRenderer
    beforeEach(async () => {
        ;[deployer, bob, alice, beneficiary] = await ethers.getSigners()
        mockRandomiser = await new MockRandomiser__factory(deployer).deploy()
        testERC20 = await new MockERC20__factory(deployer).deploy(deployer)
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
                    pick: losingTicket,
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
                    pick: winningTicket,
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
                    pick: winningTicket,
                },
            ],
            ZeroAddress,
        )
        await lotto.connect(alice).purchase(
            [
                {
                    whomst: alice.address,
                    pick: winningTicket,
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

    it('should rollover jackpot to next round if noone has won', async () => {
        const gamePeriod = 1n * 60n * 60n
        async function deploy() {
            return deployLotto({
                deployer,
                factory,
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
        expect(await lotto.computeWinningPick(seed)).to.deep.eq(winningTicket)

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
                factory,
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

    it('should be able to force redraw if draw is pending for too long', async () => {
        const gamePeriod = 1n * 60n * 60n
        async function deploy() {
            return deployLotto({
                deployer,
                factory,
                gamePeriod,
                prizeToken: testERC20,
            })
        }
        const { lotto, mockRandomiser } = await loadFixture(deploy)

        // Buy some tickets
        await testERC20.mint(deployer, parseEther('10'))
        await testERC20.approve(lotto, parseEther('10'))
        await purchaseTicket(lotto, bob.address, [1, 2, 3, 4, 5])

        // Draw but don't fulfill
        await time.increase(gamePeriod)
        await setBalance(await lotto.getAddress(), parseEther('0.1'))
        await lotto.draw()
        const { requestId: requestId0 } = await lotto.randomnessRequest()
        // We should not be able to call forceRedraw yet
        await expect(lotto.forceRedraw()).to.be.revertedWithCustomError(lotto, 'WaitLonger')

        // Fast forward, then try to forceRedraw
        await time.increase(61 * 60) // ~1h
        await expect(lotto.forceRedraw()).to.emit(lotto, 'RandomnessRequested')
        const { requestId: requestId1 } = await lotto.randomnessRequest()
        expect(requestId1).to.not.eq(requestId0)

        // If we try to call forceRedraw immediately again, it should revert again
        await expect(lotto.forceRedraw()).to.be.revertedWithCustomError(lotto, 'WaitLonger')

        // Make sure we can fulfill and continue the game as normal
        // Fulfill w/ mock randomiser
        await expect(mockRandomiser.fulfillRandomWords(requestId1, [6942069420n])).to.emit(
            lotto,
            'GameFinalised',
        )
    })

    // The gas refund has been removed, since it's hard to test and not future proof
    it.skip('should refund gas to draw() keeper', async () => {
        async function deploy() {
            return deployLotto({
                deployer,
                factory,
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
                pick: [1, 2, 3, 4, 5],
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

    describe('Regression', () => {
        it('mint tickets to correct purchasers', async () => {
            async function deploy() {
                return deployLotto({
                    deployer,
                    factory,
                    gamePeriod: 1n * 60n * 60n,
                    prizeToken: testERC20,
                })
            }

            const { lotto } = await loadFixture(deploy)
            const pickLength = await lotto.pickLength()
            const domain = await lotto.maxBallValue()

            await testERC20.mint(deployer, parseEther('1000'))
            await testERC20.approve(lotto, parseEther('1000'))

            const randomAddresses = Array(10)
                .fill(0)
                .map((_) => Wallet.createRandom().address)
            const purchaseTx = lotto.purchase(
                randomAddresses.map((whomst) => ({
                    pick: slikpik(pickLength, domain),
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
                    factory,
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

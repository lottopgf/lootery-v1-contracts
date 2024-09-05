import { ethers } from 'hardhat'
import { time, setBalance } from '@nomicfoundation/hardhat-network-helpers'
import {
    LooteryFactory,
    LooteryFactory__factory,
    Lootery__factory,
    MockRandomiser,
    MockRandomiser__factory,
    TestERC20__factory,
    type TestERC20,
    TicketSVGRenderer__factory,
    TicketSVGRenderer,
    ILootery,
    LooteryHarness__factory,
} from '../typechain-types'
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import { ZeroAddress, parseEther } from 'ethers'
import { expect } from 'chai'
import { deployProxy } from './helpers/deployProxy'
import { GameState } from './helpers/GameState'
import { computePickId, deployLotto } from './helpers/lotto'
import crypto from 'node:crypto'

const allStates = Object.values(GameState).filter(
    (key): key is number => typeof key === 'number',
) as GameState[]

describe.only('Lootery', () => {
    let mockRandomiser: MockRandomiser
    let testERC20: TestERC20
    let factory: LooteryFactory
    let deployer: SignerWithAddress
    let bob: SignerWithAddress
    let alice: SignerWithAddress
    let beneficiary: SignerWithAddress
    let ticketSVGRenderer: TicketSVGRenderer
    let validConfig: ILootery.InitConfigStruct
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

        validConfig = {
            owner: deployer.address,
            name: 'Lotto',
            symbol: 'LOTTO',
            numPicks: 5,
            maxBallValue: 69,
            gamePeriod: 60n * 60n,
            ticketPrice: parseEther('0.1'),
            communityFeeBps: 5000, // 50%
            randomiser: await mockRandomiser.getAddress(),
            prizeToken: await testERC20.getAddress(),
            seedJackpotDelay: 3600,
            seedJackpotMinValue: parseEther('1'),
            ticketSVGRenderer: await ticketSVGRenderer.getAddress(),
        }
    })

    describe('#receive', () => {
        //
    })

    describe('#init', () => {
        it('should initialise when given valid config', async () => {
            const { lotto } = await deployUninitialisedLootery(deployer)
            expect((await lotto.currentGame()).state).to.equal(GameState.Uninitialised)
            const initTx = await lotto.init(validConfig).then((tx) => tx.wait())
            // State is initialised
            expect((await lotto.currentGame()).state).to.equal(GameState.Purchase)
            // Game data is well formed
            const game = await lotto.currentGame()
            expect(game.id).to.equal(0)
            const gameData = await lotto.gameData(game.id)
            expect(gameData.ticketsSold).to.equal(0)
            expect(gameData.winningPickId).to.equal(0)
            expect(gameData.startedAt).to.eq(
                await initTx!.getBlock().then((block) => block.timestamp),
            )
        })

        it('should revert if called twice', async () => {
            const { lotto } = await deployLotto({
                deployer,
                gamePeriod: 3600n,
                prizeToken: testERC20,
            })
            await expect(lotto.init(validConfig)).to.be.revertedWithCustomError(
                lotto,
                'InvalidInitialization',
            )
        })

        it('should revert if numPicks == 0', async () => {
            const { lotto } = await deployUninitialisedLootery(deployer)
            await expect(
                lotto.init({
                    ...validConfig,
                    numPicks: 0,
                }),
            )
        })

        it('should revert if gamePeriod < 10 minutes', async () => {
            const { lotto } = await deployUninitialisedLootery(deployer)
            await expect(
                lotto.init({
                    ...validConfig,
                    gamePeriod: 9n * 60n,
                }),
            ).to.be.revertedWithCustomError(lotto, 'InvalidGamePeriod')
        })

        it('should revert if ticketPrice is unspecified', async () => {
            const { lotto } = await deployUninitialisedLootery(deployer)
            await expect(
                lotto.init({
                    ...validConfig,
                    ticketPrice: 0,
                }),
            ).to.be.revertedWithCustomError(lotto, 'InvalidTicketPrice')
        })

        it('should revert if randomiser is unspecified', async () => {
            const { lotto } = await deployUninitialisedLootery(deployer)
            await expect(
                lotto.init({
                    ...validConfig,
                    randomiser: ZeroAddress,
                }),
            ).to.be.revertedWithCustomError(lotto, 'InvalidRandomiser')
        })

        it('should revert if prizeToken is unspecified', async () => {
            const { lotto } = await deployUninitialisedLootery(deployer)
            await expect(
                lotto.init({
                    ...validConfig,
                    prizeToken: ZeroAddress,
                }),
            ).to.be.revertedWithCustomError(lotto, 'InvalidPrizeToken')
        })

        it('should revert if seed jackpot config is invalid', async () => {
            const { lotto } = await deployUninitialisedLootery(deployer)
            await expect(
                lotto.init({
                    ...validConfig,
                    seedJackpotDelay: 0,
                }),
            ).to.be.revertedWithCustomError(lotto, 'InvalidSeedJackpotConfig')
            await expect(
                lotto.init({
                    ...validConfig,
                    seedJackpotMinValue: 0,
                }),
            ).to.be.revertedWithCustomError(lotto, 'InvalidSeedJackpotConfig')
            await expect(
                lotto.init({
                    ...validConfig,
                    seedJackpotDelay: 0,
                    seedJackpotMinValue: 0,
                }),
            ).to.be.revertedWithCustomError(lotto, 'InvalidSeedJackpotConfig')
        })
    })

    describe('#seedJackpot', () => {
        it('should revert if called in any state other than Purchase', async () => {
            const { lotto } = await deployUninitialisedLootery(deployer)
            const allOtherStates = allStates.filter((state) => state !== GameState.Purchase)
            for (const state of allOtherStates) {
                await lotto.setGameState(state)
                await expect(lotto.seedJackpot(0n))
                    .to.be.revertedWithCustomError(lotto, 'UnexpectedState')
                    .withArgs(state)
            }
        })

        it('should seed the jackpot', async () => {
            const { lotto } = await deployLotto({
                deployer,
                gamePeriod: 3600n,
                prizeToken: testERC20,
                shouldSkipSeedJackpot: true,
            })
            expect(await lotto.jackpot()).to.equal(0)

            const seedJackpotMinValue = await lotto.seedJackpotMinValue()
            await testERC20.mint(deployer.address, seedJackpotMinValue)
            await testERC20.approve(await lotto.getAddress(), seedJackpotMinValue)
            expect(await testERC20.balanceOf(await lotto.getAddress())).to.equal(0n)

            // Seed jackpot
            await expect(lotto.seedJackpot(seedJackpotMinValue))
                .to.emit(lotto, 'JackpotSeeded')
                .withArgs(deployer.address, seedJackpotMinValue)
            // Accounting & actual balances
            expect(await lotto.jackpot()).to.equal(seedJackpotMinValue)
            expect(await testERC20.balanceOf(await lotto.getAddress())).to.equal(
                seedJackpotMinValue,
            )
        })

        it('should revert if seeding jackpot with an amount below the minimum (DoS vector)', async () => {
            const { lotto } = await deployLotto({
                deployer,
                gamePeriod: 3600n,
                prizeToken: testERC20,
            })
            const seedJackpotMinValue = await lotto.seedJackpotMinValue()
            await expect(lotto.seedJackpot(seedJackpotMinValue - 1n)).to.be.revertedWithCustomError(
                lotto,
                'InsufficientJackpotSeed',
            )
        })

        it('should enforce seed jackpot cooldown', async () => {
            const { lotto } = await deployLotto({
                deployer,
                gamePeriod: 3600n,
                prizeToken: testERC20,
                shouldSkipSeedJackpot: true,
            })
            const seedJackpotMinValue = await lotto.seedJackpotMinValue()
            await testERC20.mint(deployer.address, seedJackpotMinValue * 10n)
            await testERC20.approve(await lotto.getAddress(), seedJackpotMinValue * 10n)
            // 1st attempt should succeed
            await expect(lotto.seedJackpot(seedJackpotMinValue))
                .to.emit(lotto, 'JackpotSeeded')
                .withArgs(deployer.address, seedJackpotMinValue)
            // 2nd attempt - before cooldown
            await expect(lotto.seedJackpot(seedJackpotMinValue)).to.be.revertedWithCustomError(
                lotto,
                'RateLimited',
            )
            // 3rd attempt, after waiting for cooldown
            await time.increase(await lotto.seedJackpotDelay())
            await expect(lotto.seedJackpot(seedJackpotMinValue))
                .to.emit(lotto, 'JackpotSeeded')
                .withArgs(deployer.address, seedJackpotMinValue)
        })
    })

    describe('#_pickTickets', () => {
        // NB: _pickTickets doesn't deal with payment interactions (i.e. ERC-20 transfers)
        it('should revert if called in any state other than Purchase', async () => {
            const { lotto } = await deployUninitialisedLootery(deployer)
            const allOtherStates = allStates.filter((state) => state !== GameState.Purchase)
            for (const state of allOtherStates) {
                await lotto.setGameState(state)
                await expect(lotto.pickTickets([{ whomst: bob.address, picks: [1, 2, 3, 4, 5] }]))
                    .to.be.revertedWithCustomError(lotto, 'UnexpectedState')
                    .withArgs(state)
            }
        })

        it('should mint valid tickets', async () => {
            const { lotto } = await deployLotto({
                deployer,
                gamePeriod: 3600n,
                prizeToken: testERC20,
            })
            await lotto.setGameState(GameState.Purchase)

            const game = await lotto.currentGame()
            const gameData0 = await lotto.gameData(game.id)
            const totalSupply0 = await lotto.totalSupply()

            // Pick 3 tickets
            await expect(lotto.pickTickets([{ whomst: bob.address, picks: [1, 2, 3, 4, 5] }]))
                .to.emit(lotto, 'TicketPurchased')
                .withArgs(game.id, bob.address, 1n, [1, 2, 3, 4, 5])
            const pickTicketTx2 = await lotto.pickTickets([
                { whomst: alice.address, picks: [2, 3, 4, 5, 6] },
                { whomst: bob.address, picks: [3, 4, 5, 6, 7] },
            ])
            await expect(pickTicketTx2)
                .to.emit(lotto, 'TicketPurchased')
                .withArgs(game.id, alice.address, 2n, [2, 3, 4, 5, 6])
            await expect(pickTicketTx2)
                .to.emit(lotto, 'TicketPurchased')
                .withArgs(game.id, bob.address, 3n, [3, 4, 5, 6, 7])

            const gameData = await lotto.gameData(game.id)
            expect(gameData.ticketsSold).to.equal(gameData0.ticketsSold + 3n)
            expect(gameData.startedAt).to.equal(gameData0.startedAt)
            expect(gameData.winningPickId).to.equal(gameData0.winningPickId)
            expect(await lotto.totalSupply()).to.equal(totalSupply0 + 3n)

            // NFTs minted
            expect(await lotto.ownerOf(1n)).to.equal(bob.address)
            expect(await lotto.ownerOf(2n)).to.equal(alice.address)
            expect(await lotto.ownerOf(3n)).to.equal(bob.address)
        })

        it('should revert if ticket has invalid pick length', async () => {
            const { lotto } = await deployLotto({
                deployer,
                gamePeriod: 3600n,
                prizeToken: testERC20,
            })
            await lotto.setGameState(GameState.Purchase)
            await expect(lotto.pickTickets([{ whomst: bob.address, picks: [1, 2, 3, 4, 5, 6] }]))
                .to.be.revertedWithCustomError(lotto, 'InvalidNumPicks')
                .withArgs(6)
            // Ensure it still reverts even if there is a valid pick in there
            await expect(
                lotto.pickTickets([
                    { whomst: bob.address, picks: [1, 2, 3, 4, 5] },
                    { whomst: bob.address, picks: [1, 2, 3, 4, 5, 6] },
                ]),
            )
                .to.be.revertedWithCustomError(lotto, 'InvalidNumPicks')
                .withArgs(6)
        })

        it('should revert if ticket has duplicate picks', async () => {
            const { lotto } = await deployLotto({
                deployer,
                gamePeriod: 3600n,
                prizeToken: testERC20,
            })
            await lotto.setGameState(GameState.Purchase)
            await expect(lotto.pickTickets([{ whomst: bob.address, picks: [1, 1, 3, 4, 5] }]))
                .to.be.revertedWithCustomError(lotto, 'UnsortedPicks')
                .withArgs([1, 1, 3, 4, 5])
        })

        it('should revert if pick has invalid numbers', async () => {
            const { lotto } = await deployLotto({
                deployer,
                gamePeriod: 3600n,
                prizeToken: testERC20,
            })
            await lotto.setGameState(GameState.Purchase)
            // 0 is invalid
            // NB: The revert message is "UnsortedPicks" because the `lastPick` is initialised as 0,
            // and the code asserts strict ordering i.e. `lastPick < picks[i]`
            await expect(lotto.pickTickets([{ whomst: bob.address, picks: [0, 1, 3, 4, 5] }]))
                .to.be.revertedWithCustomError(lotto, 'UnsortedPicks')
                .withArgs([0, 1, 3, 4, 5])
            // Over the max ball value
            const maxBallValue = await lotto.maxBallValue()
            await expect(
                lotto.pickTickets([
                    { whomst: bob.address, picks: [1, 3, 4, 5, maxBallValue + 1n] },
                ]),
            ).to.be.revertedWithCustomError(lotto, 'InvalidBallValue')
        })
    })

    describe('#ownerPick', () => {
        it('should revert if not called by owner', async () => {
            const { lotto } = await deployLotto({
                deployer,
                gamePeriod: 3600n,
                prizeToken: testERC20,
            })
            await expect(
                lotto
                    .connect(bob /** bob's not the owner */)
                    .ownerPick([{ whomst: bob.address, picks: [1, 2, 3, 4, 5] }]),
            ).to.be.revertedWithCustomError(lotto, 'OwnableUnauthorizedAccount')
        })

        it('should mint valid tickets if called by owner', async () => {
            const { lotto } = await deployLotto({
                deployer,
                gamePeriod: 3600n,
                prizeToken: testERC20,
            })
            await expect(lotto.ownerPick([{ whomst: alice.address, picks: [1, 2, 3, 4, 5] }]))
                .to.emit(lotto, 'TicketPurchased')
                .withArgs(0, alice.address, 1n, [1, 2, 3, 4, 5])
            expect(await lotto.ownerOf(1n)).to.equal(alice.address)
        })
    })

    describe('#purchase', () => {
        it('should take tokens for payment and mint tickets (no beneficiary)', async () => {
            const { lotto } = await deployLotto({
                deployer,
                gamePeriod: 3600n,
                prizeToken: testERC20,
                shouldSkipSeedJackpot: true /** make sure it's empty initially */,
            })
            const ticketPrice = await lotto.ticketPrice()
            await testERC20.mint(deployer.address, ticketPrice * 100n)
            await testERC20.approve(await lotto.getAddress(), ticketPrice * 100n)

            // Purchase 2 tickets
            await expect(
                lotto.purchase(
                    [
                        { whomst: alice.address, picks: [1, 2, 3, 4, 5] },
                        { whomst: alice.address, picks: [2, 3, 4, 5, 6] },
                    ],
                    ZeroAddress,
                ),
            )
                .to.emit(lotto, 'TicketPurchased')
                .withArgs(0, alice.address, 1n, [1, 2, 3, 4, 5])

            const totalPurchasePrice = ticketPrice * 2n
            const communityShare = (totalPurchasePrice * (await lotto.communityFeeBps())) / 10000n
            const jackpotShare = totalPurchasePrice - communityShare
            // Internal accounting
            expect(await lotto.accruedCommunityFees()).to.eq(communityShare)
            expect(await lotto.jackpot()).to.eq(jackpotShare)

            // Actual ERC-20 balance (combined)
            expect(await testERC20.balanceOf(await lotto.getAddress())).to.eq(totalPurchasePrice)
        })

        it('should take tokens for payment and mint tickets, and transfer to beneficiary when specified', async () => {
            const { lotto } = await deployLotto({
                deployer,
                gamePeriod: 3600n,
                prizeToken: testERC20,
                shouldSkipSeedJackpot: true /** make sure it's empty initially */,
            })
            const ticketPrice = await lotto.ticketPrice()
            await testERC20.mint(deployer.address, ticketPrice * 100n)
            await testERC20.approve(await lotto.getAddress(), ticketPrice * 100n)
            const beneficiaryBalance = await testERC20.balanceOf(beneficiary.address)

            // Purchase 2 tickets
            const tx = lotto.purchase(
                [
                    { whomst: alice.address, picks: [1, 2, 3, 4, 5] },
                    { whomst: alice.address, picks: [2, 3, 4, 5, 6] },
                ],
                beneficiary.address,
            )
            await expect(tx)
                .to.emit(lotto, 'TicketPurchased')
                .withArgs(0, alice.address, 1n, [1, 2, 3, 4, 5])

            const totalPurchasePrice = ticketPrice * 2n
            const communityShare = (totalPurchasePrice * (await lotto.communityFeeBps())) / 10000n
            const jackpotShare = totalPurchasePrice - communityShare
            // Internal accounting
            await expect(tx)
                .to.emit(lotto, 'BeneficiaryPaid')
                .withArgs(0, beneficiary.address, communityShare)
            expect(await lotto.accruedCommunityFees()).to.eq(0n) // Transferred to beneficiary instead
            expect(await lotto.jackpot()).to.eq(jackpotShare)

            // Actual ERC-20 balances (combined)
            expect(await testERC20.balanceOf(await lotto.getAddress())).to.eq(jackpotShare)
            expect(await testERC20.balanceOf(beneficiary.address)).to.eq(
                beneficiaryBalance + communityShare,
            )
        })
    })

    describe('#draw', () => {
        //
    })

    describe('#receiveRandomWords', () => {
        //
    })

    describe('#_setupNextGame', () => {
        //
    })

    describe('#claimWinnings', () => {
        //
    })

    describe('#withdrawAccruedFees', () => {
        //
    })

    describe('#kill', () => {
        //
    })

    describe('#rescueTokens', () => {
        //
    })

    describe('#computePicks', () => {
        //
    })

    describe('#computeWinningBalls', () => {
        //
    })

    describe('#setTicketSVGRenderer', () => {
        //
    })

    describe('#isGameActive', () => {
        //
    })

    describe('#tokenURI', () => {
        //
    })
})

async function deployUninitialisedLootery(deployer: SignerWithAddress) {
    return {
        lotto: await deployProxy({
            deployer,
            implementation: LooteryHarness__factory,
            initData: '0x',
        }),
    }
}

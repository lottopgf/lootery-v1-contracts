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
                await expect(
                    lotto.pickTickets([{ whomst: bob.address, picks: [1, 2, 3, 4, 5] }], 0n),
                )
                    .to.be.revertedWithCustomError(lotto, 'UnexpectedState')
                    .withArgs(state)
            }
        })
    })

    describe('#purchaseTicket', () => {
        //
    })

    describe('#ownerPick', () => {
        //
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

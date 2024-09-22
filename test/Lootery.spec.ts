import { ethers } from 'hardhat'
import * as hre from 'hardhat'
import { time, setBalance, impersonateAccount } from '@nomicfoundation/hardhat-network-helpers'
import {
    MockRandomiser,
    MockRandomiser__factory,
    MockERC20__factory,
    type MockERC20,
    TicketSVGRenderer__factory,
    TicketSVGRenderer,
    ILootery,
    LooteryHarness__factory,
    LooteryHarness,
    ERC20,
    RevertingETHReceiver__factory,
    MockERC721__factory,
    LooteryFactory__factory,
    LooteryFactory,
} from '../typechain-types'
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import { ZeroAddress, parseEther } from 'ethers'
import { expect } from 'chai'
import { deployProxy } from './helpers/deployProxy'
import { GameState } from './helpers/GameState'
import { computePick, computePickId, deployLotto, shuffle, slikpik } from './helpers/lotto'
import { getRandomValues } from 'node:crypto'

const isCoverage = Boolean((hre as any).__SOLIDITY_COVERAGE_RUNNING)
const CUSTOM_RUNS = process.env.RUNS
const customRunsOrDefault =
    typeof CUSTOM_RUNS !== 'undefined' &&
    !Number.isNaN(Number(CUSTOM_RUNS)) &&
    Number.isFinite(Number(CUSTOM_RUNS))
        ? Number(CUSTOM_RUNS)
        : 100
const runs = isCoverage ? 10 : customRunsOrDefault

function randomBigInt(bytes: number) {
    return BigInt(`0x${Buffer.from(getRandomValues(new Uint8Array(bytes))).toString('hex')}`)
}

const allStates = Object.values(GameState).filter(
    (key): key is number => typeof key === 'number',
) as GameState[]

describe('Lootery', () => {
    let mockRandomiser: MockRandomiser
    let testERC20: MockERC20
    let deployer: SignerWithAddress
    let bob: SignerWithAddress
    let alice: SignerWithAddress
    let beneficiary: SignerWithAddress
    let ticketSVGRenderer: TicketSVGRenderer
    let validConfig: ILootery.InitConfigStruct
    let lotto: LooteryHarness
    let factory: LooteryFactory
    beforeEach(async () => {
        ;[deployer, bob, alice, beneficiary] = await ethers.getSigners()
        mockRandomiser = await new MockRandomiser__factory(deployer).deploy()
        testERC20 = await new MockERC20__factory(deployer).deploy(deployer)
        ticketSVGRenderer = await new TicketSVGRenderer__factory(deployer).deploy()
        factory = factory = await deployProxy({
            deployer,
            implementation: LooteryFactory__factory,
            initData: LooteryFactory__factory.createInterface().encodeFunctionData('init', [
                await new LooteryHarness__factory(deployer)
                    .deploy()
                    .then((contract) => contract.getAddress()),
                await mockRandomiser.getAddress(),
                await ticketSVGRenderer.getAddress(),
            ]),
        })

        validConfig = {
            owner: deployer.address,
            name: 'Lotto',
            symbol: 'LOTTO',
            pickLength: 5,
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

    describe('#typeAndVersion', () => {
        it('should return the correct type and version', async () => {
            ;({ lotto } = await deployLotto({
                deployer,
                factory,
                gamePeriod: 3600n,
                prizeToken: testERC20,
            }))
            const [type, version] = await lotto
                .typeAndVersion()
                .then((version) => version.split(' '))
            expect(type).to.equal('Lootery')
            expect(version).to.match(/^\d+\.\d+\.\d+$/)
        })
    })

    describe('#receive', () => {
        it('should receive ETH', async () => {
            ;({ lotto } = await deployLotto({
                deployer,
                factory,
                gamePeriod: 3600n,
                prizeToken: testERC20,
            }))

            await expect(
                deployer.sendTransaction({ to: await lotto.getAddress(), value: parseEther('1') }),
            )
                .to.emit(lotto, 'Received')
                .withArgs(deployer.address, parseEther('1'))
        })
    })

    describe('#init', () => {
        beforeEach(async () => {
            ;({ lotto } = await deployUninitialisedLootery(deployer))
        })

        it('should initialise when given valid config', async () => {
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
            expect(await lotto.callbackGasLimit()).to.not.equal(0)
        })

        it('should revert if called twice', async () => {
            await lotto.init(validConfig)
            await expect(lotto.init(validConfig)).to.be.revertedWithCustomError(
                lotto,
                'InvalidInitialization',
            )
        })

        it('should revert if pickLength == 0', async () => {
            await expect(
                lotto.init({
                    ...validConfig,
                    pickLength: 0,
                }),
            )
        })

        it('should revert if pickLength > maxBallValue', async () => {
            await expect(
                lotto.init({
                    ...validConfig,
                    maxBallValue: 5,
                    pickLength: 6,
                }),
            ).to.be.revertedWithCustomError(lotto, 'InvalidMaxBallValue')

            // pickLength == maxBallValue is ok (even though every ticket would be a winner)
            await expect(
                lotto.init({
                    ...validConfig,
                    maxBallValue: 6,
                    pickLength: 6,
                }),
            ).to.not.be.reverted
        })

        it('should revert if pickLength > 32', async () => {
            await expect(
                lotto.init({
                    ...validConfig,
                    pickLength: 33,
                }),
            ).to.be.revertedWithCustomError(lotto, 'InvalidPickLength')
        })

        it('should revert if gamePeriod < 10 minutes', async () => {
            await expect(
                lotto.init({
                    ...validConfig,
                    gamePeriod: 9n * 60n,
                }),
            ).to.be.revertedWithCustomError(lotto, 'InvalidGamePeriod')
        })

        it('should revert if ticketPrice is unspecified', async () => {
            await expect(
                lotto.init({
                    ...validConfig,
                    ticketPrice: 0,
                }),
            ).to.be.revertedWithCustomError(lotto, 'InvalidTicketPrice')
        })

        it('should revert if community fee + protocol fee > 100%', async () => {
            const protocolFeeBps = await lotto.PROTOCOL_FEE_BPS()
            await expect(
                lotto.init({
                    ...validConfig,
                    communityFeeBps: 10000n - protocolFeeBps + 1n,
                }),
            ).to.be.revertedWithCustomError(lotto, 'InvalidFeeShares')
            await expect(
                lotto.init({
                    ...validConfig,
                    communityFeeBps: 10000n - protocolFeeBps,
                }),
            ).to.not.be.reverted
        })

        it('should revert if randomiser is unspecified', async () => {
            await expect(
                lotto.init({
                    ...validConfig,
                    randomiser: ZeroAddress,
                }),
            ).to.be.revertedWithCustomError(lotto, 'InvalidRandomiser')
        })

        it('should revert if prizeToken is unspecified', async () => {
            await expect(
                lotto.init({
                    ...validConfig,
                    prizeToken: ZeroAddress,
                }),
            ).to.be.revertedWithCustomError(lotto, 'InvalidPrizeToken')
        })

        it('should revert if seed jackpot config is invalid', async () => {
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

    describe('#setBeneficiary, #beneficiaries', () => {
        beforeEach(async () => {
            ;({ lotto } = await deployLotto({
                deployer,
                factory,
                gamePeriod: 3600n,
                prizeToken: testERC20,
            }))
        })

        it('should revert if called by non-owner', async () => {
            await expect(
                lotto.connect(bob).setBeneficiary(beneficiary.address, 'Beneficiary', true),
            ).to.be.revertedWithCustomError(lotto, 'OwnableUnauthorizedAccount')
        })

        it('should revert if display name is empty', async () => {
            await expect(
                lotto.setBeneficiary(beneficiary.address, '', true),
            ).to.be.revertedWithCustomError(lotto, 'EmptyDisplayName')
        })

        it('should add beneficiaries into set', async () => {
            const n = 10
            const randomAddresses = Array.from({ length: n }, (_) => [
                ethers.Wallet.createRandom().address,
                `Beneficiary ${ethers.Wallet.createRandom().address}`,
            ])
            randomAddresses.push(randomAddresses[randomAddresses.length - 1]) // Duplicate addition

            for (const [address, displayName] of randomAddresses) {
                await lotto.setBeneficiary(address, displayName, true)
            }
            const [addresses, displayNames] = await lotto.beneficiaries()
            expect(addresses).to.deep.equal(
                randomAddresses.slice(0, -1).map(([address]) => address),
            )
            expect(displayNames).to.deep.equal(
                randomAddresses.slice(0, -1).map(([, displayName]) => displayName),
            )
        })

        it('should remove beneficiaries', async () => {
            // Add beneficiaries
            const randomAddresses = Array.from(
                { length: 10 },
                (_) => ethers.Wallet.createRandom().address,
            )
            for (const address of randomAddresses) {
                await lotto.setBeneficiary(address, `Beneficiary ${address}`, true)
            }

            // Remove beneficiaries
            randomAddresses.push(randomAddresses[randomAddresses.length - 1]) // Duplicate removal
            for (const address of randomAddresses) {
                await lotto.setBeneficiary(address, '', false)
            }
            const [addresses, displayNames] = await lotto.beneficiaries()
            expect(addresses).to.deep.equal([])
            expect(displayNames).to.deep.equal([])
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
                factory,
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
            ;({ lotto } = await deployLotto({
                deployer,
                factory,
                gamePeriod: 3600n,
                prizeToken: testERC20,
                shouldSkipSeedJackpot: true,
            }))
            const seedJackpotMinValue = await lotto.seedJackpotMinValue()
            await expect(lotto.seedJackpot(seedJackpotMinValue - 1n)).to.be.revertedWithCustomError(
                lotto,
                'InsufficientJackpotSeed',
            )
        })

        it('should enforce seed jackpot cooldown', async () => {
            const { lotto } = await deployLotto({
                deployer,
                factory,
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
        beforeEach(async () => {
            ;({ lotto } = await deployLotto({
                deployer,
                factory,
                gamePeriod: 3600n,
                prizeToken: testERC20,
            }))
        })

        // NB: _pickTickets doesn't deal with payment interactions (i.e. ERC-20 transfers)
        it('should revert if called in any state other than Purchase', async () => {
            const { lotto } = await deployUninitialisedLootery(deployer)
            const allOtherStates = allStates.filter((state) => state !== GameState.Purchase)
            for (const state of allOtherStates) {
                await lotto.setGameState(state)
                await expect(lotto.pickTickets([{ whomst: bob.address, pick: [1, 2, 3, 4, 5] }]))
                    .to.be.revertedWithCustomError(lotto, 'UnexpectedState')
                    .withArgs(state)
            }
        })

        it('should mint valid tickets', async () => {
            await lotto.setGameState(GameState.Purchase)

            const game = await lotto.currentGame()
            const gameData0 = await lotto.gameData(game.id)
            const totalSupply0 = await lotto.totalSupply()

            // Pick 3 tickets
            await expect(lotto.pickTickets([{ whomst: bob.address, pick: [1, 2, 3, 4, 5] }]))
                .to.emit(lotto, 'TicketPurchased')
                .withArgs(game.id, bob.address, 1n, [1, 2, 3, 4, 5])
            const pickTicketTx2 = await lotto.pickTickets([
                { whomst: alice.address, pick: [2, 3, 4, 5, 6] },
                { whomst: bob.address, pick: [3, 4, 5, 6, 7] },
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

        it('should allow an empty pick to mint dummy tickets', async () => {
            // A player should be able to purchase a ticket specifying an empty pick,
            // which means that they only wish to donate and not participate in the lottery.
            await lotto.setGameState(GameState.Purchase)
            const purchaseTx = lotto.pickTickets([
                { whomst: alice.address, pick: [] },
                { whomst: bob.address, pick: [] },
            ])
            await expect(purchaseTx)
                .to.emit(lotto, 'TicketPurchased')
                .withArgs(0, alice.address, 1n, [])
            await expect(purchaseTx)
                .to.emit(lotto, 'TicketPurchased')
                .withArgs(0, bob.address, 2n, [])
            expect(await lotto.ownerOf(1n)).to.equal(alice.address)
            expect(await lotto.ownerOf(2n)).to.equal(bob.address)
        })

        it('should revert if ticket has invalid pick length', async () => {
            await lotto.setGameState(GameState.Purchase)
            await expect(lotto.pickTickets([{ whomst: bob.address, pick: [1, 2, 3, 4, 5, 6] }]))
                .to.be.revertedWithCustomError(lotto, 'InvalidPickLength')
                .withArgs(6)
            // Ensure it still reverts even if there is a valid pick in there
            await expect(
                lotto.pickTickets([
                    { whomst: bob.address, pick: [1, 2, 3, 4, 5] },
                    { whomst: bob.address, pick: [1, 2, 3, 4, 5, 6] },
                ]),
            )
                .to.be.revertedWithCustomError(lotto, 'InvalidPickLength')
                .withArgs(6)
        })

        it('should revert if ticket has duplicate picks', async () => {
            await lotto.setGameState(GameState.Purchase)
            await expect(lotto.pickTickets([{ whomst: bob.address, pick: [1, 1, 3, 4, 5] }]))
                .to.be.revertedWithCustomError(lotto, 'UnsortedPick')
                .withArgs([1, 1, 3, 4, 5])
        })

        it('should revert if pick has invalid numbers', async () => {
            await lotto.setGameState(GameState.Purchase)
            // 0 is invalid
            // NB: The revert message is "UnsortedPick" because the `lastPick` is initialised as 0,
            // and the code asserts strict ordering i.e. `lastPick < picks[i]`
            await expect(lotto.pickTickets([{ whomst: bob.address, pick: [0, 1, 3, 4, 5] }]))
                .to.be.revertedWithCustomError(lotto, 'UnsortedPick')
                .withArgs([0, 1, 3, 4, 5])
            // Over the max ball value
            const maxBallValue = await lotto.maxBallValue()
            await expect(
                lotto.pickTickets([{ whomst: bob.address, pick: [1, 3, 4, 5, maxBallValue + 1n] }]),
            ).to.be.revertedWithCustomError(lotto, 'InvalidBallValue')
        })
    })

    describe('#ownerPick', () => {
        beforeEach(async () => {
            ;({ lotto } = await deployLotto({
                deployer,
                factory,
                gamePeriod: 3600n,
                prizeToken: testERC20,
            }))
        })

        it('should revert if not called by owner', async () => {
            await expect(
                lotto
                    .connect(bob /** bob's not the owner */)
                    .ownerPick([{ whomst: bob.address, pick: [1, 2, 3, 4, 5] }]),
            ).to.be.revertedWithCustomError(lotto, 'OwnableUnauthorizedAccount')
        })

        it('should mint valid tickets if called by owner', async () => {
            await expect(lotto.ownerPick([{ whomst: alice.address, pick: [1, 2, 3, 4, 5] }]))
                .to.emit(lotto, 'TicketPurchased')
                .withArgs(0, alice.address, 1n, [1, 2, 3, 4, 5])
            expect(await lotto.ownerOf(1n)).to.equal(alice.address)
        })
    })

    describe('#purchase', () => {
        beforeEach(async () => {
            ;({ lotto } = await deployLotto({
                deployer,
                factory,
                gamePeriod: 3600n,
                prizeToken: testERC20,
                shouldSkipSeedJackpot: true /** make sure it's empty initially */,
            }))
        })

        it('should revert if no tickets were specified', async () => {
            await expect(lotto.purchase([], beneficiary.address)).to.be.revertedWithCustomError(
                lotto,
                'NoTicketsSpecified',
            )
        })

        it('should take tokens for payment and mint tickets (no beneficiary)', async () => {
            const ticketPrice = await lotto.ticketPrice()
            await testERC20.mint(deployer.address, ticketPrice * 100n)
            await testERC20.approve(await lotto.getAddress(), ticketPrice * 100n)

            // Purchase 2 tickets
            await expect(
                lotto.purchase(
                    [
                        { whomst: alice.address, pick: [1, 2, 3, 4, 5] },
                        { whomst: alice.address, pick: [2, 3, 4, 5, 6] },
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

        it('should revert if beneficiary is unknown', async () => {
            const ticketPrice = await lotto.ticketPrice()
            await testERC20.mint(deployer.address, ticketPrice * 100n)
            await testERC20.approve(await lotto.getAddress(), ticketPrice * 100n)

            await expect(
                lotto.purchase(
                    [{ whomst: alice.address, pick: [1, 2, 3, 4, 5] }],
                    beneficiary.address,
                ),
            ).to.be.revertedWithCustomError(lotto, 'UnknownBeneficiary')
        })

        it('should take tokens for payment and mint tickets, and transfer to beneficiary when specified', async () => {
            const ticketPrice = await lotto.ticketPrice()
            await testERC20.mint(deployer.address, ticketPrice * 100n)
            await testERC20.approve(await lotto.getAddress(), ticketPrice * 100n)
            const beneficiaryBalance = await testERC20.balanceOf(beneficiary.address)
            await lotto.setBeneficiary(
                beneficiary.address,
                `Beneficiary ${beneficiary.address}`,
                true,
            )

            // Purchase 2 tickets
            const tx = lotto.purchase(
                [
                    { whomst: alice.address, pick: [1, 2, 3, 4, 5] },
                    { whomst: alice.address, pick: [2, 3, 4, 5, 6] },
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

        it('should take tokens for payment and mint tickets, and transfer protocol fees if turned on', async () => {
            const ticketPrice = await lotto.ticketPrice()
            await testERC20.mint(deployer.address, ticketPrice * 100n)
            await testERC20.approve(await lotto.getAddress(), ticketPrice * 100n)
            // Set protocol fee recipient (turn on protocol fees)
            await factory.setFeeRecipient(beneficiary.address)
            const balanceBefore = await testERC20.balanceOf(beneficiary.address)

            // Purchase 2 tickets
            const tx = lotto.purchase(
                [
                    { whomst: alice.address, pick: [1, 2, 3, 4, 5] },
                    { whomst: alice.address, pick: [2, 3, 4, 5, 6] },
                ],
                ZeroAddress,
            )
            await expect(tx)
                .to.emit(lotto, 'TicketPurchased')
                .withArgs(0, alice.address, 1n, [1, 2, 3, 4, 5])

            const totalPurchasePrice = ticketPrice * 2n
            const communityShare = (totalPurchasePrice * (await lotto.communityFeeBps())) / 10000n
            const protocolFeeShare =
                (totalPurchasePrice * (await lotto.PROTOCOL_FEE_BPS())) / 10000n
            const jackpotShare = totalPurchasePrice - communityShare - protocolFeeShare
            await expect(tx)
                .to.emit(lotto, 'ProtocolFeePaid')
                .withArgs(beneficiary.address, protocolFeeShare)
            // Internal accounting
            expect(await lotto.accruedCommunityFees()).to.eq(communityShare)
            expect(await lotto.jackpot()).to.eq(jackpotShare)

            // Actual ERC-20 balances (combined)
            expect(await testERC20.balanceOf(await lotto.getAddress())).to.eq(
                jackpotShare + communityShare,
            )
            expect(await testERC20.balanceOf(beneficiary.address)).to.eq(
                balanceBefore + protocolFeeShare,
            )
        })
    })

    describe('#draw', () => {
        beforeEach(async () => {
            ;({ lotto, mockRandomiser } = await deployLotto({
                deployer,
                factory,
                gamePeriod: 3600n,
                prizeToken: testERC20,
            }))
        })

        it('should revert if called in any state other than Purchase', async () => {
            const { lotto } = await deployUninitialisedLootery(deployer)
            const allOtherStates = allStates.filter((state) => state !== GameState.Purchase)
            for (const state of allOtherStates) {
                await lotto.setGameState(state)
                await expect(lotto.draw())
                    .to.be.revertedWithCustomError(lotto, 'UnexpectedState')
                    .withArgs(state)
            }
        })

        it('should revert if the game period has not elapsed', async () => {
            // Immediately draw after deploying, game period is 1h -> game period has not elapsed
            await expect(lotto.draw()).to.be.revertedWithCustomError(lotto, 'WaitLonger')
            // Try again after 1h
            await time.increase(3600n)
            await expect(lotto.draw()).to.not.be.reverted
        })

        it('should skip draw if there are no tickets sold in current game', async () => {
            await time.increase(3600n)

            await expect(lotto.draw()).to.emit(lotto, 'DrawSkipped').withArgs(0)
        })

        it('should request randomness if there are tickets sold in current game and there is ETH balance in contract', async () => {
            await lotto.pickTickets([{ whomst: alice.address, pick: [1, 2, 3, 4, 5] }])
            await time.increase(3600n)

            // Give contract some ETH balance
            await setBalance(await lotto.getAddress(), parseEther('1'))
            const drawTx = lotto.draw()
            await expect(drawTx).to.emit(lotto, 'RandomnessRequested')
            await expect(drawTx).to.not.emit(lotto, 'ExcessRefunded')
            await expect((await lotto.currentGame()).state).to.eq(GameState.DrawPending)
        })

        it('should revert if excess ETH cannot be refunded to caller', async () => {
            await lotto.pickTickets([{ whomst: alice.address, pick: [1, 2, 3, 4, 5] }])
            await time.increase(3600n)

            const _revertingReceiver = await new RevertingETHReceiver__factory(deployer).deploy()
            await impersonateAccount(await _revertingReceiver.getAddress())
            // This is now the owner, and will always revert upon receiving ETH
            const revertingReceiver = await ethers.getSigner(await _revertingReceiver.getAddress())
            await setBalance(revertingReceiver.address, parseEther('10'))

            const payment = parseEther('1') // ought to be enough for any request
            const drawTx = lotto.connect(revertingReceiver).draw({
                value: payment,
            })
            await expect(drawTx).to.be.revertedWithCustomError(lotto, 'TransferFailure')
            await expect((await lotto.currentGame()).state).to.eq(GameState.Purchase)
        })

        it('should revert if contract cannot refund excess ETH', async () => {
            await lotto.pickTickets([{ whomst: alice.address, pick: [1, 2, 3, 4, 5] }])
            await time.increase(3600n)

            const requestPrice = await mockRandomiser.getRequestPrice(
                500_000 /** TODO: This will be configurable */,
            )
            const payment = parseEther('1') // ought to be enough for any request
            const drawTx = lotto.draw({
                value: payment,
            })
            await expect(drawTx).to.emit(lotto, 'RandomnessRequested')
            await expect(drawTx)
                .to.emit(lotto, 'ExcessRefunded')
                .withArgs(deployer.address, payment - requestPrice)
            await expect((await lotto.currentGame()).state).to.eq(GameState.DrawPending)
        })

        it('should revert if contract does not have enough ETH balance to request randomness', async () => {
            await lotto.pickTickets([{ whomst: alice.address, pick: [1, 2, 3, 4, 5] }])
            await time.increase(3600n)
            // Zero the balance
            await setBalance(await lotto.getAddress(), 0n)

            await expect(lotto.draw()).to.be.revertedWithCustomError(
                lotto,
                'InsufficientOperationalFunds',
            )
        })

        it('should revert if randomness requestId is too large', async () => {
            await lotto.pickTickets([{ whomst: alice.address, pick: [1, 2, 3, 4, 5] }])
            await time.increase(3600n)
            await mockRandomiser.setNextRequestId(2n ** 208n)

            await expect(
                lotto.draw({
                    value: parseEther('1'),
                }),
            ).to.be.revertedWithCustomError(lotto, 'RequestIdOverflow')
        })
    })

    describe('#forceRedraw', () => {
        beforeEach(async () => {
            ;({ lotto, mockRandomiser } = await deployLotto({
                deployer,
                factory,
                gamePeriod: 3600n,
                prizeToken: testERC20,
            }))
        })

        it('should revert if called in any state other than DrawPending', async () => {
            const allOtherStates = allStates.filter((state) => state !== GameState.DrawPending)
            for (const state of allOtherStates) {
                await lotto.setGameState(state)
                await expect(lotto.forceRedraw())
                    .to.be.revertedWithCustomError(lotto, 'UnexpectedState')
                    .withArgs(state)
            }
        })

        it('should revert if there is no randomness request in flight', async () => {
            await lotto.setGameState(GameState.DrawPending)
            await expect(lotto.forceRedraw()).to.be.revertedWithCustomError(
                lotto,
                'NoRandomnessRequestInFlight',
            )
        })

        it('should revert if the request is not old enough', async () => {
            await lotto.setGameState(GameState.DrawPending)
            const timestamp = await ethers.provider
                .getBlock('latest')
                .then((block) => block!.timestamp)
            await lotto.setRandomnessRequest({
                requestId: 1n,
                timestamp,
            })
            await expect(lotto.forceRedraw()).to.be.revertedWithCustomError(lotto, 'WaitLonger')
        })

        it('should re-request randomness if the request is old enough', async () => {
            await lotto.setGameState(GameState.DrawPending)
            const timestamp = await ethers.provider
                .getBlock('latest')
                .then((block) => block!.timestamp)
            await lotto.setRandomnessRequest({
                requestId: 1n,
                timestamp,
            })
            await time.increase(61 * 60) // 61 mins
            const requestPrice = await lotto.getRequestPrice()
            await expect(
                lotto.forceRedraw({
                    value: requestPrice * 2n,
                }),
            ).to.emit(lotto, 'RandomnessRequested')
        })
    })

    describe('#receiveRandomWords', () => {
        let reqId = 1n
        beforeEach(async () => {
            ;({ lotto, mockRandomiser } = await deployLotto({
                deployer,
                factory,
                gamePeriod: 3600n,
                prizeToken: testERC20,
            }))
        })

        it('should finalise game upon receiving random words and pick winning balls', async () => {
            // Mock the state
            await lotto.setGameState(GameState.DrawPending)
            const gameId = (await lotto.currentGame()).id
            const game = await lotto.gameData(gameId)
            expect(game.winningPickId).to.eq(0, 'ensure game has not been drawn')
            const seed = 69420n
            const rId = reqId++
            await mockRandomiser.setRequest(rId, await lotto.getAddress())
            await lotto.setRandomnessRequest({
                requestId: rId,
                timestamp: await ethers.provider
                    .getBlock('latest')
                    .then((block) => block!.timestamp),
            })

            // Expect the game to be finalised
            await expect(mockRandomiser.fulfillRandomWords(rId, [seed]))
                .to.emit(lotto, 'GameFinalised')
                .withArgs(gameId, await lotto.computeWinningPick(seed))
            expect((await lotto.currentGame()).state).to.eq(GameState.Purchase)
            expect((await lotto.gameData(gameId)).winningPickId).to.not.eq(game.winningPickId)
        })

        it('should revert if called in any state other than DrawPending', async () => {
            const { lotto } = await deployUninitialisedLootery(deployer)
            const allOtherStates = allStates.filter((state) => state !== GameState.DrawPending)
            for (const state of allOtherStates) {
                await lotto.setGameState(state)
                await mockRandomiser.setRequest(reqId, await lotto.getAddress())
                await expect(mockRandomiser.fulfillRandomWords(reqId++, [69420n]))
                    .to.be.revertedWithCustomError(lotto, 'UnexpectedState')
                    .withArgs(state)
            }
        })

        it('should revert if not called by randomiser', async () => {
            await lotto.setGameState(GameState.DrawPending)
            await expect(lotto.connect(alice).receiveRandomWords(reqId++, [69420n]))
                .to.be.revertedWithCustomError(lotto, 'CallerNotRandomiser')
                .withArgs(alice.address)
        })

        it('should revert if randomWords is empty', async () => {
            // Mock the state
            await lotto.setGameState(GameState.DrawPending)
            const rId = reqId++
            await mockRandomiser.setRequest(rId, await lotto.getAddress())

            await expect(mockRandomiser.fulfillRandomWords(rId, [])).to.be.revertedWithCustomError(
                lotto,
                'InsufficientRandomWords',
            )
        })

        it('should revert if requestId does not match', async () => {
            // Mock the state
            await lotto.setGameState(GameState.DrawPending)
            const rId = reqId++
            await mockRandomiser.setRequest(rId, await lotto.getAddress())
            await lotto.setRandomnessRequest({
                requestId: rId,
                timestamp: await ethers.provider
                    .getBlock('latest')
                    .then((block) => block!.timestamp),
            })
            const wrongRequestId = rId + 1n
            await mockRandomiser.setRequest(wrongRequestId, await lotto.getAddress())

            await expect(mockRandomiser.fulfillRandomWords(wrongRequestId, [69420n]))
                .to.be.revertedWithCustomError(lotto, 'RequestIdMismatch')
                .withArgs(wrongRequestId, rId)
        })
    })

    describe('#_setupNextGame', () => {
        /** initial `currentGame` storage var */
        let game0: { state: bigint; id: bigint }
        beforeEach(async () => {
            ;({ lotto, mockRandomiser } = await deployLotto({
                deployer,
                factory,
                gamePeriod: 3600n,
                prizeToken: testERC20,
            }))
            game0 = await lotto.currentGame()
        })

        it('should revert if called in Dead state', async () => {
            await lotto.setGameState(GameState.Dead)
            await expect(lotto.setupNextGame()).to.be.reverted
        })

        it('should transition to Dead state when kill was called', async () => {
            await lotto.kill()
            await time.increase(await lotto.gamePeriod())

            // Call
            await lotto.setupNextGame()
            expect((await lotto.currentGame()).state).to.eq(GameState.Dead)
        })

        it('should initialise next game data correctly', async () => {
            await time.increase(await lotto.gamePeriod())

            // Call
            const tx = await lotto.setupNextGame().then((tx) => tx.wait())
            const game = await lotto.currentGame()
            // Ensure monotonic progression of gameId
            expect(game.id).to.eq(game0.id + 1n)
            // State must always transitions to `Purchase` if not killed
            expect(game.state).to.eq(GameState.Purchase)
            // Ensure gameData is initialised correctly
            const gameData = await lotto.gameData(game.id)
            expect(gameData.ticketsSold).to.eq(0n)
            expect(gameData.startedAt).to.deep.eq(
                await tx!.getBlock().then((block) => block!.timestamp),
            )
            expect(gameData.winningPickId).to.eq(0n)
        })

        describe('Jackpot accounting', () => {
            beforeEach(async () => {
                await lotto.setJackpot(parseEther('60'))
                await lotto.setUnclaimedPayouts(parseEther('40'))
            })

            describe('no winners', () => {
                it('should NOT rollover jackpot if transitioning to Dead state (apocalypse)', async () => {
                    await lotto.kill() // trigger apocalypse mode

                    await expect(lotto.setupNextGame())
                        .to.emit(lotto, 'JackpotRollover')
                        .withArgs(0, parseEther('40'), parseEther('60'), parseEther('100'), 0)
                })

                it('should rollover current jackpot and unclaimed payouts to next jackpot otherwise', async () => {
                    // Both the current jackpot and unclaimed payouts are combined and then set as the next jackpot
                    // i.e. Unclaimed payouts are only available during the next game after a win
                    await expect(lotto.setupNextGame())
                        .to.emit(lotto, 'JackpotRollover')
                        .withArgs(0, parseEther('40'), parseEther('60'), 0, parseEther('100'))
                })
            })

            describe('winners > 0', () => {
                it('should rollover current jackpot and unclaimed payouts to next game otherwise', async () => {
                    // Get some tickets going
                    await lotto.pickTickets([
                        { whomst: alice.address, pick: [1, 2, 3, 4, 5] },
                        { whomst: bob.address, pick: [1, 2, 3, 4, 5] },
                    ])
                    const gameData1 = await lotto.gameData(game0.id)
                    expect(gameData1.ticketsSold).to.eq(2)
                    await lotto.setGameData(game0.id, {
                        startedAt: gameData1.startedAt,
                        ticketsSold: gameData1.ticketsSold,
                        // Mock winning pick id to the tickets we bought
                        winningPickId: computePickId([1n, 2n, 3n, 4n, 5n]),
                    })

                    // Setup next game
                    await expect(lotto.setupNextGame())
                        .to.emit(lotto, 'JackpotRollover')
                        .withArgs(0, parseEther('40'), parseEther('60'), parseEther('100'), 0)
                })
            })
        })
    })

    describe('#claimWinnings', () => {
        let prizeToken: ERC20
        let fastForwardAndDraw: (randomness: bigint) => Promise<bigint[]>
        beforeEach(async () => {
            ;({ lotto, fastForwardAndDraw, prizeToken } = await deployLotto({
                deployer,
                factory,
                gamePeriod: 3600n,
                prizeToken: testERC20,
            }))
        })

        it('should revert if called in any state other than Purchase or Dead', async () => {
            const allOtherStates = allStates.filter(
                (state) => state !== GameState.Purchase && state !== GameState.Dead,
            )
            for (const state of allOtherStates) {
                await lotto.setGameState(state)
                await expect(lotto.claimWinnings(1))
                    .to.be.revertedWithCustomError(lotto, 'UnexpectedState')
                    .withArgs(state)
            }
        })

        it('should burn NFT', async () => {
            const receiver = ethers.Wallet.createRandom().address
            // With seed=69420, the winning pick is [5,10,41,46,55]
            const winningPick = Array.from(await lotto.computePick(36101364786398240n))
            const tokenId = (await lotto.totalSupply()) + 1n
            await expect(lotto.pickTickets([{ whomst: receiver, pick: winningPick }]))
                .to.emit(lotto, 'Transfer')
                .withArgs(ethers.ZeroAddress, receiver, tokenId)
            await fastForwardAndDraw(69420n)

            expect(await lotto.ownerOf(tokenId)).to.eq(receiver)
            // Claim winnings => burn NFT
            await expect(lotto.claimWinnings(tokenId))
                .to.emit(lotto, 'Transfer')
                .withArgs(receiver, ethers.ZeroAddress, tokenId)
            // Burnt <-> no longer owned
            await expect(lotto.ownerOf(tokenId))
                .to.be.revertedWithCustomError(lotto, 'ERC721NonexistentToken')
                .withArgs(tokenId)
        })

        it('should revert if trying to claim winnings for nonexistent token', async () => {
            const tokenId = (await lotto.totalSupply()) + 1n

            // Try to claim winnings
            await expect(lotto.claimWinnings(tokenId))
                .to.be.revertedWithCustomError(lotto, 'ERC721NonexistentToken')
                .withArgs(tokenId)
        })

        it('should revert if claim window has been missed', async () => {
            const tokenId = (await lotto.totalSupply()) + 1n
            const winningPick = Array.from(await lotto.computePick(36101364786398240n))
            await expect(lotto.pickTickets([{ whomst: alice.address, pick: winningPick }]))
                .to.emit(lotto, 'Transfer')
                .withArgs(ethers.ZeroAddress, alice.address, tokenId)
            await fastForwardAndDraw(69420n)
            // Don't claim & skip a game
            // We need to pick at least 1 ticket otherwise the game will be skipped and no VRF
            // request will be made
            await lotto.pickTickets([{ whomst: alice.address, pick: [1, 2, 3, 4, 5] }])
            await fastForwardAndDraw(99999n)

            // Try to claim winnings from 2 games ago
            await expect(lotto.claimWinnings(tokenId))
                .to.be.revertedWithCustomError(lotto, 'ClaimWindowMissed')
                .withArgs(tokenId)
        })

        describe('consolation payouts', () => {
            for (let r = 0; r < runs; r++) {
                it(`should payout a share of the pot if there are no winners in Dead state (${
                    r + 1
                }/${runs})`, async () => {
                    ;({ lotto, fastForwardAndDraw, prizeToken } = await deployLotto({
                        deployer,
                        factory,
                        gamePeriod: 3600n,
                        prizeToken: testERC20,
                        shouldSkipSeedJackpot: true,
                    }))
                    const pickLength = await lotto.pickLength()
                    const maxBallValue = await lotto.maxBallValue()
                    const jackpot = (await lotto.seedJackpotMinValue()) + randomBigInt(8)
                    await testERC20.mint(deployer.address, jackpot)
                    await testERC20.approve(await lotto.getAddress(), jackpot)
                    await lotto.seedJackpot(jackpot)
                    const tickets = Array.from(
                        { length: Math.floor(Math.random() * 19) + 1 },
                        () => ({
                            whomst: ethers.Wallet.createRandom().address,
                            pick: slikpik(pickLength, maxBallValue),
                        }),
                    )
                    const pickTx = lotto.pickTickets(tickets)
                    for (let i = 0; i < tickets.length; i++) {
                        await expect(pickTx)
                            .to.emit(lotto, 'Transfer')
                            .withArgs(ethers.ZeroAddress, tickets[i].whomst, i + 1)
                    }
                    await lotto.kill() // trigger apocalypse mode
                    await fastForwardAndDraw(69420n)

                    // Claim each consolation prize for each ticket
                    for (let i = 0; i < tickets.length; i++) {
                        const balanceBefore = await prizeToken.balanceOf(tickets[i].whomst)
                        // This is the *minimum* jackpot share for each ticket, i.e. it's the
                        // rounded-down share.
                        const minJackpotShare = jackpot / BigInt(tickets.length)
                        const claimTx = lotto.claimWinnings(i + 1)
                        await expect(claimTx).to.emit(lotto, 'ConsolationClaimed')
                        const logs = await claimTx
                            .then((tx) => tx.wait())
                            .then((receipt) => receipt?.logs)
                        const event = logs
                            ?.map((log) => {
                                try {
                                    return LooteryHarness__factory.createInterface().parseLog(log)
                                } catch (err) {
                                    return null
                                }
                            })
                            .find((log) => log?.name === 'ConsolationClaimed')
                        const [tokenId, gameId, whomst, value] = event!.args as unknown as [
                            bigint,
                            bigint,
                            `0x${string}`,
                            bigint,
                        ]
                        expect(tokenId).to.eq(i + 1)
                        expect(gameId).to.eq(0)
                        expect(whomst).to.eq(tickets[i].whomst)
                        expect(value).to.be.gte(minJackpotShare)
                        expect(await prizeToken.balanceOf(tickets[i].whomst)).to.be.gte(
                            balanceBefore + minJackpotShare,
                        )
                    }
                })
            }
        })

        // TODO: Check more cases (multiple winners, odd/even number of winners, odd/even jackpot value, etc)
        it('should payout a share of the pot for winning ticket', async () => {
            const jackpot = await lotto.jackpot()
            expect(jackpot).to.eq(parseEther('10')) // `deployLootery` sets initial jackpot to 10 ETH
            const winningPick = Array.from(await lotto.computePick(36101364786398240n))
            // Alice has the only winning ticket
            const tickets = [
                { whomst: deployer.address, pick: [1n, 2n, 3n, 4n, 5n] },
                { whomst: bob.address, pick: [2n, 3n, 4n, 5n, 6n] },
                { whomst: alice.address, pick: winningPick },
            ]
            const pickTx = lotto.pickTickets(tickets)
            for (let i = 0; i < tickets.length; i++) {
                await expect(pickTx)
                    .to.emit(lotto, 'Transfer')
                    .withArgs(ethers.ZeroAddress, tickets[i].whomst, i + 1)
            }
            await fastForwardAndDraw(69420n)

            // Alice claims her winnings (entire jackpot)
            await expect(lotto.claimWinnings(3))
                .to.emit(lotto, 'WinningsClaimed')
                .withArgs(3, 0, alice.address, jackpot)
            // Everyone else gets nothing
            await expect(lotto.claimWinnings(1))
                .to.emit(lotto, 'NoWin')
                .withArgs(computePickId(tickets[0].pick), 36101364786398240n)
            await expect(lotto.claimWinnings(2))
                .to.emit(lotto, 'NoWin')
                .withArgs(computePickId(tickets[1].pick), 36101364786398240n)
            // Ensure all the tokens were burnt after claiming, even if the user didn't win
            for (let i = 0; i < tickets.length; i++) {
                await expect(lotto.ownerOf(i + 1)).to.be.revertedWithCustomError(
                    lotto,
                    'ERC721NonexistentToken',
                )
            }
        })
    })

    describe('#withdrawAccruedFees', () => {
        beforeEach(async () => {
            ;({ lotto } = await deployLotto({
                deployer,
                factory,
                gamePeriod: 3600n,
                prizeToken: testERC20,
            }))
        })

        it('should revert if not called by owner', async () => {
            await expect(lotto.connect(alice).withdrawAccruedFees())
                .to.be.revertedWithCustomError(lotto, 'OwnableUnauthorizedAccount')
                .withArgs(alice.address)
        })

        it('should withdra all accrued community fees', async () => {
            const balance = await testERC20.balanceOf(deployer.address)
            const fees = parseEther('10')
            await lotto.setAccruedCommunityFees(fees)
            await testERC20.mint(await lotto.getAddress(), fees)
            await expect(lotto.withdrawAccruedFees())
                .to.emit(lotto, 'AccruedCommunityFeesWithdrawn')
                .withArgs(deployer.address, fees)
            expect(await testERC20.balanceOf(deployer.address)).to.eq(balance + fees)
        })
    })

    describe('#kill', () => {
        beforeEach(async () => {
            ;({ lotto } = await deployLotto({
                deployer,
                factory,
                gamePeriod: 3600n,
                prizeToken: testERC20,
            }))
        })

        it('should revert if not called by owner', async () => {
            await expect(lotto.connect(alice).kill())
                .to.be.revertedWithCustomError(lotto, 'OwnableUnauthorizedAccount')
                .withArgs(alice.address)
        })

        it('should revert if called in any state other than Purchase', async () => {
            const allOtherStates = allStates.filter((state) => state !== GameState.Purchase)
            for (const state of allOtherStates) {
                await lotto.setGameState(state)
                await expect(lotto.kill())
                    .to.be.revertedWithCustomError(lotto, 'UnexpectedState')
                    .withArgs(state)
            }
        })

        it('should queue apocalypse mode', async () => {
            await lotto.kill()
            expect(await lotto.isApocalypseMode()).to.eq(true)
        })

        it('should revert if apocalypse mode already queued', async () => {
            await lotto.kill()
            await expect(lotto.kill()).to.be.revertedWithCustomError(lotto, 'GameInactive')
        })
    })

    describe('#rescueETH', () => {
        beforeEach(async () => {
            ;({ lotto } = await deployLotto({
                deployer,
                factory,
                gamePeriod: 3600n,
                prizeToken: testERC20,
            }))
        })

        it('should revert if not called by owner', async () => {
            await expect(lotto.connect(alice).rescueETH())
                .to.be.revertedWithCustomError(lotto, 'OwnableUnauthorizedAccount')
                .withArgs(alice.address)
        })

        it('should revert if ETH transfer fails', async () => {
            const opFunds = parseEther('10')
            setBalance(await lotto.getAddress(), opFunds)
            const _revertingReceiver = await new RevertingETHReceiver__factory(deployer).deploy()
            await lotto.transferOwnership(await _revertingReceiver.getAddress())
            await impersonateAccount(await _revertingReceiver.getAddress())
            // This is now the owner, and will always revert upon receiving ETH
            const revertingReceiver = await ethers.getSigner(await _revertingReceiver.getAddress())
            setBalance(await revertingReceiver.getAddress(), parseEther('1'))

            // Rescue ETH
            const rescueTx = lotto.connect(revertingReceiver).rescueETH()
            await expect(rescueTx).to.be.revertedWithCustomError(lotto, 'TransferFailure')
        })

        it('should rescue ETH', async () => {
            const opFunds = parseEther('10')
            setBalance(await lotto.getAddress(), opFunds)
            const balance = await ethers.provider.getBalance(deployer.address)

            // Rescue ETH
            const rescueTx = lotto.rescueETH()
            await expect(rescueTx)
                .to.emit(lotto, 'OperationalFundsWithdrawn')
                .withArgs(deployer.address, opFunds)
            const receipt = await rescueTx.then((tx) => tx.wait())
            const txGasFee = receipt!.cumulativeGasUsed * receipt!.gasPrice
            expect(await ethers.provider.getBalance(deployer.address)).to.eq(
                balance + opFunds - txGasFee,
            )
        })
    })

    describe('#rescueTokens', () => {
        let fastForwardAndDraw: (randomness: bigint) => Promise<bigint[]>
        beforeEach(async () => {
            ;({ lotto, mockRandomiser, fastForwardAndDraw } = await deployLotto({
                deployer,
                factory,
                gamePeriod: 3600n,
                prizeToken: testERC20,
                shouldSkipSeedJackpot: true,
            }))
        })

        it('should revert if not called by owner', async () => {
            await expect(lotto.connect(alice).rescueTokens(await testERC20.getAddress()))
                .to.be.revertedWithCustomError(lotto, 'OwnableUnauthorizedAccount')
                .withArgs(alice.address)
        })

        it('should rescue tokens other than the prize token', async () => {
            // Load contract with random token
            const amount = parseEther('10')
            const notPrizeToken = await new MockERC20__factory(deployer).deploy(deployer.address)
            await notPrizeToken.mint(await lotto.getAddress(), amount)
            await lotto.setJackpot(parseEther('1')) // should be ignored
            await lotto.setAccruedCommunityFees(parseEther('1')) // should be ignored

            // Rescue tokens
            await lotto.rescueTokens(await notPrizeToken.getAddress())
            expect(await notPrizeToken.balanceOf(await lotto.getAddress())).to.eq(0)
            expect(await notPrizeToken.balanceOf(deployer.address)).to.eq(amount)
        })

        describe('rescue prize token', () => {
            for (let i = 0; i < runs; i++) {
                // Fuzz random scenarios
                const commFees = randomBigInt(16)
                const unclaimedPayouts = randomBigInt(16)
                const jackpot = randomBigInt(16)
                const locked = commFees + unclaimedPayouts + jackpot
                const excess = randomBigInt(16)
                it(`should rescue prize token (${i + 1}/${runs})`, async () => {
                    await lotto.setAccruedCommunityFees(commFees)
                    await lotto.setUnclaimedPayouts(unclaimedPayouts)
                    await lotto.setJackpot(jackpot)
                    await testERC20.mint(await lotto.getAddress(), locked + excess)
                    expect(await testERC20.getAddress()).to.eq(await lotto.prizeToken())

                    // Total locked should be sum of accrued fees, unclaimed payouts, and jackpot
                    const balance = await testERC20.balanceOf(deployer.address)
                    await lotto.rescueTokens(await lotto.prizeToken())
                    expect(await testERC20.balanceOf(deployer.address)).to.eq(balance + excess)
                })
            }

            it('should rescue all prize tokens if in Dead state and no tickets sold', async () => {
                const commFees = parseEther('1')
                const unclaimedPayouts = parseEther('2')
                const jackpot = parseEther('3')
                const locked = commFees + unclaimedPayouts + jackpot
                const excess = parseEther('1')
                await lotto.setAccruedCommunityFees(commFees)
                await lotto.setUnclaimedPayouts(unclaimedPayouts)
                await lotto.setJackpot(jackpot)
                await testERC20.mint(await lotto.getAddress(), locked + excess)
                await lotto.kill()
                await time.increase(await lotto.gamePeriod())
                await lotto.draw()

                await lotto.rescueTokens(await lotto.prizeToken())
                expect(await testERC20.balanceOf(await lotto.getAddress())).to.eq(0)
                expect(await lotto.accruedCommunityFees()).to.eq(0)
                expect(await lotto.unclaimedPayouts()).to.eq(0)
                expect(await lotto.jackpot()).to.eq(0)
            })
        })
    })

    describe('#computePick', () => {
        let pickLength!: number
        let maxBallValue!: number
        beforeEach(async () => {
            // Minimum of 2 numbers for a pick
            pickLength = 2 + Math.floor(Math.random() * 25)
            // maxBallValue in [pickLength, 256)
            do {
                maxBallValue = Number(randomBigInt(1))
            } while (maxBallValue < pickLength)
            ;({ lotto } = await deployLotto({
                deployer,
                factory,
                gamePeriod: 3600n,
                prizeToken: testERC20,
                pickLength: BigInt(pickLength),
                maxBallValue: BigInt(maxBallValue),
            }))
        })

        for (let i = 0; i < runs; i++) {
            it(`should compute picks (${i + 1}/${runs})`, async () => {
                const randomPickId = randomBigInt(32) & ~1n // Ensure 0th bit is always 0
                expect(await lotto.computePick(randomPickId)).to.deep.eq(
                    computePick(randomPickId).slice(0, Number(await lotto.pickLength())),
                )
            })
        }
    })

    describe('#computeWinningPick', () => {
        let pickLength!: number
        let maxBallValue!: number
        beforeEach(async () => {
            // Minimum of 2 numbers for a pick
            pickLength = 2 + Math.floor(Math.random() * 25)
            // maxBallValue in [pickLength, 256)
            do {
                maxBallValue = Number(randomBigInt(1))
            } while (maxBallValue < pickLength)
            ;({ lotto } = await deployLotto({
                deployer,
                factory,
                gamePeriod: 3600n,
                prizeToken: testERC20,
                pickLength: BigInt(pickLength),
                maxBallValue: BigInt(maxBallValue),
            }))
        })

        for (let i = 0; i < runs; i++) {
            it(`should compute winning balls (${i + 1}/${runs})`, async () => {
                const seed = randomBigInt(32)
                // Pick is always a sorted sequence of unique numbers produced by the
                // Feistel Shuffle with 12 rounds
                const pick = Array.from(
                    { length: pickLength },
                    (_, i) => 1n + shuffle(BigInt(i), BigInt(maxBallValue), seed, 12n),
                ).sort((a, b) => Number(a - b))
                expect(Array.from(await lotto.computeWinningPick(seed))).to.deep.eq(pick)
            })
        }
    })

    describe('#setTicketSVGRenderer', () => {
        beforeEach(async () => {
            ;({ lotto } = await deployLotto({
                deployer,
                factory,
                gamePeriod: 3600n,
                prizeToken: testERC20,
            }))
        })

        it('should revert if not called by owner', async () => {
            await expect(lotto.connect(alice).setTicketSVGRenderer(await lotto.getAddress()))
                .to.be.revertedWithCustomError(lotto, 'OwnableUnauthorizedAccount')
                .withArgs(alice.address)
        })

        it('should revert if renderer is zero address', async () => {
            await expect(lotto.setTicketSVGRenderer(ethers.ZeroAddress)).to.be.reverted
        })

        it('should revert if renderer does not implement ITicketSVGRenderer', async () => {
            // EOA
            await expect(lotto.setTicketSVGRenderer(alice.address)).to.be.reverted
            // Contract that doesn't implement ERC165
            const notRenderer0 = await new MockERC20__factory(deployer).deploy(deployer.address)
            await expect(lotto.setTicketSVGRenderer(await notRenderer0.getAddress())).to.be.reverted
            // Contract that implements ERC165
            const notRenderer1 = await new MockERC721__factory(deployer).deploy(deployer.address)
            await expect(lotto.setTicketSVGRenderer(await notRenderer1.getAddress()))
                .to.be.revertedWithCustomError(lotto, 'InvalidTicketSVGRenderer')
                .withArgs(await notRenderer1.getAddress())
        })

        it('should set TicketSVGRenderer', async () => {
            const renderer = await new TicketSVGRenderer__factory(deployer).deploy()
            await lotto.setTicketSVGRenderer(await renderer.getAddress())
            expect(await lotto.ticketSVGRenderer()).to.eq(await renderer.getAddress())
        })
    })

    describe('#isGameActive', () => {
        it('should return true if game is not dead', async () => {
            const { lotto } = await deployUninitialisedLootery(deployer)
            for (const state of allStates.filter((state) => state !== GameState.Dead)) {
                await lotto.setGameState(state)
                expect(await lotto.isGameActive()).to.eq(true)
            }
        })
    })

    describe('#tokenURI', () => {
        it('should revert if token does not exist', async () => {
            const { lotto } = await deployUninitialisedLootery(deployer)
            await expect(lotto.tokenURI(1)).to.be.revertedWithCustomError(
                lotto,
                'ERC721NonexistentToken',
            )
        })

        it('should return tokenURI', async () => {
            const { lotto } = await deployLotto({
                deployer,
                factory,
                gamePeriod: 3600n,
                prizeToken: testERC20,
            })
            await lotto.pickTickets([{ whomst: alice.address, pick: [1, 2, 3, 4, 5] }])
            const tokenUri = await lotto.tokenURI(1)
            expect(tokenUri.startsWith('data:application/json;base64,')).to.eq(true)
        })
    })

    describe('#setCallbackGasLimit', () => {
        it('should set callback gas limit if called by owner', async () => {
            const { lotto } = await deployLotto({
                deployer,
                factory,
                gamePeriod: 3600n,
                prizeToken: testERC20,
            })
            await expect(lotto.setCallbackGasLimit(1_000_000))
                .to.emit(lotto, 'CallbackGasLimitSet')
                .withArgs(1_000_000)
            expect(await lotto.callbackGasLimit()).to.eq(1_000_000)
        })

        it('should revert if not called by owner', async () => {
            const { lotto } = await deployLotto({
                deployer,
                factory,
                gamePeriod: 3600n,
                prizeToken: testERC20,
            })
            await expect(lotto.connect(alice).setCallbackGasLimit(1_000_000)).to.be.reverted
        })
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

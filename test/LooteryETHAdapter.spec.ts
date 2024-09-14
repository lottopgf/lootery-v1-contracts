import { ethers } from 'hardhat'
import {
    LooteryFactory,
    LooteryFactory__factory,
    Lootery__factory,
    MockRandomiser,
    MockRandomiser__factory,
    MockERC20__factory,
    type MockERC20,
    WETH9__factory,
    LooteryETHAdapter__factory,
    TicketSVGRenderer__factory,
    TicketSVGRenderer,
} from '../typechain-types'
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import { ZeroAddress, parseEther } from 'ethers'
import { expect } from 'chai'
import { deployProxy } from './helpers/deployProxy'

describe('Lootery ETH Adapter', () => {
    let mockRandomiser: MockRandomiser
    let testERC20: MockERC20
    let factory: LooteryFactory
    let deployer: SignerWithAddress
    let bob: SignerWithAddress
    let ticketSVGRenderer: TicketSVGRenderer
    beforeEach(async () => {
        ;[deployer, bob] = await ethers.getSigners()
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
                        pick: [1n, 2n, 3n, 4n, 5n],
                    },
                ],
                ZeroAddress,
                { value: parseEther('1') },
            ),
        ).to.be.revertedWith('Need to provide exact funds')

        await looteryETHAdapter.connect(bob).purchase(
            lotto,
            [
                {
                    whomst: bob.address,
                    pick: [1n, 2n, 3n, 4n, 5n],
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

        await expect(looteryETHAdapter.connect(bob).seedJackpot(lotto, { value: parseEther('10') }))
            .to.emit(looteryETHAdapter, 'JackpotSeeded')
            .withArgs(bob.address, parseEther('10'))
    })
})

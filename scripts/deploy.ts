import { ethers, ignition, run } from 'hardhat'
import { LooteryFactory__factory } from '../typechain-types'
import { config } from './config'
import LooteryImplModule from '../ignition/modules/LooteryImplV1_9_0'
import LooteryFactoryModule from '../ignition/modules/LooteryFactory'
import LooteryETHAdapterModule from '../ignition/modules/LooteryETHAdapter'
import TicketSVGRendererModule from '../ignition/modules/TicketSVGRenderer'
import assert from 'node:assert'
import { getAddress, ZeroAddress } from 'ethers'

async function main() {
    const [deployer] = await ethers.getSigners()
    const chainId = await ethers.provider.getNetwork().then((network) => network.chainId)
    const { anyrand, weth, owner, feeRecipient } = config[chainId.toString() as keyof typeof config]

    const { ticketSVGRenderer } = await ignition.deploy(TicketSVGRendererModule)
    const { looteryImpl } = await ignition.deploy(LooteryImplModule)
    const factoryInitData = LooteryFactory__factory.createInterface().encodeFunctionData('init', [
        await looteryImpl.getAddress(),
        anyrand,
        await ticketSVGRenderer.getAddress(),
    ])
    const { looteryFactoryProxy } = await ignition.deploy(LooteryFactoryModule, {
        parameters: {
            LooteryFactory: {
                factoryInitData,
            },
        },
    })
    console.log(`LooteryFactory deployed at: ${await looteryFactoryProxy.getAddress()}`)

    // Periphery
    const { looteryEthAdapter } = await ignition.deploy(LooteryETHAdapterModule, {
        parameters: {
            LooteryETHAdapter: {
                weth,
            },
        },
    })
    console.log(`LooteryETHAdapter deployed at: ${await looteryEthAdapter.getAddress()}`)

    /// Post-deployment ops

    const looteryFactory = await LooteryFactory__factory.connect(
        await looteryFactoryProxy.getAddress(),
        deployer,
    )

    // Set fee recipient
    if (feeRecipient) {
        await looteryFactory.setFeeRecipient(feeRecipient)
    }

    // NB: This should always be the last step
    // Transfer ownership of the factory
    if (owner) {
        const DEFAULT_ADMIN_ROLE = await looteryFactory.DEFAULT_ADMIN_ROLE()
        assert(getAddress(owner) !== ZeroAddress, 'Owner cannot be the zero address')
        await looteryFactory.grantRole(DEFAULT_ADMIN_ROLE, owner).then((tx) => tx.wait(1))
        // Sanity check
        assert(
            await looteryFactory.hasRole(DEFAULT_ADMIN_ROLE, owner),
            `${owner} was not successfully granted the admin role`,
        )
        await looteryFactory.revokeRole(DEFAULT_ADMIN_ROLE, deployer).then((tx) => tx.wait(1))
        // Sanity check
        assert(
            !(await looteryFactory.hasRole(DEFAULT_ADMIN_ROLE, deployer)),
            `${deployer} was not successfully revoked of the admin role`,
        )
    }

    // Verify all
    await run(
        {
            scope: 'ignition',
            task: 'verify',
        },
        {
            // Not sure this is stable, but works for now
            deploymentId: `chain-${chainId.toString()}`,
        },
    )
}

main()
    .then(() => {
        console.log('Done')
        process.exit(0)
    })
    .catch((err) => {
        console.error(err)
        process.exit(1)
    })

import { ethers, ignition, run } from 'hardhat'
import { config } from './config'
import LooteryETHAdapterModule from '../ignition/modules/LooteryETHAdapterV1_5_0'

async function main() {
    const chainId = await ethers.provider.getNetwork().then((network) => network.chainId)
    const { weth } = config[chainId.toString() as keyof typeof config]

    // Periphery
    const { looteryEthAdapter } = await ignition.deploy(LooteryETHAdapterModule, {
        parameters: {
            LooteryETHAdapterV1_5_0: {
                weth,
            },
        },
    })
    console.log(`LooteryETHAdapter deployed at: ${await looteryEthAdapter.getAddress()}`)

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

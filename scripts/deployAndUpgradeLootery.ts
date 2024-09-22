import { ethers, ignition, run } from 'hardhat'
import { LooteryFactory__factory } from '../typechain-types'
import LooteryImplV1_8_0 from '../ignition/modules/LooteryImplV1_8_0'
import fs from 'node:fs/promises'
import path from 'node:path'
import yesno from 'yesno'

// Deploy new lootery implementation and set the the new Lootery implementation on the factory.
// Note: upgrade periphery contracts required for deploying lotteries, such as the
//  TicketSVGRenderer before running this script.
async function main() {
    const chainId = await ethers.provider.getNetwork().then((network) => network.chainId)
    const deployedAddressesJson = await fs.readFile(
        path.resolve(__dirname, `../ignition/deployments/chain-${chainId}/deployed_addresses.json`),
        {
            encoding: 'utf-8',
        },
    )
    const deployedAddresses = JSON.parse(deployedAddressesJson) as {
        'LooteryFactory#ERC1967Proxy': `0x${string}`
    }
    const [deployer] = await ethers.getSigners()
    const looteryFactoryProxy = await LooteryFactory__factory.connect(
        deployedAddresses['LooteryFactory#ERC1967Proxy'],
        deployer,
    ).waitForDeployment()
    console.log(
        `\x1B[33;1mUsing LooteryFactory deployed at: ${await looteryFactoryProxy.getAddress()}\x1B[0m`,
    )
    console.log(`\x1B[33;1mUsing signer: ${deployer.address}\x1B[0m`)
    const shouldContinue = await yesno({
        question: 'Continue?',
    })
    if (!shouldContinue) {
        console.log('\x1B[31;1mAborted\x1B[0m')
        process.exit(0)
    }
    const { looteryImpl } = await ignition.deploy(LooteryImplV1_8_0, {})
    console.log(`Deployed Lootery implementation at: ${await looteryImpl.getAddress()}`)
    if ((await looteryImpl.getAddress()) !== (await looteryFactoryProxy.getLooteryMasterCopy())) {
        const tx = await looteryFactoryProxy.setLooteryMasterCopy(await looteryImpl.getAddress())
        console.log(`\x1B[32;1mSet new Lootery implementation on the factory: ${tx.hash}\x1B[0m`)
    } else {
        console.log(
            '\x1B[33;1mNothing to do; Lootery implementation is already set on the factory\x1B[0m',
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

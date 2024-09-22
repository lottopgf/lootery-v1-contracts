import { ethers, ignition, run } from 'hardhat'
import { LooteryFactory__factory } from '../typechain-types'
import LooteryFactoryImplV1_6_0 from '../ignition/modules/LooteryFactoryImplV1_6_0'
import fs from 'node:fs/promises'
import path from 'node:path'
import yesno from 'yesno'
import { getAddress, getBytes, hexlify } from 'ethers'

// Deploy new lootery factory implementation and set the the new Lootery factory implementation on the factory proxy.
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
    const { looteryFactoryImpl } = await ignition.deploy(LooteryFactoryImplV1_6_0, {})
    console.log(
        `Deployed LooteryFactory implementation at: ${await looteryFactoryImpl.getAddress()}`,
    )
    const currentLooteryFactoryImplAddress = getAddress(
        hexlify(
            getBytes(
                await ethers.provider.getStorage(
                    await looteryFactoryProxy.getAddress(),
                    '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
                ),
            ).slice(-20),
        ),
    )
    console.log(`Current LooteryFactory implementation: ${currentLooteryFactoryImplAddress}`)
    if ((await looteryFactoryImpl.getAddress()) !== currentLooteryFactoryImplAddress) {
        const tx = await looteryFactoryProxy.upgradeToAndCall(
            await looteryFactoryImpl.getAddress(),
            '0x',
        )
        console.log(`\x1B[32;1mUpgraded implementation on the factory: ${tx.hash}\x1B[0m`)
    } else {
        console.log(
            '\x1B[33;1mNothing to do; factory already points to the new implementation\x1B[0m',
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

import { buildModule } from '@nomicfoundation/hardhat-ignition/modules'

export default buildModule('LooteryETHAdapterV1_5_0', (m) => ({
    looteryEthAdapter: m.contract('LooteryETHAdapter', [m.getParameter('weth')]),
}))

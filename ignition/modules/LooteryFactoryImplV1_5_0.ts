import { buildModule } from '@nomicfoundation/hardhat-ignition/modules'

export default buildModule('LooteryFactoryImplV1_5_0', (m) => ({
    looteryFactoryImpl: m.contract('LooteryFactory', []),
}))

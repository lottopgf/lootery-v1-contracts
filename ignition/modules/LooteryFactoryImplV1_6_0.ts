import { buildModule } from '@nomicfoundation/hardhat-ignition/modules'

export default buildModule('LooteryFactoryImplV1_6_0', (m) => ({
    looteryFactoryImpl: m.contract('LooteryFactory', []),
}))
